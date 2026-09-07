import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { Workspace } from "../src/workspace/manager.js";
import { readMany } from "../src/workspace/read-many.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";

let root: string;
let ws: Workspace;
beforeAll(() => {
  root = makeTmpDir("read-many");
  write(root, "中文.ts", "第一行\n第二行\n第三行\n");
  write(root, "other.ts", "export const value = 42;\n");
  write(root, ".env", "SYNTHETIC_DO_NOT_RETURN=fixture\n");
  write(root, ".c2cignore", "private/\n");
  write(root, "private/input.txt", "synthetic-private\n");
  ws = new Workspace(root);
});
afterAll(() => cleanup(root));

describe("bounded multi-file reading", () => {
  it("keeps ordered ranges, source hashes and Chinese names", async () => {
    const result = await readMany(ws, { items: [
      { path: "中文.ts", start_line: 2, end_line: 2 },
      { path: "other.ts" },
    ] });
    expect(result.structuredContent.items.map(item => item.index)).toEqual([0, 1]);
    const first = result.structuredContent.items[0];
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected successful fixture read");
    expect(first.file.path).toBe("中文.ts");
    expect(first.file.content).toBe("第二行");
    expect(first.file.sha256).toBe(createHash("sha256").update("第一行\n第二行\n第三行\n").digest("hex"));
    expect(first.file.nextStartLine).toBe(3);
    expect(result.structuredContent.nextIndex).toBeNull();
  });

  it("reports failures individually without weakening path or ignore rules", async () => {
    const result = await readMany(ws, { items: [
      { path: ".env" }, { path: "private/input.txt" },
      { path: "../../outside.txt" }, { path: "missing.txt" }, { path: "other.ts" },
    ] });
    const items = result.structuredContent.items;
    expect(items.slice(0, 4).map(item => item.ok)).toEqual([false, false, false, false]);
    expect(items[0]).toMatchObject({ error: "ACCESS_DENIED_SENSITIVE_FILE" });
    expect(items[2]).toMatchObject({ error: "PATH_OUTSIDE_WORKSPACE" });
    expect(items[3]).toMatchObject({ error: "FILE_NOT_FOUND" });
    expect(items[4].ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_DO_NOT_RETURN");
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });

  it("counts JSON escaping and returns a true line continuation", async () => {
    const line = '"'.repeat(90) + "中文";
    write(root, "escaped.txt", Array.from({ length: 100 }, () => line).join("\n"));
    const result = await readMany(ws, { items: [{ path: "escaped.txt" }], maxResultBytes: 4096 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
    const item = result.structuredContent.items[0];
    if (!item.ok) throw new Error("At least one short line should fit");
    const count = item.file.content.split("\n").length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(100);
    expect(item.file.content.split("\n").every(text => text === line)).toBe(true);
    expect(item.file.nextStartLine).toBe(count + 1);
    expect(item.file.remainingLines).toBe(100 - count);
  });

  it("continues unreturned items with a deterministic offset", async () => {
    write(root, "one-line-a.txt", "a".repeat(2000));
    write(root, "one-line-b.txt", "b".repeat(2000));
    const items = [{ path: "one-line-a.txt" }, { path: "one-line-b.txt" }];
    const first = await readMany(ws, { items, maxResultBytes: 4096 });
    expect(first.structuredContent.items).toHaveLength(1);
    expect(first.structuredContent.nextIndex).toBe(1);
    const second = await readMany(ws, { items, offset: 1, maxResultBytes: 4096 });
    expect(second.structuredContent.inputFingerprint).toBe(first.structuredContent.inputFingerprint);
    expect(second.structuredContent.items[0]).toMatchObject({ index: 1, ok: true });
    expect(second.structuredContent.nextIndex).toBeNull();
  });

  it("does not advertise a zero-progress cursor for an oversized first item", async () => {
    write(root, "oversized.txt", '"'.repeat(3000));
    const result = await readMany(ws, { items: [{ path: "oversized.txt" }], maxResultBytes: 4096 });
    expect(result.structuredContent.items[0]).toMatchObject({ index: 0, ok: false, error: "OUTPUT_TOO_LARGE" });
    expect(result.structuredContent.nextIndex).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
  });

  it("never returns changed content for a caller's expected version", async () => {
    const result = await readMany(ws, { items: [{ path: "other.ts", expected_sha256: "0".repeat(64) }] });
    expect(result.structuredContent.items[0].ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("export const value");
  });

  it("rejects invalid batch limits and keeps EOF for an exhausted item list", async () => {
    await expect(readMany(ws, { items: [] })).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(readMany(ws, { items: [{ path: "other.ts" }], offset: 2 })).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(readMany(ws, { items: [{ path: "other.ts" }], maxResultBytes: 4000 })).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    const result = await readMany(ws, { items: [{ path: "other.ts" }], offset: 1 });
    expect(result.structuredContent.items).toEqual([]);
    expect(result.structuredContent.nextIndex).toBeNull();
  });
});
