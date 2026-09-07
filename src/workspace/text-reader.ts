import fs from "node:fs";
import { createHash } from "node:crypto";

export type TextReadEncoding = "utf8" | "utf16le" | "utf16be" | "gb18030";
export type TextReadRequestedEncoding = "auto" | TextReadEncoding;

export interface ReadTextOptions {
  startLine?: number;
  endLine?: number;
  maxLines?: number;
  maxBytes?: number;
  encoding?: TextReadRequestedEncoding;
  expectedSha256?: string;
  signal?: AbortSignal;
}

export interface TextReadResult {
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number | null;
  truncated: boolean;
  remainingLines: number;
  nextStartLine: number | null;
  content: string;
  sha256: string;
  encoding: TextReadEncoding;
}

export type TextReadErrorCode =
  | "INVALID_ARGUMENT"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "ACCESS_DENIED"
  | "BINARY_FILE"
  | "INVALID_ENCODING"
  | "RANGE_TOO_LARGE"
  | "FILE_CHANGED"
  | "HASH_MISMATCH"
  | "ABORTED"
  | "READ_FAILED";

export class TextReadError extends Error {
  constructor(public readonly code: TextReadErrorCode, message: string) {
    super(message);
    this.name = "TextReadError";
  }
}

const DEFAULT_MAX_LINES = 400;
const HARD_MAX_LINES = 2_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const HARD_MAX_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const LINE_PART_CHARS = 8 * 1024;
const MAX_SAFE_LINE = Number.MAX_SAFE_INTEGER;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

interface NormalizedOptions {
  startLine: number;
  endLine?: number;
  maxLines: number;
  maxBytes: number;
  encoding: TextReadRequestedEncoding;
  expectedSha256?: string;
  targetEndLine: number;
}

interface StatLike {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
}

interface StatFingerprint {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function invalidArgument(): TextReadError {
  return new TextReadError("INVALID_ARGUMENT", "文本读取参数无效，请检查范围、预算与编码。");
}

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 1) {
    throw invalidArgument();
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, hardMax: number): number {
  const normalized = positiveInteger(value, fallback);
  return Math.min(hardMax, normalized);
}

function lineEnd(startLine: number, count: number): number {
  return startLine > MAX_SAFE_LINE - (count - 1) ? MAX_SAFE_LINE : startLine + count - 1;
}

function normalizeOptions(options: ReadTextOptions | undefined): NormalizedOptions {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    throw invalidArgument();
  }

  const raw = (options ?? {}) as Record<string, unknown>;
  const startLine = positiveInteger(raw.startLine, 1);
  const endLine = raw.endLine === undefined ? undefined : positiveInteger(raw.endLine, 1);
  if (endLine !== undefined && endLine < startLine) throw invalidArgument();

  const maxLines = boundedInteger(raw.maxLines, DEFAULT_MAX_LINES, HARD_MAX_LINES);
  const maxBytes = boundedInteger(raw.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);

  const encoding = raw.encoding === undefined ? "auto" : raw.encoding;
  if (encoding !== "auto" && encoding !== "utf8" && encoding !== "utf16le" && encoding !== "utf16be" && encoding !== "gb18030") {
    throw invalidArgument();
  }

  let expectedSha256: string | undefined;
  if (raw.expectedSha256 !== undefined) {
    if (typeof raw.expectedSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(raw.expectedSha256)) {
      throw invalidArgument();
    }
    expectedSha256 = raw.expectedSha256.toLowerCase();
  }

  const targetEndLine =
    endLine === undefined ? lineEnd(startLine, maxLines) : Math.min(endLine, lineEnd(startLine, HARD_MAX_LINES));

  return {
    startLine,
    endLine,
    maxLines,
    maxBytes,
    encoding,
    expectedSha256,
    targetEndLine,
  };
}

