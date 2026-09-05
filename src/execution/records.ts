import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";
import { RECORD_NOTES_TRUNCATION_MARKER, sanitizeExecutionMetadata } from "./sanitize.js";

const MAX_RECORD_NOTES_BYTES = 8 * 1024;

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export interface ExecutionRecord {
  taskId: string;
  iteration: number;
  changedFiles: string[] | number;
  tests: string | null;
  exitStatus: "ok" | "failed" | "blocked" | string;
  timestamp: string;
  notes?: string;
  /** Present when Codex recorded a sanitized command output for this iteration. */
  outputId?: number;
  outputAvailable?: boolean;
}

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  const safeRecord = record.notes === undefined
    ? record
    : { ...record, notes: sanitizeExecutionMetadata(record.notes, MAX_RECORD_NOTES_BYTES, RECORD_NOTES_TRUNCATION_MARKER) };
  fs.appendFileSync(file, JSON.stringify(safeRecord) + "\n", { mode: 0o600 });
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      const record = JSON.parse(line) as ExecutionRecord;
      records.push(
        record.notes === undefined
          ? record
          : { ...record, notes: sanitizeExecutionMetadata(record.notes, MAX_RECORD_NOTES_BYTES, RECORD_NOTES_TRUNCATION_MARKER) }
      );
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}
