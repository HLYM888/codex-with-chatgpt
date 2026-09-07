import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MaterialCatalog, MaterialError } from "./catalog.js";

export type MaterialRequest = {
  format: "pdf" | "xlsx" | "docx" | "image" | "csv" | "pptx";
  operation: "overview" | "read" | "image";
  page?: number; start?: number; count?: number; sheet?: string; range?: string; encoding?: string;
};
export type ParsedMaterial = {
  ok: true;
  data: Record<string, unknown>;
  image?: { mimeType: "image/png" | "image/jpeg"; data: string };
};
const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/material_worker.py");
const MAX_OUTPUT = 2 * 1024 * 1024;

/** Isolated parser receives a fixed byte snapshot, never an arbitrary path or command. */
export async function parseMaterial(
  catalog: MaterialCatalog, bytes: Buffer, request: MaterialRequest,
  internal: { worker?: string; timeoutMs?: number } = {}
): Promise<ParsedMaterial> {
  const settings = catalog.settings();
  const python = settings.pythonExecutable;
  if (typeof python !== "string" || !path.isAbsolute(python)) {
    throw new MaterialError("PARSER_NOT_CONFIGURED", "尚未配置材料解析运行时，请由本地操作者登记 Python 路径。");
  }
  if (bytes.length > 32 * 1024 * 1024) throw new MaterialError("FILE_TOO_LARGE", "材料超过 32 MiB 输入上限。");
  const payload = JSON.stringify({ contentBase64: bytes.toString("base64"), request });
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", "-X", "utf8", internal.worker ?? WORKER], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (code: string, message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new MaterialError(code, message));
    };
    const timer = setTimeout(() => fail("PARSER_TIMEOUT", "材料解析超过 30 秒，解析进程已终止。"), internal.timeoutMs ?? 30_000);
    child.on("error", () => fail("PARSER_UNAVAILABLE", "材料解析运行时无法启动。"));
    child.stdin.on("error", () => fail("PARSER_FAILED", "材料解析输入未能完整传递。"));
    child.stderr.resume(); // Never expose parser paths, document bytes, or library tracebacks.
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { fail("OUTPUT_TOO_LARGE", "解析输出超过 2 MiB 上限。"); return; }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      try {
        const output = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if ((code === 0 || code === 2) && output?.ok === false && typeof output.error?.code === "string") {
          fail(output.error.code.slice(0, 80), String(output.error.message ?? "解析失败。").slice(0, 500)); return;
        }
        if (code !== 0) { fail("PARSER_FAILED", "材料解析进程失败，未返回可采用内容。"); return; }
        if (output?.ok !== true || !output.data || typeof output.data !== "object" || Array.isArray(output.data)) {
          fail("INVALID_PARSER_OUTPUT", "解析器返回结构无效。"); return;
        }
        if (Buffer.byteLength(JSON.stringify(output.data), "utf8") > 128 * 1024) {
          fail("OUTPUT_TOO_LARGE", "解析正文超过 128 KiB，请缩小范围。"); return;
        }
        if (output.image) {
          const img = output.image;
          if (!["image/png", "image/jpeg"].includes(img.mimeType) || typeof img.data !== "string" ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(img.data) ||
              Buffer.byteLength(img.data, "base64") > 1024 * 1024) {
            fail("INVALID_PARSER_OUTPUT", "解析器图片内容无效或超限。"); return;
          }
        }
        settled = true;
        resolve(output as ParsedMaterial);
      } catch { fail("INVALID_PARSER_OUTPUT", "解析器没有返回有效 JSON。"); }
    });
    child.stdin.end(payload);
  });
}

export function formatForPath(file: string): MaterialRequest["format"] {
  const ext = path.extname(file).toLowerCase();
  const formats: Record<string, MaterialRequest["format"]> = {
    ".pdf": "pdf", ".xlsx": "xlsx", ".docx": "docx", ".pptx": "pptx", ".csv": "csv",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
  };
  const format = formats[ext];
  if (!format) throw new MaterialError("UNSUPPORTED_FORMAT", "此格式尚无材料解析器；文本与代码请使用文本读取工具。");
  return format;
}
