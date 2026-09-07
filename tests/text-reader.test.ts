import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTextFile, TextReadError } from "../src/workspace/text-reader.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-text-reader-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function file(name: string): string {
  return path.join(root, name);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf16be(value: string): Buffer {
  const littleEndian = Buffer.from(value, "utf16le");
  for (let index = 0; index < littleEndian.length; index += 2) {
    const first = littleEndian[index];
    littleEndian[index] = littleEndian[index + 1];
    littleEndian[index + 1] = first;
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), littleEndian]);
}

describe("readTextFile", () => {
  it("normalizes LF, CRLF, and CR while hashing the original bytes", async () => {
    const bytes = Buffer.from("one\r\ntwo\rthree", "utf8");
    const target = file("newlines.txt");
    fs.writeFileSync(target, bytes);

    const result = await readTextFile(target);

    expect(result.content).toBe("one\ntwo\nthree");
    expect(result.sizeBytes).toBe(bytes.length);
    expect(result.totalLines).toBe(3);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.remainingLines).toBe(0);
    expect(result.nextStartLine).toBeNull();
    expect(result.sha256).toBe(sha256(bytes));
    expect(result.encoding).toBe("utf8");
  });

  it("keeps a multibyte UTF-8 character intact across read chunks", async () => {
    const bytes = Buffer.concat([Buffer.from("a".repeat(65_535)), Buffer.from("中\n尾", "utf8")]);
    const target = file("split-utf8.txt");
    fs.writeFileSync(target, bytes);

    const result = await readTextFile(target, { maxBytes: 200_000 });

    expect(result.totalLines).toBe(2);
    expect(result.content.endsWith("中\n尾")).toBe(true);
    expect(result.content.slice(65_535, 65_536)).toBe("中");
    expect(result.sha256).toBe(sha256(bytes));
  });

  it("decodes BOM-selected UTF-16 without mistaking raw NUL bytes for binary", async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("alpha\r\n中文", "utf16le")]);
    const target = file("utf16le.txt");
    fs.writeFileSync(target, bytes);

    const result = await readTextFile(target, { encoding: "auto" });

    expect(result.content).toBe("alpha\n中文");
    expect(result.encoding).toBe("utf16le");
    expect(result.sha256).toBe(sha256(bytes));
  });

  it("supports explicit UTF-16BE", async () => {
    const bytes = utf16be("左\n右");
    const target = file("utf16be.txt");
    fs.writeFileSync(target, bytes);

    const result = await readTextFile(target, { encoding: "utf16be" });

    expect(result.content).toBe("左\n右");
    expect(result.encoding).toBe("utf16be");
  });

  it("requires explicit GB18030 instead of guessing it in auto mode", async () => {
    const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0xc4, 0xe3, 0xba, 0xc3]);
    const target = file("gb18030.txt");
    fs.writeFileSync(target, bytes);

    const result = await readTextFile(target, { encoding: "gb18030" });
    expect(result.content).toBe("中文\n你好");
    expect(result.encoding).toBe("gb18030");
    await expect(readTextFile(target)).rejects.toMatchObject({ code: "INVALID_ENCODING" });
  });

  it("rejects a known BOM that conflicts with the explicit encoding", async () => {
    const target = file("conflicting-bom.txt");
    fs.writeFileSync(target, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文", "utf16le")]));
    await expect(readTextFile(target, { encoding: "utf16be" })).rejects.toMatchObject({ code: "INVALID_ENCODING" });
    await expect(readTextFile(target, { encoding: "gb18030" })).rejects.toMatchObject({ code: "INVALID_ENCODING" });
  });

  it("preserves a literal BOM character after the encoding marker", async () => {
    const target = file("literal-bom.txt");
    fs.writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("\ufeff正文")]));
    expect((await readTextFile(target)).content).toBe("\ufeff正文");
  });

  it("keeps ordinary terminal log controls as text, with NUL still rejected", async () => {
    const target = file("terminal.log");
    const log = "\u001b[31mFAIL\u001b[0m\nprogress\b\f";
    fs.writeFileSync(target, log);
    expect((await readTextFile(target)).content).toBe(log);
  });

  it("uses the default 400-line page and reports an exact continuation", async () => {
    const text = `${Array.from({ length: 405 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    const target = file("many-lines.txt");
    fs.writeFileSync(target, text, "utf8");

    const result = await readTextFile(target);

    expect(result.totalLines).toBe(405);
    expect(result.content.split("\n")).toHaveLength(400);
    expect(result.endLine).toBe(400);
    expect(result.truncated).toBe(true);
    expect(result.remainingLines).toBe(5);
    expect(result.nextStartLine).toBe(401);
  });

  it("allows an explicit range up to the hard line limit", async () => {
    const text = `${Array.from({ length: 600 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    const target = file("range.txt");
    fs.writeFileSync(target, text, "utf8");

    const result = await readTextFile(target, { startLine: 500, endLine: 502 });

    expect(result.content).toBe("line 500\nline 501\nline 502");
    expect(result.startLine).toBe(500);
    expect(result.endLine).toBe(502);
    expect(result.remainingLines).toBe(98);
    expect(result.nextStartLine).toBe(503);
  });

  it("truncates only at a complete line when the byte budget is exhausted", async () => {
    const target = file("budget.txt");
    fs.writeFileSync(target, "first\nthis line is too large\nlast", "utf8");

    const result = await readTextFile(target, { maxBytes: 5 });

    expect(result.content).toBe("first");
    expect(result.endLine).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.remainingLines).toBe(2);
    expect(result.nextStartLine).toBe(2);
  });

  it("rejects an overlong selected first line instead of returning a partial line", async () => {
    const target = file("long-line.txt");
    fs.writeFileSync(target, "123456\nrest", "utf8");

    await expect(readTextFile(target, { maxBytes: 5 })).rejects.toMatchObject({ code: "RANGE_TOO_LARGE" });
  });

  it("does not invent lines or continuation for empty and out-of-range reads", async () => {
    const empty = file("empty.txt");
    fs.writeFileSync(empty, "", "utf8");
    const emptyResult = await readTextFile(empty);
    expect(emptyResult.totalLines).toBe(0);
    expect(emptyResult.endLine).toBeNull();
    expect(emptyResult.truncated).toBe(false);
    expect(emptyResult.nextStartLine).toBeNull();

    const short = file("short.txt");
    fs.writeFileSync(short, "one\ntwo", "utf8");
    const outOfRange = await readTextFile(short, { startLine: 9 });
    expect(outOfRange.startLine).toBe(9);
    expect(outOfRange.endLine).toBeNull();
    expect(outOfRange.remainingLines).toBe(0);
    expect(outOfRange.nextStartLine).toBeNull();
  });

  it("rejects non-finite and reversed ranges", async () => {
    const target = file("arguments.txt");
    fs.writeFileSync(target, "one\n", "utf8");

    await expect(readTextFile(target, { startLine: Number.NaN })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readTextFile(target, { maxBytes: Number.POSITIVE_INFINITY })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readTextFile(target, { startLine: 4, endLine: 3 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("honors an already-aborted signal and closes the read path", async () => {
    const target = file("aborted.txt");
    fs.writeFileSync(target, "one\n", "utf8");
    const controller = new AbortController();
    controller.abort();

    await expect(readTextFile(target, { signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("rejects decoded binary controls and non-files", async () => {
    const binary = file("binary.bin");
    fs.writeFileSync(binary, Buffer.from([0x61, 0x00, 0x62]));
    await expect(readTextFile(binary)).rejects.toMatchObject({ code: "BINARY_FILE" });

    const directory = file("directory");
    fs.mkdirSync(directory);
    await expect(readTextFile(directory)).rejects.toMatchObject({ code: "NOT_A_FILE" });
  });

  it("checks the complete raw-file hash and does not expose the absolute path in errors", async () => {
    const bytes = Buffer.from("stable\n", "utf8");
    const target = file("hash.txt");
    fs.writeFileSync(target, bytes);

    const result = await readTextFile(target, { expectedSha256: sha256(bytes).toUpperCase() });
    expect(result.sha256).toBe(sha256(bytes));
    const error = await readTextFile(target, { expectedSha256: "0".repeat(64) }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TextReadError);
    expect((error as TextReadError).code).toBe("HASH_MISMATCH");
    expect((error as Error).message).not.toContain(target);
  });

  it("rejects a file whose path version changes before the final stat", async () => {
    const target = file("changing.txt");
    fs.writeFileSync(target, "before\n", "utf8");
    const originalStat = fs.promises.stat.bind(fs.promises);
    let calls = 0;
    const statSpy = vi.spyOn(fs.promises, "stat").mockImplementation(async (...args: any[]) => {
      calls += 1;
      if (calls === 2) fs.writeFileSync(target, "after\n", "utf8");
      return originalStat(...args);
    });

    try {
      await expect(readTextFile(target)).rejects.toMatchObject({ code: "FILE_CHANGED" });
    } finally {
      statSpy.mockRestore();
    }
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
