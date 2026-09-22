import { createHash } from "node:crypto";

import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import type { ManagedHttpHeaderReference } from "../assistant-work/http-effects.ts";
import {
  observeManagedHttp,
  parseManagedHttpPlan,
  proposeManagedHttpAction,
  type ManagedHttpEndpointPolicy,
  type ManagedHttpMessageAuthorization,
  type ManagedHttpMessageAuthorizer,
  type ManagedHttpSecretResolver,
} from "../assistant-work/http-effects.ts";
import type { ActionRecord, JsonValue } from "../assistant-work/model.ts";
import {
  AGENT_EMAIL_CAPABILITY_VERSION,
  AGENT_EMAIL_SEND_ACTION,
  type AgentEmailIdentity,
} from "./identity.ts";

const MAX_EMAIL_ADDRESS_LENGTH = 320;
// Mirrors the managed HTTP transport caps in http-effects.ts.
const MAX_TRANSPORT_BODY_BYTES = 1024 * 1024;
const MAX_TRANSPORT_URL_LENGTH = 8_192;
const MAX_SUBJECT_LENGTH = 512;
const MAX_BODY_LENGTH = 1024 * 1024;
const MAX_PROVIDER_ID_LENGTH = 512;
const MAX_RECEIVED_AT_LENGTH = 128;
const MAX_INBOX_MESSAGES = 1_000;
const MAX_INBOX_RESPONSE_BYTES = 256 * 1024;
const MAX_EVIDENCE_TEXT_BYTES = 16 * 1024;

