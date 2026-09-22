import type { CustomTool } from "@gajae-code/coding-agent";
import { Type } from "@gajae-code/coding-agent/extensibility/typebox";

import {
  agentEmailPlanAuthorizer,
  isAgentEmailAction,
} from "./agent-email.ts";
import {
  executeManagedHttpAction,
  type ManagedHttpEndpointPolicy,
  type ManagedHttpExecutionResult,
  type ManagedHttpSecretResolver,
} from "../assistant-work/http-effects.ts";
import { stableAttemptId, type ActionRecord, type AttemptRecord } from "../assistant-work/model.ts";
import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import {
  fetchAgentInbox,
  ingestAgentEmail,
  proposeAgentEmail,
  type AgentEmailDraft,
} from "./agent-email.ts";
import type { AgentEmailIdentity } from "./identity.ts";

const DEFAULT_WORKER_ID = "main-session:agent-email";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_EVIDENCE_BODY_BYTES = 8 * 1024;

interface AgentEmailToolParams {
  readonly mode: "propose" | "send" | "inbox";
  readonly workId?: string;
  readonly to?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly actionId?: string;
  readonly revision?: number;
  readonly digest?: string;
}

export interface AgentEmailToolOptions {
  readonly repository: AssistantWorkRepository;
  readonly identity: AgentEmailIdentity;
  readonly endpointPolicy: ManagedHttpEndpointPolicy;
  readonly resolveSecret?: ManagedHttpSecretResolver;
  readonly now?: () => Date;
  readonly workerId?: string;
}

