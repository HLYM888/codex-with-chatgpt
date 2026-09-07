import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withInboxGuard } from "../src/materials/inbox-guard.js";

const python = process.env.C2C_TEST_PYTHON;
const windowsRuntimeAvailable = process.platform === "win32" && typeof python === "string" && fs.existsSync(python);
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-inbox-guard-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    if (path.basename(root).startsWith("c2c-inbox-guard-")) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("withInboxGuard", () => {
  const windowsIt = windowsRuntimeAvailable ? it : it.skip;

  windowsIt("locks the inbox and delivery directory before callback, then releases both", async () => {
    const root = makeRoot();
    const inbox = path.join(root, ".local", "c2c-inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const delivery = path.join(inbox, "delivery-001");
    const movedDelivery = path.join(inbox, "delivery-001-moved");
    const movedInbox = path.join(root, ".local", "c2c-inbox-moved");

    await withInboxGuard(python!, root, inbox, delivery, () => {
      expect(fs.existsSync(delivery)).toBe(true);
      expect(() => fs.renameSync(inbox, movedInbox)).toThrow();
      expect(() => fs.renameSync(delivery, movedDelivery)).toThrow();
      fs.writeFileSync(path.join(delivery, "payload.txt"), "held", { flag: "wx" });
    });

    expect(() => fs.renameSync(delivery, movedDelivery)).not.toThrow();
    expect(() => fs.renameSync(inbox, movedInbox)).not.toThrow();
  });

  windowsIt("blocks renaming the parent that contains the locked workspace", async () => {
    const container = makeRoot();
    const root = path.join(container, "workspace");
    const inbox = path.join(root, "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const moved = `${container}-moved`;

    await withInboxGuard(python!, root, inbox, path.join(inbox, "delivery"), () => {
      expect(() => fs.renameSync(container, moved)).toThrow();
    });

    expect(() => fs.renameSync(container, moved)).not.toThrow();
    expect(() => fs.renameSync(moved, container)).not.toThrow();
  });

  windowsIt("rejects a reparse-point inbox after the lock is released", async () => {
    const root = makeRoot();
    const inbox = path.join(root, "inbox");
    const external = path.join(root, "external");
    fs.mkdirSync(inbox);
    fs.mkdirSync(external);
    const movedInbox = path.join(root, "inbox-real");
    fs.renameSync(inbox, movedInbox);
    fs.symlinkSync(external, inbox, "junction");

    await expect(withInboxGuard(python!, root, inbox, path.join(inbox, "delivery"), () => "unreachable"))
      .rejects.toMatchObject({ code: "INBOX_REPARSE_POINT" });
  });

  windowsIt("rejects an asynchronous callback instead of releasing during it", async () => {
    const root = makeRoot();
    const inbox = path.join(root, "inbox");
    fs.mkdirSync(inbox);
    let invoked = false;
    await expect(withInboxGuard(python!, root, inbox, path.join(inbox, "delivery"), async () => {
      invoked = true;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "late";
    })).rejects.toMatchObject({ code: "INBOX_GUARD_INVALID" });
    expect(invoked).toBe(false);
  });
});