export interface AgentEmailDraft {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export interface InboundAgentEmail {
  readonly providerId: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly receivedAt: string;
}

export interface ProposeAgentEmailInput {
  readonly repository: AssistantWorkRepository;
  readonly workId: string;
  readonly identity: AgentEmailIdentity;
  readonly draft: AgentEmailDraft;
  readonly endpointPolicy: ManagedHttpEndpointPolicy;
  readonly now?: () => string;
}

export interface FetchAgentInboxInput {
  readonly identity: AgentEmailIdentity;
  readonly endpointPolicy: ManagedHttpEndpointPolicy;
  readonly resolveSecret?: ManagedHttpSecretResolver;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}

export interface IngestAgentEmailInput {
  readonly repository: AssistantWorkRepository;
  readonly identity: AgentEmailIdentity;
  readonly messages: readonly InboundAgentEmail[];
  readonly now?: () => string;
}

export function agentEmailSemanticKey(draft: AgentEmailDraft, identity: AgentEmailIdentity): string {
  const normalized = normalizeDraft(draft);
  const digest = createHash("sha256")
    .update(identity.address, "utf8")
    .update("\0", "utf8")
    .update(normalized.to, "utf8")
    .update("\0", "utf8")
    .update(normalized.subject, "utf8")
    .update("\0", "utf8")
    .update(normalized.body, "utf8")
    .digest("hex");
  return `agent-email:${digest}`;
}

/**
 * Stable per-send correlation token scoped to the owning work item, so
 * re-proposing the identical draft keeps one reference while the same content
 * in a different work item can never be confirmed by the other's provider
 * status. Any change to recipient, subject, or body also produces a new one.
 */
export function agentEmailClientReference(
  draft: AgentEmailDraft,
  identity: AgentEmailIdentity,
  workId: string,
): string {
  const digest = createHash("sha256")
    .update(workId, "utf8")
    .update("\0", "utf8")
    .update(agentEmailSemanticKey(draft, identity), "utf8")
    .digest("hex");
  return `agent-email-ref-${digest}`;
}

/** The exact managed-HTTP material this capability produces for one draft. */
interface AgentEmailPlanMaterial {
  readonly url: string;
  readonly method: "POST";
  readonly headers: readonly ManagedHttpHeaderReference[];
  readonly body: string;
  readonly verificationUrl: string;
  readonly clientReference: string;
}

/**
 * The managed transport caps the final body and URL, and those are the JSON
 * envelope and the reference-scoped verification URL rather than the raw draft.
 * Reject here so an oversized draft fails with a clear capability error instead
 * of surfacing as an opaque preflight rejection after the owner approves.
 */
function assertTransportLimits(material: AgentEmailPlanMaterial): void {
  const bodyBytes = Buffer.byteLength(material.body, "utf8");
  if (bodyBytes > MAX_TRANSPORT_BODY_BYTES) {
    throw new Error(`agent email request body is ${bodyBytes} bytes, over the ${MAX_TRANSPORT_BODY_BYTES} byte transport limit`);
  }
  for (const url of [material.url, material.verificationUrl]) {
    if (url.length > MAX_TRANSPORT_URL_LENGTH) {
      throw new Error(`agent email URL is ${url.length} characters, over the ${MAX_TRANSPORT_URL_LENGTH} character transport limit`);
    }
  }
}

/**
 * Builds the one plan shape the capability will ever send. Both proposal and
 * authorization derive from this, so the authorizer can reproduce a candidate
 * plan byte-for-byte instead of pattern-matching parts of it.
 */
function agentEmailPlanMaterial(
  identity: AgentEmailIdentity,
  draft: AgentEmailDraft,
  workId: string,
): AgentEmailPlanMaterial {
  const normalized = normalizeDraft(draft);
  const sendUrl = new URL(`${identity.sendOrigin}${identity.sendPath}`).href;
  const clientReference = agentEmailClientReference(normalized, identity, workId);
  return {
    url: sendUrl,
    method: "POST",
    headers: [
      { name: "content-type", value: "application/json" },
      { name: "authorization", secretRef: identity.secretRef },
    ],
    body: JSON.stringify({
      clientReference,
      from: identity.address,
      to: normalized.to,
      subject: normalized.subject,
      text: normalized.body,
    }),
    verificationUrl: `${sendUrl}?clientReference=${encodeURIComponent(clientReference)}`,
    clientReference,
  };
}

/**
 * True when a persisted action really is one of this capability's sends. The
 * plan material alone is not enough: a generic managed-HTTP action can carry
 * byte-identical material with `messageAuthorization: null`, which execution
 * treats as an ordinary external mutation. Requiring the persisted classifi-
 * cation and capability stamp stops the email tool becoming an alternate
 * executor for that foreign record.
 */
export function isAgentEmailAction(action: ActionRecord, identity: AgentEmailIdentity): boolean {
  if (action.effectClass !== "external_message" || action.action !== AGENT_EMAIL_SEND_ACTION) return false;
  let plan;
  try {
    plan = parseManagedHttpPlan(action.payload);
  } catch {
    return false;
  }
  const persisted = plan.messageAuthorization;
  if (persisted === null
    || persisted.capabilityId !== "agent-email-send"
    || persisted.capabilityVersion !== AGENT_EMAIL_CAPABILITY_VERSION) {
    return false;
  }
  return agentEmailPlanAuthorizer(identity, action.workId)(plan) !== undefined;
}

/**
 * Authorizes ONLY a plan this capability could have produced, by rebuilding it
 * from the identity and the plan's own draft fields and comparing every
 * effect-bearing part. Authorization is deliberately not exposed as a generic
 * host message binding: a binding can pin body fields but not the credential
 * reference or the verification endpoint, so a generic managed-HTTP request
 * could otherwise claim `external_message` classification (and any owner send
 * rule for it) while swapping the credential or pointing verification
 * somewhere harmless. Reproducing the whole plan removes that surface, and
 * with it any dependence on how a JSON body happens to parse.
 */
export function agentEmailPlanAuthorizer(identity: AgentEmailIdentity, workId: string): ManagedHttpMessageAuthorizer {
  return (plan) => {
    if (plan.messageOperation === null || plan.body === null) return undefined;
    if (plan.messageOperation.action !== AGENT_EMAIL_SEND_ACTION) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(plan.body);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.to !== "string" || typeof candidate.subject !== "string" || typeof candidate.text !== "string") {
      return undefined;
    }
    let expected: AgentEmailPlanMaterial;
    try {
      expected = agentEmailPlanMaterial(identity, {
        to: candidate.to,
        subject: candidate.subject,
        body: candidate.text,
      }, workId);
    } catch {
      return undefined;
    }
    if (
      plan.url !== expected.url
      || plan.method !== expected.method
      // Byte equality also settles duplicate members, escaped key spellings and
      // whitespace: any variation is simply a different body than this
      // capability builds.
      || plan.body !== expected.body
      || !sameHeaderReferences(plan.headers, expected.headers)
      || plan.verification.url !== expected.verificationUrl
      || !sameHeaderReferences(plan.verification.headers, [expected.headers[1]!])
      || plan.verification.expected.kind !== "json_field"
      || !samePath(plan.verification.expected.path, ["acceptedReference"])
      || plan.verification.expected.value !== expected.clientReference
      || plan.messageOperation.recipient !== candidate.to
      || plan.messageOperation.topic !== candidate.subject
    ) {
      return undefined;
    }
    return { capabilityId: "agent-email-send", capabilityVersion: AGENT_EMAIL_CAPABILITY_VERSION };
  };
}