function statFingerprint(stat: StatLike): StatFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    nlink: stat.nlink,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameStat(a: StatLike, b: StatLike): boolean {
  const left = statFingerprint(a);
  const right = statFingerprint(b);
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function mapInitialFsError(error: unknown): TextReadError {
  switch (nodeErrorCode(error)) {
    case "ENOENT":
    case "ENOTDIR":
      return new TextReadError("FILE_NOT_FOUND", "文件不存在。");
    case "EACCES":
    case "EPERM":
      return new TextReadError("ACCESS_DENIED", "没有读取此文件的权限。");
    case "EISDIR":
      return new TextReadError("NOT_A_FILE", "目标不是普通文件。");
    default:
      return new TextReadError("READ_FAILED", "无法检查文件状态。");
  }
}

function mapOpenFsError(error: unknown): TextReadError {
  switch (nodeErrorCode(error)) {
    case "ENOENT":
    case "ENOTDIR":
      return new TextReadError("FILE_NOT_FOUND", "文件不存在。");
    case "EACCES":
    case "EPERM":
      return new TextReadError("ACCESS_DENIED", "没有读取此文件的权限。");
    case "EISDIR":
      return new TextReadError("NOT_A_FILE", "目标不是普通文件。");
    default:
      return new TextReadError("READ_FAILED", "无法打开文件。");
  }
}

function hasPrefix(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

function decoderSpec(requested: TextReadRequestedEncoding, prefix: Buffer): { encoding: TextReadEncoding; bomBytes: number } {
  if (requested === "auto") {
    if (hasPrefix(prefix, UTF8_BOM)) return { encoding: "utf8", bomBytes: UTF8_BOM.length };
    if (hasPrefix(prefix, UTF16LE_BOM)) return { encoding: "utf16le", bomBytes: UTF16LE_BOM.length };
    if (hasPrefix(prefix, UTF16BE_BOM)) return { encoding: "utf16be", bomBytes: UTF16BE_BOM.length };
    return { encoding: "utf8", bomBytes: 0 };
  }

  const bomEncoding = hasPrefix(prefix, UTF8_BOM) ? "utf8" :
    hasPrefix(prefix, UTF16LE_BOM) ? "utf16le" : hasPrefix(prefix, UTF16BE_BOM) ? "utf16be" : undefined;
  if (bomEncoding !== undefined && bomEncoding !== requested) {
    throw new TextReadError("INVALID_ENCODING", "文件 BOM 与显式选择的编码不一致。");
  }

  if (requested === "utf8" && hasPrefix(prefix, UTF8_BOM)) return { encoding: requested, bomBytes: UTF8_BOM.length };
  if (requested === "utf16le" && hasPrefix(prefix, UTF16LE_BOM)) return { encoding: requested, bomBytes: UTF16LE_BOM.length };
  if (requested === "utf16be" && hasPrefix(prefix, UTF16BE_BOM)) return { encoding: requested, bomBytes: UTF16BE_BOM.length };
  return { encoding: requested, bomBytes: 0 };
}

function makeDecoder(encoding: TextReadEncoding): TextDecoder {
  const label = encoding === "utf8" ? "utf-8" : encoding === "utf16le" ? "utf-16le" : encoding === "utf16be" ? "utf-16be" : "gb18030";
  try {
    // The marker is removed once by decoderSpec. Preserve any subsequent
    // literal U+FEFF character in the document itself.
    return new TextDecoder(label, { fatal: true, ignoreBOM: true });
  } catch {
    throw new TextReadError("INVALID_ENCODING", "当前运行时不支持所选文本编码。");
  }
}

function decode(decoder: TextDecoder, bytes?: Buffer): string {
  // Preserve the established binary error for non-UTF16 data even when a
  // later byte in the same chunk also makes strict decoding fail.
  if (bytes?.includes(0) && !decoder.encoding.startsWith("utf-16")) {
    throw new TextReadError("BINARY_FILE", "文件含有二进制 NUL 数据。");
  }
  try {
    return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
  } catch {
    throw new TextReadError("INVALID_ENCODING", "文件字节不符合所选编码；旧编码文本请明确指定编码。");
  }
}

function isBinaryControl(codePoint: number): boolean {
  // ANSI logs and form-feed text remain readable; they are escaped when
  // serialized by MCP. Decoded NUL retains the existing binary boundary.
  return codePoint === 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TextReadError("ABORTED", "文本读取已取消或超过期限。");
}

export async function readTextFile(abs: string, options?: ReadTextOptions): Promise<TextReadResult> {
  if (typeof abs !== "string" || abs.length === 0 || abs.includes("\0")) throw invalidArgument();
  const normalized = normalizeOptions(options);
  const signal = options?.signal;
  throwIfAborted(signal);

  let fileHandle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  try {
    let pathBefore: Awaited<ReturnType<typeof fs.promises.stat>>;
    try {
      pathBefore = await fs.promises.stat(abs, { bigint: true });
    } catch (error) {
      throw mapInitialFsError(error);
    }
    if (!pathBefore.isFile()) throw new TextReadError("NOT_A_FILE", "目标不是普通文件。");
    throwIfAborted(signal);

    try {
      fileHandle = await fs.promises.open(abs, "r");
    } catch (error) {
      throw mapOpenFsError(error);
    }
    const handle = fileHandle;

    let fdBefore: Awaited<ReturnType<typeof handle.stat>>;
    try {
      fdBefore = await handle.stat({ bigint: true });
    } catch {
      throw new TextReadError("READ_FAILED", "无法检查已打开文件的状态。");
    }
    if (!fdBefore.isFile() || !sameStat(pathBefore, fdBefore)) {
      throw new TextReadError("FILE_CHANGED", "文件在打开期间发生变化，请重新读取。");
    }

    const hash = createHash("sha256");
    const selectedLines: string[] = [];
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let decoder: TextDecoder | undefined;
    let detectedEncoding: TextReadEncoding = "utf8";
    let pendingPrefix = Buffer.alloc(0);
    let totalLines = 0;
    let currentLine = 1;
    let lineActive = false;
    let pendingCarriageReturn = false;
    let currentLineParts: string[] = [];
    let currentLineBytes = 0;
    let returnedContentBytes = 0;
    let contentTruncated = false;
    let actualEndLine: number | null = null;

    const selected = (): boolean => currentLine >= normalized.startLine && currentLine <= normalized.targetEndLine;

    const appendCurrentLinePart = (value: string): void => {
      const last = currentLineParts.length - 1;
      if (last < 0 || currentLineParts[last].length >= LINE_PART_CHARS) currentLineParts.push(value);
      else currentLineParts[last] += value;
    };

    const appendCharacter = (character: string): void => {
      if (!selected() || contentTruncated) return;
      const characterBytes = Buffer.byteLength(character, "utf8");
      const separatorBytes = selectedLines.length > 0 ? 1 : 0;
      const projected = returnedContentBytes + separatorBytes + currentLineBytes + characterBytes;
      if (projected > normalized.maxBytes) {
        if (selectedLines.length === 0) {
          throw new TextReadError("RANGE_TOO_LARGE", "所选首行超过输出预算，请选择其他行或先拆分该长行。");
        }
        contentTruncated = true;
        currentLineParts = [];
        currentLineBytes = 0;
        return;
      }
      appendCurrentLinePart(character);
      currentLineBytes += characterBytes;
    };

    const finishLine = (): void => {
      const lineNumber = currentLine;
      totalLines += 1;
      if (selected() && !contentTruncated) {
        const separatorBytes = selectedLines.length > 0 ? 1 : 0;
        const projected = returnedContentBytes + separatorBytes + currentLineBytes;
        if (projected > normalized.maxBytes) {
          if (selectedLines.length === 0) {
            throw new TextReadError("RANGE_TOO_LARGE", "所选首行超过输出预算，请选择其他行或先拆分该长行。");
          }
          contentTruncated = true;
        } else {
          selectedLines.push(currentLineParts.join(""));
          returnedContentBytes = projected;
          actualEndLine = lineNumber;
        }
      }
      currentLine += 1;
      lineActive = false;
      currentLineParts = [];
      currentLineBytes = 0;
    };

    const processText = (text: string): void => {
      let processedCharacters = 0;
      for (const character of text) {
        if ((processedCharacters++ & 0x1fff) === 0) throwIfAborted(signal);
        const codePoint = character.codePointAt(0) as number;
        if (isBinaryControl(codePoint)) throw new TextReadError("BINARY_FILE", "解码后含有二进制 NUL 数据。");

        if (pendingCarriageReturn) {
          pendingCarriageReturn = false;
          if (character === "\n") {
            finishLine();
            continue;
          }
          finishLine();
        }

        if (character === "\r") {
          lineActive = true;
          pendingCarriageReturn = true;
        } else if (character === "\n") {
          lineActive = true;
          finishLine();
        } else {
          lineActive = true;
          appendCharacter(character);
        }
      }
    };

    const initializeDecoder = (final: boolean): void => {
      if (decoder !== undefined) return;
      if (!final && pendingPrefix.length < 3) return;
      const spec = decoderSpec(normalized.encoding, pendingPrefix);
      detectedEncoding = spec.encoding;
      decoder = makeDecoder(spec.encoding);
      const body = pendingPrefix.subarray(spec.bomBytes);
      pendingPrefix = Buffer.alloc(0);
      if (body.length > 0) processText(decode(decoder, body));
    };

    const consumeBytes = (chunk: Buffer): void => {
      throwIfAborted(signal);
      if (decoder === undefined) {
        pendingPrefix = pendingPrefix.length === 0 ? Buffer.from(chunk) : Buffer.concat([pendingPrefix, chunk]);
        initializeDecoder(false);
        return;
      }
      processText(decode(decoder, chunk));
      throwIfAborted(signal);
    };

    for (;;) {
      throwIfAborted(signal);
      let readResult: { bytesRead: number; buffer: Buffer };
      try {
        readResult = await handle.read(buffer, 0, buffer.length, null);
      } catch {
        throw new TextReadError("READ_FAILED", "无法读取文件。");
      }
      if (readResult.bytesRead === 0) break;
      const chunk = buffer.subarray(0, readResult.bytesRead);
      hash.update(chunk);
      consumeBytes(chunk);
    }

    throwIfAborted(signal);
    initializeDecoder(true);
    if (decoder === undefined) throw new TextReadError("INVALID_ENCODING", "无法确定可用的文本编码。");
    processText(decode(decoder));
    if (pendingCarriageReturn || lineActive) finishLine();
    throwIfAborted(signal);

    let fdAfter: Awaited<ReturnType<typeof handle.stat>>;
    try {
      fdAfter = await handle.stat({ bigint: true });
    } catch {
      throw new TextReadError("FILE_CHANGED", "无法核实读取后的文件版本。");
    }
    let pathAfter: Awaited<ReturnType<typeof fs.promises.stat>>;
    try {
      pathAfter = await fs.promises.stat(abs, { bigint: true });
    } catch {
      throw new TextReadError("FILE_CHANGED", "文件在读取期间发生变化，请重新读取。");
    }
    if (!pathAfter.isFile() || !sameStat(fdBefore, fdAfter) || !sameStat(pathBefore, pathAfter) || !sameStat(fdAfter, pathAfter)) {
      throw new TextReadError("FILE_CHANGED", "文件在读取期间发生变化，请重新读取。");
    }

    const sha256 = hash.digest("hex");
    if (normalized.expectedSha256 !== undefined && sha256 !== normalized.expectedSha256) {
      throw new TextReadError("HASH_MISMATCH", "文件摘要与预期版本不符，请从当前版本重新读取。");
    }
    throwIfAborted(signal);

    const remainingLines = actualEndLine === null ? 0 : Math.max(0, totalLines - actualEndLine);
    return {
      sizeBytes: Number(pathBefore.size),
      totalLines,
      startLine: normalized.startLine,
      endLine: actualEndLine,
      truncated: remainingLines > 0,
      remainingLines,
      nextStartLine: remainingLines > 0 && actualEndLine !== null ? actualEndLine + 1 : null,
      content: selectedLines.join("\n"),
      sha256,
      encoding: detectedEncoding,
    };
  } catch (error) {
    if (error instanceof TextReadError) throw error;
    throw new TextReadError("READ_FAILED", "无法读取文本文件。");
  } finally {
    if (fileHandle !== undefined) {
      try {
        await fileHandle.close();
      } catch {
        // Preserve the original read outcome. The file consistency checks
        // are complete; descriptor cleanup here is best effort.
      }
    }
  }
}
