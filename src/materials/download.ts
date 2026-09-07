import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { MaterialError } from "./catalog.js";

export const MAX_DELIVERABLE_BYTES = 10 * 1024 * 1024;
const denied4 = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) denied4.addSubnet(address, prefix, "ipv4");
const global6 = new net.BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const denied6 = new net.BlockList();
denied6.addSubnet("2001::", 32, "ipv6");
denied6.addSubnet("2001:db8::", 32, "ipv6");
denied6.addSubnet("2002::", 16, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  return family === 4 ? !denied4.check(address, "ipv4") :
    family === 6 && global6.check(address, "ipv6") && !denied6.check(address, "ipv6");
}

export function validateDownloadUrl(value: string, extraHosts: string[] = []): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new MaterialError("INVALID_FILE_REFERENCE", "宿主文件下载引用无效。"); }
  const host = url.hostname.toLowerCase();
  const allowed = host === "files.oaiusercontent.com" || host.endsWith(".oaiusercontent.com") || extraHosts.includes(host);
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443") || net.isIP(host.replace(/^\[|\]$/g, "")) || !allowed) {
    throw new MaterialError("UNTRUSTED_DOWNLOAD", "只接受已配置可信宿主提供的 HTTPS 文件引用。");
  }
  return url;
}

/** No redirects, cookies, proxy inheritance, or second DNS resolution. */
export async function downloadHostFile(urlText: string, extraHosts: string[] = []): Promise<Buffer> {
  const url = validateDownloadUrl(urlText, extraHosts);
  const deadline = Date.now() + 30_000;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  let addresses: Awaited<ReturnType<typeof dns.lookup>>[];
  try {
    addresses = await Promise.race([
      dns.lookup(url.hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new Error()), 5000); }),
    ]);
  } catch { throw new MaterialError("DOWNLOAD_FAILED", "无法解析宿主文件下载地址。"); }
  finally { if (dnsTimer) clearTimeout(dnsTimer); }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new MaterialError("UNTRUSTED_DOWNLOAD", "宿主文件地址指向非公网目标，已拒绝下载。");
  }
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = 0;
    const chunks: Buffer[] = [];
    const fail = (code: string, message: string): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); request.destroy();
      reject(new MaterialError(code, message));
    };
    const request = https.request(url, {
      method: "GET", agent: false, family: pinned.family,
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { "accept-encoding": "identity" },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy(); fail("DOWNLOAD_FAILED", `宿主文件下载失败（HTTP ${response.statusCode ?? 0}），请重新传入当前附件。`); return;
      }
      const length = response.headers["content-length"];
      const expected = length === undefined ? null : Number(length);
      if ((expected !== null && (!Number.isSafeInteger(expected) || expected < 0 || expected > MAX_DELIVERABLE_BYTES)) ||
          (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
        response.destroy(); fail("FILE_TOO_LARGE", "宿主文件体积或传输编码不符合接收限制。"); return;
      }
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_DELIVERABLE_BYTES) { response.destroy(); fail("FILE_TOO_LARGE", "产物超过 10 MiB 接收上限。"); return; }
        chunks.push(chunk);
      });
      response.on("error", () => fail("DOWNLOAD_FAILED", "宿主文件传输中断，未保存产物。"));
      response.on("end", () => {
        if (settled) return;
        if (expected !== null && expected !== received) { fail("DOWNLOAD_FAILED", "宿主文件长度不一致，未保存产物。"); return; }
        settled = true; clearTimeout(timer); resolve(Buffer.concat(chunks));
      });
    });
    const timer = setTimeout(() => fail("DOWNLOAD_TIMEOUT", "宿主文件下载超时，未保存产物。"), Math.max(1, deadline - Date.now()));
    request.on("error", () => fail("DOWNLOAD_FAILED", "宿主文件下载失败，临时地址可能已过期。"));
    request.end();
  });
}
