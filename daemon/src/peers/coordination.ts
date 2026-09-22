import { randomBytes } from "node:crypto";

import type { DeliveryPort, DeliveryReceipt } from "../delivery/port.ts";
import { isTrustedPeer, normalizeHandle, type TrustedPeerRecord } from "./trusted.ts";
import { decodePeerEnvelope, encodePeerEnvelope, type PeerEnvelope } from "./envelope.ts";
import type {
  ActionRecord,
  AttemptRecord,
  ClaimRejectionReason,
  JsonValue,
} from "../assistant-work/model.ts";
import type { AssistantWorkRepository } from "../store/assistant-work.ts";

/** Thrown when the transport guard refuses before any send is attempted. */
class PeerTrustRefusedError extends Error {
  public constructor(recipient: string) {
    super(`peer trust was revoked before the envelope to ${recipient} was sent`);
    this.name = "PeerTrustRefusedError";
  }
}

export const PEER_COORDINATION_SOURCE = "peer-coordination";
export const PEER_COORDINATION_ACTION = "send_peer_envelope";

export interface AdmittedInboundPeerMessage {
  readonly kind: "admitted";
  readonly envelope: PeerEnvelope;
  readonly workId: string;
}

export type InboundPeerMessageAdmission = AdmittedInboundPeerMessage | {
  readonly kind: "ignored";
  readonly reason: "not_an_envelope" | "untrusted_peer" | "revoked_peer";
};

export interface ProposePeerMessageInput {
  readonly repository: AssistantWorkRepository;
  readonly workId: string;
  readonly peer: TrustedPeerRecord;
  readonly envelope: Omit<PeerEnvelope, "nonce"> & { readonly nonce?: string };
  readonly now?: () => string;
}

export interface ExecutePeerMessageInput {
  /** Aborts before the claim; the transport itself is a single atomic send. */
  readonly signal?: AbortSignal;
  readonly repository: AssistantWorkRepository;
  readonly port: DeliveryPort;
  readonly actionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly attemptId: string;
  readonly workerId: string;
  /** Resolves the current trusted-peer ledger immediately before dispatch. */
  readonly peers: () => readonly TrustedPeerRecord[];
  readonly now?: () => string;
}

export type PeerMessageExecutionResult =
  | {
      readonly kind: "rejected";
      readonly reason: ClaimRejectionReason | "unsupported_action" | "invalid_payload" | "untrusted_peer" | "revoked_peer";
      readonly action?: ActionRecord;
      readonly attempt?: AttemptRecord;
    }
  | {
      readonly kind: "confirmed" | "ambiguous";
      readonly action: ActionRecord;
      readonly attempt: AttemptRecord;
      readonly evidence: JsonValue;
    };

export function admitInboundPeerMessage(input: {
  readonly repository: AssistantWorkRepository;
  readonly peers: readonly TrustedPeerRecord[];
  readonly handle: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly now?: () => string;
}): InboundPeerMessageAdmission {
  const envelope = decodePeerEnvelope(input.text);
  if (envelope === undefined) {
    return { kind: "ignored", reason: "not_an_envelope" };
  }
  const normalizedHandle = normalizeHandle(input.handle);
  if (normalizedHandle === undefined) {
    return { kind: "ignored", reason: "untrusted_peer" };
  }
  const peer = input.peers.find((candidate) => candidate.handle === normalizedHandle);
  if (peer === undefined) {
    return { kind: "ignored", reason: "untrusted_peer" };
  }
  if (!isTrustedPeer(input.peers, normalizedHandle)) {
    return { kind: "ignored", reason: "revoked_peer" };
  }

  const nonce = envelope.nonce.toLowerCase();
  const occurrenceKey = `${normalizedHandle}:${nonce}`;
  const workKey = `${PEER_COORDINATION_SOURCE}:${normalizedHandle}:${envelope.threadKey}`;
  const admission = input.repository.admitObservation({
    source: PEER_COORDINATION_SOURCE,
    occurrenceKey,
    workKey,
    workTitle: `Peer coordination with ${normalizedHandle}: ${envelope.subject || envelope.threadKey}`,
    provenance: {
      principal: "third_party",
      channel: "peer",
      subject: normalizedHandle,
      evidenceId: `${PEER_COORDINATION_SOURCE}:${occurrenceKey}`,
    },
    observedAt: input.receivedAt,
    evidence: {
      kind: envelope.kind,
      threadKey: envelope.threadKey,
      subject: envelope.subject,
      body: envelope.body,
    },
  }, input.now?.() ?? new Date().toISOString());
  return { kind: "admitted", envelope, workId: admission.work.id };
}

