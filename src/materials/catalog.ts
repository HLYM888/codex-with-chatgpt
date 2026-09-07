import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import { Workspace, WorkspaceError } from "../workspace/manager.js";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_ROOTS = 8;
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export class MaterialError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MaterialError";
  }
}

interface MaterialRootConfig {
  alias: string;
  root: string;
  description?: string;
}

interface MaterialConfig {
  version: 1;
  workspaceRoot: string;
  roots?: MaterialRootConfig[];
  [key: string]: unknown;
}

type BigIntStat = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
};

interface ResolvedSource {
  rootAlias: string;
  workspace: Workspace;
  abs: string;
  rel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function sameStat(left: BigIntStat, right: BigIntStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function invalidConfig(): MaterialError {
  return new MaterialError("INVALID_CONFIG", "授权资料配置无效。请检查版本、工作区绑定和资料根。");
}

function invalidArguments(): MaterialError {
  return new MaterialError("INVALID_ARGUMENT", "资料读取参数无效。请检查根别名、路径、摘要和字节预算。");
}

function mapWorkspaceError(error: unknown): MaterialError {
  if (error instanceof MaterialError) return error;
  if (error instanceof WorkspaceError) {
    return new MaterialError(error.code, "资料路径未获授权或无法读取。");
  }
  return new MaterialError("PATH_DENIED", "资料路径未获授权或无法读取。");
}

function mapFileError(error: unknown, phase: "stat" | "open" | "read"): MaterialError {
  switch (nodeErrorCode(error)) {
    case "ENOENT":
    case "ENOTDIR":
      return new MaterialError("FILE_NOT_FOUND", "资料文件不存在。");
    case "EACCES":
    case "EPERM":
      return new MaterialError("ACCESS_DENIED", "没有读取此资料文件的权限。");
    case "EISDIR":
      return new MaterialError("NOT_A_FILE", "资料目标不是普通文件。");
    default:
      return new MaterialError(phase === "stat" ? "STAT_FAILED" : phase === "open" ? "OPEN_FAILED" : "READ_FAILED", "无法读取资料文件。");
  }
}

function ensureAbsoluteRoot(root: unknown): asserts root is string {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0") || !path.isAbsolute(root)) {
    throw invalidConfig();
  }
}

export class MaterialCatalog {
  private readonly configFile: string;

  constructor(private readonly workspace: Workspace, configFile?: string) {
    this.configFile = path.resolve(configFile ?? path.join(getStateDir(), "materials", `${workspace.id}.json`));
  }

  settings(): Record<string, unknown> {
    return cloneJson(this.readConfig());
  }

  listRoots(): { alias: string; description: string }[] {
    const config = this.readConfig();
    return [
      { alias: "workspace", description: this.workspace.name },
      ...(config.roots ?? []).map((root) => ({ alias: root.alias, description: root.description ?? "" })),
    ];
  }

  getWorkspace(alias = "workspace"): Workspace {
    const config = this.readConfig();
    if (typeof alias !== "string" || alias.length === 0) throw invalidArguments();
    if (alias === "workspace") return this.workspace;
    const configured = config.roots?.find((root) => root.alias === alias);
    if (!configured) throw new MaterialError("UNKNOWN_ROOT", "未知资料根。");
    try {
      return new Workspace(configured.root);
    } catch {
      throw new MaterialError("INVALID_ROOT", "授权资料根不可用。");
    }
  }

  async readSource(
    alias: string,
    requested: string,
    expectedSha256?: string,
    maxBytes = DEFAULT_MAX_BYTES
  ): Promise<{ rootAlias: string; path: string; sha256: string; sizeBytes: number; bytes: Buffer }> {
    if (
      typeof alias !== "string" ||
      typeof requested !== "string" ||
      (expectedSha256 !== undefined && (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(expectedSha256))) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    ) {
      throw invalidArguments();
    }

    const initial = this.resolveSource(alias, requested);
    let fileHandle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
      let pathBefore: BigIntStat;
      try {
        pathBefore = (await fs.promises.stat(initial.abs, { bigint: true })) as BigIntStat;
      } catch (error) {
        throw mapFileError(error, "stat");
      }
      if (!pathBefore.isFile()) throw new MaterialError("NOT_A_FILE", "资料目标不是普通文件。");
      if (pathBefore.size > BigInt(maxBytes)) throw new MaterialError("FILE_TOO_LARGE", "资料文件超过读取预算。");

      try {
        fileHandle = await fs.promises.open(initial.abs, "r");
      } catch (error) {
        throw mapFileError(error, "open");
      }

      const handle = fileHandle;
      let fdBefore: BigIntStat;
      try {
        fdBefore = (await handle.stat({ bigint: true })) as BigIntStat;
      } catch {
        throw new MaterialError("FILE_CHANGED", "资料文件在打开期间发生变化，请重新读取。");
      }
      if (!fdBefore.isFile() || !sameStat(pathBefore, fdBefore)) {
        throw new MaterialError("FILE_CHANGED", "资料文件在打开期间发生变化，请重新读取。");
      }

      const hash = createHash("sha256");
      const chunks: Buffer[] = [];
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes));
      let totalBytes = 0;
      for (;;) {
        const remaining = maxBytes - totalBytes;
        if (remaining <= 0) break;
        let readResult: { bytesRead: number; buffer: Buffer };
        try {
          readResult = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
        } catch (error) {
          throw mapFileError(error, "read");
        }
        if (readResult.bytesRead === 0) break;
        const chunk = Buffer.from(readResult.buffer.subarray(0, readResult.bytesRead));
        totalBytes += chunk.length;
        hash.update(chunk);
        chunks.push(chunk);
      }

