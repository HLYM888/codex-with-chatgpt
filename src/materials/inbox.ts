import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MaterialCatalog, MaterialError } from "./catalog.js";
import { downloadHostFile, MAX_DELIVERABLE_BYTES } from "./download.js";
import { formatForPath, parseMaterial } from "./parser.js";

export type HostFile = { download_url: string; file_id: string; mime_type?: string; file_name?: string };
export type SourceRef = { root_alias: string; path: string; sha256: string };

export function safeDisplayName(value: string): string {
  if (!value || value.length > 150 || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) ||
      value === "." || value === ".." || value.toLowerCase() === "receipt.json" || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new MaterialError("INVALID_FILENAME", "产物名称不符合安全文件名规则，请保留合法中文名称且不含目录。");
  }
  return value;
}

export function deliverableMime(name: string, bytes: Buffer): string {
  const ext = path.extname(name).toLowerCase();
  const starts = (hex: string) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  if (ext === ".pdf" && bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (ext === ".png" && starts("89504e470d0a1a0a")) return "image/png";
  if ([".jpg", ".jpeg"].includes(ext) && starts("ffd8ff")) return "image/jpeg";
  if (ext === ".webp" && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  const office: Record<string, string> = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  if (office[ext] && starts("504b0304")) return office[ext];
  if ([".txt", ".md", ".csv", ".tsv", ".json", ".py", ".js", ".ts", ".patch", ".diff", ".html", ".css", ".yaml", ".yml"].includes(ext)) {
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (content.includes("\0")) throw new Error();
      return ext === ".json" ? "application/json" : ext === ".csv" ? "text/csv" : "text/plain";
    } catch { throw new MaterialError("INVALID_FORMAT", "文本产物不是有效 UTF-8 或包含二进制内容。"); }
  }
  throw new MaterialError("UNSUPPORTED_FORMAT", "产物格式不受支持或内容与扩展名不符。");
}

function inboxRoot(catalog: MaterialCatalog): { abs: string; rel: string } {
  const settings = catalog.settings();
  const inbox = settings.inbox as { enabled?: boolean; path?: string } | undefined;
  if (inbox?.enabled !== true) throw new MaterialError("INBOX_DISABLED", "本项目产物收件箱尚未由本地操作者启用。");
  const requested = inbox.path ?? ".local/c2c-inbox";
  if (typeof requested !== "string" || path.isAbsolute(requested) || requested.split(/[\\/]/).includes("..")) {
    throw new MaterialError("INVALID_CONFIG", "收件箱必须是工作区内固定的相对目录。");
  }
  const workspace = catalog.getWorkspace("workspace");
  const result = workspace.resolve(requested);
  if (!result.rel || result.rel === ".git" || result.rel.startsWith(".git/")) throw new MaterialError("INVALID_CONFIG", "收件箱不能使用工作区根或 Git 内部目录。");
  return result;
}

export async function receiveDeliverable(
  catalog: MaterialCatalog, file: HostFile, sources: SourceRef[] = [],
  internal: { download?: typeof downloadHostFile } = {}
): Promise<Record<string, unknown>> {
  const before = inboxRoot(catalog);
  if (!file.file_id || file.file_id.length > 256) throw new MaterialError("INVALID_FILE_REFERENCE", "缺少有效宿主文件标识。");
  const name = safeDisplayName(file.file_name ?? `${file.file_id}.txt`);
  const settings = catalog.settings();
  const hosts = settings.downloadHosts ?? [];
  if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string" || !/^[a-z0-9.-]+$/.test(host))) {
    throw new MaterialError("INVALID_CONFIG", "可信下载主机配置无效。");
  }
  for (const source of sources) {
    await catalog.readSource(source.root_alias, source.path, source.sha256);
  }
  const bytes = await (internal.download ?? downloadHostFile)(file.download_url, hosts as string[]);
  if (bytes.length > MAX_DELIVERABLE_BYTES) throw new MaterialError("FILE_TOO_LARGE", "产物超过 10 MiB 接收上限。");
  const mimeType = deliverableMime(name, bytes);
  if (!mimeType.startsWith("text/") && mimeType !== "application/json") {
    await parseMaterial(catalog, bytes, { format: formatForPath(name), operation: "overview" });
  }
  if (file.mime_type && file.mime_type !== "application/octet-stream" && file.mime_type !== mimeType &&
      !(mimeType.startsWith("text/") && file.mime_type.startsWith("text/"))) {
    throw new MaterialError("INVALID_FORMAT", "宿主声明的文件类型与实际产物不一致。");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  for (const source of sources) await catalog.readSource(source.root_alias, source.path, source.sha256);
  if (inboxRoot(catalog).abs !== before.abs) throw new MaterialError("AUTHORIZATION_CHANGED", "下载期间收件箱配置变化，未保存产物。");
  fs.mkdirSync(before.abs, { recursive: true, mode: 0o700 });
  if (fs.realpathSync.native(before.abs) !== before.abs) throw new MaterialError("INVALID_CONFIG", "收件箱路径身份发生变化。");
  const id = randomUUID();
  const deliveryDir = path.join(before.abs, id);
  fs.mkdirSync(deliveryDir, { mode: 0o700 });
  const target = path.join(deliveryDir, name);
  const receipt = {
    id, fileName: name, path: `${before.rel}/${id}/${name}`, mimeType,
    sizeBytes: bytes.length, sha256, hostFileId: file.file_id,
    receivedAt: new Date().toISOString(), sources, adopted: false,
  };
  try {
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(deliveryDir, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
    if (inboxRoot(catalog).abs !== before.abs || fs.realpathSync.native(deliveryDir) !== deliveryDir) {
      throw new MaterialError("AUTHORIZATION_CHANGED", "接收期间目录授权变化，请本地核对候选；未标记采用。");
    }
  } catch (error) {
    // Preserve any partial file for local inspection, never claim a completed receipt.
    if (error instanceof MaterialError) throw error;
    throw new MaterialError("INBOX_WRITE_FAILED", "产物接收未完整完成，请本地检查收件箱；原有文件未覆盖。");
  }
  return receipt;
}