export function createAgentEmailTool(options: AgentEmailToolOptions): CustomTool {
  const now = options.now ?? (() => new Date());
  const workerId = requiredTrimmed(options.workerId ?? DEFAULT_WORKER_ID, "workerId");

  return {
    name: "agent_email",
    label: "Agent email",
    strict: true,
    concurrency: "exclusive",
    description: "Propose or send a typed email through the host-managed provider binding, or ingest the bounded provider inbox. Raw URLs, headers, credentials, and request bodies are not model-controlled.",
    parameters: Type.Object({
      request: Type.Union([
        Type.Object({
          mode: Type.Literal("propose"),
          workId: Type.String({ minLength: 1, maxLength: 512 }),
          to: Type.String({ minLength: 1, maxLength: 320 }),
          subject: Type.String({ minLength: 1, maxLength: 512 }),
          body: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
        }, { additionalProperties: false }),
        Type.Object({
          mode: Type.Literal("send"),
          actionId: Type.String({ minLength: 1, maxLength: 512 }),
          revision: Type.Integer({ minimum: 1 }),
          digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        }, { additionalProperties: false }),
        Type.Object({ mode: Type.Literal("inbox") }, { additionalProperties: false }),
      ]),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _onUpdate, _context, signal) {
      const input = (params as { readonly request: AgentEmailToolParams }).request;
      if (input.mode === "propose") {
        rejectExecutionFieldsOnProposal(input);
        const draft: AgentEmailDraft = {
          to: requiredString(input.to, "to"),
          subject: requiredString(input.subject, "subject"),
          body: requiredString(input.body, "body"),
        };
        const proposed = await proposeAgentEmail({
          repository: options.repository,
          workId: requiredTrimmed(input.workId, "workId"),
          identity: options.identity,
          draft,
          endpointPolicy: options.endpointPolicy,
          now: () => now().toISOString(),
        });
        const approvalRequirement = proposed.action.effectClass === "external_message"
          ? "owner message rule or exact owner approval"
          : "exact owner approval";
        return {
          content: [{ type: "text" as const, text: `Prepared agent email action ${proposed.action.id} revision ${proposed.action.revision} digest ${proposed.action.digest}. No request has run. Approval requirement: ${approvalRequirement}.` }],
          details: {
            mode: "propose" as const,
            action: actionSummary(proposed.action),
            approvalRequirement,
            effectExecuted: false,
          },
        };
      }

      if (input.mode === "send") {
        rejectProposalFieldsOnExecution(input);
        const actionId = requiredTrimmed(input.actionId, "actionId");
        const revision = requiredRevision(input.revision);
        const digest = requiredDigest(input.digest);
        const attemptId = stableAttemptId(actionId, revision, requiredTrimmed(toolCallId, "toolCallId"));
        // Dispatch re-validates message authorization, so the capability must
        // authorize its own persisted plan here too, scoped to that action's
        // own work item.
        const action = options.repository.getAction(actionId);
        if (action === undefined) throw new Error(`unknown agent email action ${actionId}`);
        // Without this the tool would happily dispatch any explicitly approved
        // managed-HTTP action, using the email capability as a generic sender.
        if (!isAgentEmailAction(action, options.identity)) {
          throw new Error(`action ${actionId} is not an agent email proposal`);
        }
        const result = await executeManagedHttpAction({
          authorizeMessage: agentEmailPlanAuthorizer(options.identity, action.workId),
          repository: options.repository,
          actionId,
          revision,
          digest,
          attemptId,
          workerId,
          endpointPolicy: options.endpointPolicy,
          resolveSecret: options.resolveSecret,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
          maxEvidenceBodyBytes: DEFAULT_MAX_EVIDENCE_BODY_BYTES,
          signal,
          now: () => now().toISOString(),
        });
        return {
          content: [{ type: "text" as const, text: executionText(result, actionId, revision, digest) }],
          details: executionDetails(result, attemptId),
        };
      }

      rejectFieldsOnInbox(input);
      const messages = await fetchAgentInbox({
        identity: options.identity,
        endpointPolicy: options.endpointPolicy,
        resolveSecret: options.resolveSecret,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
        signal,
      });
      const counts = ingestAgentEmail({
        repository: options.repository,
        identity: options.identity,
        messages,
        now: () => now().toISOString(),
      });
      return {
        content: [{ type: "text" as const, text: `Ingested ${counts.admitted} agent email${counts.admitted === 1 ? "" : "s"}; ${counts.duplicates} duplicate${counts.duplicates === 1 ? "" : "s"}.` }],
        details: { mode: "inbox" as const, ...counts, messageCount: messages.length },
      };
    },
  };
}

function executionText(result: ManagedHttpExecutionResult, actionId: string, revision: number, digest: string): string {
  if (result.kind === "confirmed") {
    return `Confirmed action ${actionId} revision ${revision}. One mutation request ran and the separate GET verification proved the expected remote state.`;
  }
  if (result.kind === "ambiguous") {
    return `Action ${actionId} revision ${revision} is ambiguous after effect_started. The mutation may have occurred, verification did not prove the expected state, and no retry was attempted.`;
  }
  if (result.kind === "definitive_failed") {
    return `Action ${actionId} revision ${revision} failed before fetch was invoked. No retry was attempted.`;
  }
  if (result.kind === "preflight_rejected") {
    return `Did not dispatch action ${actionId} revision ${revision}: ${result.message}. Re-propose from current trusted endpoint policy.`;
  }
  if (result.kind === "rejected") {
    if (result.reason === "approval_required") {
      return `Authorization required for action ${actionId} revision ${revision} digest ${digest}. No request has run. External messages need an exact recipient/topic/action owner rule or exact owner approval.`;
    }
    return `Did not dispatch action ${actionId} revision ${revision}: ${result.reason}. No new request was invoked.`;
  }
  throw new Error("unreachable managed HTTP execution result");
}

function executionDetails(result: ManagedHttpExecutionResult, attemptId: string): Record<string, unknown> {
  if (result.kind === "rejected") {
    return {
      mode: "send",
      kind: result.kind,
      reason: result.reason,
      attemptId,
      ...(result.action === undefined ? {} : { action: actionSummary(result.action) }),
      ...(result.attempt === undefined ? {} : { attempt: attemptSummary(result.attempt) }),
    };
  }
  if (result.kind === "preflight_rejected") {
    return {
      mode: "send",
      kind: result.kind,
      reason: result.reason,
      message: result.message,
      attemptId,
      action: actionSummary(result.action),
      ...(result.requiredEffectClass === undefined ? {} : { requiredEffectClass: result.requiredEffectClass }),
    };
  }
  return {
    mode: "send",
    kind: result.kind,
    attemptId,
    action: actionSummary(result.action),
    attempt: attemptSummary(result.attempt),
    evidence: result.evidence,
  };
}

function actionSummary(action: ActionRecord): Record<string, unknown> {
  return {
    id: action.id,
    workId: action.workId,
    semanticKey: action.semanticKey,
    revision: action.revision,
    digest: action.digest,
    state: action.state,
    effectClass: action.effectClass,
    action: action.action,
    ...(action.recipient === undefined ? {} : { recipient: action.recipient }),
    ...(action.topic === undefined ? {} : { topic: action.topic }),
    ...(action.activeAttemptId === undefined ? {} : { activeAttemptId: action.activeAttemptId }),
  };
}

function attemptSummary(attempt: AttemptRecord): Record<string, unknown> {
  return {
    id: attempt.id,
    actionId: attempt.actionId,
    actionRevision: attempt.actionRevision,
    actionDigest: attempt.actionDigest,
    state: attempt.state,
    authorizationSource: attempt.authorizationSource,
    claimedAt: attempt.claimedAt,
    ...(attempt.effectStartedAt === undefined ? {} : { effectStartedAt: attempt.effectStartedAt }),
    ...(attempt.settledAt === undefined ? {} : { settledAt: attempt.settledAt }),
    ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
  };
}

function rejectExecutionFieldsOnProposal(input: AgentEmailToolParams): void {
  if (input.actionId !== undefined || input.revision !== undefined || input.digest !== undefined) {
    throw new Error("agent email proposal must not include actionId, revision, or digest");
  }
}

function rejectProposalFieldsOnExecution(input: AgentEmailToolParams): void {
  if (input.workId !== undefined || input.to !== undefined || input.subject !== undefined || input.body !== undefined) {
    throw new Error("agent email send accepts only actionId, revision, and digest");
  }
}

function rejectFieldsOnInbox(input: AgentEmailToolParams): void {
  if (
    input.workId !== undefined
    || input.to !== undefined
    || input.subject !== undefined
    || input.body !== undefined
    || input.actionId !== undefined
    || input.revision !== undefined
    || input.digest !== undefined
  ) {
    throw new Error("agent email inbox accepts only mode");
  }
}

function requiredString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requiredTrimmed(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0 || value !== value.trim()) throw new Error(`${label} is required`);
  return value;
}

function requiredRevision(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("revision must be a positive integer");
  return value as number;
}

function requiredDigest(value: string | undefined): string {
  if (value === undefined || !/^[a-f0-9]{64}$/.test(value)) throw new Error("digest must be a lowercase sha256 digest");
  return value;
}
