import { createHash } from "node:crypto";

import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import {
  executeManagedHttpAction,
  parseManagedHttpPlan,
  proposeManagedHttpAction,
  MANAGED_HTTP_ACTION,
  type ManagedHttpEndpointPolicy,
  type ManagedHttpExecutionResult,
  type ManagedHttpHeaderReference,
  type ManagedHttpRuntimeOptions,
} from "../assistant-work/http-effects.ts";
import {
  authorizationRequirementForEffect,
  canonicalJson,
  stableAttemptId,
  type ActionRecord,
  type AttemptRecord,
  type JsonValue,
  type ProposeActionInput,
} from "../assistant-work/model.ts";
import { normalizeCallNumber, type CallProviderConfig } from "./provider.ts";

const DEFAULT_WORKER_ID = "main-session:agent-call";
const PROVIDER_SECRET_PATTERN = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~\/-]*$/;

export interface AgentCallRequest {
  readonly to: string;
  readonly purpose: string;
  readonly script: string;
  readonly maxMinutes: number;
}

export interface ProposeAgentCallInput {
  readonly repository: AssistantWorkRepository;
  readonly workId: string;
  readonly provider: CallProviderConfig;
  readonly request: AgentCallRequest;
  readonly endpointPolicy: ManagedHttpEndpointPolicy;
  readonly now?: () => string;
}

export interface ExecuteAgentCallInput extends ManagedHttpRuntimeOptions {
  readonly repository: AssistantWorkRepository;
  readonly actionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly attemptId?: string;
  readonly dispatchKey?: string;
  readonly workerId?: string;
  readonly provider?: CallProviderConfig;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}

export interface AgentCallProposal {
  readonly action: ActionRecord;
  readonly plan: ReturnType<typeof proposeManagedHttpAction> extends Promise<infer Result>
    ? Result extends { readonly plan: infer Plan } ? Plan : never
    : never;
  readonly effectClass: "external_mutation";
}

export type AgentCallExecutionResult =
  | {
      readonly kind: "placed";
      readonly action: ActionRecord;
      readonly attempt: AttemptRecord;
      readonly evidence: JsonValue;
      readonly managed: ManagedHttpExecutionResult;
    }
  | {
      readonly kind: "failed";
      readonly action?: ActionRecord;
      readonly attempt?: AttemptRecord;
      readonly evidence?: JsonValue;
      readonly reason: string;
      readonly managed?: ManagedHttpExecutionResult;
    }
  | {
      readonly kind: "uncertain";
      readonly action?: ActionRecord;
      readonly attempt?: AttemptRecord;
      readonly evidence?: JsonValue;
      readonly reason: string;
      readonly managed: ManagedHttpExecutionResult;
    };

