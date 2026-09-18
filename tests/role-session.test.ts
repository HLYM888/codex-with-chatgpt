import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseRoleChatUrl,
  readRoleBinding,
  readRoleBindings,
  resolveOwnerThreadId,
  roleBindingsFile,
  setRoleBinding,
  viewRoleBinding,
} from "../src/session/roles.js";
import { readSession, resolveConversation, writeSession } from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const WS = "abc123abc123";
const OWNER = "0199b7c8-1111-7000-8000-aaaaaaaaaaaa";
const OTHER_OWNER = "0199b7c8-2222-7000-8000-bbbbbbbbbbbb";
const CONNECTOR = "Codex with ChatGPT · Demo";
const PLANNING_PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const AUDIT_PROJECT = "https://chatgpt.com/g/g-p-7b054aa541f19202971bc6475c8859c9/project";
const PLANNING_CHAT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-planning-0001";
const AUDIT_CHAT = "https://chatgpt.com/g/g-p-7b054aa541f19202971bc6475c8859c9/c/chat-audit-0002";
const OLD_CANDIDATE = "1".repeat(64);
const NEW_CANDIDATE = "2".repeat(64);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
  delete process.env.C2C_STATE_DIR;
});

function stateDir(): string {
  const dir = isolateStateDir();
  dirs.push(dir);
  return dir;
}

