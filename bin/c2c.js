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
try {
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-version.json"), "utf8"));
  const candidateDist = active.versionDir ? path.resolve(active.versionDir, "dist", "cli", "index.js") : "";
  if (candidateDist && existsSync(candidateDist)) dist = candidateDist;
} catch {
  /* first run or incomplete update: use the installed checkout */
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
