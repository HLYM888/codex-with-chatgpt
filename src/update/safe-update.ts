import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export type UpdateDecision = "up_to_date" | "deferred_dirty" | "candidate";

export interface UpdateSnapshot {
  localCommit: string;
  remoteCommit: string;
  dirty: boolean;
}

export interface SafeUpdateResult {
  ok: boolean;
  status: "up_to_date" | "deferred_dirty" | "updated" | "conflict" | "validation_failed" | "blocked";
  localCommit?: string;
  remoteCommit?: string;
  candidateDir?: string;
  activeVersion?: string;
  skippedUntracked?: string[];
  reason?: string;
}

export interface RollbackResult {
  ok: boolean;
  status: "rolled_back" | "unavailable" | "blocked";
  activeVersion?: string;
  reason?: string;
}

type CommandResult = { status: number | null; stdout: string; stderr: string };
type Runner = (file: string, args: string[], cwd: string, timeoutMs?: number) => CommandResult;

const SENSITIVE_SEGMENTS = [
  /^\.env(?:\.|$)/i,
  /(^|[\\/])(credentials?|secrets?|tokens?|private|certs?)([\\/]|$)/i,
  /(?:service-account|id_rsa|\.pem$|\.key$)/i,
];

const UPDATE_LOCK_STALE_AFTER_MS = 30_000;

function defaultRunner(file: string, args: string[], cwd: string, timeoutMs = 120_000): CommandResult {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString(),
  };
}

function git(root: string, args: string[], run: Runner): CommandResult {
  return run("git", args, root, 120_000);
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function acquireUpdateLock(stateDir: string): (() => void) | null {
  const lockFile = path.join(path.resolve(stateDir), "update.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number };
        const lockAgeMs = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (lockAgeMs > UPDATE_LOCK_STALE_AFTER_MS && Number.isInteger(lock.pid) && lock.pid! > 0) {
          try {
            process.kill(lock.pid!, 0);
          } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code !== "EPERM") {
              fs.rmSync(lockFile, { force: true });
              return acquireUpdateLock(stateDir);
            }
          }
        } else if (lockAgeMs > UPDATE_LOCK_STALE_AFTER_MS) {
          fs.rmSync(lockFile, { force: true });
          return acquireUpdateLock(stateDir);
        }
      } catch {
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > UPDATE_LOCK_STALE_AFTER_MS) {
            fs.rmSync(lockFile, { force: true });
            return acquireUpdateLock(stateDir);
          }
        } catch {
          /* an unreadable or very recent lock remains fail-closed */
        }
      }
      return null;
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      /* best effort */
    }
    throw error;
  }
  return () => {
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      /* best effort; a crashed process leaves the lock for safe manual review */
    }
  };
}

function pathHasSymlink(root: string, relative: string): boolean {
  let current = path.resolve(root);
  for (const segment of relative.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
  }
  return false;
}

function safeRelativePath(relative: string): boolean {
  if (!relative || path.isAbsolute(relative)) return false;
  const normalized = relative.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return false;
  return !SENSITIVE_SEGMENTS.some((pattern) => pattern.test(normalized));
}

export function isSafeUntrackedPath(relative: string): boolean {
  return safeRelativePath(relative);
}

export function classifyUpdate(snapshot: UpdateSnapshot): UpdateDecision {
  if (snapshot.localCommit === snapshot.remoteCommit) return "up_to_date";
  return snapshot.dirty ? "deferred_dirty" : "candidate";
}

export function shouldKeepOldVersion(status: SafeUpdateResult["status"]): boolean {
  return status === "deferred_dirty" || status === "conflict" || status === "validation_failed" || status === "blocked";
}

function readSnapshot(repoRoot: string, run: Runner): UpdateSnapshot | null {
  const local = git(repoRoot, ["rev-parse", "HEAD"], run);
  const remote = git(repoRoot, ["ls-remote", "origin", "HEAD"], run);
  const status = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], run);
  if (local.status !== 0 || remote.status !== 0 || status.status !== 0) return null;
  const remoteCommit = remote.stdout.trim().split(/\s+/)[0] ?? "";
  if (!remoteCommit) return null;
  return { localCommit: local.stdout.trim(), remoteCommit, dirty: status.stdout.trim().length > 0 };
}

