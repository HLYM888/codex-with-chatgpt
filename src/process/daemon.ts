import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  findBridgeObservation,
  findLiveBridge,
  probeBridge,
  readRuntimeState,
  type HealthPayload,
  type RuntimeState,
} from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  const projectRoot = path.resolve(__dirname, "..", "..");
  const stableLauncher = path.join(projectRoot, "bin", "c2c.js");
  if (fs.existsSync(stableLauncher)) {
    return { cmd: process.execPath, args: [stableLauncher] };
  }
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(workspaceRoot: string, opts: { port?: number } = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  const observation = await findBridgeObservation(workspace.id, workspace.root);
  if (observation.state === "healthy") return { runtime: observation.runtime, spawned: false };
  if (observation.state === "unknown") {
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
    );
  }

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    [...args, "serve", "--workspace", workspace.root, ...(opts.port ? ["--port", String(opts.port)] : [])],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env },
      windowsHide: true,
    }
  );
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) return { runtime, spawned: true };
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export interface StopBridgeDependencies {
  probe?: (port: number) => Promise<HealthPayload | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export async function stopBridge(
  workspaceRoot: string,
  dependencies: StopBridgeDependencies = {}
): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const runtime = readRuntimeState(workspace.id);
  if (!runtime) return false;
  if (typeof runtime.workspaceRoot !== "string" || !runtime.workspaceRoot.trim()) return false;
  const recordedRoot = path.resolve(runtime.workspaceRoot);
  const requestedRoot = path.resolve(workspace.root);
  const rootsMatch = process.platform === "win32"
    ? recordedRoot.toLowerCase() === requestedRoot.toLowerCase()
    : recordedRoot === requestedRoot;
  if (!rootsMatch) return false;
  const probe = dependencies.probe ?? probeBridge;
  const kill = dependencies.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const healthy = await probe(runtime.port);

  // A port may have been reused by another workspace, or the recorded PID may
  // now belong to an unrelated process. Never kill without a positive bridge
  // identity match. This is also the safe behavior when probing is uncertain.
  if (!healthy || healthy.workspaceId !== workspace.id) return false;

  try {
    await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
    return true;
  } catch {
    // Re-probe immediately before the fallback kill. A shutdown timeout must
    // not turn a reused PID into a kill target.
    const confirmed = await probe(runtime.port);
    if (!confirmed || confirmed.workspaceId !== workspace.id) return false;
    try {
      const info = await adminFetch<{
        workspaceId?: string;
        workspaceRoot?: string;
        pid?: number;
      }>(runtime, "GET", "/admin/info", 2000);
      const confirmedRoot = typeof info.workspaceRoot === "string" ? path.resolve(info.workspaceRoot) : "";
      const sameRoot = process.platform === "win32"
        ? confirmedRoot.toLowerCase() === requestedRoot.toLowerCase()
        : confirmedRoot === requestedRoot;
      if (info.workspaceId !== workspace.id || info.pid !== runtime.pid || !sameRoot) return false;
    } catch {
      return false;
    }
  }
  try {
    kill(runtime.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
