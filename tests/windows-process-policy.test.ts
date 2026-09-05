import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

describe("Windows child-process policy", () => {
  it("hides every production child process from the Windows desktop", () => {
    const offenders = sourceFiles(sourceRoot).flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      const usesChildProcess = source.includes('from "node:child_process"');
      const startsProcess = /\b(?:spawn|spawnSync)\s*\(/.test(source);
      if (!usesChildProcess || !startsProcess || source.includes("windowsHide")) return [];
      return [path.relative(projectRoot, file).split(path.sep).join("/")];
    });

    expect(offenders).toEqual([]);
  });

  it("routes daemon restarts through the stable launcher when installed", () => {
    const daemon = fs.readFileSync(path.join(sourceRoot, "process", "daemon.ts"), "utf8");
    expect(daemon).toContain('path.join(projectRoot, "bin", "c2c.js")');
    expect(daemon).toContain("stableLauncher");
  });
});
