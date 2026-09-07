import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MaterialError } from "./catalog.js";

const GUARD_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/inbox_guard.py");
const DEFAULT_TIMEOUT_MS = 30_000;
const RELEASE_TIMEOUT_MS = 2_000;
const MAX_PROTOCOL_BYTES = 64 * 1024;

export type InboxGuardOptions = { timeoutMs?: number };

type GuardExit = { code: number | null; signal: NodeJS.Signals | null };

function guardError(code: string, message: string): MaterialError {
  return new MaterialError(code, message);
}

function invalidPath(name: string): MaterialError {
  return guardError("INBOX_GUARD_INVALID", `${name} 必须是绝对路径。`);
}

function validatePath(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw invalidPath(name);
  }
}

function protocolError(value: unknown): MaterialError {
  if (typeof value === "object" && value !== null && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const code = (error as { code?: unknown }).code;
      const message = (error as { message?: unknown }).message;
      if (typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)) {
        return guardError(code, typeof message === "string" ? message.slice(0, 500) : "收件箱目录保护失败。");
      }
    }
  }
  return guardError("INBOX_GUARD_FAILED", "收件箱目录保护协议无效。 ");
}

type GuardSession = {
  child: ChildProcess;
  ready: Promise<void>;
  closed: Promise<GuardExit>;
  get isClosed(): boolean;
  get loss(): MaterialError | undefined;
  abort(error: MaterialError): void;
  beginRelease(): void;
  endInput(): void;
  terminate(): void;
};

