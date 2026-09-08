import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MaterialCatalog } from "../src/materials/catalog.js";
import { Workspace } from "../src/workspace/manager.js";
import { receiveDeliverable, safeDisplayName, deliverableMime } from "../src/materials/inbox.js";
import { isPublicAddress, validateDownloadUrl } from "../src/materials/download.js";
import { filterScopes } from "../src/auth/store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup(enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-inbox-")); dirs.push(root);
  const workspace = new Workspace(root);
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify({ version: 1, workspaceRoot: workspace.root, pythonExecutable: process.env.C2C_TEST_PYTHON, inbox: { enabled } }));
  return { root, config, catalog: new MaterialCatalog(workspace, config) };
}
const file = { file_id: "file-synthetic-1", file_name: "中文成果.py", download_url: "https://files.oaiusercontent.com/synthetic" };

describe("candidate-only inbox", () => {
  it("never adds write authority to default, unknown, or legacy read-only scope requests", () => {
    for (const request of [undefined, "", "unknown.scope", "workspace.read"]) {
      expect(filterScopes(request)).not.toContain("artifacts.write");
    }
    expect(filterScopes("workspace.read artifacts.write")).toEqual(["workspace.read", "artifacts.write"]);
  });
  it("retains Chinese names and rejects path traversal, device names and reserved receipt", () => {
    expect(safeDisplayName("中文报告.xlsx")).toBe("中文报告.xlsx");
    for (const name of ["../evil.py", "C:\\evil.py", "CON.txt", "receipt.json", "bad.", "a/b.txt", "nul"]) {
      expect(() => safeDisplayName(name)).toThrow();
    }
  });
  it("refuses disabled inboxes before downloading", async () => {
    const { catalog, root } = setup(false);
    const download = vi.fn();
    await expect(receiveDeliverable(catalog, file, [], { download })).rejects.toMatchObject({ code: "INBOX_DISABLED" });
    expect(download).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, ".local"))).toBe(false);
  });
  it.skipIf(process.platform !== "win32" || !process.env.C2C_TEST_PYTHON)("writes exact bytes and a hash receipt without overwriting either source or previous delivery", async () => {
    const { catalog, root } = setup();
    const bytes = Buffer.from('print("中文")\n');
    const source = path.join(root, "original.py"); fs.writeFileSync(source, "unchanged");
    const a = await receiveDeliverable(catalog, file, [], { download: async () => bytes });
    const b = await receiveDeliverable(catalog, file, [], { download: async () => bytes });
    expect(a.path).not.toBe(b.path);
    expect(fs.readFileSync(path.join(root, a.path as string))).toEqual(bytes);
    expect(a.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(a.adopted).toBe(false);
    expect(fs.readFileSync(source, "utf8")).toBe("unchanged");
    const receipt = fs.readFileSync(path.join(root, a.path as string, "..", "receipt.json"), "utf8");
    expect(receipt).not.toContain("download_url");
    expect(receipt).not.toContain("https://");
  });
  it("honors authorization revoked while the file is downloading", async () => {
    const { catalog, config, root } = setup();
    await expect(receiveDeliverable(catalog, file, [], { download: async () => {
      fs.writeFileSync(config, JSON.stringify({ version: 1, workspaceRoot: root, inbox: { enabled: false } }));
      return Buffer.from("text");
    } })).rejects.toMatchObject({ code: "INBOX_DISABLED" });
    expect(fs.existsSync(path.join(root, ".local"))).toBe(false);
  });
  it("rejects unsupported or mislabelled content and oversized downloads", async () => {
    const { catalog, root } = setup();
    expect(() => deliverableMime("executable.exe", Buffer.from("MZ"))).toThrow();
    expect(() => deliverableMime("photo.png", Buffer.from("not a PNG"))).toThrow();
    expect(() => deliverableMime("bad.py", Buffer.from([0xff]))).toThrow();
    await expect(receiveDeliverable(catalog, { ...file, mime_type: "image/png" }, [], { download: async () => Buffer.from("text") }))
      .rejects.toMatchObject({ code: "INVALID_FORMAT" });
    await expect(receiveDeliverable(catalog, file, [], { download: async () => Buffer.alloc(10 * 1024 * 1024 + 1) }))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(fs.existsSync(path.join(root, ".local"))).toBe(false);
  });
});

describe("host file download boundary", () => {
  it("accepts HTTPS host references, rejecting arbitrary URLs, redirects and URL credentials", () => {
    expect(validateDownloadUrl("https://files.oaiusercontent.com/file-1?temporary=1").hostname).toBe("files.oaiusercontent.com");
    for (const value of ["http://files.oaiusercontent.com/a", "https://localhost/a", "https://127.0.0.1/a", "https://files.oaiusercontent.com.evil.test/a",
      "https://user:password@files.oaiusercontent.com/a", "https://files.oaiusercontent.com:444/a", "https://files.oaiusercontent.com/a#fragment"]) {
      expect(() => validateDownloadUrl(value)).toThrow();
    }
  });
  it("rejects private, special, IPv4-mapped and transition addresses before connection", () => {
    for (const ip of ["127.0.0.1", "10.0.0.2", "169.254.169.254", "100.64.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1", "2002:7f00:1::"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("reports host compatibility failures without credentials, path, query or fragment values", () => {
    let message = "";
    try { validateDownloadUrl("https://privateuser:privatepassword@new-host.example.test/privatepath?sig=privatesignature#privatefragment"); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain('"host":"new-host.example.test"');
    expect(JSON.parse(message.split("脱敏诊断：")[1])).toEqual({ protocol: "https:", host: "new-host.example.test", rejected: true });
    for (const secret of ["privateuser", "privatepassword", "privatepath", "privatesignature", "privatefragment"]) expect(message).not.toContain(secret);
    for (const value of ["https://privateuser:privatepassword@files.oaiusercontent.com/a", "https://files.oaiusercontent.com/a#privatefragment"]) {
      try { validateDownloadUrl(value); throw new Error("unexpected success"); }
      catch (error) { expect(JSON.parse((error as Error).message.split("脱敏诊断：")[1])).toEqual({ protocol: "https:", host: "files.oaiusercontent.com", rejected: true }); }
    }
  });
});
