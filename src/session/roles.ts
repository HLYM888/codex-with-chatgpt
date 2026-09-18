import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  mergeSession,
  normalizeProjectUrl,
  projectIdFromUrl,
  PROTOCOL_STATES,
  WAITING_FOR,
  type SavedSession,
  type SessionPatch,
  type TaskCheckpoint,
} from "./state.js";

/**
 * Role bindings keep planning and audit windows apart without touching the
 * workspace session file. Each binding file belongs to exactly one workspace
 * and one Codex owner thread, so a second thread never inherits another
 * thread's planning chat and a role write never overwrites the original
 * workspace session or checkpoint.
 */
export const ROLE_NAMES = ["planning", "audit"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const ROLE_SCHEMA_VERSION = 1;

export const OWNER_THREAD_ENV = "CODEX_THREAD_ID";
export const OWNER_SESSION_ENV = "CODEX_SESSION_ID";

const OWNER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const PROJECT_SLUG_RE = /^(g-p-[a-zA-Z0-9]+)(?:-[a-zA-Z0-9]+)*$/;

/** One role's own window. Never a claim that the other role agreed. */
export interface RoleBinding {
  url?: string;
  projectUrl?: string;
  connectorName?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  savedAt: string;
  /**
   * Exact candidate hash this binding refers to. Metadata only: it never
   * asserts that files were verified, that the candidate was built, or that
   * any audit passed.
   */
  candidateSha256?: string;
  checkpoint?: TaskCheckpoint;
}

export interface RoleBindingPatch extends SessionPatch {
  candidateSha256?: string;
}

export interface RoleBindings {
  schemaVersion: number;
  workspaceId: string;
  ownerThreadId: string;
  revision: number;
  planning?: RoleBinding;
  audit?: RoleBinding;
}

export interface RoleBindingView {
  ok: true;
  role: RoleName;
  bound: boolean;
  unbound: boolean;
  workspaceId: string;
  ownerThreadId: string;
  revision: number;
  binding: RoleBinding | null;
  /** A candidate hash is bound metadata; it is never an audit verdict. */
  candidateIsMetadataOnly: true;
}

export interface RoleSetOptions {
  /** Required whenever a role file already exists. */
  expectedRevision?: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const hasOwn = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requiredStoredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`role binding ${label} is invalid`);
  }
  return value.trim();
}

function optionalStoredString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  if (!hasOwn(record, key)) return undefined;
  return requiredStoredString(record, key, label);
}

export function isOwnerThreadId(value: unknown): value is string {
  return typeof value === "string" && OWNER_UUID_RE.test(value.trim());
}

export function assertOwnerThreadId(value: unknown): string {
  if (!isOwnerThreadId(value)) {
    throw new Error(
      `owner thread id must be a UUID taken from ${OWNER_THREAD_ENV} (or ${OWNER_SESSION_ENV} when ${OWNER_THREAD_ENV} is absent); refusing to bind roles without a verifiable owner`
    );
  }
  return value.trim().toLowerCase();
}

/**
 * The owner is the complete current Codex thread id. A missing thread id may
 * fall back to CODEX_SESSION_ID; a present-but-invalid value never falls back,
 * and the owner is never guessed from a title, cwd or an old session file.
 */
export function resolveOwnerThreadId(env: NodeJS.ProcessEnv = process.env): string {
  const rawThread = (env[OWNER_THREAD_ENV] ?? "").trim();
  if (rawThread !== "") {
    if (!OWNER_UUID_RE.test(rawThread)) {
      throw new Error(
        `${OWNER_THREAD_ENV} is not a valid UUID; refusing to bind roles to an unverifiable owner`
      );
    }
    return rawThread.toLowerCase();
  }
  const rawSession = (env[OWNER_SESSION_ENV] ?? "").trim();
  if (rawSession === "") {
    throw new Error(
      `owner thread id missing: ${OWNER_THREAD_ENV} is not set (and neither is ${OWNER_SESSION_ENV}); role bindings require a verifiable Codex thread`
    );
  }
  if (!OWNER_UUID_RE.test(rawSession)) {
    throw new Error(`${OWNER_SESSION_ENV} is not a valid UUID; refusing to bind roles to an unverifiable owner`);
  }
  return rawSession.toLowerCase();
}

function assertWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || !WORKSPACE_ID_RE.test(value.trim())) {
    throw new Error("workspace id must be a plain identifier such as the c2c workspace hash");
  }
  return value.trim();
}

function assertRoleName(value: unknown): RoleName {
  if (typeof value !== "string" || !(ROLE_NAMES as readonly string[]).includes(value.trim())) {
    throw new Error(`role must be one of ${ROLE_NAMES.join(", ")}`);
  }
  return value.trim() as RoleName;
}

export function roleBindingsDir(): string {
  return path.join(getStateDir(), "roles");
}

/** One file per workspace and owner thread; the owner is part of the name. */
export function roleBindingsFile(workspaceId: string, ownerThreadId: string): string {
  const workspace = assertWorkspaceId(workspaceId);
  const owner = assertOwnerThreadId(ownerThreadId);
  return path.join(roleBindingsDir(), `${workspace}.${owner}.json`);
}

export interface ChatUrlIdentity {
  /** Normalized URL without www, credentials, port, query or hash. */
  url: string;
  conversationId: string;
  projectId: string | null;
}

function normalizeConversationId(segment: string): string | null {
  if (!segment || segment.includes("%") || segment.includes(".")) return null;
  if (!CONVERSATION_ID_RE.test(segment)) return null;
  return segment.toLowerCase();
}

/**
 * Accepts only `https://chatgpt.com/c/<id>` or
 * `https://chatgpt.com/g/g-p-<id>/c/<id>`: HTTPS, no credentials, no port,
 * no query and no hash. Anything else is refused rather than guessed.
 */
const ROLE_CHAT_URL_ERROR =
  "role chat URL must be https://chatgpt.com/c/<id> or https://chatgpt.com/g/g-p-<id>/c/<id> with no credentials, port, query or hash";

export function parseRoleChatUrl(value: string): ChatUrlIdentity {
  let parsed: URL;
  try {
    parsed = new URL(typeof value === "string" ? value.trim() : "");
  } catch {
    throw new Error(ROLE_CHAT_URL_ERROR);
  }
  if (parsed.protocol !== "https:") throw new Error(ROLE_CHAT_URL_ERROR);
  if (parsed.username || parsed.password || parsed.port) throw new Error(ROLE_CHAT_URL_ERROR);
  if (parsed.search || parsed.hash) throw new Error(ROLE_CHAT_URL_ERROR);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "chatgpt.com") throw new Error(ROLE_CHAT_URL_ERROR);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0].toLowerCase() === "c") {
    const conversationId = normalizeConversationId(segments[1]);
    if (!conversationId) throw new Error(ROLE_CHAT_URL_ERROR);
    return { url: `https://chatgpt.com/c/${segments[1]}`, conversationId, projectId: null };
  }
  if (segments.length === 4 && segments[0].toLowerCase() === "g" && segments[2].toLowerCase() === "c") {
    const slug = segments[1];
    const projectMatch = PROJECT_SLUG_RE.exec(slug);
    const conversationId = normalizeConversationId(segments[3]);
    if (!projectMatch || !conversationId) throw new Error(ROLE_CHAT_URL_ERROR);
    return {
      url: `https://chatgpt.com/g/${slug}/c/${segments[3]}`,
      conversationId,
      projectId: projectMatch[1].toLowerCase(),
    };
  }
  throw new Error(ROLE_CHAT_URL_ERROR);
}

function projectIdOf(projectUrl: string | undefined): string | null {
  if (!projectUrl) return null;
  const raw = projectIdFromUrl(projectUrl);
  return raw ? raw.toLowerCase() : null;
}

