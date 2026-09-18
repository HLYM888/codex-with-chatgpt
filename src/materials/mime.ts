import path from "node:path";
import { MaterialError } from "./catalog.js";

/** Validate and classify an authorized material snapshot without accepting writes. */
export function materialMime(name: string, bytes: Buffer): string {
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
    } catch { throw new MaterialError("INVALID_FORMAT", "文本材料不是有效 UTF-8 或包含二进制内容。"); }
  }
  throw new MaterialError("UNSUPPORTED_FORMAT", "材料格式不受支持或内容与扩展名不符。");
}