/** Strict recognizer for the owner-approval boundary: the payload must be a
 * well-formed peer envelope bound to the action's own recipient and topic. */
export function isPeerEnvelopeAction(action: ActionRecord): boolean {
  if (action.action !== PEER_COORDINATION_ACTION || action.effectClass !== "external_message") return false;
  const payload = peerEnvelopePayload(action.payload);
  if (payload === undefined) return false;
  const envelope = decodePeerEnvelope(payload.encoded);
  const normalized = normalizeHandle(payload.handle);
  return envelope !== undefined
    && normalized !== undefined
    && normalized === action.recipient
    && envelope.threadKey === action.topic;
}

export async function proposePeerMessage(input: ProposePeerMessageInput): Promise<ActionRecord> {
  const normalizedHandle = normalizeHandle(input.peer.handle);
  if (normalizedHandle === undefined) {
    throw new Error("cannot propose a peer message to an invalid handle");
  }
  if (input.peer.state !== "trusted") {
    throw new Error("cannot propose a peer message to a revoked peer");
  }
  const nonce = input.envelope.nonce ?? randomBytes(16).toString("hex");
  const envelope: PeerEnvelope = {
    v: input.envelope.v,
    kind: input.envelope.kind,
    threadKey: input.envelope.threadKey,
    subject: input.envelope.subject,
    body: input.envelope.body,
    nonce,
  };
  const encoded = encodePeerEnvelope(envelope);
  const semanticKey = `${PEER_COORDINATION_SOURCE}:${normalizedHandle}:${envelope.threadKey}:${nonce.toLowerCase()}`;
  return input.repository.proposeAction({
    workId: input.workId,
    semanticKey,
    effectClass: "external_message",
    recipient: normalizedHandle,
    topic: envelope.threadKey,
    action: PEER_COORDINATION_ACTION,
    payload: {
      handle: normalizedHandle,
      kind: envelope.kind,
      threadKey: envelope.threadKey,
      subject: envelope.subject,
      body: envelope.body,
      nonce: envelope.nonce,
      encoded,
    },
    scope: {
      peerId: input.peer.id,
      relation: input.peer.relation,
      displayName: input.peer.displayName,
    },
  }, input.now?.() ?? new Date().toISOString());
}