function assertCompleteProjectChatBinding(
  binding: RoleBinding,
  role: RoleName,
  requireCandidate: boolean
): void {
  if (!binding.url) {
    throw new Error(`${role} binding requires a complete Project chat URL`);
  }
  const identity = parseRoleChatUrl(binding.url);
  if (!identity.projectId) {
    throw new Error(`${role} binding requires a Project chat URL`);
  }
  if (!binding.projectUrl) {
    throw new Error(`${role} binding requires a Project URL`);
  }
  const projectId = projectIdOf(binding.projectUrl);
  if (!projectId || projectId !== identity.projectId) {
    throw new Error(`${role} binding chat URL and Project URL must refer to the same Project`);
  }
  if (!binding.connectorName || binding.connectorName.trim() === "") {
    throw new Error(`${role} binding requires a connector name`);
  }
  if (requireCandidate && !binding.candidateSha256) {
    throw new Error("audit binding requires an explicit candidate SHA256");
  }
}

function chatIdentityForBinding(binding: RoleBinding | undefined): ChatUrlIdentity | null {
  if (!binding) return null;
  const chatUrl = binding.url ?? binding.checkpoint?.chatUrl;
  return chatUrl ? parseRoleChatUrl(chatUrl) : null;
}

function projectIdentityForBinding(binding: RoleBinding | undefined): string | null {
  if (!binding) return null;
  return projectIdOf(binding.projectUrl ?? binding.checkpoint?.projectUrl);
}

function normalizeCandidate(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA256_RE.test(value.trim())) {
    throw new Error("candidate must be a 64-character hex SHA256 value");
  }
  return value.trim().toLowerCase();
}

function emptyBindings(workspaceId: string, ownerThreadId: string): RoleBindings {
  return {
    schemaVersion: ROLE_SCHEMA_VERSION,
    workspaceId,
    ownerThreadId,
    revision: 0,
  };
}

function readStoredCheckpoint(raw: unknown): TaskCheckpoint {
  const record = asRecord(raw);
  if (!record) throw new Error("role binding checkpoint has an invalid shape");
  const taskId = requiredStoredString(record, "taskId", "checkpoint.taskId");
  const protocolState = requiredStoredString(record, "protocolState", "checkpoint.protocolState");
  const waitingFor = requiredStoredString(record, "waitingFor", "checkpoint.waitingFor");
  if (!(PROTOCOL_STATES as readonly string[]).includes(protocolState)) {
    throw new Error("role binding checkpoint.protocolState is invalid");
  }
  if (!(WAITING_FOR as readonly string[]).includes(waitingFor)) {
    throw new Error("role binding checkpoint.waitingFor is invalid");
  }
  if (!isNonNegativeSafeInteger(record.iteration)) {
    throw new Error("role binding checkpoint.iteration is invalid");
  }
  const iteration = record.iteration;
  const chatUrlRaw = optionalStoredString(record, "chatUrl", "checkpoint.chatUrl");
  const projectUrlRaw = optionalStoredString(record, "projectUrl", "checkpoint.projectUrl");
  const chatIdentity = chatUrlRaw ? parseRoleChatUrl(chatUrlRaw) : null;
  const projectUrl = projectUrlRaw ? normalizeProjectUrl(projectUrlRaw) : null;
  if (projectUrlRaw && !projectUrl) throw new Error("role binding checkpoint.projectUrl is invalid");
  if (chatIdentity?.projectId && projectIdOf(projectUrl ?? undefined) !== chatIdentity.projectId) {
    throw new Error("role binding checkpoint chat URL belongs to a different ChatGPT Project");
  }
  return {
    taskId,
    iteration,
    protocolState: protocolState as TaskCheckpoint["protocolState"],
    waitingFor: waitingFor as TaskCheckpoint["waitingFor"],
    originalGoal: optionalStoredString(record, "originalGoal", "checkpoint.originalGoal"),
    completedSubtasks: optionalStoredString(record, "completedSubtasks", "checkpoint.completedSubtasks"),
    knownIssues: optionalStoredString(record, "knownIssues", "checkpoint.knownIssues"),
    nextExpectedStep: optionalStoredString(record, "nextExpectedStep", "checkpoint.nextExpectedStep"),
    chatUrl: chatIdentity?.url,
    projectUrl: projectUrl ?? undefined,
    updatedAt: requiredStoredString(record, "updatedAt", "checkpoint.updatedAt"),
  };
}

