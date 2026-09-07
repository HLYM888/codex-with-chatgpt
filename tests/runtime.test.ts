import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import {
  findBridgeObservation,
  findLiveBridge,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function stubRuntime(workspaceId: string, workspaceRoot: string, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

describe("findBridgeObservation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("treats a missing runtime file as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-missing");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("runtime_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("treats a dead pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("pid_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("does not treat a live pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unknown");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, child.pid, 1));
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("probe_failed");
      expect(await findLiveBridge(workspace.id)).toBeNull();
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("reports healthy when the local bridge answers", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    try {
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      expect(await findLiveBridge(bridge.workspace.id)).not.toBeNull();
    } finally {
      await bridge.close();
    }
  });

  it("recognizes a dead recorded process when another project has reused its port", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("reused-port-own");
    const other = makeTmpDir("reused-port-other");
    dirs.push(root, other);
    const workspace = new Workspace(root);
    const bridge = await startBridge({ workspaceRoot: other, port: 0, persistRuntime: false });
    try {
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, bridge.port));
      expect(await findBridgeObservation(workspace.id, workspace.root)).toMatchObject({ state: "stopped", reason: "pid_missing" });
      expect((await (await fetch(`${bridge.localBaseUrl()}/health`)).json()).workspaceId).toBe(bridge.workspace.id);
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, process.pid, bridge.port));
      expect(await findBridgeObservation(workspace.id, workspace.root)).toMatchObject({ state: "unknown", reason: "workspace_mismatch" });
    } finally { await bridge.close(); }
  });

  it("persists the selected commit and reports the same value through admin info", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-active-commit");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-active-commit-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const selectedCommit = "a".repeat(40);
    const previousCommit = process.env.C2C_ACTIVE_VERSION_COMMIT;
    process.env.C2C_ACTIVE_VERSION_COMMIT = selectedCommit;
    let bridge: Awaited<ReturnType<typeof startBridge>> | null = null;
    try {
      bridge = await startBridge({
        workspaceRoot: root,
        port: 0,
        persistRuntime: true,
        authStoreFile: auth,
      });
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      if (observation.state === "healthy") expect(observation.runtime.activeCommit).toBe(selectedCommit);

      const response = await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(response.ok).toBe(true);
      const info = await response.json() as { activeCommit?: string };
      expect(info.activeCommit).toBe(selectedCommit);
    } finally {
      if (bridge) await bridge.close();
      if (previousCommit === undefined) delete process.env.C2C_ACTIVE_VERSION_COMMIT;
      else process.env.C2C_ACTIVE_VERSION_COMMIT = previousCommit;
    }
  });

  it("does not invent an active commit when the launcher did not provide one", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-no-active-commit");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-no-active-commit-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const previousCommit = process.env.C2C_ACTIVE_VERSION_COMMIT;
    delete process.env.C2C_ACTIVE_VERSION_COMMIT;
    let bridge: Awaited<ReturnType<typeof startBridge>> | null = null;
    try {
      bridge = await startBridge({
        workspaceRoot: root,
        port: 0,
        persistRuntime: true,
        authStoreFile: auth,
      });
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      if (observation.state === "healthy") expect(observation.runtime.activeCommit).toBeUndefined();

      const response = await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(response.ok).toBe(true);
      const info = await response.json() as { activeCommit?: string };
      expect(info.activeCommit).toBeUndefined();
    } finally {
      if (bridge) await bridge.close();
      if (previousCommit === undefined) delete process.env.C2C_ACTIVE_VERSION_COMMIT;
      else process.env.C2C_ACTIVE_VERSION_COMMIT = previousCommit;
    }
  });

  it("does not kill a PID when the health identity belongs to another workspace", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("stop-mismatch");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 12345, 43123));
    const kill = vi.fn();

    const stopped = await stopBridge(root, {
      probe: async () => ({
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: "different-workspace",
        status: "ok",
      }),
      kill,
    });

    expect(stopped).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not act on a runtime file whose recorded root is different", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("stop-root-mismatch");
    const otherRoot = makeTmpDir("stop-root-other");
    dirs.push(root, otherRoot);
    write(root, "a.txt", "a");
    write(otherRoot, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, otherRoot, 12345, 43123));
    const observation = await findBridgeObservation(workspace.id, workspace.root);
    const probe = vi.fn();
    const kill = vi.fn();

    const stopped = await stopBridge(root, { probe, kill });

    expect(stopped).toBe(false);
    expect(observation).toMatchObject({ state: "unknown", reason: "workspace_mismatch" });
    expect(probe).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("rechecks identity before a fallback kill when the PID may have been reused", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("stop-pid-reuse");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 12345, 43123));
    const identity = (workspaceId: string) => ({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId,
      status: "ok",
    });
    const probe = vi.fn()
      .mockResolvedValueOnce(identity(workspace.id))
      .mockResolvedValueOnce(identity("different-workspace"));
    const kill = vi.fn();

    const stopped = await stopBridge(root, { probe, kill });

    expect(stopped).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(kill).not.toHaveBeenCalled();
  });
});