      let fdAfter: BigIntStat;
      let pathAfter: BigIntStat;
      try {
        fdAfter = (await handle.stat({ bigint: true })) as BigIntStat;
        pathAfter = (await fs.promises.stat(initial.abs, { bigint: true })) as BigIntStat;
      } catch {
        throw new MaterialError("FILE_CHANGED", "资料文件在读取期间发生变化，请重新读取。");
      }
      if (fdAfter.size > BigInt(maxBytes) || pathAfter.size > BigInt(maxBytes)) {
        throw new MaterialError("FILE_TOO_LARGE", "资料文件超过读取预算。");
      }
      if (
        !fdAfter.isFile() ||
        !pathAfter.isFile() ||
        !sameStat(pathBefore, fdBefore) ||
        !sameStat(pathBefore, pathAfter) ||
        !sameStat(fdBefore, fdAfter) ||
        !sameStat(fdAfter, pathAfter) ||
        BigInt(totalBytes) !== pathAfter.size
      ) {
        throw new MaterialError("FILE_CHANGED", "资料文件在读取期间发生变化，请重新读取。");
      }

      const sha256 = hash.digest("hex");
      if (expectedSha256 !== undefined && sha256 !== expectedSha256.toLowerCase()) {
        throw new MaterialError("HASH_MISMATCH", "资料文件摘要与预期版本不符，请重新读取。");
      }

      const final = this.resolveSource(alias, requested);
      if (final.abs !== initial.abs || final.rel !== initial.rel || final.workspace.root !== initial.workspace.root) {
        throw new MaterialError("AUTHORIZATION_REVOKED", "资料授权在读取期间发生变化，请重新读取。");
      }

      return {
        rootAlias: initial.rootAlias,
        path: initial.rel,
        sha256,
        sizeBytes: totalBytes,
        bytes: Buffer.concat(chunks, totalBytes),
      };
    } catch (error) {
      if (error instanceof MaterialError) throw error;
      throw mapWorkspaceError(error);
    } finally {
      if (fileHandle !== undefined) {
        try {
          await fileHandle.close();
        } catch {
          // Preserve the read result or the consistency error.
        }
      }
    }
  }

  private resolveSource(alias: string, requested: string): ResolvedSource {
    if (typeof alias !== "string" || typeof requested !== "string") throw invalidArguments();
    const resolvedWorkspace = this.getWorkspace(alias);
    try {
      const resolved = resolvedWorkspace.resolve(requested);
      return { rootAlias: alias, workspace: resolvedWorkspace, abs: resolved.abs, rel: resolved.rel };
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  }

  private readConfig(): MaterialConfig {
    let source: string;
    try {
      source = fs.readFileSync(this.configFile, "utf8");
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return { version: 1, workspaceRoot: this.workspace.root };
      throw invalidConfig();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw invalidConfig();
    }
    if (!isRecord(parsed) || parsed.version !== 1 || parsed.workspaceRoot !== this.workspace.root) {
      throw invalidConfig();
    }
    if (parsed.roots !== undefined) {
      if (!Array.isArray(parsed.roots) || parsed.roots.length > MAX_ROOTS) throw invalidConfig();
      const aliases = new Set<string>(["workspace"]);
      for (const item of parsed.roots) {
        if (!isRecord(item) || typeof item.alias !== "string" || !ALIAS_PATTERN.test(item.alias) || aliases.has(item.alias)) {
          throw invalidConfig();
        }
        if (item.description !== undefined && typeof item.description !== "string") throw invalidConfig();
        ensureAbsoluteRoot(item.root);
        try {
          const root = fs.realpathSync.native(item.root);
          if (!fs.statSync(root).isDirectory()) throw invalidConfig();
        } catch (error) {
          if (error instanceof MaterialError) throw error;
          throw invalidConfig();
        }
        aliases.add(item.alias);
      }
    }
    return parsed as MaterialConfig;
  }
}
