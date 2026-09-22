import { hashHandle, normalizeHandle } from "../imessage/allowlist.ts";

export { normalizeHandle };

export const TRUSTED_PEER_RELATIONS = ["household", "colleague", "professional", "business"] as const;
export type TrustedPeerRelation = typeof TRUSTED_PEER_RELATIONS[number];
export type TrustedPeerState = "trusted" | "revoked";

export interface TrustedPeerRecord {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly relation: TrustedPeerRelation;
  readonly state: TrustedPeerState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TrustedPeerUpsertInput {
  readonly handle: string;
  readonly displayName: string;
  readonly relation: TrustedPeerRelation;
  readonly state?: TrustedPeerState;
}

export function trustedPeerId(handle: string): string {
  const normalized = normalizeHandle(handle);
  if (normalized === undefined) {
    throw new Error("trusted peer handle is invalid");
  }
  return `peer:${hashHandle(normalized)}`;
}

export function isTrustedPeer(records: readonly TrustedPeerRecord[], handle: string): boolean {
  const normalized = normalizeHandle(handle);
  return normalized !== undefined
    && records.some((record) => record.state === "trusted" && record.handle === normalized);
}
