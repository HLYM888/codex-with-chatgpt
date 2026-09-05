import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(projectRoot, "bin", "c2c.js");
const tempDirs: string[] = [];

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
    const version = path.join(state, "candidates", "valid");
    fs.mkdirSync(path.join(version, "dist", "cli"), { recursive: true });
    fs.writeFileSync(path.join(version, "package.json"), "{}");
    fs.writeFileSync(path.join(version, "dist", "cli", "index.js"), "console.log(process.env.C2C_ACTIVE_VERSION_COMMIT);");
    fs.mkdirSync(path.join(version, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(state, "active-version.json"), JSON.stringify({ versionDir: version, commit: "expected-new" }));
    const result = runLauncher(state);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("expected-new");
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
});
