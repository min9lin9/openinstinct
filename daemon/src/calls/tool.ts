import type { CustomTool } from "@gajae-code/coding-agent";
import { Type } from "@gajae-code/coding-agent/extensibility/typebox";

import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import type {
  ManagedHttpEndpointPolicy,
  ManagedHttpSecretResolver,
} from "../assistant-work/http-effects.ts";
import type { ActionRecord, JsonValue } from "../assistant-work/model.ts";
import {
  executeAgentCall,
  proposeAgentCall,
  type AgentCallExecutionResult,
  type AgentCallRequest,
} from "./agent-call.ts";
import type { CallProviderConfig } from "./provider.ts";

const DEFAULT_WORKER_ID = "main-session:agent-call";

interface AgentCallToolParams {
  readonly mode: "propose" | "place";
  readonly workId?: string;
  readonly to?: string;
  readonly purpose?: string;
  readonly script?: string;
  readonly maxMinutes?: number;
  readonly actionId?: string;
  readonly revision?: number;
  readonly digest?: string;
}

export interface AgentCallToolOptions {
  readonly repository: AssistantWorkRepository;
  readonly provider: CallProviderConfig;
  readonly endpointPolicy: ManagedHttpEndpointPolicy;
  readonly resolveSecret?: ManagedHttpSecretResolver;
  readonly now?: () => Date;
  readonly workerId?: string;
}

