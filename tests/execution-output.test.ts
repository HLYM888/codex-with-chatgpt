import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sanitizeExecutionOutput, MAX_OUTPUT_LINES } from "../src/execution/sanitize.js";
import { listExecutionOutputs, readExecutionOutput, saveExecutionOutput } from "../src/execution/output.js";
import { readCappedUtf8 } from "../src/execution/input.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

describe("sanitizeExecutionOutput", () => {
  it("redacts bearer tokens and pairing-code shaped strings", () => {
    const result = sanitizeExecutionOutput(
      "Authorization: Bearer c2c_at_abcdefghijklmnopqrstuv\ncode ABCD-EFGH failed"
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.text).not.toMatch(/c2c_at_/);
      expect(result.text).toContain("[REDACTED]");
      expect(result.text).not.toContain("ABCD-EFGH");
    }
  });

  it("rejects private keys entirely", () => {
    const result = sanitizeExecutionOutput("oops\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("private_key");
  });

  it("rejects PGP private key blocks", () => {
    const result = sanitizeExecutionOutput("-----BEGIN PGP PRIVATE KEY BLOCK-----\nversion\n-----END PGP PRIVATE KEY BLOCK-----");
    expect(result.allowed).toBe(false);
  });

  it("redacts home paths", () => {
    const result = sanitizeExecutionOutput("wrote /Users/alice/proj/src/a.ts");
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.text).not.toContain("/Users/alice");
      expect(result.text).toContain("/Users/[user]");
    }
  });

  it("truncates giant logs", () => {
    const raw = Array.from({ length: MAX_OUTPUT_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
    const result = sanitizeExecutionOutput(raw);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.truncated).toBe(true);
      expect(result.text.split("\n").length).toBeLessThanOrEqual(MAX_OUTPUT_LINES + 2);
    }
  });
});

describe("execution output store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("stores readable output and hides restricted bodies", () => {
    dirs.push(isolateStateDir());
    const okItem = saveExecutionOutput("ws1", {
      command: "pnpm test",
      raw: "2 failed\nAssertionError: expected 1 to be 2",
      exitCode: 1,
      taskId: "c2c_aa",
      iteration: 3,
    });
    expect(okItem.allowed).toBe(true);
    const listed = listExecutionOutputs("ws1");
    expect(listed.some((item) => item.id === okItem.id && item.allowed)).toBe(true);
    const read = readExecutionOutput("ws1", okItem.id);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.text).toContain("AssertionError");

    const blocked = saveExecutionOutput("ws1", {
      command: "cat key",
      raw: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
      exitCode: 0,
    });
    expect(blocked.allowed).toBe(false);
    const denied = readExecutionOutput("ws1", blocked.id);
    expect(denied).toEqual({ ok: false, error: "OUTPUT_RESTRICTED" });
  });

  it("redacts token-shaped text in the stored command", () => {
    dirs.push(isolateStateDir());
    const item = saveExecutionOutput("ws1", {
      command: "curl -H Bearer c2c_at_abcdefghijklmnopqrstuv",
      raw: "ok",
      exitCode: 0,
    });
    expect(item.command).not.toMatch(/c2c_at_/);
    expect(item.command).toContain("[REDACTED]");
  });

  it("marks a bounded source file instead of silently hiding the truncation", () => {
    dirs.push(isolateStateDir());
    const item = saveExecutionOutput("ws1", {
      command: "long command",
      raw: "保留的前缀",
      sourceTruncated: true,
      exitCode: 0,
    });
    expect(item.truncated).toBe(true);
    expect(item.sourceTruncated).toBe(true);
    const read = readExecutionOutput("ws1", item.id);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.text).toContain("源文件已达到读取上限");
  });
});

describe("readCappedUtf8", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanup(dir);
    delete process.env.C2C_STATE_DIR;
  });

  it("keeps a complete UTF-8 boundary when the byte cap splits a character", () => {
    const dir = makeTmpDir("output-utf8-boundary");
    dirs.push(dir);
    const file = path.join(dir, "out.log");
    fs.writeFileSync(file, "a你\n", "utf8");
    expect(readCappedUtf8(file, 3)).toEqual({ text: "a", sourceTruncated: true, encoding: "utf8" });
  });

  it("decodes Chinese command output from the Windows GB18030/CP936 stream", () => {
    const dir = makeTmpDir("output-gb18030");
    dirs.push(dir);
    const file = path.join(dir, "out.log");
    fs.writeFileSync(file, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
    const output = readCappedUtf8(file, 1024);
    expect(output.text).toBe("中文\n");
    expect(output.encoding).toBe("gb18030");
    expect(output.sourceTruncated).toBe(false);

    dirs.push(isolateStateDir());
    const item = saveExecutionOutput("ws1", {
      command: "命令",
      raw: output.text,
      sourceEncoding: output.encoding,
      exitCode: 0,
    });
    expect(item.sourceEncoding).toBe("gb18030");
  });
});
