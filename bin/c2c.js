#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.C2C_STATE_DIR || (process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || here, "AppData", "Local"), "codex-with-chatgpt")
  : path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || here, ".local", "state"), "codex-with-chatgpt"));
let dist = path.join(here, "..", "dist", "cli", "index.js");
delete process.env.C2C_ACTIVE_VERSION_COMMIT;
const activeFile = path.join(stateDir, "active-version.json");
if (existsSync(activeFile)) {
  try {
    const active = JSON.parse(readFileSync(activeFile, "utf8"));
    const validator = path.join(here, "..", "dist", "update", "safe-update.js");
    if (!existsSync(validator)) throw new Error("候选版本校验器不存在");
    const { isCompleteCandidateVersion } = await import(pathToFileURL(validator).href);
    if (
      !active ||
      typeof active.versionDir !== "string" ||
      typeof active.commit !== "string" ||
      !/^[0-9a-f]{40}$/i.test(active.commit) ||
      !isCompleteCandidateVersion(stateDir, active.versionDir, active.commit)
    ) {
      throw new Error("活动版本指针无效或候选版本不完整");
    }
    const candidateDist = path.resolve(active.versionDir, "dist", "cli", "index.js");
    process.env.C2C_ACTIVE_VERSION_COMMIT = active.commit;
    dist = candidateDist;
  } catch (error) {
    process.stderr.write(`活动版本无法安全加载：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    process.exit();
  }
}

if (existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else {
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const entry = path.join(here, "..", "src", "cli", "index.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    windowsHide: true,
  });
  process.exit(result.status ?? 1);
}
