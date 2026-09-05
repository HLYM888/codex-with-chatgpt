import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(projectRoot, "bin", "c2c.js");
const tempDirs: string[] = [];

function makeTmpDir(name: string): string {
  const safeName = name.replaceAll(/[^A-Za-z0-9_-]/g, "_");
  return fs.mkdtempSync(path.join(os.tmpdir(), `c2c-launcher-${safeName}-`));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanup(dir);
});

function runLauncher(stateDir: string) {
  return spawnSync(process.execPath, [launcher, "--version"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, C2C_STATE_DIR: stateDir },
  });
}

function commitFixture(root: string): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "c2c-test",
    GIT_AUTHOR_EMAIL: "test@c2c.local",
    GIT_COMMITTER_NAME: "c2c-test",
    GIT_COMMITTER_EMAIL: "test@c2c.local",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  for (const args of [["init", "-b", "main"], ["add", "."], ["commit", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env, windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function prepareCandidate(state: string, name: string, packageJson: object = {}): { version: string; commit: string } {
  const version = path.join(state, "candidates", name);
  fs.mkdirSync(path.join(version, "dist", "cli"), { recursive: true });
  fs.writeFileSync(path.join(version, "package.json"), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(version, "dist", "cli", "index.js"), "console.log(process.env.C2C_ACTIVE_VERSION_COMMIT);");
  fs.mkdirSync(path.join(version, "node_modules"), { recursive: true });
  return { version, commit: commitFixture(version) };
}

describe("stable launcher active-version gate", () => {
  it("fails closed instead of falling back when the active candidate is missing", () => {
    const state = makeTmpDir("launcher-invalid-active");
    tempDirs.push(state);
    fs.writeFileSync(
      path.join(state, "active-version.json"),
      JSON.stringify({ versionDir: path.join(state, "candidates", "missing"), commit: "expected-new" })
    );
    const result = runLauncher(state);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("活动版本无法安全加载");
  });

  it("loads a regular candidate and passes its exact commit to the runtime", () => {
    const state = makeTmpDir("launcher-valid-active");
    tempDirs.push(state);
    const candidate = prepareCandidate(state, "valid");
    fs.writeFileSync(path.join(state, "active-version.json"), JSON.stringify({ versionDir: candidate.version, commit: candidate.commit }));
    const result = runLauncher(state);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(candidate.commit);
  });

  it("rejects a complete-looking candidate outside the state candidates root", () => {
    const state = makeTmpDir("launcher-outside-active");
    const outside = makeTmpDir("launcher-outside-candidate");
    tempDirs.push(state, outside);
    fs.mkdirSync(path.join(outside, "dist", "cli"), { recursive: true });
    fs.writeFileSync(path.join(outside, "package.json"), "{}");
    fs.writeFileSync(path.join(outside, "dist", "cli", "index.js"), "console.log('unsafe');");
    fs.mkdirSync(path.join(outside, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(state, "active-version.json"), JSON.stringify({ versionDir: outside, commit: "expected-new" }));
    const result = runLauncher(state);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("活动版本无法安全加载");
  });

  it("rejects an active pointer whose commit does not match the candidate Git HEAD", () => {
    const state = makeTmpDir("launcher-head-mismatch");
    tempDirs.push(state);
    const candidate = prepareCandidate(state, "mismatch");
    fs.writeFileSync(path.join(state, "active-version.json"), JSON.stringify({ versionDir: candidate.version, commit: "0".repeat(40) }));
    const result = runLauncher(state);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("活动版本无法安全加载");
  });

  it("rejects an active candidate with a declared dependency that is not installed", () => {
    const state = makeTmpDir("launcher-missing-dependency");
    tempDirs.push(state);
    const candidate = prepareCandidate(state, "missing-dependency", { dependencies: { express: "5.0.0" } });
    fs.rmSync(path.join(candidate.version, "node_modules"), { recursive: true, force: true });
    fs.writeFileSync(path.join(state, "active-version.json"), JSON.stringify({ versionDir: candidate.version, commit: candidate.commit }));
    const result = runLauncher(state);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("活动版本无法安全加载");
  });

  it("rejects a candidate whose .git is a Windows junction to an external checkout", () => {
    const state = makeTmpDir("launcher-git-junction");
    tempDirs.push(state);
    const external = prepareCandidate(state, "external-git");
    const candidate = prepareCandidate(state, "junction-git");
    fs.rmSync(path.join(candidate.version, ".git"), { recursive: true, force: true });
    try {
      fs.symlinkSync(path.join(external.version, ".git"), path.join(candidate.version, ".git"), "junction");
    } catch {
      return;
    }
    fs.writeFileSync(path.join(state, "active-version.json"), JSON.stringify({ versionDir: candidate.version, commit: external.commit }));
    const result = runLauncher(state);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("活动版本无法安全加载");
  });
});
