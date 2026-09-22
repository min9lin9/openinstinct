import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeClientFrame } from "../../src/control/schema.ts";
import { admitInboundPeerMessage } from "../../src/peers/coordination.ts";
import { encodePeerEnvelope } from "../../src/peers/envelope.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const T0 = "2026-09-18T00:00:00.000Z";
const HANDLE = "+821012345678";
const roots: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(): StateStore {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-peer-admin-"));
  roots.push(root);
  const store = openStateStore(join(root, "state.db"));
  stores.push(store);
  return store;
}

function envelopeFor(nonce: string): string {
  return encodePeerEnvelope({
    v: 1, kind: "propose", threadKey: "dinner", subject: "Friday", body: "8pm works?", nonce,
  });
}

describe("trusted peer administration", () => {
  test("an operator can enroll a peer, whose envelope is then admitted as evidence, and revoke them again", () => {
    const store = createStore();
    const nonce = "a".repeat(32);
    const later = "b".repeat(32);

    // Before enrollment the allow-list is empty, so the capability is inert.
    expect(store.listTrustedPeers()).toEqual([]);
    expect(admitInboundPeerMessage({
      repository: store.assistantWork,
      peers: store.listTrustedPeers("trusted"),
      handle: HANDLE,
      text: envelopeFor(nonce),
      receivedAt: T0,
      now: () => T0,
    })).toMatchObject({ kind: "ignored", reason: "untrusted_peer" });
    expect(store.assistantWork.listObservations()).toHaveLength(0);

    const enrolled = store.upsertTrustedPeer({
      handle: HANDLE, displayName: "Alice", relation: "household",
    }, T0);
    expect(enrolled).toMatchObject({ handle: HANDLE, state: "trusted", relation: "household" });
    expect(store.listTrustedPeers("trusted")).toHaveLength(1);

    const admitted = admitInboundPeerMessage({
      repository: store.assistantWork,
      peers: store.listTrustedPeers("trusted"),
      handle: HANDLE,
      text: envelopeFor(nonce),
      receivedAt: T0,
      now: () => T0,
    });
    expect(admitted).toMatchObject({ kind: "admitted" });
    expect(store.assistantWork.listObservations()).toHaveLength(1);
    expect(store.assistantWork.listObservations()[0]).toMatchObject({
      provenance: { principal: "third_party", channel: "peer", subject: HANDLE },
    });

    const revoked = store.revokeTrustedPeer(HANDLE, T0);
    expect(revoked).toMatchObject({ handle: HANDLE, state: "revoked" });
    // Revocation keeps the record but stops admission of anything new.
    expect(store.listTrustedPeers()).toHaveLength(1);
    expect(store.listTrustedPeers("trusted")).toHaveLength(0);
    expect(admitInboundPeerMessage({
      repository: store.assistantWork,
      peers: store.listTrustedPeers(),
      handle: HANDLE,
      text: envelopeFor(later),
      receivedAt: T0,
      now: () => T0,
    })).toMatchObject({ kind: "ignored", reason: "revoked_peer" });
    expect(store.assistantWork.listObservations()).toHaveLength(1);
  });

  test("the control surface rejects malformed enrollment payloads", () => {
    // The trust boundary moves here, so payload validation is the gate: an
    // unknown relation, a bad handle, or a missing field must never enroll.
    const decode = (verb: string, payload: Record<string, unknown>) => () => decodeClientFrame({
      type: "request", id: "req-1", verb, payload,
    });
    expect(decode("peers.upsert", { handle: HANDLE, displayName: "Alice", relation: "household" })).not.toThrow();
    expect(decode("peers.upsert", { handle: HANDLE, displayName: "Alice", relation: "stranger" })).toThrow();
    expect(decode("peers.upsert", { handle: "not a handle", displayName: "Alice", relation: "household" })).toThrow();
    expect(decode("peers.upsert", { handle: HANDLE, displayName: "", relation: "household" })).toThrow();
    expect(decode("peers.upsert", { handle: HANDLE, relation: "household" })).toThrow();
    expect(decode("peers.upsert", { handle: HANDLE, displayName: "Alice", relation: "household", extra: 1 })).toThrow();
    expect(decode("peers.revoke", { handle: HANDLE })).not.toThrow();
    expect(decode("peers.revoke", {})).toThrow();
  });

  test("enrollment is idempotent on the normalized handle", () => {
    const store = createStore();
    store.upsertTrustedPeer({ handle: HANDLE, displayName: "Alice", relation: "household" }, T0);
    store.upsertTrustedPeer({ handle: HANDLE, displayName: "Alice Kim", relation: "colleague" }, T0);
    const peers = store.listTrustedPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ displayName: "Alice Kim", relation: "colleague", state: "trusted" });
  });
});
