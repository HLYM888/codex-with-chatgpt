import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyUpdate, isCompleteCandidateVersion, isSafeUntrackedPath, performSafeUpdate, rollbackActiveVersion, shouldKeepOldVersion } from "../src/update/safe-update.js";
import { cleanup } from "./helpers.js";

const tempDirs: string[] = [];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_COMMIT = "1".repeat(40);
const REMOTE_COMMIT = "2".repeat(40);
const OLD_COMMIT = "3".repeat(40);
const NEW_COMMIT = "4".repeat(40);
const LINKED_COMMIT = "5".repeat(40);
const PNPM_COMMIT = "6".repeat(40);

function makeTmpDir(name: string): string {
  const safeName = name.replaceAll(/[^A-Za-z0-9_-]/g, "_");
  return fs.mkdtempSync(path.join(os.tmpdir(), `c2c-safe-update-${safeName}-`));
}

function prepareSourceCheckout(root: string): void {
  fs.mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "cli", "index.js"), "installed");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
}

function prepareVersion(root: string, label: string, commit = label === "old" ? OLD_COMMIT : NEW_COMMIT): void {
  fs.mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "cli", "index.js"), label);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".c2c-version.json"), JSON.stringify({ schemaVersion: "1.0.0", kind: "source-snapshot", commit }));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanup(dir);
});

