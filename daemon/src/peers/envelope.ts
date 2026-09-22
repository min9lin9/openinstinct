export const PEER_ENVELOPE_PREFIX = "OI-PEER/1";
export const PEER_ENVELOPE_KINDS = ["propose", "counter", "accept", "decline", "info"] as const;
export type PeerEnvelopeKind = typeof PEER_ENVELOPE_KINDS[number];

export interface PeerEnvelope {
  readonly v: 1;
  readonly kind: PeerEnvelopeKind;
  readonly threadKey: string;
  readonly subject: string;
  readonly body: string;
  readonly nonce: string;
}

const ENVELOPE_KEYS = ["v", "kind", "threadKey", "subject", "body", "nonce"] as const;
const MAX_THREAD_KEY_LENGTH = 512;
const MAX_SUBJECT_LENGTH = 512;
const MAX_BODY_LENGTH = 16_384;
const MAX_ENVELOPE_LENGTH = 24_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const NONCE = /^[0-9a-fA-F]{32}$/u;

export function encodePeerEnvelope(envelope: PeerEnvelope): string {
  assertEnvelope(envelope);
  return `${PEER_ENVELOPE_PREFIX} ${JSON.stringify({
    v: envelope.v,
    kind: envelope.kind,
    threadKey: envelope.threadKey,
    subject: envelope.subject,
    body: envelope.body,
    nonce: envelope.nonce,
  })}`;
}

export function decodePeerEnvelope(text: string): PeerEnvelope | undefined {
  if (typeof text !== "string" || text.length > MAX_ENVELOPE_LENGTH || CONTROL_CHARACTERS.test(text)) {
    return undefined;
  }
  const prefix = `${PEER_ENVELOPE_PREFIX} `;
  if (!text.startsWith(prefix)) {
    return undefined;
  }
  const json = text.slice(prefix.length);
  if (json.length === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== ENVELOPE_KEYS.length || !ENVELOPE_KEYS.every((key) => key in parsed)) {
    return undefined;
  }
  if (parsed.v !== 1 || !isPeerEnvelopeKind(parsed.kind)
    || typeof parsed.threadKey !== "string"
    || typeof parsed.subject !== "string"
    || typeof parsed.body !== "string"
    || typeof parsed.nonce !== "string") {
    return undefined;
  }
  const envelope: PeerEnvelope = {
    v: 1,
    kind: parsed.kind,
    threadKey: parsed.threadKey,
    subject: parsed.subject,
    body: parsed.body,
    nonce: parsed.nonce,
  };
  try {
    assertEnvelope(envelope);
  } catch {
    return undefined;
  }
  return envelope;
}

function assertEnvelope(envelope: PeerEnvelope): void {
  if (envelope.v !== 1) {
    throw new Error("peer envelope version is invalid");
  }
  if (!isPeerEnvelopeKind(envelope.kind)) {
    throw new Error("peer envelope kind is invalid");
  }
  assertTextField(envelope.threadKey, MAX_THREAD_KEY_LENGTH, "threadKey", true);
  assertTextField(envelope.subject, MAX_SUBJECT_LENGTH, "subject", false);
  assertTextField(envelope.body, MAX_BODY_LENGTH, "body", false);
  if (typeof envelope.nonce !== "string" || !NONCE.test(envelope.nonce)) {
    throw new Error("peer envelope nonce is invalid");
  }
}

function assertTextField(value: string, maximum: number, label: string, nonEmpty: boolean): void {
  if (typeof value !== "string" || (nonEmpty && value.length === 0) || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`peer envelope ${label} is invalid`);
  }
}

function isPeerEnvelopeKind(value: unknown): value is PeerEnvelopeKind {
  return typeof value === "string" && (PEER_ENVELOPE_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