/** Plan normalization sorts headers, so compare as a set keyed by name. */
function sameHeaderReferences(
  actual: readonly ManagedHttpHeaderReference[],
  expected: readonly ManagedHttpHeaderReference[],
): boolean {
  const byName = (headers: readonly ManagedHttpHeaderReference[]) =>
    [...headers].sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
  const left = byName(actual);
  const right = byName(expected);
  return left.length === right.length && left.every((header, index) => {
    const other = right[index]!;
    if (header.name.toLowerCase() !== other.name.toLowerCase()) return false;
    if ("secretRef" in other) return "secretRef" in header && header.secretRef === other.secretRef;
    return !("secretRef" in header) && header.value === other.value;
  });
}

function samePath(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((segment, index) => segment === expected[index]);
}

export async function proposeAgentEmail(input: ProposeAgentEmailInput) {
  const workId = requiredText(input.workId, "workId", 512);
  const draft = normalizeDraft(input.draft);
  const material = agentEmailPlanMaterial(input.identity, draft, workId);
  assertTransportLimits(material);
  // The capability authorizes its own plan; a host binding cannot express the
  // credential reference or the verification endpoint that make it safe.
  const authorizeMessage = agentEmailPlanAuthorizer(input.identity, workId);
  const proposed = await proposeManagedHttpAction({
    workId,
    semanticKey: agentEmailSemanticKey(draft, input.identity),
    method: "POST",
    url: material.url,
    headers: material.headers,
    body: material.body,
    // A managed plan carries exactly one expectation, so correlation and
    // success ride the same field: the provider reports `acceptedReference`
    // only for a message it actually accepted, and only for the reference
    // asked about. A bare `accepted: true` would confirm a stale or concurrent
    // send, and an echoed reference beside `accepted: false` would confirm a
    // send that never happened.
    verification: {
      url: material.verificationUrl,
      headers: [material.headers[1]!],
      expected: { kind: "json_field", path: ["acceptedReference"], value: material.clientReference },
    },
    messageOperation: {
      recipient: draft.to,
      topic: draft.subject,
      action: AGENT_EMAIL_SEND_ACTION,
    },
  }, {
    repository: input.repository,
    endpointPolicy: input.endpointPolicy,
    authorizeMessage,
    now: input.now,
  });
  if (proposed.effectClass !== "external_message") {
    throw new Error("agent email must be proposed as an external_message action");
  }
  return proposed;
}


export function ingestAgentEmail(input: IngestAgentEmailInput): { readonly admitted: number; readonly duplicates: number } {
  const now = input.now ?? (() => new Date().toISOString());
  let admitted = 0;
  let duplicates = 0;
  for (const message of input.messages) {
    const normalized = normalizeInboundEmail(message);
    if (sameEmail(normalized.from, input.identity.address)) {
      throw new Error(`agent email rejected self-addressed message from ${normalized.from}`);
    }
    const threadDigest = createHash("sha256")
      .update(normalized.from, "utf8")
      .update("\0", "utf8")
      .update(normalized.subject, "utf8")
      .digest("hex");
    const result = input.repository.admitObservation({
      source: "agent-email",
      occurrenceKey: normalized.providerId,
      workKey: `agent-email-thread:${threadDigest}`,
      workTitle: `${normalized.subject} — ${normalized.from}`,
      provenance: {
        principal: "third_party",
        channel: "email",
        subject: normalized.from,
        evidenceId: `agent-email:${normalized.providerId}`,
      },
      observedAt: normalized.receivedAt,
      evidence: {
        from: normalized.from,
        subject: normalized.subject,
        text: truncateUtf8(normalized.text, MAX_EVIDENCE_TEXT_BYTES),
      },
    }, now());
    if (result.created) admitted += 1;
    else duplicates += 1;
  }
  return { admitted, duplicates };
}

