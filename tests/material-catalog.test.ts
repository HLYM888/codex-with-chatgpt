import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialCatalog, MaterialError } from "../src/materials/catalog.js";
import { Workspace } from "../src/workspace/manager.js";
import { getStateDir } from "../src/config/paths.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

let root: string;
let outside: string;
let workspace: Workspace;
let configFile: string;
let catalog: MaterialCatalog;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function saveConfig(value: unknown): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(value), "utf8");
}

function config(roots: unknown[] = [], extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, workspaceRoot: workspace.root, roots, ...extras };
}

beforeEach(() => {
  root = makeTmpDir("materials-workspace");
  outside = makeTmpDir("materials-outside");
  workspace = new Workspace(root);
  isolateStateDir();
  configFile = path.join(makeTmpDir("materials-config"), "materials.json");
  catalog = new MaterialCatalog(workspace, configFile);
});

afterEach(() => {
  cleanup(root);
  cleanup(outside);
  delete process.env.C2C_STATE_DIR;
  vi.restoreAllMocks();
});

describe("MaterialCatalog", () => {
  it("uses the state materials path when no config file is supplied", () => {
    const defaultFile = path.join(getStateDir(), "materials", `${workspace.id}.json`);
    fs.mkdirSync(path.dirname(defaultFile), { recursive: true });
    fs.writeFileSync(defaultFile, JSON.stringify(config([{ alias: "docs", root: outside }])), "utf8");

    const defaultCatalog = new MaterialCatalog(workspace);
    expect(defaultCatalog.listRoots().map((item) => item.alias)).toEqual(["workspace", "docs"]);
  });

  it("uses the workspace as the default root and preserves other settings", () => {
    saveConfig(config([{ alias: "docs", root: outside, description: "研究资料" }], { manifest: { mode: "internal" } }));

    expect(catalog.settings()).toMatchObject({ version: 1, manifest: { mode: "internal" } });
    expect(catalog.listRoots()).toEqual([
      { alias: "workspace", description: workspace.name },
      { alias: "docs", description: "研究资料" },
    ]);
    expect(catalog.getWorkspace()).toBe(workspace);
    expect(catalog.getWorkspace("docs").root).toBe(fs.realpathSync.native(outside));
  });

  it("re-reads configuration and rejects invalid or revoked authorization", async () => {
    write(outside, "note.txt", "authorized\n");
    saveConfig(config([{ alias: "docs", root: outside }]));
    expect((await catalog.readSource("docs", "note.txt")).path).toBe("note.txt");

    saveConfig(config([]));
    await expect(catalog.readSource("docs", "note.txt")).rejects.toMatchObject({ code: "UNKNOWN_ROOT" });

    saveConfig({ version: 1, workspaceRoot: path.join(workspace.root, "elsewhere") });
    expect(() => catalog.listRoots()).toThrowError(MaterialError);
    expect(() => catalog.settings()).toThrow(/配置无效/);
    fs.writeFileSync(configFile, "not-json", "utf8");
    expect(() => catalog.listRoots()).toThrowError(MaterialError);
  });

  it("rejects invalid aliases, root counts, and non-absolute roots", () => {
    const invalid = [
      [{ alias: "Workspace", root: outside }],
      [{ alias: "workspace", root: outside }],
      [{ alias: "资料", root: outside }],
      [{ alias: "a".repeat(33), root: outside }],
      [{ alias: "docs", root: "relative" }],
      [{ alias: "missing", root: path.join(outside, "missing") }],
    ];
    for (const roots of invalid) {
      saveConfig(config(roots));
      expect(() => catalog.listRoots()).toThrowError(MaterialError);
    }
    saveConfig(config(Array.from({ length: 9 }, (_, index) => ({ alias: `r${index}`, root: outside }))));
    expect(() => catalog.listRoots()).toThrowError(MaterialError);
  });

  it("inherits path, sensitive-file, and symlink containment rules", async () => {
    write(outside, "ok.txt", "outside-root\n");
    write(outside, ".env", "SECRET=hidden\n");
    write(root, "inside.txt", "inside\n");
    saveConfig(config([{ alias: "docs", root: outside }]));

    await expect(catalog.readSource("docs", "../outside/ok.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(catalog.readSource("docs", ".env")).rejects.toMatchObject({ code: "ACCESS_DENIED_SENSITIVE_FILE" });

    let symlinkReady = true;
    try {
      fs.symlinkSync(path.join(root, "inside.txt"), path.join(outside, "inside-link.txt"));
    } catch {
      symlinkReady = false;
    }
    if (symlinkReady) {
      await expect(catalog.readSource("docs", "inside-link.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
      try {
        fs.symlinkSync(root, path.join(outside, "directory-link"), "junction");
        await expect(catalog.readSource("docs", "directory-link/inside.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
      } catch {
        // Junction creation may be unavailable on an unprivileged Windows runner.
      }
    }
  });

  it("enforces the raw-byte budget and returns the raw hash", async () => {
    const bytes = Buffer.from("raw\x00bytes\n", "binary");
    const rawFile = path.join(outside, "raw.bin");
    fs.writeFileSync(rawFile, bytes);
    saveConfig(config([{ alias: "docs", root: outside }]));

    const result = await catalog.readSource("docs", "raw.bin", undefined, bytes.length);
    expect(result.rootAlias).toBe("docs");
    expect(result.bytes).toEqual(bytes);
    expect(result.sizeBytes).toBe(bytes.length);
    expect(result.sha256).toBe(sha256(bytes));
    await expect(catalog.readSource("docs", "raw.bin", undefined, bytes.length - 1)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("rejects an unexpected digest without exposing the absolute path", async () => {
    write(outside, "hash.txt", "stable\n");
    saveConfig(config([{ alias: "docs", root: outside }]));

    const error = await catalog.readSource("docs", "hash.txt", "0".repeat(64)).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MaterialError);
    expect((error as MaterialError).code).toBe("HASH_MISMATCH");
    expect((error as Error).message).not.toContain(outside);
  });

  it("rejects a path version changed before the final authorization check", async () => {
    write(outside, "changing.txt", "before\n");
    saveConfig(config([{ alias: "docs", root: outside }]));
    const originalStat = fs.promises.stat.bind(fs.promises);
    let calls = 0;
    vi.spyOn(fs.promises, "stat").mockImplementation(async (...args: any[]) => {
      const result = await originalStat(...args);
      calls += 1;
      if (calls === 2) saveConfig(config([]));
      return result;
    });

    await expect(catalog.readSource("docs", "changing.txt")).rejects.toMatchObject({ code: "UNKNOWN_ROOT" });
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
