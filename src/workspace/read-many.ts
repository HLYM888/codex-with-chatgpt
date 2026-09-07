import { createHash } from "node:crypto";
import { Workspace, WorkspaceError, type ReadFileResult } from "./manager.js";
import { TextReadError, type ReadTextOptions } from "./text-reader.js";

export interface ReadManyItem {
  path: string;
  start_line?: number;
  end_line?: number;
  encoding?: ReadTextOptions["encoding"];
  expected_sha256?: string;
}

type ItemResult =
  | { index: number; ok: true; file: ReadFileResult }
  | { index: number; ok: false; error: string; message: string };

export type ReadManyResult = {
  content: { type: "text"; text: string }[];
  structuredContent: {
    inputFingerprint: string;
    inputCount: number;
    offset: number;
    items: ItemResult[];
    hasMoreItems: boolean;
    nextIndex: number | null;
  };
};

export const MAX_READ_MANY_ITEMS = 8;
export const MAX_READ_MANY_BYTES = 256 * 1024;
export const DEFAULT_READ_MANY_BYTES = 64 * 1024;

function itemError(index: number, error: unknown): ItemResult {
  if (error instanceof WorkspaceError || error instanceof TextReadError) {
    return { index, ok: false, error: error.code, message: error.message.slice(0, 500) };
  }
  return { index, ok: false, error: "READ_FAILED", message: "文件读取失败，未返回正文。" };
}

/** Batch only the existing authorized file reader; no new roots or permissions. */
export async function readMany(
  workspace: Workspace,
  request: { items: ReadManyItem[]; offset?: number; maxResultBytes?: number },
  internal: { deadlineMs?: number } = {}
): Promise<ReadManyResult> {
  const { items } = request;
  const offset = request.offset ?? 0;
  const budget = request.maxResultBytes ?? DEFAULT_READ_MANY_BYTES;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_READ_MANY_ITEMS ||
      !Number.isInteger(offset) || offset < 0 || offset > items.length ||
      !Number.isInteger(budget) || budget < 4096 || budget > MAX_READ_MANY_BYTES) {
    throw new WorkspaceError("INVALID_ARGUMENTS", "批量读取参数超出范围。");
  }
  const inputFingerprint = createHash("sha256").update(JSON.stringify(items)).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), internal.deadlineMs ?? 30_000);
  const pending: ItemResult[] = new Array(items.length - offset);
  let next = offset;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      try {
        if (!item || typeof item.path !== "string" || item.path.length > 1024) {
          throw new WorkspaceError("INVALID_PATH", "文件路径必须是不超过 1024 字符的字符串。");
        }
        const file = await workspace.readFile(item.path, {
          startLine: item.start_line,
          endLine: item.end_line,
          encoding: item.encoding,
          expectedSha256: item.expected_sha256,
          maxBytes: budget,
          signal: controller.signal,
        });
        pending[index - offset] = { index, ok: true, file };
      } catch (error) {
        pending[index - offset] = itemError(index, error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(2, items.length - offset) }, worker));
  } finally {
    clearTimeout(timer);
  }

  const returned: ItemResult[] = [];
  const envelope = (resultItems: ItemResult[], after: number): ReadManyResult => ({
    content: [{ type: "text", text: `已返回 ${resultItems.length} 项文件读取结果；正文与逐项错误见结构化结果。` }],
    structuredContent: {
      inputFingerprint,
      inputCount: items.length,
      offset,
      items: resultItems,
      hasMoreItems: after < items.length,
      nextIndex: after < items.length ? after : null,
    },
  });
  const fits = (entries: ItemResult[], after: number): boolean =>
    Buffer.byteLength(JSON.stringify(envelope(entries, after)), "utf8") <= budget;

  for (const original of pending) {
    let item = original;
    if (!fits([...returned, item], item.index + 1) && item.ok && item.file.endLine !== null) {
      const file = item.file;
      const lines = file.content.split("\n");
      let low = 1;
      let high = lines.length;
      let best: ItemResult | null = null;
      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const endLine = file.startLine + count - 1;
        const clipped: ItemResult = {
          index: item.index, ok: true,
          file: {
            ...file,
            content: lines.slice(0, count).join("\n"),
            endLine,
            truncated: endLine < file.totalLines,
            remainingLines: Math.max(0, file.totalLines - endLine),
            nextStartLine: endLine < file.totalLines ? endLine + 1 : null,
          },
        };
        if (fits([...returned, clipped], item.index + 1)) {
          best = clipped;
          low = count + 1;
        } else high = count - 1;
      }
      if (best) item = best;
    }
    if (!fits([...returned, item], item.index + 1)) {
      // Once a page has made progress, retry the unreturned item in a fresh
      // envelope. A first item that cannot fit is an explicit error, not a
      // zero-progress cursor and not a silent skip of an oversized line.
      if (returned.length > 0) break;
      item = { index: item.index, ok: false, error: "OUTPUT_TOO_LARGE",
        message: "单项结果超过序列化预算。请缩小该项行范围；超长单行需要专用读取方式。" };
    }
    returned.push(item);
  }
  const after = offset + returned.length;
  return envelope(returned, after);
}
