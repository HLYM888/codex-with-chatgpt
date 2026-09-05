import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { sanitizeExecutionMetadata } from "../execution/sanitize.js";

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
const VALIDATION_REASON_MAX_BYTES = 4_000;
const VALIDATION_REASON_TRUNCATION_MARKER = "…[输出已截断]";

function resolveWindowsCorepackEntry(): string | null {
  const nodeDirectory = path.dirname(process.execPath);
  const searchDirectories = [
    nodeDirectory,
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
  ];
  const seen = new Set<string>();
  for (const directory of searchDirectories) {
    const resolvedDirectory = path.resolve(directory);
    const key = resolvedDirectory.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const shim = path.join(resolvedDirectory, "corepack.cmd");
    if (resolvedDirectory !== nodeDirectory && !regularFile(shim)) continue;
    const entry = path.join(resolvedDirectory, "node_modules", "corepack", "dist", "corepack.js");
    if (regularFile(entry)) return entry;
  }
  return null;
}

function commandDiagnostics(result: CommandResult): string {
  const stderr = sanitizeExecutionMetadata(result.stderr, VALIDATION_REASON_MAX_BYTES, VALIDATION_REASON_TRUNCATION_MARKER).trim();
  const stdout = sanitizeExecutionMetadata(result.stdout, VALIDATION_REASON_MAX_BYTES, VALIDATION_REASON_TRUNCATION_MARKER).trim();
  const details = [
    stderr ? `stderr: ${stderr}` : "",
    stdout ? `stdout: ${stdout}` : "",
  ].filter(Boolean).join("; ");
  if (!details) return "";
  return sanitizeExecutionMetadata(details, VALIDATION_REASON_MAX_BYTES, VALIDATION_REASON_TRUNCATION_MARKER);
}

function validationFailureReason(file: string, args: string[], result: CommandResult): string {
  const details = commandDiagnostics(result);
  return sanitizeExecutionMetadata(
    `候选验证失败：${file} ${args.join(" ")}${details ? `；${details}` : ""}`,
    VALIDATION_REASON_MAX_BYTES,
    VALIDATION_REASON_TRUNCATION_MARKER,
  );
}