/**
 * Read only known fields. Unknown keys (for example a hand-written
 * `auditPassed` or `verdict`) are dropped instead of being carried forward,
 * so this file can never accumulate a fake pass record for a changed
 * candidate.
 */
function readStoredRoleBinding(raw: unknown, role: RoleName): RoleBinding | undefined {
  if (raw === undefined) return undefined;
  const record = asRecord(raw);
  if (!record) throw new Error(`role binding ${role} has an invalid shape`);
  const savedAt = requiredStoredString(record, "savedAt", `${role}.savedAt`);
  const urlRaw = optionalStoredString(record, "url", `${role}.url`);
  const projectUrlRaw = optionalStoredString(record, "projectUrl", `${role}.projectUrl`);
  const projectUrl = projectUrlRaw ? normalizeProjectUrl(projectUrlRaw) : null;
  if (projectUrlRaw && !projectUrl) throw new Error(`role binding ${role}.projectUrl is invalid`);
  const identity = urlRaw ? parseRoleChatUrl(urlRaw) : null;
  if (identity?.projectId && projectIdOf(projectUrl ?? undefined) !== identity.projectId) {
    throw new Error(`role binding ${role} chat URL belongs to a different ChatGPT Project`);
  }
  const binding: RoleBinding = {
    savedAt,
  };
  if (identity) binding.url = identity.url;
  if (projectUrl) binding.projectUrl = projectUrl;
  const connectorName = optionalStoredString(record, "connectorName", `${role}.connectorName`);
  if (connectorName) binding.connectorName = connectorName;
  const title = optionalStoredString(record, "title", `${role}.title`);
  if (title) binding.title = title;
  const taskId = optionalStoredString(record, "taskId", `${role}.taskId`);
  if (taskId) binding.taskId = taskId;
  if (hasOwn(record, "iteration")) {
    if (!isNonNegativeSafeInteger(record.iteration)) throw new Error(`role binding ${role}.iteration is invalid`);
    binding.iteration = record.iteration;
  }
  const lastState = optionalStoredString(record, "lastState", `${role}.lastState`);
  if (lastState) binding.lastState = lastState;
  if (hasOwn(record, "candidateSha256")) {
    const candidate = normalizeCandidate(record.candidateSha256);
    if (candidate) binding.candidateSha256 = candidate;
  }
  if (hasOwn(record, "checkpoint")) {
    const checkpoint = readStoredCheckpoint(record.checkpoint);
    if (binding.taskId && checkpoint.taskId !== binding.taskId) {
      throw new Error(`role binding ${role} taskId does not match its checkpoint`);
    }
    if (binding.iteration !== undefined && checkpoint.iteration !== binding.iteration) {
      throw new Error(`role binding ${role} iteration does not match its checkpoint`);
    }
    if (identity && checkpoint.chatUrl && parseRoleChatUrl(checkpoint.chatUrl).conversationId !== identity.conversationId) {
      throw new Error(`role binding ${role} checkpoint refers to a different ChatGPT conversation`);
    }
    if (projectUrl && checkpoint.projectUrl && projectIdOf(projectUrl) !== projectIdOf(checkpoint.projectUrl)) {
      throw new Error(`role binding ${role} checkpoint belongs to a different ChatGPT Project`);
    }
    binding.checkpoint = checkpoint;
  }
  return binding;
}

interface LoadedRoleBindings {
  bindings: RoleBindings;
  exists: boolean;
}

