import type { CustomTool } from "@gajae-code/coding-agent";
import { Type } from "@gajae-code/coding-agent/extensibility/typebox";

import type { DeliveryPort } from "../delivery/port.ts";
import { authorizationRequirementForEffect, type ActionRecord } from "../assistant-work/model.ts";
import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import {
  executePeerMessage,
  proposePeerMessage,
  type PeerMessageExecutionResult,
} from "./coordination.ts";
import { PEER_ENVELOPE_KINDS } from "./envelope.ts";
import { isTrustedPeer, normalizeHandle, type TrustedPeerRecord } from "./trusted.ts";

const DEFAULT_WORKER_ID = "main-session:peer-coordination";

interface PeerToolParams {
  readonly mode: "list" | "propose" | "send";
  readonly workId?: string;
  readonly handle?: string;
  readonly kind?: typeof PEER_ENVELOPE_KINDS[number];
  readonly threadKey?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly actionId?: string;
  readonly revision?: number;
  readonly digest?: string;
}

export interface PeerCoordinationToolOptions {
  readonly repository: AssistantWorkRepository;
  /** Live trusted-peer lookup; a revoked peer must stop working immediately. */
  readonly peers: () => readonly TrustedPeerRecord[];
  readonly port: () => DeliveryPort | undefined;
  readonly now?: () => Date;
  readonly workerId?: string;
}

/**
 * Lets the main session coordinate with a trusted peer's assistant. Proposals
 * are ordinary `external_message` actions, so the host approval path — not this
 * tool — decides whether an envelope may leave.
 */