export async function fetchAgentInbox(input: FetchAgentInboxInput): Promise<readonly InboundAgentEmail[]> {
  const configuredLimit = input.maxResponseBytes ?? MAX_INBOX_RESPONSE_BYTES;
  const maxResponseBytes = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
    ? Math.min(configuredLimit, MAX_INBOX_RESPONSE_BYTES)
    : MAX_INBOX_RESPONSE_BYTES;
  const result = await observeManagedHttp({
    url: input.identity.inboxUrl,
    headers: [{ name: "authorization", secretRef: input.identity.secretRef }],
    endpointPolicy: input.endpointPolicy,
    resolveSecret: input.resolveSecret,
    timeoutMs: input.timeoutMs,
    maxResponseBytes,
    signal: input.signal,
  });
  if (result.kind === "failed") {
    throw new Error(`agent email inbox fetch failed: ${result.message}`);
  }
  if (!result.response.ok || result.response.truncated) {
    throw new Error(
      result.response.truncated
        ? "agent email inbox response exceeded the configured byte bound"
        : `agent email inbox returned HTTP ${result.response.status}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.response.body);
  } catch (error) {
    throw new Error("agent email inbox response is not valid JSON", { cause: error });
  }
  return parseInboxPayload(parsed);
}

function normalizeDraft(value: AgentEmailDraft): AgentEmailDraft {
  if (value === null || typeof value !== "object") throw new Error("agent email draft is required");
  return {
    to: normalizeEmailAddress(value.to, "draft.to"),
    subject: requiredText(value.subject, "draft.subject", MAX_SUBJECT_LENGTH, true),
    body: requiredText(value.body, "draft.body", MAX_BODY_LENGTH, false, true),
  };
}

function normalizeInboundEmail(value: InboundAgentEmail): InboundAgentEmail {
  if (value === null || typeof value !== "object") throw new Error("inbound agent email must be an object");
  return {
    providerId: requiredText(value.providerId, "inbound providerId", MAX_PROVIDER_ID_LENGTH),
    from: normalizeEmailAddress(value.from, "inbound from"),
    subject: requiredText(value.subject, "inbound subject", MAX_SUBJECT_LENGTH, true),
    text: requiredText(value.text, "inbound text", MAX_BODY_LENGTH, false, true),
    receivedAt: timestamp(value.receivedAt),
  };
}

function parseInboxPayload(value: unknown): readonly InboundAgentEmail[] {
  let entries: readonly unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (isRecord(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "messages") && Array.isArray(value.messages)) {
    entries = value.messages;
  } else {
    throw new Error("agent email inbox response must be an array or an object containing only messages");
  }
  if (entries.length > MAX_INBOX_MESSAGES) throw new Error("agent email inbox contains too many messages");
  return entries.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`agent email inbox message ${index} must be an object`);
    const keys = Object.keys(entry).sort();
    if (keys.length !== 5 || keys.join(",") !== "from,providerId,receivedAt,subject,text") {
      throw new Error(`agent email inbox message ${index} has invalid fields`);
    }
    return normalizeInboundEmail({
      providerId: readString(entry.providerId, `inbox message ${index} providerId`),
      from: readString(entry.from, `inbox message ${index} from`),
      subject: readString(entry.subject, `inbox message ${index} subject`),
      text: readString(entry.text, `inbox message ${index} text`),
      receivedAt: readString(entry.receivedAt, `inbox message ${index} receivedAt`),
    });
  });
}

function normalizeEmailAddress(value: string, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_EMAIL_ADDRESS_LENGTH
    || value !== value.trim()
    || /\s/.test(value)
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a valid email address`);
  }
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) {
    throw new Error(`${label} must contain exactly one @ with a local part and domain`);
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (
    local.length > 64
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || domain.length > 255
    || domain.startsWith(".")
    || domain.endsWith(".")
    || domain.includes("..")
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(domain)
  ) {
    throw new Error(`${label} must be a valid email address`);
  }
  return `${local}@${domain.toLowerCase()}`;
}

function requiredText(
  value: string,
  label: string,
  maxLength: number,
  forbidNewlines = false,
  preserveWhitespace = false,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || (!preserveWhitespace && value !== value.trim())
    || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || (forbidNewlines && /[\r\n]/.test(value))
  ) {
    throw new Error(`${label} is required and must be bounded text`);
  }
  return value;
}

function timestamp(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RECEIVED_AT_LENGTH || Number.isNaN(Date.parse(value))) {
    throw new Error("inbound receivedAt must be a valid timestamp");
  }
  return value;
}

function sameEmail(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  // Cut on the buffer, then drop the trailing bytes of a split codepoint, so a
  // bounded 256 KiB inbox body costs one pass instead of a per-character rescan.
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