/** Fail closed on a damaged or foreign file instead of silently replacing it. */
function loadRoleBindings(file: string, workspaceId: string, ownerThreadId: string): LoadedRoleBindings {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { bindings: emptyBindings(workspaceId, ownerThreadId), exists: false };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("role binding file is not valid JSON; refusing to overwrite it");
  }
  const record = asRecord(parsed);
  if (!record) throw new Error("role binding file has an invalid shape; refusing to overwrite it");
  if (record.schemaVersion !== ROLE_SCHEMA_VERSION) {
    throw new Error(`unsupported role binding schemaVersion ${String(record.schemaVersion)}`);
  }
  const fileWorkspace = asString(record.workspaceId);
  if (!fileWorkspace || fileWorkspace.toLowerCase() !== workspaceId.toLowerCase()) {
    throw new Error("role binding file belongs to a different workspace");
  }
  const fileOwner = asString(record.ownerThreadId);
  if (!fileOwner || !OWNER_UUID_RE.test(fileOwner) || fileOwner.toLowerCase() !== ownerThreadId.toLowerCase()) {
    throw new Error("role binding file belongs to a different owner thread");
  }
  const revision = record.revision;
  if (!isNonNegativeSafeInteger(revision)) {
    throw new Error("role binding file has an invalid revision");
  }
  const planning = readStoredRoleBinding(record.planning, "planning");
  const audit = readStoredRoleBinding(record.audit, "audit");
  const bindings: RoleBindings = {
    schemaVersion: ROLE_SCHEMA_VERSION,
    workspaceId,
    ownerThreadId,
    revision,
    planning,
    audit,
  };
  if (planning) assertCompleteProjectChatBinding(planning, "planning", false);
  if (audit) {
    if (!planning) throw new Error("audit binding requires an existing planning binding");
    assertCompleteProjectChatBinding(audit, "audit", true);
  }
  assertRolePair(bindings);
  return {
    bindings,
    exists: true,
  };
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin as a last resort */
    }
  }
}

/**
 * Small synchronous lock around read-modify-write. A lock owned by this call
 * is released on every handled failure; a process crash or external I/O
 * failure can still leave an OS-level lock artifact behind.
 */
function withRoleFileLock<T>(file: string, run: () => T): T {
  ensureDir(path.dirname(file));
  const lockFile = `${file}.lock`;
  let acquired = false;
  let lockOwned = false;
  for (let attempt = 0; attempt < 20 && !acquired; attempt += 1) {
    let handle: number | undefined;
    try {
      handle = fs.openSync(lockFile, "wx", 0o600);
      lockOwned = true;
      try {
        fs.writeSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        fs.closeSync(handle);
        handle = undefined;
      }
      acquired = true;
    } catch (error) {
      if (handle !== undefined) {
        try {
          fs.closeSync(handle);
        } catch {
          /* best effort before removing this call's own lock */
        }
      }
      if (lockOwned && !acquired) {
        try {
          fs.rmSync(lockFile, { force: true });
        } catch {
          /* external failure may leave the lock artifact for later diagnosis */
        }
        lockOwned = false;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      sleepSync(25);
    }
  }
  if (!acquired) {
    throw new Error(`role binding file is locked by another c2c process: ${lockFile}`);
  }
  try {
    return run();
  } finally {
    if (lockOwned) {
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {
        /* external failure may leave the lock artifact for later diagnosis */
      }
    }
  }
}

function writeRoleBindingsAtomic(file: string, data: RoleBindings): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
    fd = fs.openSync(temp, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      /* best effort on platforms without chmod semantics */
    }
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best effort; the old target remains untouched if rename failed */
    }
  }
}

function assertRolePair(bindings: RoleBindings): void {
  const { planning, audit } = bindings;
  if (!planning || !audit) return;
  assertCompleteProjectChatBinding(planning, "planning", false);
  assertCompleteProjectChatBinding(audit, "audit", true);
  const planningProject = projectIdOf(planning.projectUrl);
  const auditProject = projectIdOf(audit.projectUrl);
  if (!planningProject || !auditProject) {
    throw new Error("both role bindings require a valid ChatGPT Project URL");
  }
  if (planningProject === auditProject) {
    throw new Error("planning and audit must use different ChatGPT Projects");
  }
  const planningChat = planning.url ? parseRoleChatUrl(planning.url).conversationId : null;
  const auditChat = audit.url ? parseRoleChatUrl(audit.url).conversationId : null;
  if (planningChat && auditChat && planningChat === auditChat) {
    throw new Error("planning and audit must use different ChatGPT conversations");
  }
  if (!planning.connectorName || !audit.connectorName) {
    throw new Error("planning and audit must both record the workspace connector name");
  }
  if (planning.connectorName.trim() !== audit.connectorName.trim()) {
    throw new Error("planning and audit must use the same connector name");
  }
}