export function createPeerCoordinationTool(options: PeerCoordinationToolOptions): CustomTool {
  const now = options.now ?? (() => new Date());
  const workerId = requiredTrimmed(options.workerId ?? DEFAULT_WORKER_ID, "workerId");

  return {
    name: "peer_coordinate",
    label: "Peer coordination",
    strict: true,
    concurrency: "exclusive",
    description: "List the owner's trusted peers, or propose and send one coordination envelope to a trusted peer's assistant. Sending is an external message bound to that exact handle and thread key, so it needs a matching send rule or owner approval.",
    // Keep the union nested: providers flatten root unions, mixing incompatible mode fields.
    parameters: Type.Object({
      request: Type.Union([
        Type.Object({ mode: Type.Literal("list") }, { additionalProperties: false }),
        Type.Object({
          mode: Type.Literal("propose"),
          workId: Type.String({ minLength: 1, maxLength: 512 }),
          handle: Type.String({ minLength: 1, maxLength: 128 }),
          kind: Type.Enum([...PEER_ENVELOPE_KINDS]),
          threadKey: Type.String({ minLength: 1, maxLength: 256 }),
          subject: Type.String({ minLength: 1, maxLength: 512 }),
          body: Type.String({ minLength: 1, maxLength: 4_096 }),
        }, { additionalProperties: false }),
        Type.Object({
          mode: Type.Literal("send"),
          actionId: Type.String({ minLength: 1, maxLength: 512 }),
          revision: Type.Integer({ minimum: 1 }),
          digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        }, { additionalProperties: false }),
      ]),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _onUpdate, _context, signal) {
      const input = (params as { request: PeerToolParams }).request;
      const peers = options.peers();

      if (input.mode === "list") {
        rejectFieldsOnList(input);
        const trusted = peers.filter((peer) => isTrustedPeer(peers, peer.handle));
        return {
          content: [{ type: "text" as const, text: listText(trusted) }],
          details: {
            mode: "list" as const,
            peers: trusted.map((peer) => ({
              handle: peer.handle, displayName: peer.displayName, relation: peer.relation,
            })),
            effectInvoked: false,
          },
        };
      }

      if (input.mode === "propose") {
        rejectSendFieldsOnProposal(input);
        const handle = requiredTrimmed(input.handle, "handle");
        const normalizedHandle = normalizeHandle(handle);
        const peer = peers.find((candidate) => candidate.id === handle
          || (normalizedHandle !== undefined && candidate.handle === normalizedHandle));
        if (peer === undefined || !isTrustedPeer(peers, peer.handle)) {
          throw new Error(`${handle} is not a trusted peer; ask the owner to add them before coordinating`);
        }
        if (input.kind === undefined) throw new Error("kind is required");
        const action = await proposePeerMessage({
          repository: options.repository,
          workId: requiredTrimmed(input.workId, "workId"),
          peer,
          envelope: {
            v: 1,
            kind: input.kind,
            threadKey: requiredTrimmed(input.threadKey, "threadKey"),
            subject: requiredTrimmed(input.subject, "subject"),
            body: requiredTrimmed(input.body, "body"),
          },
          now: () => now().toISOString(),
        });
        return {
          content: [{ type: "text" as const, text: proposalText(action, peer) }],
          details: { mode: "propose" as const, action: actionSummary(action), effectInvoked: false },
        };
      }

      rejectProposalFieldsOnSend(input);
      const port = options.port();
      if (port === undefined) {
        throw new Error("the iMessage lane is not attached, so a peer envelope cannot be sent");
      }
      const actionId = requiredTrimmed(input.actionId, "actionId");
      const revision = requiredRevision(input.revision);
      const digest = requiredDigest(input.digest);
      const result = await executePeerMessage({
        signal,
        repository: options.repository,
        port,
        actionId,
        revision,
        digest,
        attemptId: `peer:${actionId}:${revision}`,
        workerId,
        peers: options.peers,
        now: () => now().toISOString(),
      });
      return {
        content: [{ type: "text" as const, text: sendText(result, actionId, revision, digest) }],
        details: {
          mode: "send" as const,
          kind: result.kind,
          ...(result.kind === "rejected" ? { reason: result.reason } : {}),
          ...(result.kind === "rejected" ? {} : { attemptId: result.attempt.id }),
          effectInvoked: result.kind === "confirmed" || result.kind === "ambiguous",
        },
      };
    },
  };
}

function listText(peers: readonly TrustedPeerRecord[]): string {
  if (peers.length === 0) return "No trusted peers are configured, so peer coordination is unavailable.";
  return `Trusted peers: ${peers.map((peer) => `${peer.displayName} (${peer.handle}, ${peer.relation})`).join("; ")}.`;
}

function proposalText(action: ActionRecord, peer: TrustedPeerRecord): string {
  const requirement = authorizationRequirementForEffect(action.effectClass);
  const identity = `action ${action.id} revision ${action.revision} digest ${action.digest}`;
  return requirement === "local_policy"
    ? `Proposed a ${action.topic ?? "coordination"} envelope to ${peer.displayName}; send it with ${identity}.`
    : `Proposed a ${action.topic ?? "coordination"} envelope to ${peer.displayName} (${peer.handle}). It needs ${requirement === "owner_explicit" ? "owner approval" : "a matching send rule or owner approval"}: /approve ${action.id} ${action.revision} ${action.digest}`;
}

function sendText(result: PeerMessageExecutionResult, actionId: string, revision: number, digest: string): string {
  switch (result.kind) {
    case "confirmed":
      return `Delivered the envelope for action ${actionId} revision ${revision}.`;
    case "ambiguous":
      return `The envelope for action ${actionId} revision ${revision} may or may not have been delivered; it is recorded as ambiguous and will not be resent automatically.`;
    case "rejected":
      return `The ledger refused to send action ${actionId} revision ${revision} digest ${digest}: ${result.reason}.`;
  }
}

function actionSummary(action: ActionRecord): Record<string, unknown> {
  return {
    id: action.id,
    workId: action.workId,
    revision: action.revision,
    digest: action.digest,
    state: action.state,
    effectClass: action.effectClass,
    recipient: action.recipient,
    topic: action.topic,
    authorizationRequirement: authorizationRequirementForEffect(action.effectClass),
  };
}

function rejectFieldsOnList(input: PeerToolParams): void {
  for (const field of ["workId", "handle", "kind", "threadKey", "subject", "body", "actionId", "revision", "digest"] as const) {
    if (input[field] !== undefined) throw new Error(`${field} is not accepted in list mode`);
  }
}

function rejectSendFieldsOnProposal(input: PeerToolParams): void {
  for (const field of ["actionId", "revision", "digest"] as const) {
    if (input[field] !== undefined) throw new Error(`${field} is not accepted in propose mode`);
  }
}

function rejectProposalFieldsOnSend(input: PeerToolParams): void {
  for (const field of ["workId", "handle", "kind", "threadKey", "subject", "body"] as const) {
    if (input[field] !== undefined) throw new Error(`${field} is not accepted in send mode`);
  }
}

function requiredTrimmed(value: string | undefined, label: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) throw new Error(`${label} is required`);
  return trimmed;
}

function requiredRevision(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) throw new Error("revision is required");
  return value;
}

function requiredDigest(value: string | undefined): string {
  const digest = (value ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("digest is required");
  return digest;
}