export function createAgentCallTool(options: AgentCallToolOptions): CustomTool {
  const now = options.now ?? (() => new Date());
  const workerId = requiredTrimmed(options.workerId ?? DEFAULT_WORKER_ID, "workerId");

  return {
    name: "agent_call",
    label: "Agent Voice Call",
    strict: true,
    concurrency: "exclusive",
    description: "Propose or place one bounded outbound voice call through the host-configured telephony provider. The call is an external_mutation and always requires explicit owner approval; owner rules cannot authorize it.",
    parameters: Type.Object({
      request: Type.Union([
        Type.Object({
          mode: Type.Literal("propose"),
          workId: Type.String({ minLength: 1, maxLength: 512 }),
          to: Type.String({ minLength: 1, maxLength: 64 }),
          purpose: Type.String({ minLength: 1, maxLength: 4_096 }),
          script: Type.String({ minLength: 1, maxLength: 100_000 }),
          maxMinutes: Type.Integer({ minimum: 1, maximum: 30 }),
        }, { additionalProperties: false }),
        Type.Object({
          mode: Type.Literal("place"),
          actionId: Type.String({ minLength: 1, maxLength: 512 }),
          revision: Type.Integer({ minimum: 1 }),
          digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        }, { additionalProperties: false }),
      ]),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _onUpdate, _context, signal) {
      const input = (params as { readonly request: AgentCallToolParams }).request;
      if (input.mode === "propose") {
        rejectPlaceFieldsOnProposal(input);
        const request: AgentCallRequest = {
          to: requiredString(input.to, "to"),
          purpose: requiredString(input.purpose, "purpose"),
          script: requiredString(input.script, "script"),
          maxMinutes: requiredMinutes(input.maxMinutes),
        };
        const proposed = await proposeAgentCall({
          repository: options.repository,
          workId: requiredTrimmed(input.workId, "workId"),
          provider: options.provider,
          request,
          endpointPolicy: options.endpointPolicy,
          now: () => now().toISOString(),
        });
        return {
          content: [{ type: "text" as const, text: proposalText(proposed.action) }],
          details: {
            mode: "propose" as const,
            action: actionSummary(proposed.action),
            effectInvoked: false,
          },
        };
      }

      rejectProposalFieldsOnPlace(input);
      const actionId = requiredTrimmed(input.actionId, "actionId");
      const revision = requiredRevision(input.revision);
      const digest = requiredDigest(input.digest);
      const result = await executeAgentCall({
        signal,
        repository: options.repository,
        provider: options.provider,
        actionId,
        revision,
        digest,
        attemptId: undefined,
        dispatchKey: requiredTrimmed(toolCallId, "toolCallId"),
        workerId,
        endpointPolicy: options.endpointPolicy,
        resolveSecret: options.resolveSecret,
        now: () => now().toISOString(),
      });
      return {
        content: [{ type: "text" as const, text: placementText(result, actionId, revision) }],
        details: {
          mode: "place" as const,
          ...executionDetails(result),
          effectInvoked: result.kind === "placed"
            || result.kind === "failed" && result.managed?.kind === "definitive_failed"
            || result.kind === "uncertain",
        },
      };
    },
  };
}

const MAX_RENDERED_SCRIPT = 2_000;

function proposalText(action: ActionRecord): string {
  const call = callDetails(action);
  const identity = `action ${action.id} revision ${action.revision} digest ${action.digest}`;
  const callee = call?.callee ?? "the requested callee";
  const purpose = call?.purpose ?? "the requested purpose";
  const maxMinutes = call?.maxMinutes ?? "the configured limit";
  // The owner must be able to read the exact words before approving them.
  const script = call?.script === undefined
    ? "the authorized script is unavailable"
    : call.script.length > MAX_RENDERED_SCRIPT
      ? `${call.script.slice(0, MAX_RENDERED_SCRIPT)}… (truncated for display; the approved digest covers the full script)`
      : call.script;
  return `Prepared a call to ${callee} for ${purpose}. Cost bound: at most ${maxMinutes} minute${maxMinutes === 1 ? "" : "s"}. Authorized script: ${script}. This is an external_mutation and its authorization requirement is owner_explicit: explicit owner approval is required, and owner rules cannot authorize calls. No call was placed. Send exactly: /approve ${identity.slice(6)}`;
}

function placementText(result: AgentCallExecutionResult, actionId: string, revision: number): string {
  const call = result.action === undefined ? undefined : callDetails(result.action);
  const callee = call?.callee ?? "the requested callee";
  if (result.kind === "placed") {
    return `Call to ${callee} was placed and the provider verification confirmed it.`;
  }
  if (result.kind === "uncertain") {
    return `Call to ${callee} is uncertain after effect_started: ${result.reason}. No retry was attempted. Inspect assistant work action ${actionId} revision ${revision} before taking any further action.`;
  }
  return `Call to ${callee} failed: ${result.reason}. No automatic retry was attempted.`;
}

function executionDetails(result: AgentCallExecutionResult): Record<string, unknown> {
  return {
    kind: result.kind,
    ...(result.action === undefined ? {} : { action: actionSummary(result.action) }),
    ...(result.attempt === undefined ? {} : {
      attempt: {
        id: result.attempt.id,
        state: result.attempt.state,
        authorizationSource: result.attempt.authorizationSource,
      },
    }),
    ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
    ...("reason" in result ? { reason: result.reason } : {}),
  };
}

function actionSummary(action: ActionRecord): Record<string, unknown> {
  return {
    id: action.id,
    workId: action.workId,
    revision: action.revision,
    digest: action.digest,
    state: action.state,
    effectClass: action.effectClass,
    authorizationRequirement: "owner_explicit",
    ...(action.scope === undefined ? {} : { scope: action.scope }),
    ...(action.cost === undefined ? {} : { cost: action.cost }),
  };
}

function callDetails(action: ActionRecord): {
  readonly script?: string;
  readonly callee: string;
  readonly purpose: string;
  readonly maxMinutes: number;
} | undefined {
  if (!isRecord(action.scope)
    || action.scope.kind !== "agent_call"
    || typeof action.scope.callee !== "string"
    || typeof action.scope.purpose !== "string"
    || !isRecord(action.cost)
    || action.cost.kind !== "call"
    || typeof action.cost.maxMinutes !== "number") return undefined;
  return {
    callee: action.scope.callee,
    purpose: action.scope.purpose,
    maxMinutes: action.cost.maxMinutes,
    ...(typeof action.scope.script === "string" ? { script: action.scope.script } : {}),
  };
}

function rejectPlaceFieldsOnProposal(input: AgentCallToolParams): void {
  if (input.actionId !== undefined || input.revision !== undefined || input.digest !== undefined) {
    throw new Error("agent_call propose accepts call fields only; actionId, revision, and digest belong to place");
  }
}

function rejectProposalFieldsOnPlace(input: AgentCallToolParams): void {
  if (
    input.workId !== undefined
    || input.to !== undefined
    || input.purpose !== undefined
    || input.script !== undefined
    || input.maxMinutes !== undefined
  ) {
    throw new Error("agent_call place accepts actionId, revision, and digest only");
  }
}

function requiredString(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requiredTrimmed(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredMinutes(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 30) {
    throw new Error("maxMinutes must be an integer from 1 to 30");
  }
  return value as number;
}

function requiredRevision(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("revision must be a positive integer");
  return value as number;
}

function requiredDigest(value: string | undefined): string {
  const digest = requiredTrimmed(value, "digest");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("digest must be a lowercase sha256 digest");
  return digest;
}

function isRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