function startGuard(
  pythonAbsolute: string,
  workspaceRoot: string,
  inboxAbsolute: string,
  deliveryDir: string,
): GuardSession {
  const child = spawn(
    pythonAbsolute,
    [
      "-I",
      "-X",
      "utf8",
      GUARD_SCRIPT,
      "--workspace-root",
      workspaceRoot,
      "--inbox",
      inboxAbsolute,
      "--delivery-dir",
      deliveryDir,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false },
  );

  let readySettled = false;
  let readyState = false;
  let closed = false;
  let releasing = false;
  let loss: MaterialError | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: MaterialError) => void;
  let closeResolve!: (exit: GuardExit) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const closedPromise = new Promise<GuardExit>((resolve) => { closeResolve = resolve; });
  let stdout = "";

  const markLoss = (error: MaterialError): void => {
    if (releasing || loss !== undefined) return;
    loss = error;
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (readyState) {
      if (text.trim() !== "") markLoss(guardError("INBOX_GUARD_PROTOCOL", "目录保护进程在 ready 后输出了无效数据。"));
      return;
    }
    stdout += text;
    if (Buffer.byteLength(stdout, "utf8") > MAX_PROTOCOL_BYTES) {
      markLoss(guardError("INBOX_GUARD_PROTOCOL", "目录保护进程输出超过协议上限。"));
      return;
    }
    const newline = stdout.indexOf("\n");
    if (newline < 0) return;
    const line = stdout.slice(0, newline).replace(/\r$/, "");
    const remainder = stdout.slice(newline + 1);
    stdout = "";
    if (remainder.trim() !== "") {
      markLoss(guardError("INBOX_GUARD_PROTOCOL", "目录保护进程返回了多余输出。"));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      markLoss(guardError("INBOX_GUARD_PROTOCOL", "目录保护进程没有返回有效 JSON。"));
      return;
    }
    if (typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true &&
        (value as { state?: unknown }).state === "ready") {
      readyState = true;
      readySettled = true;
      readyResolve();
      return;
    }
    markLoss(protocolError(value));
  });
  child.stderr?.resume();
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    if (!releasing) {
      markLoss(guardError("INBOX_GUARD_LOST", `目录保护输入通道失败（${error.code ?? "unknown"}）。`));
    }
  });
  child.on("error", () => {
    markLoss(guardError("INBOX_GUARD_UNAVAILABLE", "目录保护进程无法启动或意外失败。"));
  });
  child.on("close", (code, signal) => {
    closed = true;
    if (!releasing) {
      markLoss(guardError("INBOX_GUARD_LOST", "目录保护进程提前退出，已拒绝继续收件。"));
    }
    closeResolve({ code, signal });
  });

  return {
    child,
    ready,
    closed: closedPromise,
    get isClosed() { return closed; },
    get loss() { return loss; },
    abort(error: MaterialError) {
      markLoss(error);
      try { child.kill(); } catch { /* The OS will release the directory handles. */ }
    },
    beginRelease() { releasing = true; },
    endInput() {
      try { child.stdin?.end(); } catch { /* close/kill below remains fail-closed */ }
    },
    terminate() {
      try { child.kill(); } catch { /* already exited */ }
    },
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

function yieldToChildEvents(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForClose(session: GuardSession, timeoutMs: number): Promise<GuardExit> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      session.closed,
      new Promise<GuardExit>((_, reject) => {
        timer = setTimeout(() => reject(guardError("INBOX_GUARD_RELEASE_FAILED", "目录保护进程没有及时释放。")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Protect workspaceRoot -> inboxAbsolute -> deliveryDir until callback resolves.
 * The helper creates only missing directory components and never creates files.
 */
export async function withInboxGuard<T>(
  pythonAbsolute: string,
  workspaceRoot: string,
  inboxAbsolute: string,
  deliveryDir: string,
  callback: () => T,
  options: InboxGuardOptions = {},
): Promise<T> {
  if (process.platform !== "win32") {
    throw guardError("INBOX_PLATFORM_UNSUPPORTED", "收件箱目录保护当前仅支持 Windows；其他平台没有等价保护。 ");
  }
  validatePath(pythonAbsolute, "pythonAbsolute");
  validatePath(workspaceRoot, "workspaceRoot");
  validatePath(inboxAbsolute, "inboxAbsolute");
  validatePath(deliveryDir, "deliveryDir");
  if (typeof callback !== "function" || callback.constructor?.name === "AsyncFunction") {
    throw guardError("INBOX_GUARD_INVALID", "callback 必须是同步函数。");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw guardError("INBOX_GUARD_INVALID", "timeoutMs 必须是正整数。 ");
  }

  const session = startGuard(pythonAbsolute, workspaceRoot, inboxAbsolute, deliveryDir);
  let timer: NodeJS.Timeout | undefined;
  try {
    timer = setTimeout(() => {
      session.abort(guardError("INBOX_GUARD_TIMEOUT", "目录保护进程超时，已拒绝继续收件。"));
    }, timeoutMs);
    await session.ready;
    if (session.isClosed || session.loss !== undefined) {
      throw session.loss ?? guardError("INBOX_GUARD_LOST", "目录保护进程未保持运行。 ");
    }
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;

    // The callback is deliberately synchronous. This keeps the child alive for
    // the whole filesystem write without an uncancellable async continuation.
    const result = callback();
    if (isThenable(result)) {
      void Promise.resolve(result).catch(() => undefined);
      throw guardError("INBOX_GUARD_INVALID", "收件箱目录保护 callback 必须同步返回，不能返回 Promise。 ");
    }
    await yieldToChildEvents();
    if (session.isClosed || session.loss !== undefined) {
      throw session.loss ?? guardError("INBOX_GUARD_LOST", "目录保护进程提前退出。 ");
    }
    if (session.child.exitCode !== null || session.child.signalCode !== null) {
      throw guardError("INBOX_GUARD_LOST", "目录保护进程已退出，已拒绝继续收件。 ");
    }
    session.beginRelease();
    session.endInput();
    const exit = await waitForClose(session, RELEASE_TIMEOUT_MS);
    if (exit.code !== 0) throw guardError("INBOX_GUARD_RELEASE_FAILED", "目录保护进程释放失败。 ");
    return result;
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    session.beginRelease();
    session.endInput();
    session.terminate();
    try { await waitForClose(session, RELEASE_TIMEOUT_MS); } catch { /* The operation is already failed closed. */ }
    throw error;
  }
}