function untrackedFiles(repoRoot: string, run: Runner): string[] {
  const result = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], run);
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function copyOrdinaryUntracked(repoRoot: string, candidateDir: string, files: string[]): string[] {
  const skipped: string[] = [];
  for (const relative of files) {
    if (!safeRelativePath(relative)) {
      skipped.push(relative);
      continue;
    }
    if (pathHasSymlink(repoRoot, relative) || pathHasSymlink(candidateDir, relative)) {
      skipped.push(relative);
      continue;
    }
    const source = path.resolve(repoRoot, relative);
    const target = path.resolve(candidateDir, relative);
    const root = path.resolve(candidateDir) + path.sep;
    if (!target.startsWith(root) || !fs.existsSync(source)) {
      skipped.push(relative);
      continue;
    }
    let sourceStat: fs.Stats;
    try {
      sourceStat = fs.lstatSync(source);
    } catch {
      skipped.push(relative);
      continue;
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      skipped.push(relative);
      continue;
    }
    try {
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
        skipped.push(relative);
        continue;
      }
    } catch {
      skipped.push(relative);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return skipped;
}

function patchWorkingTree(repoRoot: string, candidateDir: string, run: Runner, commitPatch: string): "ok" | "conflict" | "none" {
  const diff = git(repoRoot, ["diff", "--binary", "HEAD"], run);
  if (diff.status !== 0) return "conflict";
  const patch = `${commitPatch}${diff.stdout}`;
  if (!patch) return "none";
  const patchFile = path.join(candidateDir, `.c2c-local-${process.pid}.patch`);
  fs.writeFileSync(patchFile, patch, { mode: 0o600 });
  try {
    const applied = git(candidateDir, ["apply", "--3way", "--index", patchFile], run);
    return applied.status === 0 ? "ok" : "conflict";
  } finally {
    try {
      fs.rmSync(patchFile, { force: true });
    } catch {
      /* preserve candidate even if audit cleanup fails */
    }
  }
}

function validationCommands(): Array<[string, string[]]> {
  const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
  return [
    [corepack, ["pnpm", "install", "--frozen-lockfile"]],
    [corepack, ["pnpm", "test"]],
    [corepack, ["pnpm", "typecheck"]],
    [corepack, ["pnpm", "build"]],
  ];
}

type SkillPlan =
  | { action: "none" | "preserve"; reason?: string }
  | { action: "update"; content: string }
  | { action: "error"; reason: string };

function normalizeSkillContent(value: string, roots: string[]): string {
  let normalized = value.replaceAll("\r\n", "\n");
  for (const root of roots) {
    if (!root) continue;
    normalized = normalized.replaceAll(root, "<ACTUAL_CHECKOUT_PATH>");
    normalized = normalized.replaceAll(root.replaceAll("\\", "/"), "<ACTUAL_CHECKOUT_PATH>");
  }
  return normalized;
}

function materializeSkillContent(value: string, repoRoot: string, roots: string[]): string {
  let materialized = value.replaceAll("<ACTUAL_CHECKOUT_PATH>", repoRoot);
  for (const root of roots) {
    if (!root) continue;
    materialized = materialized.replaceAll(root, repoRoot);
    materialized = materialized.replaceAll(root.replaceAll("\\", "/"), repoRoot);
  }
  return materialized;
}

function planSkillInstall(repoRoot: string, candidateDir: string, installedSkillPath: string, additionalRoots: string[] = []): SkillPlan {
  const candidateSkill = path.join(candidateDir, "skill", "SKILL.md");
  if (!fs.existsSync(candidateSkill)) return { action: "none" };
  try {
    const candidate = fs.readFileSync(candidateSkill, "utf8");
    const roots = [repoRoot, candidateDir, ...additionalRoots, path.resolve(repoRoot), path.resolve(candidateDir)];
    const materialized = materializeSkillContent(candidate, repoRoot, roots);
    if (!fs.existsSync(installedSkillPath)) return { action: "update", content: materialized };
    const currentSource = path.join(repoRoot, "skill", "SKILL.md");
    const installed = fs.readFileSync(installedSkillPath, "utf8");
    const source = fs.readFileSync(currentSource, "utf8");
    if (normalizeSkillContent(installed, roots) !== normalizeSkillContent(source, roots)) {
      return { action: "preserve", reason: "已安装 Skill 存在本地定制" };
    }
    return { action: "update", content: materialized };
  } catch (error) {
    return { action: "error", reason: `Skill 校验失败：${(error as Error).message}` };
  }
}

function restoreFile(file: string, existed: boolean, content: string | null): void {
  if (existed && content !== null) atomicWrite(file, content);
  else fs.rmSync(file, { force: true });
}

function isCompleteCandidateVersion(stateDir: string, versionDir: string): boolean {
  const root = path.resolve(stateDir);
  const candidateRoot = path.resolve(root, "candidates") + path.sep;
  const resolved = path.resolve(versionDir);
  if (!resolved.startsWith(candidateRoot)) return false;
  const relative = path.relative(root, resolved);
  if (!relative || pathHasSymlink(root, relative)) return false;
  const entry = path.join(resolved, "dist", "cli", "index.js");
  const entryRelative = path.relative(root, entry);
  if (!entryRelative || pathHasSymlink(root, entryRelative)) return false;
  try {
    const versionStat = fs.lstatSync(resolved);
    const entryStat = fs.lstatSync(entry);
    return versionStat.isDirectory() && entryStat.isFile() && !entryStat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function performSafeUpdate(options: {
  repoRoot: string;
  stateDir: string;
  installedSkillPath?: string;
  run?: Runner;
  now?: Date;
  validate?: boolean;
  allowDirtyCandidate?: boolean;
}): SafeUpdateResult {
  let release: (() => void) | null = null;
  try {
    release = acquireUpdateLock(options.stateDir);
  } catch (error) {
    return { ok: false, status: "blocked", reason: `无法建立更新锁：${(error as Error).message}` };
  }
  if (!release) return { ok: false, status: "blocked", reason: "已有更新正在进行，当前版本保持不变。" };
  try {
    return performSafeUpdateUnlocked(options);
  } finally {
    release();
  }
}

function performSafeUpdateUnlocked(options: {
  repoRoot: string;
  stateDir: string;
  installedSkillPath?: string;
  run?: Runner;
  now?: Date;
  validate?: boolean;
  allowDirtyCandidate?: boolean;
}): SafeUpdateResult {
  const repoRoot = path.resolve(options.repoRoot);
  const run = options.run ?? defaultRunner;
  const snapshot = readSnapshot(repoRoot, run);
  if (!snapshot) return { ok: false, status: "blocked", reason: "无法读取本地或远端 Git 状态，已保留当前版本。" };
  const decision = classifyUpdate(snapshot);
  if (decision === "up_to_date") return { ok: true, status: "up_to_date", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit };
  if (decision === "deferred_dirty" && options.allowDirtyCandidate === false) {
    return { ok: true, status: "deferred_dirty", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, reason: "检测到本地改动，未在活动目录更新。" };
  }

  const head = git(repoRoot, ["rev-parse", "HEAD"], run).stdout.trim();
  let commitPatch = "";

  const stamp = (options.now ?? new Date()).toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  const candidateDir = path.join(options.stateDir, "candidates", `${stamp}-${snapshot.remoteCommit.slice(0, 8)}`);
  fs.mkdirSync(path.dirname(candidateDir), { recursive: true });
  const remoteUrl = git(repoRoot, ["config", "--get", "remote.origin.url"], run).stdout.trim();
  if (!remoteUrl) return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, reason: "无法确认上游地址，未自动切换。" };

  const clone = run("git", ["clone", "--no-checkout", remoteUrl, candidateDir], repoRoot, 300_000);
  if (clone.status !== 0) return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, reason: "候选目录创建失败，旧版本继续运行。" };
  const checkout = git(candidateDir, ["checkout", "--detach", snapshot.remoteCommit], run);
  if (checkout.status !== 0) return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, reason: "无法固定远端提交，旧版本继续运行。" };

  // The source checkout may not have fetched the newly advertised remote
  // commit. Fetch the source HEAD into the isolated candidate only, then
  // calculate the relationship and preserve any local commits without
  // changing the user's checkout or its refs.
  if (head !== snapshot.remoteCommit) {
    const sourceHead = git(candidateDir, ["fetch", "--no-tags", repoRoot, head], run);
    if (sourceHead.status !== 0) {
      return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, reason: "无法在隔离候选中读取本地提交基线，未自动切换。" };
    }
    const mergeBase = git(candidateDir, ["merge-base", head, snapshot.remoteCommit], run);
    if (mergeBase.status !== 0) {
      return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, reason: "本地提交基线无法确认，未自动切换。" };
    }
    const base = mergeBase.stdout.trim();
    if (base === snapshot.remoteCommit) {
      const localCommits = git(candidateDir, ["diff", "--binary", `${snapshot.remoteCommit}..${head}`], run);
      if (localCommits.status !== 0) return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, reason: "无法保全本地提交差异，未自动切换。" };
      commitPatch = localCommits.stdout;
    } else if (base !== head) {
      return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, reason: "本地与上游已分叉，未自动选择任一版本。" };
    }
  }

  const patch = patchWorkingTree(repoRoot, candidateDir, run, commitPatch);
  if (patch === "conflict") {
    return { ok: false, status: "conflict", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, reason: "三方应用发生冲突，活动版本未改变。" };
  }
  const skippedUntracked = copyOrdinaryUntracked(repoRoot, candidateDir, untrackedFiles(repoRoot, run));

  if (options.validate !== false) {
    for (const [file, args] of validationCommands()) {
      const result = run(file, args, candidateDir, 600_000);
      if (result.status !== 0) {
        return { ok: false, status: "validation_failed", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, skippedUntracked, reason: `候选验证失败：${file} ${args.join(" ")}` };
      }
    }
  }

  const activeFile = path.join(options.stateDir, "active-version.json");
  const previousFile = path.join(options.stateDir, "previous-version.json");
  const hadActiveFile = fs.existsSync(activeFile);
  const oldActiveRaw = hadActiveFile ? fs.readFileSync(activeFile, "utf8") : null;
  const hadPreviousFile = fs.existsSync(previousFile);
  const oldPreviousRaw = hadPreviousFile ? fs.readFileSync(previousFile, "utf8") : null;
  let previous: unknown = null;
  if (oldActiveRaw !== null) {
    try {
      previous = JSON.parse(oldActiveRaw);
    } catch {
      return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, skippedUntracked, reason: "当前活动版本指针无法读取，未自动切换。" };
    }
  }
  const activeVersionDir =
    previous && typeof previous === "object" && "versionDir" in previous && typeof previous.versionDir === "string"
      ? previous.versionDir
      : undefined;
  const skillPlan = options.installedSkillPath
    ? planSkillInstall(repoRoot, candidateDir, options.installedSkillPath, activeVersionDir ? [activeVersionDir] : [])
    : ({ action: "none" } as const);
  if (skillPlan.action === "error") {
    return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, skippedUntracked, reason: skillPlan.reason };
  }
  try {
    atomicWrite(previousFile, JSON.stringify(previous, null, 2));
    atomicWrite(activeFile, JSON.stringify({ versionDir: candidateDir, commit: snapshot.remoteCommit, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    try {
      restoreFile(activeFile, hadActiveFile, oldActiveRaw);
      restoreFile(previousFile, hadPreviousFile, oldPreviousRaw);
    } catch {
      return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, skippedUntracked, reason: "活动版本指针切换及回退均失败，已停止自动更新。" };
    }
    return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, skippedUntracked, reason: "活动版本指针切换失败，旧版本继续运行。" };
  }
  if (skillPlan.action === "update" && options.installedSkillPath) {
    try {
      atomicWrite(options.installedSkillPath, skillPlan.content);
    } catch (error) {
      try {
        restoreFile(activeFile, hadActiveFile, oldActiveRaw);
        restoreFile(previousFile, hadPreviousFile, oldPreviousRaw);
      } catch {
        return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, skippedUntracked, reason: `Skill 更新失败且版本指针回滚失败：${(error as Error).message}` };
      }
      return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, skippedUntracked, reason: `Skill 更新失败，已保留旧版本：${(error as Error).message}` };
    }
  }
  return { ok: true, status: "updated", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, activeVersion: snapshot.remoteCommit, skippedUntracked };
}