describe("role bindings", () => {
  it("binds planning and audit separately without overwriting each other", () => {
    stateDir();
    const first = setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
      title: "规划讨论",
      taskId: "c2c_plan01",
      checkpoint: { protocolState: "INIT", waitingFor: "GPT_PLAN", originalGoal: "分离规划与验收" },
    });
    expect(first.revision).toBe(1);
    expect(first.planning?.url).toBe(PLANNING_CHAT);
    expect(first.planning?.checkpoint?.protocolState).toBe("INIT");
    expect(first.audit).toBeUndefined();

    const second = setRoleBinding(
      WS,
      OWNER,
      "audit",
      {
        url: AUDIT_CHAT,
        projectUrl: AUDIT_PROJECT,
        connectorName: CONNECTOR,
        title: "独立验收",
        candidateSha256: OLD_CANDIDATE,
      },
      { expectedRevision: 1 }
    );
    expect(second.revision).toBe(2);
    expect(second.planning?.url).toBe(PLANNING_CHAT);
    expect(second.planning?.checkpoint?.protocolState).toBe("INIT");
    expect(second.planning?.checkpoint?.chatUrl).toBe(PLANNING_CHAT);
    expect(second.audit?.candidateSha256).toBe(OLD_CANDIDATE);

    const third = setRoleBinding(
      WS,
      OWNER,
      "planning",
      { url: PLANNING_CHAT, title: "规划讨论 v2" },
      { expectedRevision: 2 }
    );
    expect(third.revision).toBe(3);
    expect(third.planning?.title).toBe("规划讨论 v2");
    expect(third.audit?.candidateSha256).toBe(OLD_CANDIDATE);
    expect(third.audit?.projectUrl).toBe(AUDIT_PROJECT);
    expect(readRoleBindings(WS, OWNER).revision).toBe(3);
  });

  it("keeps one file per owner thread and never reads another owner's bindings", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    const ownerFile = roleBindingsFile(WS, OWNER);
    const otherFile = roleBindingsFile(WS, OTHER_OWNER);
    expect(otherFile).not.toBe(ownerFile);
    expect(fs.existsSync(otherFile)).toBe(false);
    expect(viewRoleBinding(WS, OTHER_OWNER, "planning").bound).toBe(false);
    expect(readRoleBinding(WS, OTHER_OWNER, "planning")).toBeNull();

    // The other thread cannot see the first thread's planning binding.
    expect(() =>
      setRoleBinding(WS, OTHER_OWNER, "audit", {
        url: AUDIT_CHAT,
        projectUrl: AUDIT_PROJECT,
        connectorName: CONNECTOR,
      })
    ).toThrow(/planning/);

    const ownerBytes = fs.readFileSync(ownerFile);
    setRoleBinding(WS, OTHER_OWNER, "planning", {
      url: AUDIT_CHAT,
      projectUrl: AUDIT_PROJECT,
      connectorName: CONNECTOR,
    });
    expect(fs.readFileSync(ownerFile)).toEqual(ownerBytes);
  });

  it("requires a verifiable owner UUID and rejects a missing owner", () => {
    stateDir();
    expect(() => resolveOwnerThreadId({})).toThrow(/CODEX_THREAD_ID/);
    expect(() => resolveOwnerThreadId({ CODEX_THREAD_ID: "not-a-uuid" })).toThrow(/UUID/);
    expect(() =>
      resolveOwnerThreadId({ CODEX_THREAD_ID: "not-a-uuid", CODEX_SESSION_ID: OWNER })
    ).toThrow(/CODEX_THREAD_ID/);
    expect(resolveOwnerThreadId({ CODEX_SESSION_ID: OWNER })).toBe(OWNER);
    expect(resolveOwnerThreadId({ CODEX_THREAD_ID: OWNER.toUpperCase() })).toBe(OWNER);

    for (const owner of ["", "../escape", "a/b", "0199b7c8-1111-7000-8000-aaaaaaaaaaa"]) {
      expect(() =>
        setRoleBinding(WS, owner, "planning", {
          url: PLANNING_CHAT,
          projectUrl: PLANNING_PROJECT,
          connectorName: CONNECTOR,
        })
      ).toThrow(/owner thread id/);
    }
    expect(fs.existsSync(roleBindingsFile(WS, OWNER))).toBe(false);
  });

  it("never rewrites the legacy workspace session file", () => {
    const dir = stateDir();
    writeSession(WS, {
      url: "https://chatgpt.com/c/legacy-thread",
      taskId: "c2c_legacy",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    const sessionPath = path.join(dir, "sessions", `${WS}.json`);
    const before = fs.readFileSync(sessionPath);

    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    setRoleBinding(
      WS,
      OWNER,
      "audit",
      { url: AUDIT_CHAT, projectUrl: AUDIT_PROJECT, connectorName: CONNECTOR, candidateSha256: OLD_CANDIDATE },
      { expectedRevision: 1 }
    );

    expect(fs.readFileSync(sessionPath)).toEqual(before);
    const legacy = readSession(WS);
    expect(legacy?.url).toBe("https://chatgpt.com/c/legacy-thread");
    expect(resolveConversation(legacy).mode).toBe("long-chat");
    expect(roleBindingsFile(WS, OWNER)).not.toBe(sessionPath);
  });

  it("rejects the same conversation under a different-looking URL", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "audit",
        {
          url: "https://chatgpt.com/g/g-p-7b054aa541f19202971bc6475c8859c9/c/chat-planning-0001",
          projectUrl: AUDIT_PROJECT,
          connectorName: CONNECTOR,
          candidateSha256: OLD_CANDIDATE,
        },
        { expectedRevision: 1 }
      )
    ).toThrow(/different ChatGPT conversations/);
  });

  it("normalizes www and case when comparing conversation identity", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: "https://www.chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/WWW-Thread-1",
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    expect(readRoleBinding(WS, OWNER, "planning")?.url).toBe(
      "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/WWW-Thread-1"
    );
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "audit",
        {
          url: "https://chatgpt.com/g/g-p-7b054aa541f19202971bc6475c8859c9/c/www-thread-1",
          projectUrl: AUDIT_PROJECT,
          connectorName: CONNECTOR,
          candidateSha256: OLD_CANDIDATE,
        },
        { expectedRevision: 1 }
      )
    ).toThrow(/different ChatGPT conversations/);
    expect(readRoleBindings(WS, OWNER).audit).toBeUndefined();
  });

  it("rejects reusing the same ChatGPT Project for audit", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "audit",
        {
          url: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/audit-thread-77",
          projectUrl: PLANNING_PROJECT,
          connectorName: CONNECTOR,
          candidateSha256: OLD_CANDIDATE,
        },
        { expectedRevision: 1 }
      )
    ).toThrow(/different ChatGPT Projects/);
  });

  it("rejects a chat URL whose Project does not match its own project URL", () => {
    stateDir();
    expect(() =>
      setRoleBinding(WS, OWNER, "planning", {
        url: AUDIT_CHAT,
        projectUrl: PLANNING_PROJECT,
        connectorName: CONNECTOR,
      })
    ).toThrow(/different ChatGPT Project/);
    expect(fs.existsSync(roleBindingsFile(WS, OWNER))).toBe(false);
  });

  it("requires a planning binding before audit", () => {
    stateDir();
    expect(() =>
      setRoleBinding(WS, OWNER, "audit", {
        url: AUDIT_CHAT,
        projectUrl: AUDIT_PROJECT,
        connectorName: CONNECTOR,
      })
    ).toThrow(/planning/);
    expect(fs.existsSync(roleBindingsFile(WS, OWNER))).toBe(false);
  });

  it("requires audit to be project mode with the same connector name", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: "Codex with ChatGPT · A",
    });
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "audit",
        {
          url: AUDIT_CHAT,
          projectUrl: AUDIT_PROJECT,
          connectorName: "Codex with ChatGPT · B",
          candidateSha256: OLD_CANDIDATE,
        },
        { expectedRevision: 1 }
      )
    ).toThrow(/connector/);
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "audit",
        { url: AUDIT_CHAT, projectUrl: AUDIT_PROJECT, candidateSha256: OLD_CANDIDATE },
        { expectedRevision: 1 }
      )
    ).toThrow(/connector/);
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "audit",
        { url: "https://chatgpt.com/c/audit-thread-88", connectorName: "Codex with ChatGPT · A" },
        { expectedRevision: 1 }
      )
    ).toThrow(/project mode/);
    expect(readRoleBindings(WS, OWNER).audit).toBeUndefined();
    expect(readRoleBindings(WS, OWNER).revision).toBe(1);
  });

  it("requires audit to have a complete Project chat identity and candidate", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "audit",
        { url: "https://chatgpt.com/c/audit-ordinary", projectUrl: AUDIT_PROJECT, connectorName: CONNECTOR, candidateSha256: OLD_CANDIDATE },
        { expectedRevision: 1 }
      )
    ).toThrow(/Project chat URL/);
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "audit",
        { projectUrl: AUDIT_PROJECT, connectorName: CONNECTOR, candidateSha256: OLD_CANDIDATE },
        { expectedRevision: 1 }
      )
    ).toThrow(/complete Project chat URL/);
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "audit",
        { url: AUDIT_CHAT, projectUrl: AUDIT_PROJECT, connectorName: CONNECTOR },
        { expectedRevision: 1 }
      )
    ).toThrow(/candidate/);
    setRoleBinding(
      WS,
      OWNER,
      "audit",
      { url: AUDIT_CHAT, projectUrl: AUDIT_PROJECT, connectorName: CONNECTOR, candidateSha256: OLD_CANDIDATE },
      { expectedRevision: 1 }
    );
    expect(readRoleBindings(WS, OWNER).revision).toBe(2);

    const file = roleBindingsFile(WS, OWNER);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { audit: Record<string, unknown> };
    delete raw.audit.candidateSha256;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const missingCandidate = fs.readFileSync(file);
    expect(() => readRoleBindings(WS, OWNER)).toThrow(/candidate/);
    expect(fs.readFileSync(file)).toEqual(missingCandidate);
    raw.audit.candidateSha256 = OLD_CANDIDATE;
    raw.audit.url = "https://chatgpt.com/c/audit-ordinary";
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const damaged = fs.readFileSync(file);
    expect(() => readRoleBindings(WS, OWNER)).toThrow(/Project chat URL/);
    expect(fs.readFileSync(file)).toEqual(damaged);

    expect(() =>
      setRoleBinding(WS, OTHER_OWNER, "planning", {
        url: "https://chatgpt.com/c/planning-ordinary",
        projectUrl: PLANNING_PROJECT,
        connectorName: CONNECTOR,
      })
    ).toThrow(/planning binding requires a Project chat URL/);
    expect(fs.existsSync(roleBindingsFile(WS, OTHER_OWNER))).toBe(false);
  });

  it("requires an explicit candidate when an audit task or iteration changes", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    setRoleBinding(
      WS,
      OWNER,
      "audit",
      {
        url: AUDIT_CHAT,
        projectUrl: AUDIT_PROJECT,
        connectorName: CONNECTOR,
        candidateSha256: OLD_CANDIDATE,
        taskId: "audit-old-task",
        iteration: 1,
        lastState: "DONE",
        checkpoint: { taskId: "audit-old-task", iteration: 1, protocolState: "DONE", waitingFor: "none" },
      },
      { expectedRevision: 1 }
    );
    expect(() =>
      setRoleBinding(WS, OWNER, "audit", { taskId: "audit-new-task" }, { expectedRevision: 2 })
    ).toThrow(/explicit --candidate/);
    expect(() =>
      setRoleBinding(WS, OWNER, "audit", { iteration: 2 }, { expectedRevision: 2 })
    ).toThrow(/explicit --candidate/);
    const sameCandidate = setRoleBinding(
      WS,
      OWNER,
      "audit",
      { taskId: "audit-new-task", iteration: 2, candidateSha256: OLD_CANDIDATE },
      { expectedRevision: 2 }
    );
    expect(sameCandidate.audit).toMatchObject({ taskId: "audit-new-task", iteration: 2, candidateSha256: OLD_CANDIDATE });
    expect(sameCandidate.audit?.lastState).toBeUndefined();
    expect(sameCandidate.audit?.checkpoint).toBeUndefined();
  });

  it("rejects incomplete planning bindings without writing a bound record", () => {
    const cases: Array<{ label: string; patch: Parameters<typeof setRoleBinding>[3]; message: RegExp }> = [
      { label: "task-only", patch: { taskId: "task-only" }, message: /Project chat URL/ },
      { label: "title-only", patch: { title: "title-only" }, message: /nothing to save|Project chat URL/ },
      {
        label: "checkpoint-only",
        patch: { checkpoint: { taskId: "checkpoint-only", iteration: 0, protocolState: "INIT", waitingFor: "GPT_PLAN" } },
        message: /Project chat URL/,
      },
      {
        label: "ordinary-chat",
        patch: { url: "https://chatgpt.com/c/planning-ordinary", projectUrl: PLANNING_PROJECT, connectorName: CONNECTOR },
        message: /Project chat URL/,
      },
      { label: "missing-connector", patch: { url: PLANNING_CHAT, projectUrl: PLANNING_PROJECT }, message: /connector/ },
    ];
    for (const testCase of cases) {
      stateDir();
      expect(() => setRoleBinding(WS, OWNER, "planning", testCase.patch), testCase.label).toThrow(testCase.message);
      expect(fs.existsSync(roleBindingsFile(WS, OWNER)), testCase.label).toBe(false);
      expect(fs.existsSync(`${roleBindingsFile(WS, OWNER)}.lock`), testCase.label).toBe(false);
    }

    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    const file = roleBindingsFile(WS, OWNER);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { planning: Record<string, unknown> };
    delete raw.planning.url;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const damaged = fs.readFileSync(file);
    expect(() => readRoleBindings(WS, OWNER)).toThrow(/planning binding requires a complete Project chat URL/);
    expect(fs.readFileSync(file)).toEqual(damaged);
  });

  it("requires clear-checkpoint before changing a role chat or Project identity", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
      taskId: "identity-task",
      iteration: 1,
      lastState: "DONE",
      checkpoint: { taskId: "identity-task", iteration: 1, protocolState: "DONE", waitingFor: "none" },
    });
    const sameProjectNewChat = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-planning-0003";
    expect(() =>
      setRoleBinding(WS, OWNER, "planning", { url: sameProjectNewChat }, { expectedRevision: 1 })
    ).toThrow(/clear-checkpoint/);
    const clearedChat = setRoleBinding(
      WS,
      OWNER,
      "planning",
      { url: sameProjectNewChat, clearCheckpoint: true },
      { expectedRevision: 1 }
    );
    expect(clearedChat.planning?.url).toBe(sameProjectNewChat);
    expect(clearedChat.planning?.lastState).toBeUndefined();
    expect(clearedChat.planning?.checkpoint).toBeUndefined();

    const withNewProgress = setRoleBinding(
      WS,
      OWNER,
      "planning",
      {
        taskId: "identity-task-2",
        iteration: 1,
        lastState: "EXECUTING",
        checkpoint: { taskId: "identity-task-2", iteration: 1, protocolState: "EXECUTING", waitingFor: "GPT_REVIEW" },
      },
      { expectedRevision: 2 }
    );
    expect(withNewProgress.planning?.checkpoint).toBeDefined();
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "planning",
        { url: AUDIT_CHAT, projectUrl: AUDIT_PROJECT },
        { expectedRevision: 3 }
      )
    ).toThrow(/clear-checkpoint/);
    const clearedProject = setRoleBinding(
      WS,
      OWNER,
      "planning",
      { url: AUDIT_CHAT, projectUrl: AUDIT_PROJECT, clearCheckpoint: true },
      { expectedRevision: 3 }
    );
    expect(clearedProject.planning?.projectUrl).toBe(AUDIT_PROJECT);
    expect(clearedProject.planning?.lastState).toBeUndefined();
    expect(clearedProject.planning?.checkpoint).toBeUndefined();
  });

  it("rejects a stale expected revision and keeps the old file bytes", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    const file = roleBindingsFile(WS, OWNER);
    const before = fs.readFileSync(file);

    expect(() => setRoleBinding(WS, OWNER, "planning", { title: "no revision" })).toThrow(
      /expected-revision/
    );
    expect(() =>
      setRoleBinding(WS, OWNER, "planning", { title: "stale" }, { expectedRevision: 0 })
    ).toThrow(/revision conflict/);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);

    const next = setRoleBinding(WS, OWNER, "planning", { title: "current" }, { expectedRevision: 1 });
    expect(next.revision).toBe(2);
    expect(next.planning?.title).toBe("current");
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("never keeps a previous pass state when the candidate changes", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    setRoleBinding(
      WS,
      OWNER,
      "audit",
      {
        url: AUDIT_CHAT,
        projectUrl: AUDIT_PROJECT,
        connectorName: CONNECTOR,
        candidateSha256: OLD_CANDIDATE,
      },
      { expectedRevision: 1 }
    );
    const file = roleBindingsFile(WS, OWNER);

    // A hand-written pass state must be dropped on read, not carried forward.
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { audit: Record<string, unknown> };
    raw.audit.auditPassed = true;
    raw.audit.verdict = "通过";
    raw.audit.approved = true;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));

    const loaded = readRoleBinding(WS, OWNER, "audit");
    for (const forbidden of ["auditPassed", "verdict", "approved", "pass", "passed", "auditResult"]) {
      expect(Object.keys(loaded ?? {})).not.toContain(forbidden);
    }

    const updated = setRoleBinding(
      WS,
      OWNER,
      "audit",
      { candidateSha256: NEW_CANDIDATE },
      { expectedRevision: 2 }
    );
    expect(updated.audit?.candidateSha256).toBe(NEW_CANDIDATE);
    for (const forbidden of ["auditPassed", "verdict", "approved", "pass", "passed", "auditResult"]) {
      expect(Object.keys(updated.audit ?? {})).not.toContain(forbidden);
    }
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toMatch(/auditPassed|approved|verdict/);
    expect(viewRoleBinding(WS, OWNER, "audit").candidateIsMetadataOnly).toBe(true);
  });

  it("persists role task, iteration, last state and checkpoint fields", () => {
    stateDir();
    const saved = setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
      taskId: "role-task-01",
      iteration: 7,
      lastState: "EXECUTED_LOCAL",
      checkpoint: {
        taskId: "role-task-01",
        iteration: 7,
        protocolState: "EXECUTED_LOCAL",
        waitingFor: "GPT_REVIEW",
      },
    });
    expect(saved.planning).toMatchObject({ taskId: "role-task-01", iteration: 7, lastState: "EXECUTED_LOCAL" });
    expect(readRoleBinding(WS, OWNER, "planning")).toMatchObject({
      taskId: "role-task-01",
      iteration: 7,
      lastState: "EXECUTED_LOCAL",
      checkpoint: { taskId: "role-task-01", iteration: 7, protocolState: "EXECUTED_LOCAL" },
    });
  });

  it("drops the previous candidate checkpoint and last state on candidate switch", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    setRoleBinding(
      WS,
      OWNER,
      "audit",
      {
        url: AUDIT_CHAT,
        projectUrl: AUDIT_PROJECT,
        connectorName: CONNECTOR,
        taskId: "candidate-task",
        iteration: 3,
        lastState: "DONE",
        candidateSha256: OLD_CANDIDATE,
        checkpoint: { taskId: "candidate-task", iteration: 3, protocolState: "DONE", waitingFor: "none" },
      },
      { expectedRevision: 1 }
    );
    const updated = setRoleBinding(
      WS,
      OWNER,
      "audit",
      { candidateSha256: NEW_CANDIDATE },
      { expectedRevision: 2 }
    );
    expect(updated.audit?.candidateSha256).toBe(NEW_CANDIDATE);
    expect(updated.audit?.lastState).toBeUndefined();
    expect(updated.audit?.checkpoint).toBeUndefined();
    expect(updated.audit?.taskId).toBe("candidate-task");
    expect(updated.audit?.iteration).toBe(3);
  });

  it("invalidates old role progress when task or iteration changes", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
      taskId: "old-task",
      iteration: 1,
      lastState: "DONE",
      checkpoint: { taskId: "old-task", iteration: 1, protocolState: "DONE", waitingFor: "none" },
    });
    const taskChanged = setRoleBinding(
      WS,
      OWNER,
      "planning",
      { taskId: "new-task" },
      { expectedRevision: 1 }
    );
    expect(taskChanged.planning).toMatchObject({ taskId: "new-task", iteration: 1 });
    expect(taskChanged.planning?.lastState).toBeUndefined();
    expect(taskChanged.planning?.checkpoint).toBeUndefined();

    const iterationChanged = setRoleBinding(
      WS,
      OWNER,
      "planning",
      { iteration: 2 },
      { expectedRevision: 2 }
    );
    expect(iterationChanged.planning).toMatchObject({ taskId: "new-task", iteration: 2 });
    expect(iterationChanged.planning?.lastState).toBeUndefined();
    expect(iterationChanged.planning?.checkpoint).toBeUndefined();
  });

  it("rejects task or iteration disagreement instead of creating mismatched role state", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
      taskId: "old-task",
      iteration: 1,
      lastState: "DONE",
      checkpoint: { taskId: "old-task", iteration: 1, protocolState: "DONE", waitingFor: "none" },
    });
    const file = roleBindingsFile(WS, OWNER);
    const before = fs.readFileSync(file);
    expect(() =>
      setRoleBinding(
        WS,
        OWNER,
        "planning",
        {
          taskId: "new-task",
          iteration: 2,
          checkpoint: { taskId: "other-task", iteration: 3, protocolState: "INIT", waitingFor: "none" },
        },
        { expectedRevision: 1 }
      )
    ).toThrow(/match/);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);

    const raw = JSON.parse(before.toString("utf8")) as { planning: Record<string, unknown> };
    raw.planning.taskId = "corrupt-task";
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    expect(() => readRoleBindings(WS, OWNER)).toThrow(/taskId.*checkpoint/);
  });

  it("fails closed on damaged stored fields without overwriting the original file", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
      taskId: "strict-task",
      iteration: 1,
      checkpoint: { taskId: "strict-task", iteration: 1, protocolState: "INIT", waitingFor: "GPT_PLAN" },
    });
    const file = roleBindingsFile(WS, OWNER);
    const before = fs.readFileSync(file);
    const raw = JSON.parse(before.toString("utf8")) as { planning: Record<string, unknown> };
    raw.planning.candidateSha256 = "bad-candidate";
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const damaged = fs.readFileSync(file);
    expect(() => readRoleBindings(WS, OWNER)).toThrow(/candidate/);
    expect(fs.readFileSync(file)).toEqual(damaged);
    expect(() => setRoleBinding(WS, OWNER, "planning", { title: "must not write" }, { expectedRevision: 1 })).toThrow(
      /candidate/
    );
    expect(fs.readFileSync(file)).toEqual(damaged);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(before).not.toEqual(damaged);
  });

  it("keeps old bytes and cleans the temp file when atomic rename fails", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    const file = roleBindingsFile(WS, OWNER);
    const before = fs.readFileSync(file);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });
    try {
      expect(() => setRoleBinding(WS, OWNER, "planning", { title: "must not commit" }, { expectedRevision: 1 })).toThrow(
        /simulated rename failure/
      );
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(`${path.basename(file)}.`))).toEqual([]);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("removes a lock that this call created when lock metadata write fails", () => {
    stateDir();
    const file = roleBindingsFile(WS, OWNER);
    const write = vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
      throw new Error("simulated lock write failure");
    });
    try {
      expect(() =>
        setRoleBinding(WS, OWNER, "planning", {
          url: PLANNING_CHAT,
          projectUrl: PLANNING_PROJECT,
          connectorName: CONNECTOR,
        })
      ).toThrow(/simulated lock write failure/);
    } finally {
      write.mockRestore();
    }
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("reports an explicit unbound role without inheriting the legacy session URL", () => {
    stateDir();
    writeSession(WS, {
      url: "https://chatgpt.com/c/legacy-thread",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    const view = viewRoleBinding(WS, OWNER, "planning");
    expect(view.bound).toBe(false);
    expect(view.unbound).toBe(true);
    expect(view.binding).toBeNull();
    expect(view.revision).toBe(0);
    expect(view.workspaceId).toBe(WS);
    expect(view.ownerThreadId).toBe(OWNER);
    expect(JSON.stringify(view)).not.toContain("legacy-thread");
  });
});