function defaultRunner(file: string, args: string[], cwd: string, timeoutMs = 120_000): CommandResult {
  let executable = file;
  let commandArgs = args;
  if (process.platform === "win32" && path.basename(file).toLowerCase() === "corepack.cmd") {
    const corepackEntry = resolveWindowsCorepackEntry();
    if (!corepackEntry) {
      return {
        status: null,
        stdout: "",
        stderr: "spawn error: 无法解析 Windows Corepack 的 Node CLI 入口",
      };
    }
    executable = process.execPath;
    commandArgs = [corepackEntry, ...args];
  }
  const result = spawnSync(executable, commandArgs, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").toString(),
    stderr: [
      (result.stderr ?? "").toString(),
      result.error ? `spawn error: ${result.error.message}` : "",
    ].filter(Boolean).join("\n"),
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
  const localCommit = local.stdout.trim();
  if (!FULL_COMMIT.test(localCommit) || !FULL_COMMIT.test(remoteCommit)) return null;
  return { localCommit, remoteCommit, dirty: status.stdout.trim().length > 0 };
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

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const VERSION_IDENTITY_FILE = ".c2c-version.json";

type VersionPointer = {
  versionDir?: string;
  commit?: string;
  updatedAt?: string;
  skillBackup?: string | null;
};

type VersionIdentity = {
  schemaVersion: "1.0.0";
  kind: "source-snapshot";
  commit: string;
};

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function regularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function regularDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function readableDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink()) return fs.statSync(directory).isDirectory();
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function readPackageJson(directory: string): Record<string, unknown> | null {
  const file = path.join(directory, "package.json");
  if (!regularFile(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function dependencyNames(packageJson: Record<string, unknown>): {
  required: string[];
  optional: string[];
} {
  const names = (value: unknown): string[] =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>)
      : [];
  const dependencies = names(packageJson.dependencies);
  const optionalDependencies = names(packageJson.optionalDependencies);
  const optionalPeerNames = new Set(
    Object.entries(
      packageJson.peerDependenciesMeta && typeof packageJson.peerDependenciesMeta === "object"
        ? packageJson.peerDependenciesMeta as Record<string, unknown>
        : {}
    )
      .filter(([, meta]) => meta && typeof meta === "object" && (meta as Record<string, unknown>).optional === true)
      .map(([name]) => name)
  );
  const peers = names(packageJson.peerDependencies);
  const optional = [...new Set([...optionalDependencies, ...peers.filter((name) => optionalPeerNames.has(name))])];
  const optionalSet = new Set(optional);
  return {
    required: [...new Set([...dependencies, ...peers].filter((name) => !optionalSet.has(name)))],
    optional,
  };
}

function safePackageName(name: string): boolean {
  return /^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(name);
}

function resolvePackageDirectory(fromDirectory: string, packageName: string): string | null {
  if (!safePackageName(packageName)) return null;
  const starts = [path.resolve(fromDirectory)];
  try {
    const real = fs.realpathSync(fromDirectory);
    if (!samePath(real, starts[0])) starts.push(real);
  } catch {
    /* the normal path walk below reports the missing dependency */
  }
  for (const start of starts) {
    let current = start;
    while (true) {
      const candidate = path.join(current, "node_modules", packageName);
      if (readableDirectory(candidate) && regularFile(path.join(candidate, "package.json"))) return candidate;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

function hasCompleteDependencyTree(root: string): boolean {
  const packageJson = readPackageJson(root);
  if (!packageJson) return false;
  const rootDependencies = dependencyNames(packageJson);
  if (
    rootDependencies.required.length === 0 &&
    rootDependencies.optional.length === 0
  ) return true;
  if (!readableDirectory(path.join(root, "node_modules"))) return false;
  const visited = new Set<string>();
  const verify = (directory: string, requiredBy: string): boolean => {
    let realDirectory: string;
    try {
      realDirectory = fs.realpathSync(directory);
    } catch {
      return false;
    }
    if (visited.has(realDirectory)) return true;
    visited.add(realDirectory);
    const current = readPackageJson(directory);
    if (!current) return false;
    const { required, optional } = dependencyNames(current);
    for (const name of required) {
      const resolved = resolvePackageDirectory(directory, name);
      if (!resolved || !verify(resolved, `${requiredBy} -> ${name}`)) return false;
    }
    for (const name of optional) {
      const resolved = resolvePackageDirectory(directory, name);
      if (resolved && !verify(resolved, `${requiredBy} -> ${name}`)) return false;
    }
    return true;
  };
  return verify(root, "root");
}

function readGitHead(directory: string, run: Runner): string | null {
  const result = git(directory, ["rev-parse", "HEAD"], run);
  const head = result.stdout.trim();
  return result.status === 0 && FULL_COMMIT.test(head) ? head : null;
}

function readRegularCloneHead(directory: string, run: Runner): string | null {
  const gitMetadata = path.join(directory, ".git");
  let metadataStat: fs.Stats;
  try {
    metadataStat = fs.lstatSync(gitMetadata);
  } catch {
    return null;
  }
  if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink()) return null;
  try {
    if (!samePath(fs.realpathSync(gitMetadata), gitMetadata)) return null;
  } catch {
    return null;
  }
  const gitDir = git(directory, ["rev-parse", "--git-dir"], run);
  const commonDir = git(directory, ["rev-parse", "--git-common-dir"], run);
  if (gitDir.status !== 0 || commonDir.status !== 0) return null;
  if (!samePath(path.resolve(directory, gitDir.stdout.trim()), gitMetadata)) return null;
  if (!samePath(path.resolve(directory, commonDir.stdout.trim()), gitMetadata)) return null;
  return readGitHead(directory, run);
}

function writeSourceSnapshotIdentity(directory: string, commit: string): void {
  const identity: VersionIdentity = { schemaVersion: "1.0.0", kind: "source-snapshot", commit };
  atomicWrite(path.join(directory, VERSION_IDENTITY_FILE), JSON.stringify(identity, null, 2));
}

function candidateIdentityMatches(directory: string, expectedCommit: string, run: Runner): boolean {
  if (!FULL_COMMIT.test(expectedCommit)) return false;
  const gitMetadata = path.join(directory, ".git");
  try {
    fs.lstatSync(gitMetadata);
  } catch {
    /* materialized source snapshots intentionally have no .git metadata */
    const identityFile = path.join(directory, VERSION_IDENTITY_FILE);
    if (!regularFile(identityFile)) return false;
    try {
      const identity = JSON.parse(fs.readFileSync(identityFile, "utf8")) as Partial<VersionIdentity>;
      return identity.schemaVersion === "1.0.0" && identity.kind === "source-snapshot" && identity.commit?.toLowerCase() === expectedCommit.toLowerCase();
    } catch {
      return false;
    }
  }
  const head = readRegularCloneHead(directory, run);
  return head !== null && head.toLowerCase() === expectedCommit.toLowerCase();
}

function validateInstalledSource(sourceDir: string, run: Runner): { root: string; head: string } | null {
  const root = path.resolve(sourceDir);
  if (!regularDirectory(root)) return null;
  const top = git(root, ["rev-parse", "--show-toplevel"], run);
  const head = readGitHead(root, run);
  if (top.status !== 0 || !head || !samePath(top.stdout.trim(), root)) return null;
  if (!regularFile(path.join(root, "dist", "cli", "index.js")) || !readPackageJson(root)) return null;
  if (!hasCompleteDependencyTree(root)) return null;
  return { root, head };
}

function copyCurrentVersionTree(sourceDir: string, targetDir: string, relative = ""): void {
  const currentSource = relative ? path.join(sourceDir, relative) : sourceDir;
  for (const entry of fs.readdirSync(currentSource, { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.name === ".git" || entry.name === ".local" || entry.name === "node_modules" || entry.name === VERSION_IDENTITY_FILE) continue;
    if (!safeRelativePath(child) || pathHasSymlink(sourceDir, child)) continue;
    const source = path.join(currentSource, entry.name);
    const target = path.join(targetDir, child);
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      copyCurrentVersionTree(sourceDir, targetDir, child);
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}

type PendingDependencyLink = {
  target: string;
  resolvedSource: string;
};

function isWithinDirectory(root: string, candidate: string): boolean {
  const normalizedRoot = normalizedPath(root);
  const normalizedCandidate = normalizedPath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function nativeDependencyLinkTarget(targetRoot: string, targetResolved: string): string | null {
  if (process.platform !== "win32") return targetResolved;
  try {
    const nativeRoot = fs.realpathSync.native(targetRoot);
    const nativeTarget = fs.realpathSync.native(targetResolved);
    return isWithinDirectory(nativeRoot, nativeTarget) ? nativeTarget : null;
  } catch {
    return null;
  }
}

function copyDependencyTree(source: string, target: string): boolean {
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(target);
  const pendingLinks: PendingDependencyLink[] = [];

  const copyRealEntries = (currentSource: string, currentTarget: string): void => {
    for (const entry of fs.readdirSync(currentSource, { withFileTypes: true })) {
      const sourcePath = path.join(currentSource, entry.name);
      const targetPath = path.join(currentTarget, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) {
        const resolvedSource = fs.realpathSync(sourcePath);
        if (!isWithinDirectory(sourceRoot, resolvedSource)) {
          throw new Error("依赖树包含候选目录外的链接");
        }
        const resolvedStat = fs.statSync(resolvedSource);
        if (!resolvedStat.isDirectory()) {
          throw new Error("依赖树包含非目录链接");
        }
        pendingLinks.push({ target: targetPath, resolvedSource });
      } else if (stat.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        copyRealEntries(sourcePath, targetPath);
      } else if (stat.isFile()) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
      } else {
        throw new Error("依赖树包含不支持的文件类型");
      }
    }
  };

  try {
    const sourceStat = fs.lstatSync(sourceRoot);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return false;
    fs.mkdirSync(targetRoot, { recursive: true });
    copyRealEntries(sourceRoot, targetRoot);
    for (const link of pendingLinks) {
      const relativeResolved = path.relative(sourceRoot, link.resolvedSource);
      if (!relativeResolved || path.isAbsolute(relativeResolved) || relativeResolved.split(/[\\/]/).includes("..")) {
        return false;
      }
      const targetResolved = path.resolve(targetRoot, relativeResolved);
      if (!isWithinDirectory(targetRoot, targetResolved) || !regularDirectory(targetResolved) || fs.existsSync(link.target)) {
        return false;
      }
      const linkTarget = nativeDependencyLinkTarget(targetRoot, targetResolved);
      if (!linkTarget) return false;
      fs.symlinkSync(linkTarget, link.target, process.platform === "win32" ? "junction" : "dir");
    }
    return true;
  } catch {
    return false;
  }
}

function linkCurrentDependencies(sourceDir: string, targetDir: string): boolean {
  const source = path.join(sourceDir, "node_modules");
  if (!fs.existsSync(source)) return false;
  return copyDependencyTree(source, path.join(targetDir, "node_modules"));
}

function materializeSourceVersion(repoRoot: string, stateDir: string, sourceCommit: string, now: Date): VersionPointer | null {
  const sourceEntry = path.join(repoRoot, "dist", "cli", "index.js");
  const sourcePackage = path.join(repoRoot, "package.json");
  if (!fs.existsSync(sourceEntry) || !fs.existsSync(sourcePackage)) return null;
  const stamp = now.toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  const candidateDir = path.join(stateDir, "candidates", `${stamp}-source-${sourceCommit.slice(0, 8)}-${randomBytes(3).toString("hex")}`);
  try {
    fs.mkdirSync(candidateDir, { recursive: true });
    copyCurrentVersionTree(repoRoot, candidateDir);
    if (!linkCurrentDependencies(repoRoot, candidateDir)) {
      fs.rmSync(candidateDir, { recursive: true, force: true });
      return null;
    }
    writeSourceSnapshotIdentity(candidateDir, sourceCommit);
    if (!isCompleteCandidateVersion(stateDir, candidateDir, sourceCommit)) {
      fs.rmSync(candidateDir, { recursive: true, force: true });
      return null;
    }
    return { versionDir: candidateDir, commit: sourceCommit, updatedAt: now.toISOString() };
  } catch {
    try {
      fs.rmSync(candidateDir, { recursive: true, force: true });
    } catch {
      /* preserve a failed candidate for manual review if cleanup is blocked */
    }
    return null;
  }
}

function readSkillContent(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("已安装 Skill 不是正规文件");
  return fs.readFileSync(file, "utf8");
}

function skillBackupPath(stateDir: string, relative: string): string | null {
  const root = path.resolve(stateDir);
  const resolved = path.resolve(root, relative);
  const backupRoot = path.resolve(root, "skill-backups") + path.sep;
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const normalizedRoot = process.platform === "win32" ? backupRoot.toLowerCase() : backupRoot;
  if (!normalized.startsWith(normalizedRoot) || pathHasSymlink(root, path.relative(root, resolved))) return null;
  return resolved;
}

function writeSkillBackup(stateDir: string, content: string | null, label: string): string | null {
  if (content === null) return null;
  const safeLabel = label.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "version";
  const relative = path.join("skill-backups", `${safeLabel}-${randomBytes(3).toString("hex")}.md`);
  const file = path.resolve(stateDir, relative);
  atomicWrite(file, content);
  return relative.replaceAll("\\", "/");
}

function restoreSkillBackup(stateDir: string, pointer: VersionPointer, installedSkillPath: string): void {
  if (pointer.skillBackup === undefined) {
    if (fs.existsSync(installedSkillPath)) throw new Error("版本没有可验证的 Skill 回退绑定");
    return;
  }
  if (pointer.skillBackup === null) {
    fs.rmSync(installedSkillPath, { force: true });
    return;
  }
  const backup = skillBackupPath(stateDir, pointer.skillBackup);
  if (!backup || !fs.existsSync(backup)) throw new Error("版本绑定的 Skill 备份不存在或不安全");
  const stat = fs.lstatSync(backup);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("版本绑定的 Skill 备份不是正规文件");
  atomicWrite(installedSkillPath, fs.readFileSync(backup, "utf8"));
}

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

function planSkillInstall(
  baselineRoot: string,
  candidateDir: string,
  installedSkillPath: string,
  additionalRoots: string[] = [],
  outputRoot = baselineRoot,
): SkillPlan {
  const candidateSkill = path.join(candidateDir, "skill", "SKILL.md");
  if (!fs.existsSync(candidateSkill)) return { action: "none" };
  try {
    const candidate = fs.readFileSync(candidateSkill, "utf8");
    const roots = [baselineRoot, outputRoot, candidateDir, ...additionalRoots, path.resolve(baselineRoot), path.resolve(outputRoot), path.resolve(candidateDir)];
    const materialized = materializeSkillContent(candidate, outputRoot, roots);
    if (!fs.existsSync(installedSkillPath)) return { action: "update", content: materialized };
    const currentSource = path.join(baselineRoot, "skill", "SKILL.md");
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

export function isCompleteCandidateVersion(stateDir: string, versionDir: string, expectedCommit?: string): boolean {
  const root = path.resolve(stateDir);
  const candidateRoot = path.resolve(root, "candidates") + path.sep;
  const resolved = path.resolve(versionDir);
  const normalizedResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const normalizedCandidateRoot = process.platform === "win32" ? candidateRoot.toLowerCase() : candidateRoot;
  if (!normalizedResolved.startsWith(normalizedCandidateRoot)) return false;
  const relative = path.relative(root, resolved);
  if (!relative || pathHasSymlink(root, relative)) return false;
  const entry = path.join(resolved, "dist", "cli", "index.js");
  const entryRelative = path.relative(root, entry);
  if (!entryRelative || pathHasSymlink(root, entryRelative)) return false;
  try {
    const versionStat = fs.lstatSync(resolved);
    const entryStat = fs.lstatSync(entry);
    const packageStat = fs.lstatSync(path.join(resolved, "package.json"));
    if (
      versionStat.isDirectory() &&
      entryStat.isFile() &&
      !entryStat.isSymbolicLink() &&
      packageStat.isFile() &&
      !packageStat.isSymbolicLink()
    ) {
      if (!hasCompleteDependencyTree(resolved)) return false;
      return expectedCommit === undefined || candidateIdentityMatches(resolved, expectedCommit, defaultRunner);
    }
    return false;
  } catch {
    return false;
  }
}

function stageLocalCandidate(
  sourceDir: string,
  stateDir: string,
  candidateCommit: string,
  run: Runner,
  now: Date,
): string | null {
  const source = path.resolve(sourceDir);
  const candidatesRoot = path.resolve(stateDir, "candidates");
  if (!/^[0-9a-f]{40}$/i.test(candidateCommit)) return null;
  try {
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return null;
    if (fs.existsSync(candidatesRoot) && pathHasSymlink(stateDir, "candidates")) return null;
    const top = git(source, ["rev-parse", "--show-toplevel"], run);
    const head = git(source, ["rev-parse", "HEAD"], run);
    const trackedStatus = git(source, ["status", "--porcelain=v1", "--untracked-files=no"], run);
    const normalizedSource = process.platform === "win32" ? source.toLowerCase() : source;
    const normalizedTop = process.platform === "win32" ? path.resolve(top.stdout.trim()).toLowerCase() : path.resolve(top.stdout.trim());
    if (
      top.status !== 0 ||
      normalizedTop !== normalizedSource ||
      head.status !== 0 ||
      head.stdout.trim().toLowerCase() !== candidateCommit.toLowerCase() ||
      trackedStatus.status !== 0 ||
      trackedStatus.stdout.trim()
    ) return null;
  } catch {
    return null;
  }

  const stamp = now.toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  const target = path.join(candidatesRoot, `${stamp}-local-${candidateCommit.slice(0, 8)}-${randomBytes(3).toString("hex")}`);
  try {
    fs.mkdirSync(candidatesRoot, { recursive: true });
    const clone = run("git", ["clone", "--no-checkout", "--no-local", source, target], source, 300_000);
    if (clone.status !== 0) throw new Error("local candidate clone failed");
    const checkout = git(target, ["checkout", "--detach", candidateCommit], run);
    const clonedHead = git(target, ["rev-parse", "HEAD"], run);
    if (checkout.status !== 0 || clonedHead.status !== 0 || clonedHead.stdout.trim().toLowerCase() !== candidateCommit.toLowerCase()) {
      throw new Error("local candidate identity changed during staging");
    }
    return target;
  } catch {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* preserve an incomplete candidate for manual review if cleanup is blocked */
    }
    return null;
  }
}

interface CandidateActivationOptions {
  repoRoot: string;
  stateDir: string;
  candidateDir: string;
  candidateCommit: string;
  sourceCommit: string;
  installedSourceDir?: string;
  installedSkillPath?: string;
  now?: Date;
  localCommit?: string;
  skippedUntracked?: string[];
}

function activateCandidateUnlocked(options: CandidateActivationOptions): SafeUpdateResult {
  const now = options.now ?? new Date();
  const localCommit = options.localCommit ?? options.sourceCommit;
  const remoteCommit = options.candidateCommit;
  const candidateDir = path.resolve(options.candidateDir);
  const skippedUntracked = options.skippedUntracked;
  if (!isCompleteCandidateVersion(options.stateDir, candidateDir, options.candidateCommit)) {
    return {
      ok: false,
      status: "blocked",
      localCommit,
      remoteCommit,
      candidateDir,
      skippedUntracked,
      reason: "候选入口或依赖不完整，未自动切换。",
    };
  }

  const activeFile = path.join(options.stateDir, "active-version.json");
  const previousFile = path.join(options.stateDir, "previous-version.json");
  const hadActiveFile = fs.existsSync(activeFile);
  const oldActiveRaw = hadActiveFile ? fs.readFileSync(activeFile, "utf8") : null;
  const hadPreviousFile = fs.existsSync(previousFile);
  const oldPreviousRaw = hadPreviousFile ? fs.readFileSync(previousFile, "utf8") : null;
  let previous: VersionPointer | null = null;
  if (oldActiveRaw !== null) {
    try {
      previous = JSON.parse(oldActiveRaw) as VersionPointer;
    } catch {
      return { ok: false, status: "blocked", localCommit, remoteCommit, candidateDir, skippedUntracked, reason: "当前活动版本指针无法读取，未自动切换。" };
    }
    if (!previous || typeof previous.versionDir !== "string" || typeof previous.commit !== "string" || !FULL_COMMIT.test(previous.commit) || !isCompleteCandidateVersion(options.stateDir, previous.versionDir, previous.commit)) {
      return { ok: false, status: "blocked", localCommit, remoteCommit, candidateDir, skippedUntracked, reason: "当前活动版本不是可验证候选，未自动切换。" };
    }
  } else {
    previous = materializeSourceVersion(options.installedSourceDir ?? options.repoRoot, options.stateDir, options.sourceCommit, now);
    if (!previous) {
      return { ok: false, status: "blocked", localCommit, remoteCommit, candidateDir, skippedUntracked, reason: "没有可验证的旧版本候选，未自动切换。" };
    }
  }
  const activeVersionDir = previous.versionDir;
  const skillBaselineRoot = options.installedSourceDir ?? options.repoRoot;
  const skillPlan = options.installedSkillPath
    ? planSkillInstall(
        skillBaselineRoot,
        candidateDir,
        options.installedSkillPath,
        activeVersionDir ? [activeVersionDir] : [],
        options.repoRoot,
      )
    : ({ action: "none" } as const);
  if (skillPlan.action === "error") {
    return { ok: false, status: "blocked", localCommit, remoteCommit, candidateDir, skippedUntracked, reason: skillPlan.reason };
  }
  let oldSkill: string | null = null;
  let nextSkill: string | null = null;
  try {
    if (options.installedSkillPath) {
      oldSkill = readSkillContent(options.installedSkillPath);
      nextSkill = skillPlan.action === "update" ? skillPlan.content : oldSkill;
      previous = { ...previous, skillBackup: writeSkillBackup(options.stateDir, oldSkill, `previous-${previous.commit?.slice(0, 12) ?? "unknown"}`) };
    }
  } catch (error) {
    return { ok: false, status: "blocked", localCommit, remoteCommit, candidateDir, skippedUntracked, reason: `无法建立旧版本或 Skill 回退绑定：${(error as Error).message}` };
  }
  let activeSkillBackup: string | null | undefined;
  try {
    if (options.installedSkillPath) {
      activeSkillBackup = writeSkillBackup(options.stateDir, nextSkill, `active-${remoteCommit.slice(0, 12)}`);
    }
  } catch (error) {
    return { ok: false, status: "blocked", localCommit, remoteCommit, candidateDir, skippedUntracked, reason: `无法建立新版本 Skill 回退绑定：${(error as Error).message}` };
  }
  const activePointer: VersionPointer = {
    versionDir: candidateDir,
    commit: remoteCommit,
    updatedAt: now.toISOString(),
    ...(options.installedSkillPath ? { skillBackup: activeSkillBackup } : {}),
  };
  try {
    atomicWrite(previousFile, JSON.stringify(previous, null, 2));
    atomicWrite(activeFile, JSON.stringify(activePointer, null, 2));
  } catch {
    try {
      restoreFile(activeFile, hadActiveFile, oldActiveRaw);
      restoreFile(previousFile, hadPreviousFile, oldPreviousRaw);
    } catch {
      return { ok: false, status: "blocked", localCommit, remoteCommit, candidateDir, skippedUntracked, reason: "活动版本指针切换及回退均失败，已停止自动更新。" };
    }
    return { ok: false, status: "blocked", localCommit, remoteCommit, candidateDir, skippedUntracked, reason: "活动版本指针切换失败，旧版本继续运行。" };
  }
  if (skillPlan.action === "update" && options.installedSkillPath) {
    try {
      atomicWrite(options.installedSkillPath, skillPlan.content);
    } catch (error) {
      try {
        restoreFile(activeFile, hadActiveFile, oldActiveRaw);
        restoreFile(previousFile, hadPreviousFile, oldPreviousRaw);
        if (oldSkill === null) fs.rmSync(options.installedSkillPath, { force: true });
        else atomicWrite(options.installedSkillPath, oldSkill);
      } catch {
        return { ok: false, status: "blocked", localCommit, remoteCommit, candidateDir, skippedUntracked, reason: `Skill 更新失败且版本指针回滚失败：${(error as Error).message}` };
      }
      return { ok: false, status: "blocked", localCommit, remoteCommit, candidateDir, skippedUntracked, reason: `Skill 更新失败，已保留旧版本：${(error as Error).message}` };
    }
  }
  return { ok: true, status: "updated", localCommit, remoteCommit, candidateDir, activeVersion: remoteCommit, skippedUntracked };
}

export function performSafeUpdate(options: {
  repoRoot: string;
  stateDir: string;
  installedSourceDir?: string;
  installedSkillPath?: string;
  run?: Runner;
  now?: Date;
  validate?: boolean;
  allowDirtyCandidate?: boolean;
  candidateSourceDir?: string;
  candidateCommit?: string;
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
  installedSourceDir?: string;
  installedSkillPath?: string;
  run?: Runner;
  now?: Date;
  validate?: boolean;
  allowDirtyCandidate?: boolean;
  candidateSourceDir?: string;
  candidateCommit?: string;
}): SafeUpdateResult {
  const repoRoot = path.resolve(options.repoRoot);
  const run = options.run ?? defaultRunner;
  if (options.candidateSourceDir !== undefined || options.candidateCommit !== undefined) {
    const candidateCommit = options.candidateCommit?.trim() ?? "";
    if (!options.candidateSourceDir || !FULL_COMMIT.test(candidateCommit)) {
      return { ok: false, status: "blocked", reason: "本地候选必须提供可验证的完整 Git 提交，当前版本未改变。" };
    }
    const candidateSourceDir = path.resolve(options.candidateSourceDir);
    const candidateHead = readGitHead(candidateSourceDir, run);
    if (!candidateHead || candidateHead.toLowerCase() !== candidateCommit.toLowerCase()) {
      return { ok: false, status: "blocked", remoteCommit: candidateCommit, reason: "本地候选的 Git HEAD 与指定提交不一致，当前版本未改变。" };
    }
    const installedSourceDir = options.installedSourceDir
      ? path.resolve(options.installedSourceDir)
      : samePath(repoRoot, candidateSourceDir)
        ? null
        : repoRoot;
    if (!installedSourceDir || samePath(installedSourceDir, candidateSourceDir)) {
      return { ok: false, status: "blocked", localCommit: candidateHead, remoteCommit: candidateCommit, reason: "从候选 checkout 执行本地更新时必须显式提供不同的 --installed-source；未猜测旧版本来源。" };
    }
    const installed = validateInstalledSource(installedSourceDir, run);
    if (!installed) {
      return { ok: false, status: "blocked", localCommit: candidateHead, remoteCommit: candidateCommit, reason: "已安装 source 不是可验证的 Git checkout，或入口、package.json、依赖树不完整；当前版本未改变。" };
    }
    const staged = stageLocalCandidate(candidateSourceDir, options.stateDir, candidateCommit, run, options.now ?? new Date());
    if (!staged) {
      return { ok: false, status: "blocked", localCommit: installed.head, remoteCommit: candidateCommit, reason: "本地候选未通过路径、Git 身份或干净工作树校验，当前版本未改变。" };
    }
    if (options.validate !== false) {
      for (const [file, args] of validationCommands()) {
        const result = run(file, args, staged, 600_000);
        if (result.status !== 0) {
          return { ok: false, status: "validation_failed", localCommit: installed.head, remoteCommit: candidateCommit, candidateDir: staged, reason: validationFailureReason(file, args, result) };
        }
      }
    }
    return activateCandidateUnlocked({
      repoRoot: candidateSourceDir,
      stateDir: options.stateDir,
      candidateDir: staged,
      candidateCommit,
      sourceCommit: installed.head,
      installedSourceDir: installed.root,
      installedSkillPath: options.installedSkillPath,
      now: options.now,
      localCommit: installed.head,
    });
  }
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
        return { ok: false, status: "validation_failed", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, skippedUntracked, reason: validationFailureReason(file, args, result) };
      }
    }
  }
  if (!isCompleteCandidateVersion(options.stateDir, candidateDir, snapshot.remoteCommit)) {
    return { ok: false, status: "blocked", localCommit: snapshot.localCommit, remoteCommit: snapshot.remoteCommit, candidateDir, skippedUntracked, reason: "候选入口或依赖不完整，未自动切换。" };
  }

  return activateCandidateUnlocked({
    repoRoot,
    stateDir: options.stateDir,
    candidateDir,
    candidateCommit: snapshot.remoteCommit,
    sourceCommit: head,
    installedSkillPath: options.installedSkillPath,
    now: options.now,
    localCommit: snapshot.localCommit,
    skippedUntracked,
  });
}

export function rollbackActiveVersion(stateDir: string, installedSkillPath = defaultInstalledSkillPath()): RollbackResult {
  let release: (() => void) | null = null;
  try {
    release = acquireUpdateLock(stateDir);
  } catch (error) {
    return { ok: false, status: "blocked", reason: `无法建立更新锁：${(error as Error).message}` };
  }
  if (!release) return { ok: false, status: "blocked", reason: "已有更新正在进行，当前版本保持不变。" };
  try {
    return rollbackActiveVersionUnlocked(stateDir, installedSkillPath);
  } finally {
    release();
  }
}

function rollbackActiveVersionUnlocked(stateDir: string, installedSkillPath: string): RollbackResult {
  const root = path.resolve(stateDir);
  const activeFile = path.join(root, "active-version.json");
  const previousFile = path.join(root, "previous-version.json");
  if (!fs.existsSync(activeFile) || !fs.existsSync(previousFile)) {
    return { ok: false, status: "unavailable", reason: "没有可回滚的旧版本。" };
  }
  let activeRaw: string;
  let previousRaw: string;
  let active: VersionPointer | null;
  let previous: VersionPointer | null;
  try {
    activeRaw = fs.readFileSync(activeFile, "utf8");
    previousRaw = fs.readFileSync(previousFile, "utf8");
    active = JSON.parse(activeRaw) as VersionPointer | null;
    previous = JSON.parse(previousRaw) as VersionPointer | null;
  } catch {
    return { ok: false, status: "blocked", reason: "版本指针文件无法读取，未执行回滚。" };
  }
  if (!active || typeof active.versionDir !== "string" || typeof active.commit !== "string" || !FULL_COMMIT.test(active.commit)) {
    return { ok: false, status: "blocked", reason: "当前活动版本指针不完整，未执行回滚。" };
  }
  if (!previous || typeof previous.versionDir !== "string" || typeof previous.commit !== "string" || !FULL_COMMIT.test(previous.commit)) {
    return { ok: false, status: "unavailable", reason: "没有可回滚的完整旧版本。" };
  }
  if (!isCompleteCandidateVersion(root, active.versionDir, active.commit)) {
    return { ok: false, status: "blocked", reason: "当前活动版本目录不存在或不完整，未执行回滚。" };
  }
  if (!isCompleteCandidateVersion(root, previous.versionDir, previous.commit)) {
    return { ok: false, status: "blocked", reason: "旧版本目录不存在或不完整，未执行回滚。" };
  }
  let currentSkill: string | null = null;
  try {
    currentSkill = readSkillContent(installedSkillPath);
  } catch (error) {
    return { ok: false, status: "blocked", reason: `当前已安装 Skill 无法读取，未执行回滚：${(error as Error).message}` };
  }
  try {
    atomicWrite(previousFile, activeRaw);
    atomicWrite(activeFile, previousRaw);
    restoreSkillBackup(root, previous, installedSkillPath);
  } catch {
    try {
      atomicWrite(previousFile, previousRaw);
      atomicWrite(activeFile, activeRaw);
      if (currentSkill === null) fs.rmSync(installedSkillPath, { force: true });
      else atomicWrite(installedSkillPath, currentSkill);
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
