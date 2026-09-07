import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { MaterialCatalog } from "../src/materials/catalog.js";
import { parseMaterial, type MaterialRequest } from "../src/materials/parser.js";

const python = process.env.C2C_TEST_PYTHON;
describe.skipIf(!python)("real material subprocess integration", () => {
  let root: string;
  let catalog: MaterialCatalog;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-parser-"));
    const workspace = new Workspace(root);
    const config = path.join(root, "config.json");
    fs.writeFileSync(config, JSON.stringify({ version: 1, workspaceRoot: workspace.root, pythonExecutable: python }));
    catalog = new MaterialCatalog(workspace, config);
    const generated = spawnSync(python!, ["-I", "-X", "utf8", "scripts/make_material_fixtures.py", path.join(root, "fixtures")],
      { windowsHide: true, shell: false, encoding: "utf8", timeout: 30000 });
    expect(generated.status, generated.stderr).toBe(0);
  }, 40000);
  afterAll(() => { if (root?.startsWith(path.join(os.tmpdir(), "c2c-parser-"))) fs.rmSync(root, { recursive: true, force: true }); });
  const read = (name: string, request: MaterialRequest) => parseMaterial(catalog, fs.readFileSync(path.join(root, "fixtures", name)), request);
  it.each([
    ["sample.pdf", { format: "pdf", operation: "read", page: 1, count: 2 }],
    ["sample.xlsx", { format: "xlsx", operation: "read", sheet: "Sheet1", range: "A1:F7" }],
    ["sample.docx", { format: "docx", operation: "read" }],
    ["sample.pptx", { format: "pptx", operation: "read" }],
    ["sample-gbk.csv", { format: "csv", operation: "read", encoding: "gbk" }],
  ] as [string, MaterialRequest][])("parses %s through the real IPC boundary", async (name, request) => {
    const parsed = await read(name, request);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.format).toBe(request.format);
    expect((parsed.data.source as { sha256: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("returns native PNG image bytes for both bitmap and scanned PDF", async () => {
    for (const [name, request] of [["visual.png", { format: "image", operation: "image" }],
      ["sample.pdf", { format: "pdf", operation: "image", page: 2 }]] as [string, MaterialRequest][]) {
      const parsed = await read(name, request);
      expect(parsed.image?.mimeType).toBe("image/png");
      expect(Buffer.from(parsed.image!.data, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  });
  it("preserves structured errors from worker exit code 2", async () => {
    await expect(read("encrypted.pdf", { format: "pdf", operation: "overview" })).rejects.toMatchObject({ code: "ENCRYPTED_FILE" });
    await expect(read("disguised.xlsx", { format: "xlsx", operation: "overview" })).rejects.toMatchObject({ code: "FORMAT_MISMATCH" });
  });
  it("terminates a stuck parser instead of adopting a partial output", async () => {
    const worker = path.join(root, "stuck.py");
    fs.writeFileSync(worker, "import sys,time\nsys.stdin.buffer.read()\ntime.sleep(60)\n");
    await expect(parseMaterial(catalog, Buffer.from("x"), { format: "csv", operation: "overview" },
      { worker, timeoutMs: 100 })).rejects.toMatchObject({ code: "PARSER_TIMEOUT" });
  });
});