describe("role input validation", () => {
  it("rejects unsafe role chat URLs", () => {
    for (const url of [
      PLANNING_CHAT.replace("https:", "http:"),
      PLANNING_CHAT.replace("chatgpt.com", "chatgpt.com.evil.test"),
      PLANNING_CHAT.replace("chatgpt.com", "user:secret@chatgpt.com"),
      PLANNING_CHAT.replace("chatgpt.com", "chatgpt.com:8443"),
      `${PLANNING_CHAT}?display=project`,
      `${PLANNING_CHAT}#main`,
      "https://chatgpt.com/g/g-p-abc/project",
      "https://chatgpt.com/c/",
      "https://chatgpt.com/c/..%2Fetc%2Fpasswd",
      "https://chatgpt.com/c/../../etc/passwd",
      "https://chatgpt.com/g/xyz/c/thread",
    ]) {
      expect(() => parseRoleChatUrl(url)).toThrow(/role chat URL/);
    }
  });

  it("leaves no file or lock behind after a rejected write", () => {
    stateDir();
    const file = roleBindingsFile(WS, OWNER);
    expect(() =>
      setRoleBinding(WS, OWNER, "planning", {
        url: "http://chatgpt.com/c/thread-1",
        projectUrl: PLANNING_PROJECT,
        connectorName: CONNECTOR,
      })
    ).toThrow(/role chat URL/);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("rejects malicious owners, candidates and role names", () => {
    stateDir();
    setRoleBinding(WS, OWNER, "planning", {
      url: PLANNING_CHAT,
      projectUrl: PLANNING_PROJECT,
      connectorName: CONNECTOR,
    });
    for (const candidate of ["a".repeat(63), "z".repeat(64), "../../etc/passwd", ""]) {
      expect(() =>
        setRoleBinding(
          WS,
          OWNER,
          "audit",
          {
            url: AUDIT_CHAT,
            projectUrl: AUDIT_PROJECT,
            connectorName: CONNECTOR,
            candidateSha256: candidate,
          },
          { expectedRevision: 1 }
        )
      ).toThrow(/candidate/);
    }
    expect(() =>
      setRoleBinding(WS, OWNER, "auditor" as never, {
        url: PLANNING_CHAT,
        projectUrl: PLANNING_PROJECT,
        connectorName: CONNECTOR,
      })
    ).toThrow(/role must be one of/);
    expect(readRoleBindings(WS, OWNER).revision).toBe(1);
    expect(fs.existsSync(`${roleBindingsFile(WS, OWNER)}.lock`)).toBe(false);
  });

  it("rejects unsafe role iteration values", () => {
    stateDir();
    for (const iteration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(() =>
        setRoleBinding(WS, OWNER, "planning", {
          url: PLANNING_CHAT,
          projectUrl: PLANNING_PROJECT,
          connectorName: CONNECTOR,
          iteration,
        })
      ).toThrow(/iteration/);
    }
    expect(() =>
      setRoleBinding(WS, OWNER, "planning", {
        url: PLANNING_CHAT,
        projectUrl: PLANNING_PROJECT,
        connectorName: CONNECTOR,
        checkpoint: { taskId: "strict-iteration", iteration: -1, protocolState: "INIT", waitingFor: "none" },
      })
    ).toThrow(/checkpoint iteration/);
    expect(fs.existsSync(roleBindingsFile(WS, OWNER))).toBe(false);
    expect(fs.existsSync(`${roleBindingsFile(WS, OWNER)}.lock`)).toBe(false);
  });
});
