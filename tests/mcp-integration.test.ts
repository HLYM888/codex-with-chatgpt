import fs from "node:fs";
import os from "node:os";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { cleanup, write, makeGitRepo, git } from "./helpers.js";

let root: string;
let bridge: Bridge;
let client: Client;
let accessToken: string;
const tempDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;

function makeTmpDir(name: string): string {
  const safeName = name.replaceAll(/[^A-Za-z0-9_-]/g, "_");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c2c-mcp-${safeName}-`));
  tempDirs.push(dir);
  return dir;
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

beforeAll(async () => {
  const stateDir = makeTmpDir("state");
  process.env.C2C_STATE_DIR = stateDir;
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { react: "^19.0.0" } }));
  write(root, ".env", "API_KEY=supersecret\n");
  // an uncommitted change so git_diff has content
  write(root, "src/index.ts", "export const answer = 43; // changed\n");

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  const tokens = bridge.authStore.issueTokens({
    clientId: "it-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
  });
  accessToken = tokens.accessToken;

  client = new Client({ name: "c2c-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  for (const dir of tempDirs.splice(0)) cleanup(dir);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("MCP tools over Streamable HTTP", () => {
  it("lists scoped material tools alongside existing tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "context_manifest",
      "execution_output",
      "execution_summary",
      "export_material",
      "git_diff",
      "git_status",
      "list_directory",
      "list_material_roots",
      "list_materials",
      "read_file",
      "read_files",
      "read_material",
      "search_workspace",
      "test_status",
      "workspace_info",
    ]);
    // Arbitrary source writes and execution remain absent.
    for (const forbidden of ["write_file", "delete_file", "execute_shell", "git_commit", "install_package"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("workspace_info returns identity and project detection", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const info = jsonOf<{ workspaceId: string; projectType: string; frameworks: string[]; git: { isRepo: boolean; branch: string } }>(result);
    expect(info.workspaceId).toBe(bridge.workspace.id);
    expect(info.projectType).toBe("node");
    expect(info.frameworks).toContain("React");
    expect(info.git.isRepo).toBe(true);
    expect(info.git.branch).toBe("main");
  });

  it("read_file returns hello.txt", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const file = jsonOf<{ content: string; totalLines: number }>(result);
    expect(file.content).toContain("Hello from Codex with ChatGPT!");
  });

  it("read_file denies .env with ACCESS_DENIED_SENSITIVE_FILE and no content", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
    expect(textOf(result)).not.toContain("supersecret");
  });

  it("read_file denies paths outside the workspace", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("read_files exposes structured results while enforcing per-file policy", async () => {
    const result = await client.callTool({ name: "read_files", arguments: {
      items: [{ path: "hello.txt" }, { path: ".env" }], max_result_bytes: 4096,
    } });
    const data = result.structuredContent as { items: { ok: boolean; file?: { sha256: string }; error?: string }[] };
    expect(data.items[0].ok).toBe(true);
    expect(data.items[0].file?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data.items[1]).toMatchObject({ ok: false, error: "ACCESS_DENIED_SENSITIVE_FILE" });
    expect(JSON.stringify(result)).not.toContain("supersecret");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
  });

  it("refuses serialized single-file output beyond the transport budget", async () => {
    write(root, "escaped-single-line.txt", '"'.repeat(150000));
    const result = await client.callTool({ name: "read_file", arguments: { path: "escaped-single-line.txt" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("OUTPUT_TOO_LARGE");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
  });

  it("requires workspace.read for the new batch tool", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "batch-no-read", scopes: ["git.read"] });
    const limitedClient = new Client({ name: "batch-no-read", version: "1.0.0" });
    await limitedClient.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    }));
    try {
      const denied = await limitedClient.callTool({ name: "read_files", arguments: { items: [{ path: "hello.txt" }] } });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
      expect(textOf(denied)).not.toContain("Hello from");
    } finally {
      await limitedClient.close();
    }
  });

  it("returns authorized root aliases and a source-bound change manifest without duplicating text", async () => {
    const roots = await client.callTool({ name: "list_material_roots", arguments: {} });
    expect((roots.structuredContent as any).result.roots).toHaveLength(1);
    expect(JSON.stringify(roots)).not.toContain(root);
    const manifest = await client.callTool({ name: "context_manifest", arguments: { items: [
      { path: "hello.txt", expected_sha256: "0".repeat(64) }, { path: ".env" }, { path: "not-present.txt" },
    ] } });
    const entries = (manifest.structuredContent as any).result.items;
    expect(entries[0]).toMatchObject({ path: "hello.txt", status: "ready", changed: true });
    expect(entries[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entries[0].content).toBeUndefined();
    expect(entries[1]).toMatchObject({ status: "unavailable", error: "ACCESS_DENIED_SENSITIVE_FILE" });
    expect(entries[2]).toMatchObject({ status: "unavailable", error: "FILE_NOT_FOUND" });
    expect(JSON.stringify(manifest)).not.toContain("supersecret");
  });

  it("exports exact bytes through a resource link across stateless requests and rejects a changed source", async () => {
    const exported = await client.callTool({ name: "export_material", arguments: { path: "hello.txt" } });
    const link = (exported.content as any[]).find((item) => item.type === "resource_link");
    expect(link.uri).toContain(`c2c-material://${bridge.workspace.id}/`);
    const contents = await client.readResource({ uri: link.uri });
    expect(Buffer.from((contents.contents[0] as any).blob, "base64")).toEqual(fs.readFileSync(path.join(root, "hello.txt")));
    const original = fs.readFileSync(path.join(root, "hello.txt"));
    fs.writeFileSync(path.join(root, "hello.txt"), "changed while reference exists");
    try { await expect(client.readResource({ uri: link.uri })).rejects.toThrow(); }
    finally { fs.writeFileSync(path.join(root, "hello.txt"), original); }
  });

  it("list_directory lists the tree", async () => {
    const result = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 2 } });
    const listing = jsonOf<{ entries: { path: string }[] }>(result);
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
  });

  it("search_workspace finds matches", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "answer" } });
    const search = jsonOf<{ matches: { path: string; line: number }[] }>(result);
    expect(search.matches.some((match) => match.path === "src/index.ts")).toBe(true);
  });

  it("git_status reports the dirty file", async () => {
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const status = jsonOf<{ isRepo: boolean; unstaged: { path: string }[] }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
  });

  it("git_diff shows the change", async () => {
    const result = await client.callTool({ name: "git_diff", arguments: { mode: "unstaged" } });
    const diff = jsonOf<{ diff: string; hasMore: boolean }>(result);
    expect(diff.diff).toContain("answer = 43");
    expect(diff.hasMore).toBe(false);
  });

  it("git_diff paginates large diffs", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `content line ${i}`).join("\n");
    write(root, "big-change.txt", big);
    git(root, "add", "big-change.txt");
    const first = jsonOf<{ hasMore: boolean; nextOffset: number; totalBytes: number; returnedBytes: number }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged", max_bytes: 4096 } })
    );
    expect(first.hasMore).toBe(true);
    expect(first.returnedBytes).toBeLessThanOrEqual(4096);
    const second = jsonOf<{ offset: number; diff: string }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", max_bytes: 4096, offset: first.nextOffset },
      })
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
    git(root, "reset", "big-change.txt");
  });

  it("execution_summary and test_status read harness records", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_test1",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "27 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
      notes: `review api_key=sk-proj-${"A".repeat(40)} ghp_${"B".repeat(30)}`,
    });
    const summary = jsonOf<{ records: { taskId: string; notes?: string }[] }>(
      await client.callTool({ name: "execution_summary", arguments: {} })
    );
    expect(summary.records[0].taskId).toBe("c2c_test1");
    expect(summary.records[0].notes).not.toContain("sk-proj-");
    expect(summary.records[0].notes).not.toContain("ghp_");
    expect(summary.records[0].notes).toContain("api_key=[REDACTED]");
    expect(summary.records[0].notes).toContain("[REDACTED]");

    const status = jsonOf<{ available: boolean; tests: string; outputAvailable: boolean; outputId: number | null }>(
      await client.callTool({ name: "test_status", arguments: {} })
    );
    expect(status.available).toBe(true);
    expect(status.tests).toBe("27 passed");
    expect(status.outputAvailable).toBe(false);
    expect(status.outputId).toBeNull();
  });

  it("execution_output lists readable items and refuses restricted bodies", async () => {
    const readable = saveExecutionOutput(bridge.workspace.id, {
      command: "pnpm test",
      raw: "FAIL src/a.test.ts\nAssertionError: expected true",
      exitCode: 1,
    });
    const hidden = saveExecutionOutput(bridge.workspace.id, {
      command: "print-key",
      raw: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
      exitCode: 0,
    });
    const list = jsonOf<{ items: { id: number; status: string; command: string; text?: string }[] }>(
      await client.callTool({ name: "execution_output", arguments: { action: "list" } })
    );
    expect(list.items.some((item) => item.id === readable.id && item.status === "readable")).toBe(true);
    expect(list.items.some((item) => item.id === hidden.id && item.status === "restricted")).toBe(true);
    expect(list.items.every((item) => item.text === undefined)).toBe(true);

    const body = jsonOf<{ text: string }>(
      await client.callTool({ name: "execution_output", arguments: { action: "read", id: readable.id } })
    );
    expect(body.text).toContain("AssertionError");

    const projectToken = `sk-proj-${"A".repeat(40)}`;
    const tokenOutput = saveExecutionOutput(bridge.workspace.id, {
      command: "print-project-token",
      raw: `token=${projectToken}`,
      exitCode: 0,
    });
    const tokenBody = jsonOf<{ text: string }>(
      await client.callTool({ name: "execution_output", arguments: { action: "read", id: tokenOutput.id } })
    );
    expect(tokenBody.text).not.toContain(projectToken);
    expect(tokenBody.text).toContain("[REDACTED]");

    const denied = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: hidden.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("OUTPUT_RESTRICTED");
    expect(textOf(denied)).not.toContain("BEGIN RSA");

    const missing = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: 999999 },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("NOT_FOUND");
  });

  it("enforces scopes per tool", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "limited", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    const denied = await limitedClient.callTool({ name: "git_diff", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    const outputDenied = await limitedClient.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    expect(outputDenied.isError).toBe(true);
    expect(textOf(outputDenied)).toContain("INSUFFICIENT_SCOPE");
    const allowed = await limitedClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowed.isError ?? false).toBe(false);
    await limitedClient.close();
  });

  it("reads code from an authorized alias and refuses a revoked directory listing", async () => {
    const config = path.join(process.env.C2C_STATE_DIR!, "materials", `${bridge.workspace.id}.json`);
    const materialRoot = makeTmpDir("authorized-material");
    write(materialRoot, "code.py", "first\n中文第二行\nthird\n");
    const settings = { version: 1, workspaceRoot: bridge.workspace.root, roots: [{ alias: "source", root: materialRoot }] };
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify(settings));
    try {
      const read = await client.callTool({ name: "read_material", arguments: { root_alias: "source", path: "code.py", operation: "read", start: 2, count: 1 } });
      expect(read.isError).not.toBe(true);
      const data = (read.structuredContent as { result: Record<string, unknown> }).result;
      expect(data.content).toBe("中文第二行");
      expect(data.source).toMatchObject({ rootAlias: "source", path: "code.py" });
      const original = Workspace.prototype.listDirectory;
      const spy = vi.spyOn(Workspace.prototype, "listDirectory").mockImplementationOnce(async function(this: Workspace, ...args) {
        const listing = await original.apply(this, args);
        fs.writeFileSync(config, JSON.stringify({ ...settings, roots: [] }));
        return listing;
      });
      try {
        const listing = await client.callTool({ name: "list_materials", arguments: { root_alias: "source" } });
        expect(listing.isError).toBe(true);
        expect(textOf(listing)).not.toContain("code.py");
      } finally { spy.mockRestore(); }
    } finally { fs.unlinkSync(config); }
  });

  it("git_diff over MCP excludes sensitive files like .npmrc and service-account*.json", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=supersecret-npm-token\n");
    write(root, "service-account-test.json", '{"private_key": "supersecret-sa-key"}\n');
    write(root, "src/visible.ts", "export const visible = 'safe-change';\n");

    git(root, "add", "-f", ".npmrc", "service-account-test.json", "src/visible.ts");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).toContain("safe-change");
    expect(result.diff).not.toContain("supersecret-npm-token");
    expect(result.diff).not.toContain("supersecret-sa-key");

    git(root, "rm", "-f", "--cached", ".npmrc", "service-account-test.json", "src/visible.ts");
  });

  it("git_diff over MCP blocks sensitive-to-safe renames from leaking original content", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=mcp-secret-token-123\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add secret to rename");

    git(root, "mv", ".npmrc", "public_harmless.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("mcp-secret-token-123");
    expect(result.diff).not.toContain("public_harmless.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("git_diff over MCP with path='src' blocks cross-boundary rename leaks from root secrets", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=root-mcp-scoped-secret\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add root secret for scoped test");

    // Rename root .npmrc to src/public.txt
    git(root, "mv", ".npmrc", "src/public.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", path: "src" },
      })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("root-mcp-scoped-secret");
    expect(result.diff).not.toContain("src/public.txt");

    git(root, "reset", "--hard", "HEAD");
  });
});