export async function executePeerMessage(input: ExecutePeerMessageInput): Promise<PeerMessageExecutionResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const action = input.repository.getAction(input.actionId);
  if (action === undefined) {
    return { kind: "rejected", reason: "unknown_action" };
  }
  if (action.revision !== input.revision) {
    return { kind: "rejected", reason: "stale_revision", action };
  }
  if (action.digest !== input.digest) {
    return { kind: "rejected", reason: "stale_digest", action };
  }
  if (action.action !== PEER_COORDINATION_ACTION || action.effectClass !== "external_message") {
    return { kind: "rejected", reason: "unsupported_action", action };
  }
  const payload = peerEnvelopePayload(action.payload);
  if (payload === undefined) {
    return { kind: "rejected", reason: "invalid_payload", action };
  }
  const recipient = action.recipient;
  if (recipient === undefined) {
    return { kind: "rejected", reason: "invalid_payload", action };
  }
  const normalizedPayloadHandle = normalizeHandle(payload.handle);
  if (normalizedPayloadHandle === undefined || normalizedPayloadHandle !== recipient) {
    return { kind: "rejected", reason: "invalid_payload", action };
  }
  const livePeers = input.peers();
  const livePeer = livePeers.find((candidate) => candidate.handle === recipient);
  if (!isTrustedPeer(livePeers, recipient)) {
    return {
      kind: "rejected",
      reason: livePeer === undefined ? "untrusted_peer" : "revoked_peer",
      action,
    };
  }

  if (input.signal?.aborted === true) {
    return { kind: "rejected", reason: "cancelled", action };
  }
  const claim = input.repository.claimForDispatch({
    actionId: input.actionId,
    revision: input.revision,
    digest: input.digest,
    attemptId: input.attemptId,
    workerId: input.workerId,
  }, now());
  if (claim.kind === "rejected") {
    return claim;
  }

  // Re-read trust after the claim: a revoke committed between the first check
  // and here must still stop the send, and the claim is the point after which
  // an attempt row exists. Cancelling before `effect_started` leaves no
  // ambiguity about whether the envelope went out.
  const claimedPeers = input.peers();
  if (!isTrustedPeer(claimedPeers, recipient)) {
    // Nothing was sent and the attempt never started its effect, so the ledger
    // cannot settle it as failed. Cancelling the action is the truthful move:
    // this envelope must never go to a peer the owner no longer trusts, and it
    // releases the claim instead of leaving it dangling.
    const cancelled = input.repository.cancelAction({
      actionId: input.actionId,
      revision: input.revision,
      digest: input.digest,
      reason: "peer_trust_revoked_before_send",
    }, now());
    return {
      kind: "rejected",
      reason: claimedPeers.some((candidate) => candidate.handle === recipient) ? "revoked_peer" : "untrusted_peer",
      action: cancelled,
    };
  }

  const started = input.repository.markEffectStarted({
    attemptId: input.attemptId,
    workerId: input.workerId,
  }, now());
  if (started.attempt.state !== "effect_started") {
    throw new Error(`peer message attempt did not enter effect_started: ${input.attemptId}`);
  }

  let receipt: DeliveryReceipt;
  try {
    // Re-checked inside the transport slot when the port supports it: a queued
    // send can otherwise wait behind earlier work while the peer is revoked.
    if (input.port.sendTextGuarded === undefined) {
      receipt = await input.port.sendText(recipient, payload.encoded);
    } else {
      let guardRefused = false;
      receipt = await input.port.sendTextGuarded(recipient, payload.encoded, () => {
        const trusted = isTrustedPeer(input.peers(), recipient);
        guardRefused = !trusted;
        return trusted;
      }).catch((error: unknown) => {
        // A refused guard ran before the transport call, so nothing was sent:
        // that is a definitive refusal, not an ambiguous delivery.
        if (guardRefused) throw new PeerTrustRefusedError(recipient);
        throw error;
      });
    }
  } catch (error) {
    if (error instanceof PeerTrustRefusedError) {
      const refusal: JsonValue = { code: "peer_trust_revoked_before_send", recipient };
      const settled = input.repository.failAttemptDefinitively({
        attemptId: input.attemptId,
        workerId: input.workerId,
        outcome: refusal,
      }, now());
      return { kind: "rejected", reason: "revoked_peer", action: settled.action, attempt: settled.attempt };
    }
    const evidence: JsonValue = {
      code: "peer_send_ambiguous",
      message: "peer message delivery failed after the effect started; delivery may have landed",
      recipient,
    };
    const settled = input.repository.markAttemptAmbiguous({
      attemptId: input.attemptId,
      workerId: input.workerId,
      outcome: evidence,
    }, now());
    return { kind: "ambiguous", action: settled.action, attempt: settled.attempt, evidence };
  }

  const evidence = deliveryEvidence(receipt, recipient);
  const settled = input.repository.confirmAttempt({
    attemptId: input.attemptId,
    workerId: input.workerId,
    outcome: evidence,
  }, now());
  return { kind: "confirmed", action: settled.action, attempt: settled.attempt, evidence };
}

function peerEnvelopePayload(payload: JsonValue): { readonly handle: string; readonly encoded: string } | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const object = payload as { readonly [key: string]: JsonValue };
  const expectedKeys = ["handle", "kind", "threadKey", "subject", "body", "nonce", "encoded"];
  if (Object.keys(object).length !== expectedKeys.length || !expectedKeys.every((key) => key in object)) {
    return undefined;
  }
  const handle = object.handle;
  const encoded = object.encoded;
  if (typeof handle !== "string" || typeof encoded !== "string") {
    return undefined;
  }
  const parsed = decodePeerEnvelope(encoded);
  if (parsed === undefined) {
    return undefined;
  }
  if (object.kind !== parsed.kind || object.threadKey !== parsed.threadKey
    || object.subject !== parsed.subject || object.body !== parsed.body || object.nonce !== parsed.nonce) {
    return undefined;
  }
  try {
    if (encodePeerEnvelope(parsed) !== encoded) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { handle, encoded };
}

function deliveryEvidence(receipt: DeliveryReceipt, recipient: string): JsonValue {
  return {
    recipient,
    receipt: {
      messageId: receipt.messageId,
      ...(receipt.threadId === undefined ? {} : { threadId: receipt.threadId }),
      ...(receipt.linkedMessageId === undefined ? {} : { linkedMessageId: receipt.linkedMessageId }),
    },
  };
}