function applyRolePatch(bindings: RoleBindings, role: RoleName, patch: RoleBindingPatch): RoleBindings {
  const previous = bindings[role];
  const explicitCandidate = patch.candidateSha256 !== undefined ? normalizeCandidate(patch.candidateSha256) : undefined;
  const candidateChanged =
    explicitCandidate !== undefined && explicitCandidate !== previous?.candidateSha256;
  if (
    patch.taskId !== undefined &&
    patch.checkpoint?.taskId !== undefined &&
    patch.taskId !== patch.checkpoint.taskId
  ) {
    throw new Error("role taskId and checkpoint.taskId must match");
  }
  if (
    patch.iteration !== undefined &&
    patch.checkpoint?.iteration !== undefined &&
    patch.iteration !== patch.checkpoint.iteration
  ) {
    throw new Error("role iteration and checkpoint.iteration must match");
  }
  const requestedTaskId = patch.taskId ?? patch.checkpoint?.taskId;
  const requestedIteration = patch.iteration ?? patch.checkpoint?.iteration;
  const taskChanged = requestedTaskId !== undefined && requestedTaskId !== previous?.taskId;
  const iterationChanged = requestedIteration !== undefined && requestedIteration !== previous?.iteration;
  const previousChatIdentity = chatIdentityForBinding(previous);
  const nextChatIdentity =
    patch.url !== undefined ? parseRoleChatUrl(patch.url) : previousChatIdentity;
  const previousProjectIdentity = projectIdentityForBinding(previous);
  const nextProjectIdentity =
    patch.projectUrl !== undefined
      ? projectIdOf(normalizeProjectUrl(patch.projectUrl) ?? undefined)
      : previousProjectIdentity;
  const urlIdentityChanged =
    patch.url !== undefined &&
    (previousChatIdentity?.conversationId !== nextChatIdentity?.conversationId ||
      previousChatIdentity?.projectId !== nextChatIdentity?.projectId);
  const projectIdentityChanged =
    patch.projectUrl !== undefined && previousProjectIdentity !== nextProjectIdentity;
  const identityChanged = urlIdentityChanged || projectIdentityChanged;
  if (identityChanged && previous?.checkpoint && !patch.clearCheckpoint) {
    throw new Error("changing role chat or Project identity requires --clear-checkpoint");
  }
  if (role === "audit" && (taskChanged || iterationChanged) && patch.candidateSha256 === undefined) {
    throw new Error("audit task or iteration changes require an explicit --candidate SHA256");
  }
  const previousProgressChanged = candidateChanged || taskChanged || iterationChanged || identityChanged;
  const previousSession: SavedSession | null = previous
    ? {
        url: previous.url,
        title: previous.title,
        taskId: previous.taskId,
        iteration: previous.iteration,
        lastState: previousProgressChanged ? undefined : previous.lastState,
        projectUrl: previous.projectUrl,
        connectorName: previous.connectorName,
        conversationMode: previous.projectUrl ? "project" : undefined,
        checkpoint: previousProgressChanged ? undefined : previous.checkpoint,
        savedAt: previous.savedAt,
      }
    : null;

  const sessionPatch: SessionPatch = {
    url: patch.url,
    title: patch.title,
    taskId: requestedTaskId,
    iteration: requestedIteration,
    lastState: patch.lastState,
    conversationMode: patch.conversationMode ?? (patch.projectUrl ? "project" : undefined),
    projectUrl: patch.projectUrl,
    connectorName: patch.connectorName,
    checkpoint: patch.checkpoint,
    clearCheckpoint: patch.clearCheckpoint,
  };
  const merged = mergeSession(previousSession, sessionPatch);

  const identity = merged.url ? parseRoleChatUrl(merged.url) : null;
  const url = identity ? identity.url : merged.url;
  const ownProject = projectIdOf(merged.projectUrl);
  if (identity?.projectId && identity.projectId !== ownProject) {
    throw new Error("role chat URL belongs to a different ChatGPT Project than this role's project URL");
  }
  if (role === "audit") {
    if (!merged.projectUrl) {
      throw new Error("audit binding requires project mode (--project-url)");
    }
    if (!merged.connectorName) {
      throw new Error("audit binding requires --connector-name");
    }
    if (!bindings.planning) {
      throw new Error("audit binding requires an existing planning binding");
    }
  }

  const binding: RoleBinding = {
    url,
    projectUrl: merged.projectUrl ? normalizeProjectUrl(merged.projectUrl) ?? merged.projectUrl : undefined,
    connectorName: merged.connectorName,
    title: merged.title,
    taskId: merged.taskId,
    iteration: merged.iteration,
    lastState: merged.lastState,
    savedAt: merged.savedAt,
    candidateSha256: explicitCandidate ?? previous?.candidateSha256,
    checkpoint: merged.checkpoint,
  };
  assertCompleteProjectChatBinding(binding, role, role === "audit");
  const next: RoleBindings = { ...bindings, [role]: binding };
  assertRolePair(next);
  return next;
}