describe("safe update policy", () => {
  it("does not expose a public validation bypass", () => {
    const cli = fs.readFileSync(path.join(projectRoot, "src/cli/index.ts"), "utf8");
    expect(cli).not.toContain("--skip-validation");
  });

  it("classifies clean, dirty, and current versions", () => {
    expect(classifyUpdate({ localCommit: "a", remoteCommit: "a", dirty: false })).toBe("up_to_date");
    expect(classifyUpdate({ localCommit: "a", remoteCommit: "b", dirty: true })).toBe("deferred_dirty");
    expect(classifyUpdate({ localCommit: "a", remoteCommit: "b", dirty: false })).toBe("candidate");
  });

  it("keeps the old version for every unsafe terminal state", () => {
    expect(shouldKeepOldVersion("deferred_dirty")).toBe(true);
    expect(shouldKeepOldVersion("conflict")).toBe(true);
    expect(shouldKeepOldVersion("validation_failed")).toBe(true);
    expect(shouldKeepOldVersion("blocked")).toBe(true);
    expect(shouldKeepOldVersion("updated")).toBe(false);
  });

  it("never copies sensitive or escaping untracked paths", () => {
    expect(isSafeUntrackedPath("tests/new.test.ts")).toBe(true);
    expect(isSafeUntrackedPath(".env")).toBe(false);
    expect(isSafeUntrackedPath("credentials/token.json")).toBe(false);
    expect(isSafeUntrackedPath("../outside.txt")).toBe(false);
  });

  function fakeRunner(options: { applyStatus?: number; validationStatus?: number; validationStdout?: string; validationStderr?: string } = {}) {
    const calls: string[] = [];
    const candidateRoots = new Set<string>();
    const run = (file: string, args: string[], cwd: string) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "git" && args[0] === "rev-parse") {
        const resolvedCwd = path.resolve(cwd);
        const isCandidate = [...candidateRoots].some(
          (candidateRoot) => resolvedCwd === candidateRoot || resolvedCwd.startsWith(`${candidateRoot}${path.sep}`),
        );
        return { status: 0, stdout: `${isCandidate ? REMOTE_COMMIT : LOCAL_COMMIT}\n`, stderr: "" };
      }
      if (file === "git" && args[0] === "ls-remote") return { status: 0, stdout: `${REMOTE_COMMIT}\tHEAD\n`, stderr: "" };
      if (file === "git" && args[0] === "status") return { status: 0, stdout: " M src/index.ts\n?? .env\n", stderr: "" };
      if (file === "git" && args[0] === "merge-base") return { status: 0, stdout: `${LOCAL_COMMIT}\n`, stderr: "" };
      if (file === "git" && args[0] === "config") return { status: 0, stdout: "https://example.invalid/c2c.git\n", stderr: "" };
      if (file === "git" && args[0] === "clone") {
        const candidate = args.at(-1)!;
        candidateRoots.add(path.resolve(candidate));
        fs.mkdirSync(path.join(candidate, "dist", "cli"), { recursive: true });
        fs.writeFileSync(path.join(candidate, "dist", "cli", "index.js"), "candidate");
        fs.writeFileSync(path.join(candidate, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
        fs.mkdirSync(path.join(candidate, "node_modules"), { recursive: true });
        fs.writeFileSync(path.join(candidate, ".c2c-version.json"), JSON.stringify({ schemaVersion: "1.0.0", kind: "source-snapshot", commit: REMOTE_COMMIT }));
        return { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args[0] === "checkout") return { status: 0, stdout: "", stderr: "" };
      if (file === "git" && args[0] === "diff") {
        return args[2] === "HEAD" ? { status: 0, stdout: "diff --git a/src/index.ts b/src/index.ts\n", stderr: "" } : { status: 0, stdout: "", stderr: "" };
      }
      if (file === "git" && args[0] === "apply") return { status: options.applyStatus ?? 0, stdout: "", stderr: "" };
      if (file === "corepack.cmd" || file === "corepack") return {
        status: options.validationStatus ?? 0,
        stdout: options.validationStdout ?? "",
        stderr: options.validationStderr ?? "",
      };
      return { status: 0, stdout: "", stderr: "" };
    };
    return { run, calls };
  }

  it("keeps a source fixture distinct when its path contains a candidates segment", () => {
    const outer = makeTmpDir("safe-update-candidates-parent");
    const root = path.join(outer, "candidates", "source");
    const state = makeTmpDir("safe-update-candidates-parent-state");
    tempDirs.push(outer, state);
    fs.mkdirSync(root, { recursive: true });
    prepareSourceCheckout(root);
    const result = performSafeUpdate({ repoRoot: root, stateDir: state, run: fakeRunner().run, validate: false, allowDirtyCandidate: true });
    expect(result).toMatchObject({ ok: true, status: "updated", remoteCommit: REMOTE_COMMIT });
  });

  it("keeps the active version when the three-way patch conflicts", () => {
    const root = makeTmpDir("safe-update-conflict");
    const state = makeTmpDir("safe-update-conflict-state");
    tempDirs.push(root, state);
    const fake = fakeRunner({ applyStatus: 1 });
    const result = performSafeUpdate({ repoRoot: root, stateDir: state, run: fake.run, validate: false, allowDirtyCandidate: true, now: new Date("2026-09-03T05:00:00Z") });
    expect(result.status).toBe("conflict");
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(state, "active-version.json"))).toBe(false);
  });

  it("does not run a second update while the state lock is held", () => {
    const root = makeTmpDir("safe-update-locked");
    const state = makeTmpDir("safe-update-locked-state");
    tempDirs.push(root, state);
    fs.writeFileSync(path.join(state, "update.lock"), JSON.stringify({ pid: 1 }), { mode: 0o600 });
    const result = performSafeUpdate({ repoRoot: root, stateDir: state, run: fakeRunner().run, validate: false, allowDirtyCandidate: true });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("已有更新正在进行");
  });

  it("reclaims an old lock only when its recorded process is gone", () => {
    const root = makeTmpDir("safe-update-stale-lock");
    const state = makeTmpDir("safe-update-stale-lock-state");
    tempDirs.push(root, state);
    prepareSourceCheckout(root);
    const lock = path.join(state, "update.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999 }), { mode: 0o600 });
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    const result = performSafeUpdate({ repoRoot: root, stateDir: state, run: fakeRunner().run, validate: false, allowDirtyCandidate: true });
    expect(result.status).toBe("updated");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("reclaims an old malformed lock instead of blocking future updates forever", () => {
    const root = makeTmpDir("safe-update-malformed-lock");
    const state = makeTmpDir("safe-update-malformed-lock-state");
    tempDirs.push(root, state);
    prepareSourceCheckout(root);
    const lock = path.join(state, "update.lock");
    fs.writeFileSync(lock, "", { mode: 0o600 });
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    const result = performSafeUpdate({ repoRoot: root, stateDir: state, run: fakeRunner().run, validate: false, allowDirtyCandidate: true });
    expect(result.status).toBe("updated");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("atomically records a tested candidate without touching the source tree", () => {
    const root = makeTmpDir("safe-update-success");
    const state = makeTmpDir("safe-update-success-state");
    tempDirs.push(root, state);
    prepareSourceCheckout(root);
    const fake = fakeRunner();
    const result = performSafeUpdate({ repoRoot: root, stateDir: state, run: fake.run, validate: false, allowDirtyCandidate: true, now: new Date("2026-09-03T05:00:00Z") });
    expect(result.status).toBe("updated");
    expect(result.ok).toBe(true);
    const pointer = JSON.parse(fs.readFileSync(path.join(state, "active-version.json"), "utf8")) as { versionDir: string; commit: string };
    expect(pointer.commit).toBe(REMOTE_COMMIT);
    expect(pointer.versionDir).toContain("candidates");
    const previous = JSON.parse(fs.readFileSync(path.join(state, "previous-version.json"), "utf8")) as { versionDir?: string; commit?: string };
    expect(previous.commit).toBe(LOCAL_COMMIT);
    expect(previous.versionDir).toContain("source-");
    expect(fake.calls.some((call) => call.includes("git pull") || call.includes("git stash") || call.includes("git reset"))).toBe(false);
  });

  it("retains validation stdout and stderr in a failed validation reason", () => {
    const root = makeTmpDir("safe-update-validation-diagnostics");
    const state = makeTmpDir("safe-update-validation-diagnostics-state");
    tempDirs.push(root, state);
    prepareSourceCheckout(root);
    const result = performSafeUpdate({
      repoRoot: root,
      stateDir: state,
      run: fakeRunner({
        validationStatus: 1,
        validationStdout: "progress: resolved 1",
        validationStderr: "ERR_PNPM_LOCKFILE_MISSING",
      }).run,
      validate: true,
      allowDirtyCandidate: true,
    });
    expect(result.status).toBe("validation_failed");
    expect(result.reason).toContain("stderr: ERR_PNPM_LOCKFILE_MISSING");
    expect(result.reason).toContain("stdout: progress: resolved 1");
  });

  it("redacts tokens and home paths in validation diagnostics", () => {
    const root = makeTmpDir("safe-update-validation-redaction");
    const state = makeTmpDir("safe-update-validation-redaction-state");
    tempDirs.push(root, state);
    prepareSourceCheckout(root);
    const token = "sk-proj-AuditSyntheticToken1234567890";
    const homePath = "C:\\Users\\audit-user\\private\\note.txt";
    const result = performSafeUpdate({
      repoRoot: root,
      stateDir: state,
      run: fakeRunner({
        validationStatus: 1,
        validationStdout: `progress: ${token}`,
        validationStderr: `api_key=${token}; path=${homePath}`,
      }).run,
      validate: true,
      allowDirtyCandidate: true,
    });
    expect(result.status).toBe("validation_failed");
    expect(result.reason).toContain("progress: [REDACTED]");
    expect(result.reason).toContain("api_key=[REDACTED]");
    expect(result.reason).toContain("C:\\Users\\[user]");
    expect(result.reason).not.toContain(token);
    expect(result.reason).not.toContain(homePath);
  });

  it("restricts private keys in validation diagnostics", () => {
    const root = makeTmpDir("safe-update-validation-private-key");
    const state = makeTmpDir("safe-update-validation-private-key-state");
    tempDirs.push(root, state);
    prepareSourceCheckout(root);
    const privateKey = "-----BEGIN PRIVATE KEY-----\nAUDIT_SYNTHETIC\n-----END PRIVATE KEY-----";
    const result = performSafeUpdate({
      repoRoot: root,
      stateDir: state,
      run: fakeRunner({ validationStatus: 1, validationStderr: privateKey }).run,
      validate: true,
      allowDirtyCandidate: true,
    });
    expect(result.status).toBe("validation_failed");
    expect(result.reason).toContain("[RESTRICTED: private_key]");
    expect(result.reason).not.toContain(privateKey);
  });

  it("caps validation diagnostics on a UTF-8 byte boundary", () => {
    const root = makeTmpDir("safe-update-validation-utf8");
    const state = makeTmpDir("safe-update-validation-utf8-state");
    tempDirs.push(root, state);
    prepareSourceCheckout(root);
    const result = performSafeUpdate({
      repoRoot: root,
      stateDir: state,
      run: fakeRunner({ validationStatus: 1, validationStdout: "界".repeat(3_000) }).run,
      validate: true,
      allowDirtyCandidate: true,
    });
    expect(result.status).toBe("validation_failed");
    expect(Buffer.byteLength(result.reason ?? "", "utf8")).toBeLessThanOrEqual(4_000);
    expect(result.reason).toContain("…[输出已截断]");
    expect(result.reason).not.toContain("�");
  });

  it.skipIf(process.platform !== "win32")("runs Windows Corepack validation through its Node CLI entry", () => {
    const candidate = makeTmpDir("safe-update-windows-corepack-candidate");
    const installed = makeTmpDir("safe-update-windows-corepack-installed");
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-safe-update-windows-corepack-state-"));
    tempDirs.push(candidate, installed, state);

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "c2c-test",
      GIT_AUTHOR_EMAIL: "test@c2c.local",
      GIT_COMMITTER_NAME: "c2c-test",
      GIT_COMMITTER_EMAIL: "test@c2c.local",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const commitFixture = (root: string, label: string): string => {
      fs.mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
      fs.writeFileSync(path.join(root, "dist", "cli", "index.js"), label);
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
        name: "c2c-windows-validation-fixture",
        version: "0.0.0",
        packageManager: "pnpm@11.24.0",
        scripts: {
          test: "node -e \"process.exit(0)\"",
          typecheck: "node -e \"process.exit(0)\"",
          build: "node -e \"process.exit(0)\"",
        },
      }));
      fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), [
        "lockfileVersion: '9.0'",
        "",
        "settings:",
        "  autoInstallPeers: true",
        "  excludeLinksFromLockfile: false",
        "",
        "importers:",
        "  .: {}",
        "",
      ].join("\n"));
      fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
      for (const args of [["init", "-b", "main"], ["add", "dist", "package.json", "pnpm-lock.yaml"], ["commit", "-m", "fixture"]]) {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv, windowsHide: true });
        if (result.status !== 0) throw new Error(result.stderr.toString());
      }
      const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env: gitEnv, windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };

    const candidateCommit = commitFixture(candidate, "candidate");
    commitFixture(installed, "installed");
    const result = performSafeUpdate({
      repoRoot: candidate,
      stateDir: state,
      candidateSourceDir: candidate,
      candidateCommit,
      installedSourceDir: installed,
      validate: true,
      now: new Date("2026-09-05T06:00:00Z"),
    });
    expect(result.ok, result.reason).toBe(true);
    expect(result.status).toBe("updated");
  });

  it("stages an explicit local candidate through the existing updater path", () => {
    const root = makeTmpDir("safe-update-local-candidate");
    const installed = makeTmpDir("safe-update-local-installed");
    const state = makeTmpDir("safe-update-local-candidate-state");
    const installedSkill = path.join(makeTmpDir("safe-update-local-installed-skill"), "SKILL.md");
    tempDirs.push(root, installed, state, path.dirname(installedSkill));
    fs.mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "cli", "index.js"), "candidate-entry");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "skill", "SKILL.md"), "Checkout: <ACTUAL_CHECKOUT_PATH>\nCandidate template\n");
    prepareSourceCheckout(installed);
    fs.writeFileSync(path.join(installed, "dist", "cli", "index.js"), "old-production-entry");
    fs.writeFileSync(path.join(installed, "local-production-customization.txt"), "keep-local-customization\n");
    fs.mkdirSync(path.join(installed, "skill"), { recursive: true });
    fs.writeFileSync(path.join(installed, "skill", "SKILL.md"), "Checkout: <ACTUAL_CHECKOUT_PATH>\nOld template\n");
    fs.writeFileSync(installedSkill, `Checkout: ${installed}\nOld template\n`);
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "c2c-test",
          GIT_AUTHOR_EMAIL: "test@c2c.local",
          GIT_COMMITTER_NAME: "c2c-test",
          GIT_COMMITTER_EMAIL: "test@c2c.local",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      return result.stdout.toString().trim();
    };
    git(root, "init", "-b", "main");
    git(root, "add", "dist", "package.json", "skill");
    git(root, "commit", "-m", "candidate");
    const candidateCommit = git(root, "rev-parse", "HEAD");
    const missingInstalledSource = performSafeUpdate({
      repoRoot: root,
      stateDir: state,
      candidateSourceDir: root,
      candidateCommit,
      validate: false,
    });
    expect(missingInstalledSource).toMatchObject({ ok: false, status: "blocked" });
    expect(missingInstalledSource.reason).toContain("--installed-source");
    git(installed, "init", "-b", "main");
    git(installed, "add", "dist", "package.json");
    git(installed, "commit", "-m", "installed");
    const installedCommit = git(installed, "rev-parse", "HEAD");
    const result = performSafeUpdate({
      repoRoot: root,
      stateDir: state,
      candidateSourceDir: root,
      candidateCommit,
      installedSourceDir: installed,
      installedSkillPath: installedSkill,
      validate: false,
      now: new Date("2026-09-03T05:00:00Z"),
    });
    expect(result.ok, result.reason).toBe(true);
    expect(result).toMatchObject({ ok: true, status: "updated", remoteCommit: candidateCommit });
    expect(result.candidateDir).toContain(`local-${candidateCommit.slice(0, 8)}`);
    expect(git(result.candidateDir!, "rev-parse", "HEAD")).toBe(candidateCommit);
    expect(fs.readFileSync(installedSkill, "utf8").replaceAll("\r\n", "\n")).toBe(`Checkout: ${root}\nCandidate template\n`);
    const previous = JSON.parse(fs.readFileSync(path.join(state, "previous-version.json"), "utf8")) as { versionDir: string; commit: string };
    expect(previous.commit).toBe(installedCommit);
    expect(fs.readFileSync(path.join(previous.versionDir, "dist", "cli", "index.js"), "utf8")).toBe("old-production-entry");
    expect(fs.readFileSync(path.join(previous.versionDir, "local-production-customization.txt"), "utf8")).toBe("keep-local-customization\n");
    const rolledBack = rollbackActiveVersion(state, installedSkill);
    expect(rolledBack).toMatchObject({ ok: true, status: "rolled_back", activeVersion: installedCommit });
    expect(fs.readFileSync(path.join(JSON.parse(fs.readFileSync(path.join(state, "active-version.json"), "utf8")).versionDir, "dist", "cli", "index.js"), "utf8")).toBe("old-production-entry");
    expect(fs.readFileSync(installedSkill, "utf8").replaceAll("\r\n", "\n")).toBe(`Checkout: ${installed}\nOld template\n`);
  });

  it("blocks a first update when the installed checkout cannot be staged for rollback", () => {
    const root = makeTmpDir("safe-update-no-rollback-source");
    const state = makeTmpDir("safe-update-no-rollback-state");
    tempDirs.push(root, state);
    const result = performSafeUpdate({ repoRoot: root, stateDir: state, run: fakeRunner().run, validate: false, allowDirtyCandidate: true });
    expect(result).toMatchObject({ ok: false, status: "blocked" });
    expect(result.reason).toContain("旧版本候选");
    expect(fs.existsSync(path.join(state, "active-version.json"))).toBe(false);
    expect(fs.existsSync(path.join(state, "previous-version.json"))).toBe(false);
  });

  it("keeps the installed Skill path stable across candidate-to-candidate updates", () => {
    const root = makeTmpDir("safe-update-skill-continuity");
    const state = makeTmpDir("safe-update-skill-continuity-state");
    const installedRoot = makeTmpDir("safe-update-skill-continuity-installed");
    tempDirs.push(root, state, installedRoot);
    prepareSourceCheckout(root);
    const installedSkill = path.join(installedRoot, "SKILL.md");
    const sourceSkill = "Checkout: <ACTUAL_CHECKOUT_PATH>\n";
    fs.mkdirSync(path.join(root, "skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "skill", "SKILL.md"), sourceSkill);
    const oldVersion = path.join(state, "candidates", "old");
    prepareVersion(oldVersion, "old");
    fs.writeFileSync(path.join(state, "active-version.json"), JSON.stringify({ versionDir: oldVersion, commit: OLD_COMMIT }));
    fs.writeFileSync(installedSkill, `Checkout: ${oldVersion}\n`);
    const fake = fakeRunner();
    const run = (file: string, args: string[], cwd: string) => {
      const result = fake.run(file, args, cwd);
      if (file === "git" && args[0] === "clone") {
        const candidate = args.at(-1)!;
        fs.mkdirSync(path.join(candidate, "skill"), { recursive: true });
        fs.writeFileSync(path.join(candidate, "skill", "SKILL.md"), sourceSkill);
      }
      return result;
    };
    const result = performSafeUpdate({ repoRoot: root, stateDir: state, installedSkillPath: installedSkill, run, validate: false, allowDirtyCandidate: true, now: new Date("2026-09-03T05:00:00Z") });
    expect(result.status).toBe("updated");
    expect(fs.readFileSync(installedSkill, "utf8")).toBe(`Checkout: ${root}\n`);
  });

  it("restores the Skill bound to the previous version during rollback", () => {
    const root = makeTmpDir("safe-update-skill-rollback");
    const state = makeTmpDir("safe-update-skill-rollback-state");
    const installedRoot = makeTmpDir("safe-update-skill-rollback-installed");
    tempDirs.push(root, state, installedRoot);
    prepareSourceCheckout(root);
    const installedSkill = path.join(installedRoot, "SKILL.md");
    fs.mkdirSync(path.join(root, "skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "skill", "SKILL.md"), "old-skill\n");
    const oldVersion = path.join(state, "candidates", "old");
    prepareVersion(oldVersion, "old");
    fs.writeFileSync(path.join(state, "active-version.json"), JSON.stringify({ versionDir: oldVersion, commit: OLD_COMMIT }));
    fs.writeFileSync(installedSkill, "old-skill\n");
    const fake = fakeRunner();
    const run = (file: string, args: string[], cwd: string) => {
      const result = fake.run(file, args, cwd);
      if (file === "git" && args[0] === "clone") {
        const candidate = args.at(-1)!;
        fs.mkdirSync(path.join(candidate, "skill"), { recursive: true });
        fs.writeFileSync(path.join(candidate, "skill", "SKILL.md"), "new-skill\n");
      }
      return result;
    };
    const updated = performSafeUpdate({ repoRoot: root, stateDir: state, installedSkillPath: installedSkill, run, validate: false, allowDirtyCandidate: true });
    expect(updated.status).toBe("updated");
    expect(fs.readFileSync(installedSkill, "utf8")).toBe("new-skill\n");
    const rolledBack = rollbackActiveVersion(state, installedSkill);
    expect(rolledBack).toMatchObject({ ok: true, status: "rolled_back", activeVersion: OLD_COMMIT });
    expect(fs.readFileSync(installedSkill, "utf8")).toBe("old-skill\n");
  });

  it("makes the first update rollback-safe for both source and Skill", () => {
    const root = makeTmpDir("safe-update-first-rollback");
    const state = makeTmpDir("safe-update-first-rollback-state");
    const installedRoot = makeTmpDir("safe-update-first-rollback-installed");
    tempDirs.push(root, state, installedRoot);
    prepareSourceCheckout(root);
    const installedSkill = path.join(installedRoot, "SKILL.md");
    fs.mkdirSync(path.join(root, "skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "skill", "SKILL.md"), "old-first-skill\n");
    fs.writeFileSync(installedSkill, "old-first-skill\n");
    const fake = fakeRunner();
    const run = (file: string, args: string[], cwd: string) => {
      const result = fake.run(file, args, cwd);
      if (file === "git" && args[0] === "clone") {
        const candidate = args.at(-1)!;
        fs.mkdirSync(path.join(candidate, "skill"), { recursive: true });
        fs.writeFileSync(path.join(candidate, "skill", "SKILL.md"), "new-first-skill\n");
      }
      return result;
    };
    const updated = performSafeUpdate({
      repoRoot: root,
      stateDir: state,
      installedSkillPath: installedSkill,
      run,
      validate: false,
      allowDirtyCandidate: true,
      now: new Date("2026-09-03T05:00:00Z"),
    });
    expect(updated).toMatchObject({ ok: true, status: "updated" });
    expect(fs.readFileSync(installedSkill, "utf8")).toBe("new-first-skill\n");
    const previous = JSON.parse(fs.readFileSync(path.join(state, "previous-version.json"), "utf8")) as {
      versionDir: string;
      skillBackup?: string | null;
    };
    expect(previous.versionDir).toContain("source-");
    expect(previous.skillBackup).toMatch(/^skill-backups\//);
    const rolledBack = rollbackActiveVersion(state, installedSkill);
    expect(rolledBack).toMatchObject({ ok: true, status: "rolled_back", activeVersion: LOCAL_COMMIT });
    expect(fs.readFileSync(installedSkill, "utf8")).toBe("old-first-skill\n");
  });

  it("preserves tracked local edits when the isolated remote advances", () => {
    const remote = makeTmpDir("safe-update-real-remote");
    const upstream = makeTmpDir("safe-update-real-upstream");
    const root = makeTmpDir("safe-update-real-local");
    const state = makeTmpDir("safe-update-real-state");
    tempDirs.push(remote, upstream, root, state);
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "c2c-test",
          GIT_AUTHOR_EMAIL: "test@c2c.local",
          GIT_COMMITTER_NAME: "c2c-test",
          GIT_COMMITTER_EMAIL: "test@c2c.local",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      return result.stdout.toString();
    };
    git(remote, "init", "--bare", "--initial-branch=main");
    git(upstream, "init", "-b", "main");
    fs.writeFileSync(path.join(upstream, "base.txt"), "base\n");
    git(upstream, "add", "base.txt");
    git(upstream, "commit", "-m", "initial");
    git(upstream, "remote", "add", "origin", remote);
    git(upstream, "push", "-u", "origin", "main");
    git(root, "clone", remote, ".");
    prepareSourceCheckout(root);
    fs.writeFileSync(path.join(upstream, "remote.txt"), "from upstream\n");
    git(upstream, "add", "remote.txt");
    git(upstream, "commit", "-m", "upstream advance");
    const remoteCommit = git(upstream, "rev-parse", "HEAD").trim();
    git(upstream, "push", "origin", "main");
    fs.writeFileSync(path.join(root, "base.txt"), "base with local repair\n");
    const result = performSafeUpdate({ repoRoot: root, stateDir: state, validate: false, now: new Date("2026-09-03T05:00:00Z") });
    expect(result).toMatchObject({ ok: true, status: "updated", remoteCommit });
    expect(fs.readFileSync(path.join(root, "base.txt"), "utf8")).toBe("base with local repair\n");
    expect(fs.readFileSync(path.join(result.candidateDir!, "base.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("base with local repair\n");
    expect(fs.readFileSync(path.join(result.candidateDir!, "remote.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("from upstream\n");
    expect(JSON.parse(fs.readFileSync(path.join(state, "active-version.json"), "utf8")).commit).toBe(remoteCommit);
  });

  it("swaps only complete candidate pointers when rolling back", () => {
    const state = makeTmpDir("safe-update-rollback-state");
    tempDirs.push(state);
    const oldVersion = path.join(state, "candidates", "old");
    const newVersion = path.join(state, "candidates", "new");
    prepareVersion(oldVersion, "old");
    prepareVersion(newVersion, "new");
    fs.writeFileSync(path.join(state, "active-version.json"), JSON.stringify({ versionDir: newVersion, commit: NEW_COMMIT }));
    fs.writeFileSync(path.join(state, "previous-version.json"), JSON.stringify({ versionDir: oldVersion, commit: OLD_COMMIT }));
    const result = rollbackActiveVersion(state, path.join(state, "no-installed-skill.md"));
    expect(result).toMatchObject({ ok: true, status: "rolled_back", activeVersion: OLD_COMMIT });
    expect(JSON.parse(fs.readFileSync(path.join(state, "active-version.json"), "utf8")).commit).toBe(OLD_COMMIT);
    expect(JSON.parse(fs.readFileSync(path.join(state, "previous-version.json"), "utf8")).commit).toBe(NEW_COMMIT);
  });

  it("rejects rollback through a deep candidate symlink", () => {
    const state = makeTmpDir("safe-update-rollback-symlink-state");
    const external = makeTmpDir("safe-update-rollback-symlink-external");
    tempDirs.push(state, external);
    const oldVersion = path.join(state, "candidates", "old");
    const linkedVersion = path.join(state, "candidates", "linked");
    prepareVersion(oldVersion, "old");
    prepareVersion(external, "linked", LINKED_COMMIT);
    fs.mkdirSync(linkedVersion, { recursive: true });
    try {
      fs.symlinkSync(path.join(external, "dist"), path.join(linkedVersion, "dist"), "junction");
    } catch {
      return;
    }
    fs.writeFileSync(path.join(state, "active-version.json"), JSON.stringify({ versionDir: linkedVersion, commit: LINKED_COMMIT }));
    fs.writeFileSync(path.join(state, "previous-version.json"), JSON.stringify({ versionDir: oldVersion, commit: OLD_COMMIT }));
    const result = rollbackActiveVersion(state);
    expect(result.status).toBe("blocked");
    expect(JSON.parse(fs.readFileSync(path.join(state, "active-version.json"), "utf8")).commit).toBe(LINKED_COMMIT);
  });

  it("recognizes a complete pnpm-style dependency tree through package junctions", () => {
    const state = makeTmpDir("safe-update-pnpm-tree-state");
    tempDirs.push(state);
    const version = path.join(state, "candidates", "pnpm-tree");
    const packageStore = path.join(version, "node_modules", ".pnpm", "root-dep@1", "node_modules");
    const packageDir = path.join(packageStore, "root-dep");
    fs.mkdirSync(path.join(version, "dist", "cli"), { recursive: true });
    fs.writeFileSync(path.join(version, "dist", "cli", "index.js"), "candidate");
    fs.writeFileSync(path.join(version, "package.json"), JSON.stringify({ dependencies: { "root-dep": "1.0.0" } }));
    fs.writeFileSync(path.join(version, ".c2c-version.json"), JSON.stringify({ schemaVersion: "1.0.0", kind: "source-snapshot", commit: PNPM_COMMIT }));
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "root-dep", dependencies: { "nested-dep": "1.0.0" } }));
    fs.mkdirSync(path.join(packageStore, "nested-dep"), { recursive: true });
    fs.writeFileSync(path.join(packageStore, "nested-dep", "package.json"), JSON.stringify({ name: "nested-dep", version: "1.0.0" }));
    try {
      fs.symlinkSync(packageDir, path.join(version, "node_modules", "root-dep"), "junction");
    } catch {
      return;
    }
    expect(isCompleteCandidateVersion(state, version, PNPM_COMMIT)).toBe(true);
  });

  it("materializes pnpm directory links inside the rollback snapshot", () => {
    const candidate = makeTmpDir("safe-update-pnpm-candidate");
    const installed = makeTmpDir("safe-update-pnpm-installed");
    const state = makeTmpDir("safe-update-pnpm-state");
    tempDirs.push(candidate, installed, state);
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "c2c-test",
      GIT_AUTHOR_EMAIL: "test@c2c.local",
      GIT_COMMITTER_NAME: "c2c-test",
      GIT_COMMITTER_EMAIL: "test@c2c.local",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const commitFixture = (root: string, packageJson: Record<string, unknown>): string => {
      fs.mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
      fs.writeFileSync(path.join(root, "dist", "cli", "index.js"), "fixture");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
      fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
      for (const args of [["init", "-b", "main"], ["add", "dist", "package.json"], ["commit", "-m", "fixture"]]) {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv, windowsHide: true });
        if (result.status !== 0) throw new Error(result.stderr.toString());
      }
      const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env: gitEnv, windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };

    const candidateCommit = commitFixture(candidate, { name: "candidate", version: "0.0.0" });
    const installedCommit = commitFixture(installed, {
      name: "installed",
      version: "0.0.0",
      dependencies: { "root-dep": "1.0.0" },
    });
    const packageDirectory = path.join(installed, "node_modules", ".pnpm", "root-dep@1", "node_modules", "root-dep");
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ name: "root-dep", version: "1.0.0" }));
    try {
      fs.symlinkSync(
        packageDirectory,
        path.join(installed, "node_modules", "root-dep"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return;
    }

    const result = performSafeUpdate({
      repoRoot: candidate,
      stateDir: state,
      candidateSourceDir: candidate,
      candidateCommit,
      installedSourceDir: installed,
      validate: false,
      now: new Date("2026-09-05T06:00:00Z"),
    });
    expect(result).toMatchObject({ ok: true, status: "updated", localCommit: installedCommit, remoteCommit: candidateCommit });
    const previous = JSON.parse(fs.readFileSync(path.join(state, "previous-version.json"), "utf8")) as { versionDir: string; commit: string };
    expect(previous.commit).toBe(installedCommit);
    expect(isCompleteCandidateVersion(state, previous.versionDir, installedCommit)).toBe(true);
    const rollbackLink = path.join(previous.versionDir, "node_modules", "root-dep");
    expect(fs.lstatSync(rollbackLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(rollbackLink)).not.toBe(packageDirectory);
    expect(fs.realpathSync(rollbackLink).toLowerCase()).toContain(path.resolve(previous.versionDir).toLowerCase());
  });
});