export async function proposeAgentCall(input: ProposeAgentCallInput): Promise<AgentCallProposal> {
  const workId = requiredTrimmed(input.workId, "workId");
  const provider = validateProvider(input.provider);
  const request = validateRequest(input.request);
  const semanticKey = agentCallSemanticKey(request, provider);
  const url = `${provider.origin}${provider.createPath}`;
  const statusUrl = `${provider.origin}${provider.statusPath}`;
  const headers: readonly ManagedHttpHeaderReference[] = [
    { name: "authorization", secretRef: provider.secretRef },
    { name: "content-type", value: "application/json" },
  ];
  const clientReference = agentCallClientReference(request, provider, workId);
  const body = JSON.stringify({
    from: provider.callerId,
    to: request.to,
    purpose: request.purpose,
    script: request.script,
    maxMinutes: request.maxMinutes,
    clientReference,
  });

  // The owner approves a digest, so the exact words the call is authorized to
  // say must be part of the approval-legible material, not only of the request
  // body. The digest binds the displayed script to the transported one.
  const scope: JsonValue = {
    kind: "agent_call",
    callee: request.to,
    purpose: request.purpose,
    script: request.script,
    scriptSha256: createHash("sha256").update(request.script, "utf8").digest("hex"),
  };
  const cost: JsonValue = { kind: "call", maxMinutes: request.maxMinutes };
  const proposalRepository = new Proxy(input.repository, {
    get(target, property, receiver) {
      if (property === "proposeAction") {
        return (proposal: ProposeActionInput, now: string): ActionRecord => target.proposeAction({
          ...proposal,
          scope,
          cost,
        }, now);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const proposed = await proposeManagedHttpAction({
    workId,
    semanticKey,
    method: "POST",
    url,
    headers,
    body,
    // A status endpoint that only reports "placed" proves nothing about THIS
    // call: a prior or concurrent call would satisfy it and falsely confirm a
    // billable, irreversible effect. A managed plan allows one expectation, so
    // correlation and success ride the same field: the provider reports
    // `placedReference` only for a call it actually placed, and only for the
    // reference asked about. An echoed reference beside `status: not_placed`
    // must never confirm.
    verification: {
      url: `${statusUrl}?clientReference=${encodeURIComponent(clientReference)}`,
      headers: [{ name: "authorization", secretRef: provider.secretRef }],
      expected: { kind: "json_field", path: ["placedReference"], value: clientReference },
    },
  }, {
    repository: proposalRepository,
    endpointPolicy: input.endpointPolicy,
    now: input.now,
  });

  if (proposed.effectClass !== "external_mutation"
    || authorizationRequirementForEffect(proposed.effectClass) !== "owner_explicit"
    || proposed.action.effectClass !== "external_mutation"
    || authorizationRequirementForEffect(proposed.action.effectClass) !== "owner_explicit") {
    throw new Error("agent calls must remain external_mutation actions requiring owner_explicit approval");
  }

  return {
    action: proposed.action,
    plan: proposed.plan,
    effectClass: "external_mutation",
  };
}

export async function executeAgentCall(input: ExecuteAgentCallInput): Promise<AgentCallExecutionResult> {
  const workerId = requiredTrimmed(input.workerId ?? DEFAULT_WORKER_ID, "workerId");
  const attemptId = input.attemptId
    ?? stableAttemptId(input.actionId, input.revision, requiredTrimmed(input.dispatchKey, "dispatchKey"));
  const now = input.now ?? (() => new Date().toISOString());
  const action = input.repository.getAction(input.actionId);
  if (action !== undefined && !isAgentCallAction(action, input.provider)) {
    return {
      kind: "failed",
      action,
      reason: "the action is not a trusted agent call proposal",
    };
  }

  const managed = await executeManagedHttpAction({
    repository: input.repository,
    actionId: input.actionId,
    revision: input.revision,
    digest: input.digest,
    attemptId,
    workerId,
    endpointPolicy: input.endpointPolicy,
    resolveSecret: input.resolveSecret,
    authorizeMessage: input.authorizeMessage,
    timeoutMs: input.timeoutMs,
    maxResponseBytes: input.maxResponseBytes,
    maxEvidenceBodyBytes: input.maxEvidenceBodyBytes,
    signal: input.signal,
    now,
  });

  if (managed.kind === "confirmed") {
    return {
      kind: "placed",
      action: managed.action,
      attempt: managed.attempt,
      evidence: managed.evidence,
      managed,
    };
  }

  if (managed.kind === "ambiguous") {
    const providerFailure = providerReturnedServerFailure(managed.evidence);
    if (providerFailure) {
      const settled = input.repository.resolveAmbiguousAttempt({
        attemptId: managed.attempt.id,
        workerId,
        resolution: "definitive_failed",
        evidenceSource: "agent-call-provider",
        evidenceId: `${managed.attempt.id}:provider-5xx`,
        evidence: {
          kind: "agent_call_provider_failure",
          providerStatus: providerFailure,
          managedEvidence: managed.evidence,
        },
      }, now());
      return {
        kind: "failed",
        action: settled.action,
        attempt: settled.attempt,
        evidence: managed.evidence,
        reason: `provider returned HTTP ${providerFailure}; the call was settled definitive_failed and was not retried`,
        managed,
      };
    }
    return {
      kind: "uncertain",
      action: managed.action,
      attempt: managed.attempt,
      evidence: managed.evidence,
      reason: "the call may have been placed, but verification did not prove the provider state; no retry was attempted",
      managed,
    };
  }

  if (managed.kind === "definitive_failed") {
    return {
      kind: "failed",
      action: managed.action,
      attempt: managed.attempt,
      evidence: managed.evidence,
      reason: "the call failed definitively before it could be placed; no retry was attempted",
      managed,
    };
  }

  if (managed.kind === "preflight_rejected") {
    return {
      kind: "failed",
      action: managed.action,
      reason: managed.message,
      managed,
    };
  }

  return {
    kind: "failed",
    ...(managed.action === undefined ? {} : { action: managed.action }),
    ...(managed.attempt === undefined ? {} : { attempt: managed.attempt }),
    reason: managed.reason === "approval_required"
      ? "explicit owner approval is required before placing this call"
      : `the call was not placed: ${managed.reason}`,
    managed,
  };
}

export function agentCallSemanticKey(request: AgentCallRequest, provider: CallProviderConfig): string {
  const normalizedRequest = validateRequest(request);
  const normalizedProvider = validateProvider(provider);
  const identity = {
    provider: {
      origin: normalizedProvider.origin,
      createPath: normalizedProvider.createPath,
      statusPath: normalizedProvider.statusPath,
      callerId: normalizedProvider.callerId,
    },
    to: normalizedRequest.to,
    purpose: normalizedRequest.purpose,
    script: normalizedRequest.script,
    maxMinutes: normalizedRequest.maxMinutes,
  } as const;
  const digest = createHash("sha256").update(canonicalJson(identity)).digest("hex");
  return `agent-call:${digest}`;
}

/**
 * Stable per-call correlation token scoped to the owning work item, so an
 * identical re-proposal keeps one reference while the same call requested from
 * a different work item can never be confirmed by the other's provider status.
 * Any change to callee, purpose, script, or cap also produces a new one.
 */
export function agentCallClientReference(
  request: AgentCallRequest,
  provider: CallProviderConfig,
  workId: string,
): string {
  const digest = createHash("sha256")
    .update(workId, "utf8")
    .update("\0", "utf8")
    .update(agentCallSemanticKey(request, provider), "utf8")
    .digest("hex");
  return `agent-call-ref-${digest}`;
}

function validateRequest(request: AgentCallRequest): AgentCallRequest {
  if (request === null || typeof request !== "object") throw new Error("agent call request is required");
  const to = normalizeCallNumber(request.to);
  const purpose = requiredText(request.purpose, "purpose");
  const script = requiredText(request.script, "script");
  if (!Number.isSafeInteger(request.maxMinutes) || request.maxMinutes < 1 || request.maxMinutes > 30) {
    throw new Error("maxMinutes must be an integer from 1 to 30");
  }
  return { to, purpose, script, maxMinutes: request.maxMinutes };
}

function validateProvider(provider: CallProviderConfig): CallProviderConfig {
  if (provider === null || typeof provider !== "object") throw new Error("agent call provider is required");
  const origin = exactOrigin(provider.origin, "provider origin");
  const createPath = exactPath(provider.createPath, "provider createPath");
  const statusPath = exactPath(provider.statusPath, "provider statusPath");
  const callerId = normalizeCallNumber(provider.callerId);
  if (
    provider.secretRef.length > 512
    || !PROVIDER_SECRET_PATTERN.test(provider.secretRef)
    || provider.secretRef.includes("/../")
    || provider.secretRef.endsWith("/..")
  ) {
    throw new Error("provider secretRef must be an opaque secret:// reference");
  }
  return { origin, createPath, statusPath, callerId, secretRef: provider.secretRef };
}

function exactOrigin(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be an exact http(s) origin`);
  }
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
    || value !== url.origin
  ) {
    throw new Error(`${label} must be an exact scheme/host/port origin`);
  }
  return url.origin;
}

function exactPath(value: string, label: string): string {
  if (
    typeof value !== "string"
    || !value.startsWith("/")
    || value.includes("?")
    || value.includes("#")
    || value.includes("\0")
  ) {
    throw new Error(`${label} must be an exact absolute path without query or fragment`);
  }
  const normalized = new URL(value, "https://agent-call.invalid");
  if (normalized.pathname !== value || normalized.search !== "" || normalized.hash !== "") {
    throw new Error(`${label} must be an exact absolute path without query or fragment`);
  }
  return value;
}

function requiredTrimmed(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must not be empty`);
  if (value.includes("\0")) throw new Error(`${label} contains an invalid NUL character`);
  return value;
}

function isAgentCallAction(action: ActionRecord, provider: CallProviderConfig | undefined): boolean {
  if (action.effectClass !== "external_mutation" || action.action !== "managed_http_request") return false;
  if (action.cost === undefined || action.scope === undefined) return false;
  let plan;
  try {
    plan = parseManagedHttpPlan(action.payload);
  } catch {
    return false;
  }
  if (plan.method !== "POST" || plan.messageOperation !== null || plan.messageAuthorization !== null) return false;
  if (provider !== undefined) {
    let normalizedProvider: CallProviderConfig;
    try {
      normalizedProvider = validateProvider(provider);
    } catch {
      return false;
    }
    const verification = new URL(plan.verification.url);
    // The verification URL is scoped to this call's client reference, so match
    // the endpoint and require the reference query rather than an exact string.
    if (plan.url !== `${normalizedProvider.origin}${normalizedProvider.createPath}`
      || `${verification.origin}${verification.pathname}` !== `${normalizedProvider.origin}${normalizedProvider.statusPath}`
      || (verification.searchParams.get("clientReference") ?? "").length === 0) return false;
  }
  if (!hasAuthorizationSecret(plan.headers) || !hasAuthorizationSecret(plan.verification.headers)) return false;
  if (!isRecord(action.cost) || action.cost.kind !== "call" || !isIntegerInRange(action.cost.maxMinutes, 1, 30)) return false;
  if (!isRecord(action.scope) || action.scope.kind !== "agent_call"
    || typeof action.scope.callee !== "string" || typeof action.scope.purpose !== "string"
    || typeof action.scope.script !== "string" || typeof action.scope.scriptSha256 !== "string") return false;
  const parsedBody = parseCallBody(plan.body);
  if (parsedBody === undefined) return false;
  // Bind EVERY effect-bearing field to the approved material, the way agent
  // email rebuilds its whole plan. Checking only the script would let a
  // post-approval payload edit place a call to a different number under the
  // original digest. Recomputing the work-scoped client reference from the
  // transported material is what makes that impossible: callee, purpose,
  // script, cap and provider identity all feed the reference.
  if (provider !== undefined) {
    let normalizedProvider: CallProviderConfig;
    try {
      normalizedProvider = validateProvider(provider);
    } catch {
      return false;
    }
    const rawBody: unknown = JSON.parse(plan.body ?? "null");
    if (!isRecord(rawBody) || rawBody.from !== normalizedProvider.callerId) return false;
    const expectedReference = agentCallClientReference({
      to: parsedBody.to,
      purpose: parsedBody.purpose,
      script: parsedBody.script,
      maxMinutes: parsedBody.maxMinutes,
    }, normalizedProvider, action.workId);
    if (bodyClientReference(plan.body) !== expectedReference) return false;
  }
  if (parsedBody.script !== action.scope.script
    || createHash("sha256").update(parsedBody.script, "utf8").digest("hex") !== action.scope.scriptSha256
    || parsedBody.to !== action.scope.callee
    || parsedBody.purpose !== action.scope.purpose
    || !isRecord(action.cost)
    || action.cost.maxMinutes !== parsedBody.maxMinutes) {
    return false;
  }
  const reference = verificationReference(plan.verification.url);
  return reference !== undefined
    && reference === bodyClientReference(plan.body)
    && isCorrelatedVerification(plan.verification.expected, reference);
}

function hasAuthorizationSecret(headers: readonly ManagedHttpHeaderReference[]): boolean {
  return headers.some((header) => header.name.toLowerCase() === "authorization" && "secretRef" in header);
}

function verificationReference(url: string): string | undefined {
  const value = new URL(url).searchParams.get("clientReference");
  return value === null || value.length === 0 ? undefined : value;
}

function bodyClientReference(body: string | null): string | undefined {
  if (body === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || typeof parsed.clientReference !== "string") return undefined;
    return parsed.clientReference;
  } catch {
    return undefined;
  }
}

function parseCallBody(body: string | null): AgentCallRequest | undefined {
  if (body === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).sort().join(",") !== "clientReference,from,maxMinutes,purpose,script,to"
    || typeof parsed.clientReference !== "string"
    || parsed.clientReference.length === 0
    || typeof parsed.from !== "string"
    || typeof parsed.to !== "string"
    || typeof parsed.purpose !== "string"
    || typeof parsed.script !== "string"
    || typeof parsed.maxMinutes !== "number") return undefined;
  try {
    const request = validateRequest({
      to: parsed.to,
      purpose: parsed.purpose,
      script: parsed.script,
      maxMinutes: parsed.maxMinutes,
    });
    normalizeCallNumber(parsed.from);
    return request;
  } catch {
    return undefined;
  }
}

/**
 * The expectation must assert the echoed client reference, not a bare status:
 * a status alone carries no correlation, so another call's "placed" would
 * satisfy it and falsely confirm this billable effect.
 */
function isCorrelatedVerification(
  expected: { readonly kind: string; readonly [key: string]: unknown },
  clientReference: string,
): boolean {
  return expected.kind === "json_field"
    && Array.isArray(expected.path)
    && expected.path.length === 1
    && expected.path[0] === "placedReference"
    && expected.value === clientReference
    && clientReference.length > 0;
}

function providerReturnedServerFailure(evidence: JsonValue): number | undefined {
  if (!isRecord(evidence) || !isRecord(evidence.request) || evidence.request.outcome !== "response") return undefined;
  const status = evidence.request.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 500 && status <= 599 ? status : undefined;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