export function rollbackActiveVersion(stateDir: string): RollbackResult {
  let release: (() => void) | null = null;
  try {
    release = acquireUpdateLock(stateDir);
  } catch (error) {
    return { ok: false, status: "blocked", reason: `无法建立更新锁：${(error as Error).message}` };
  }
  if (!release) return { ok: false, status: "blocked", reason: "已有更新正在进行，当前版本保持不变。" };
  try {
    return rollbackActiveVersionUnlocked(stateDir);
  } finally {
    release();
  }
}

function rollbackActiveVersionUnlocked(stateDir: string): RollbackResult {
  const root = path.resolve(stateDir);
  const activeFile = path.join(root, "active-version.json");
  const previousFile = path.join(root, "previous-version.json");
  if (!fs.existsSync(activeFile) || !fs.existsSync(previousFile)) {
    return { ok: false, status: "unavailable", reason: "没有可回滚的旧版本。" };
  }
  let activeRaw: string;
  let previousRaw: string;
  let active: { versionDir?: string; commit?: string } | null;
  let previous: { versionDir?: string; commit?: string } | null;
  try {
    activeRaw = fs.readFileSync(activeFile, "utf8");
    previousRaw = fs.readFileSync(previousFile, "utf8");
    active = JSON.parse(activeRaw) as { versionDir?: string; commit?: string } | null;
    previous = JSON.parse(previousRaw) as { versionDir?: string; commit?: string } | null;
  } catch {
    return { ok: false, status: "blocked", reason: "版本指针文件无法读取，未执行回滚。" };
  }
  if (!active || typeof active.versionDir !== "string" || typeof active.commit !== "string") {
    return { ok: false, status: "blocked", reason: "当前活动版本指针不完整，未执行回滚。" };
  }
  if (!previous || typeof previous.versionDir !== "string" || typeof previous.commit !== "string") {
    return { ok: false, status: "unavailable", reason: "没有可回滚的完整旧版本。" };
  }
  if (!isCompleteCandidateVersion(root, active.versionDir)) {
    return { ok: false, status: "blocked", reason: "当前活动版本目录不存在或不完整，未执行回滚。" };
  }
  if (!isCompleteCandidateVersion(root, previous.versionDir)) {
    return { ok: false, status: "blocked", reason: "旧版本目录不存在或不完整，未执行回滚。" };
  }
  try {
    atomicWrite(previousFile, activeRaw);
    atomicWrite(activeFile, previousRaw);
  } catch {
    try {
      atomicWrite(previousFile, previousRaw);
      atomicWrite(activeFile, activeRaw);
    } catch {
      return { ok: false, status: "blocked", reason: "回滚指针写入及补偿恢复均失败，已停止回滚。" };
    }
    return { ok: false, status: "blocked", reason: "回滚指针写入失败，已恢复原指针。" };
  }
  return { ok: true, status: "rolled_back", activeVersion: previous?.commit };
}

export function defaultInstalledSkillPath(): string {
  const home = os.homedir();
  return path.join(home, ".codex", "skills", "codex-with-chatgpt", "SKILL.md");
}
