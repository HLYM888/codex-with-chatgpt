import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { sanitizeExecutionMetadata, sanitizeExecutionOutput } from "./sanitize.js";

export const MAX_OUTPUT_RECORDS = 40;
export const MAX_OUTPUT_PAGE_BYTES = 64 * 1024;
export const MAX_STORED_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ExecutionOutputMeta {
  id: number;
  command: string;
  exitCode: number | null;
  timestamp: string;
  taskId?: string;
  iteration?: number;
  allowed: boolean;
  restrictedReason?: string;
  truncated: boolean;
  /** The local command file exceeded the read budget; the body is bounded. */
  sourceTruncated: boolean;
  sourceEncoding: "utf8" | "gb18030";
  sizeBytes: number;
}

interface OutputIndex {
  nextId: number;
  items: ExecutionOutputMeta[];
}

function outputDir(workspaceId: string): string {
  return ensureDir(path.join(getStateDir(), "execution-outputs", workspaceId));
}

function indexFile(workspaceId: string): string {
  return path.join(outputDir(workspaceId), "index.json");
}

function bodyFile(workspaceId: string, id: number): string {
  return path.join(outputDir(workspaceId), "bodies", `${id}.txt`);
}

function readIndex(workspaceId: string): OutputIndex {
  const saved = readJsonIfExists<OutputIndex>(indexFile(workspaceId));
  if (!saved) return { nextId: 1, items: [] };
  return {
    nextId: saved.nextId,
    items: saved.items.map((item) => ({
      ...item,
      command: sanitizeExecutionMetadata(typeof item.command === "string" ? item.command : "", 200),
      sourceTruncated: Boolean(item.sourceTruncated),
      sourceEncoding: item.sourceEncoding ?? "utf8",
    })),
  };
}

function writeIndex(workspaceId: string, index: OutputIndex): void {
  writeSecureJson(indexFile(workspaceId), index);
}

export interface SaveOutputInput {
  command: string;
  raw: string;
  exitCode?: number | null;
  taskId?: string;
  iteration?: number;
  sourceTruncated?: boolean;
  sourceEncoding?: "utf8" | "gb18030";
}

export interface ExecutionOutputPage {
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
}

function capUtf8Text(value: string, maxBytes = MAX_STORED_OUTPUT_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}

function capSanitizedText(value: string): { text: string; truncated: boolean } {
  const marker = "\n…[脱敏正文已达到 4 MiB 安全保存上限，后续内容未保存]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const prefix = capUtf8Text(value, Math.max(0, MAX_STORED_OUTPUT_BYTES - markerBytes));
  return { text: `${prefix.text}${marker}`, truncated: true };
}

function pageUtf8(
  text: string,
  requestedOffset = 0,
  requestedMaxBytes = MAX_OUTPUT_PAGE_BYTES
): ExecutionOutputPage & { text: string } {
  const bytes = Buffer.from(text, "utf8");
  const maxBytes = Math.min(MAX_OUTPUT_PAGE_BYTES, Math.max(1024, Math.floor(requestedMaxBytes)));
  let offset = Math.max(0, Math.min(bytes.length, Math.floor(requestedOffset)));
  // Never start inside a UTF-8 continuation byte, even if a caller supplies a
  // stale or hand-written offset.
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset += 1;
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end > offset) {
    try {
      const page = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
      const hasMore = end < bytes.length;
      return { text: page, offset, nextOffset: hasMore ? end : null, hasMore };
    } catch {
      end -= 1;
    }
  }
  return { text: "", offset, nextOffset: offset < bytes.length ? offset + 1 : null, hasMore: offset < bytes.length };
}

export function saveExecutionOutput(workspaceId: string, input: SaveOutputInput): ExecutionOutputMeta {
  const capped = capUtf8Text(input.raw);
  const sourceTruncated = Boolean(input.sourceTruncated || capped.truncated);
  const raw = sourceTruncated
    ? `${capped.text}\n…[源文件已达到安全保存上限，正文仅含安全前缀]`
    : capped.text;
  const sanitized = sanitizeExecutionOutput(raw, { truncate: false });
  const index = readIndex(workspaceId);
  const id = index.nextId;
  const timestamp = new Date().toISOString();
  const allowed = sanitized.allowed;
  const stored = allowed ? capUtf8Text(sanitized.text) : { text: "", truncated: false };
  const text = allowed ? (stored.truncated ? capSanitizedText(sanitized.text).text : sanitized.text) : "";
  const truncated = allowed ? sanitized.truncated || sourceTruncated || stored.truncated : false;
  const meta: ExecutionOutputMeta = {
    id,
    command: sanitizeExecutionMetadata(input.command, 200),
    exitCode: input.exitCode ?? null,
    timestamp,
    taskId: input.taskId,
    iteration: input.iteration,
    allowed,
    restrictedReason: allowed ? undefined : sanitized.reason,
    truncated,
    sourceTruncated,
    sourceEncoding: input.sourceEncoding ?? "utf8",
    sizeBytes: Buffer.byteLength(text, "utf8"),
  };
  if (allowed && text) {
    const file = bodyFile(workspaceId, id);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, text, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* ignore */
    }
  }
  index.nextId = id + 1;
  index.items.push(meta);
  while (index.items.length > MAX_OUTPUT_RECORDS) {
    const dropped = index.items.shift();
    if (dropped) {
      fs.rmSync(bodyFile(workspaceId, dropped.id), { force: true });
    }
  }
  writeIndex(workspaceId, index);
  return meta;
}

export function listExecutionOutputs(workspaceId: string, limit = 20): ExecutionOutputMeta[] {
  const items = readIndex(workspaceId).items;
  return items.slice(-Math.max(1, Math.min(50, limit)));
}

export function readExecutionOutput(
  workspaceId: string,
  id: number,
  options: { offset?: number; maxBytes?: number } = {}
):
  | ({ ok: true; meta: ExecutionOutputMeta; text: string } & ExecutionOutputPage)
  | { ok: false; error: "NOT_FOUND" | "OUTPUT_RESTRICTED" } {
  const meta = readIndex(workspaceId).items.find((item) => item.id === id);
  if (!meta) return { ok: false, error: "NOT_FOUND" };
  if (!meta.allowed) return { ok: false, error: "OUTPUT_RESTRICTED" };
  const file = bodyFile(workspaceId, id);
  const fullText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { ok: true, meta, ...pageUtf8(fullText, options.offset, options.maxBytes) };
}