/** Read the current owner's file; never another owner's bindings. */
export function readRoleBindings(workspaceId: string, ownerThreadId: string): RoleBindings {
  const workspace = assertWorkspaceId(workspaceId);
  const owner = assertOwnerThreadId(ownerThreadId);
  const file = path.join(roleBindingsDir(), `${workspace}.${owner}.json`);
  return loadRoleBindings(file, workspace, owner).bindings;
}

export function readRoleBinding(
  workspaceId: string,
  ownerThreadId: string,
  role: RoleName
): RoleBinding | null {
  const name = assertRoleName(role);
  return readRoleBindings(workspaceId, ownerThreadId)[name] ?? null;
}

export function viewRoleBinding(
  workspaceId: string,
  ownerThreadId: string,
  role: RoleName
): RoleBindingView {
  const name = assertRoleName(role);
  const bindings = readRoleBindings(workspaceId, ownerThreadId);
  const binding = bindings[name] ?? null;
  return {
    ok: true,
    role: name,
    bound: binding !== null,
    unbound: binding === null,
    workspaceId: bindings.workspaceId,
    ownerThreadId: bindings.ownerThreadId,
    revision: bindings.revision,
    binding,
    candidateIsMetadataOnly: true,
  };
}

/**
 * Update exactly one role. The other role and the workspace session file are
 * preserved. Existing progress is preserved only when its candidate, task,
 * iteration and chat/Project identity remain unchanged. The first write starts
 * from revision 0 and every successful write increments it; an existing file
 * requires an explicit expected revision.
 */
export function setRoleBinding(
  workspaceId: string,
  ownerThreadId: string,
  role: RoleName,
  patch: RoleBindingPatch,
  options: RoleSetOptions = {}
): RoleBindings {
  const name = assertRoleName(role);
  const workspace = assertWorkspaceId(workspaceId);
  const owner = assertOwnerThreadId(ownerThreadId);
  const file = path.join(roleBindingsDir(), `${workspace}.${owner}.json`);
  if (options.expectedRevision !== undefined) {
    if (!isNonNegativeSafeInteger(options.expectedRevision)) {
      throw new Error("expected revision must be a non-negative integer");
    }
  }
  if (patch.iteration !== undefined && !isNonNegativeSafeInteger(patch.iteration)) {
    throw new Error("iteration must be a non-negative safe integer");
  }
  if (patch.checkpoint?.iteration !== undefined && !isNonNegativeSafeInteger(patch.checkpoint.iteration)) {
    throw new Error("checkpoint iteration must be a non-negative safe integer");
  }
  return withRoleFileLock(file, () => {
    const { bindings, exists } = loadRoleBindings(file, workspace, owner);
    if (exists && options.expectedRevision === undefined) {
      throw new Error(
        `existing role binding requires --expected-revision ${bindings.revision} (current revision is ${bindings.revision})`
      );
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== bindings.revision) {
      throw new Error(
        `revision conflict: expected ${options.expectedRevision} but found ${bindings.revision}; refusing to overwrite a concurrent write`
      );
    }
    const next = applyRolePatch(bindings, name, patch);
    if (bindings.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error("role binding revision cannot exceed the safe integer range");
    }
    next.revision = bindings.revision + 1;
    writeRoleBindingsAtomic(file, next);
    return next;
  });
}
