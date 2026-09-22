import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeliveryPort } from "../../src/delivery/port.ts";
import { dispatchManagedAction } from "../../src/assistant-work/dispatch.ts";
import { configuredHttpAccess } from "../../src/assistant-work/http-policy.ts";
import {
  PEER_COORDINATION_ACTION,
  admitInboundPeerMessage,
  isPeerEnvelopeAction,
  executePeerMessage,
  proposePeerMessage,
} from "../../src/peers/coordination.ts";
import {
  decodePeerEnvelope,
  encodePeerEnvelope,
  type PeerEnvelope,
} from "../../src/peers/envelope.ts";
import type { TrustedPeerRecord } from "../../src/peers/trusted.ts";
import { stableAttemptId } from "../../src/assistant-work/model.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const T0 = "2026-09-18T00:00:00.000Z";
const T1 = "2026-09-18T00:01:00.000Z";
const T2 = "2026-09-18T00:02:00.000Z";
const roots: string[] = [];
const stores: StateStore[] = [];

const peer: TrustedPeerRecord = {
  id: "peer:alice",
  handle: "+821012345678",
  displayName: "Alice",
  relation: "household",
  state: "trusted",
  createdAt: T0,
  updatedAt: T0,
};

const envelope: PeerEnvelope = {
  v: 1,
  kind: "propose",
  threadKey: "trip",
  subject: "Weekend plans",
  body: "Can we leave Friday evening?",
  nonce: "0123456789abcdef0123456789abcdef",
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(): StateStore {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-peer-coordination-"));
  roots.push(root);
  const store = openStateStore(join(root, "state.db"));
  stores.push(store);
  return store;
}

function fakePort(options: { readonly fail?: boolean } = {}): { readonly port: DeliveryPort; readonly sends: string[] } {
  const sends: string[] = [];
  return {
    sends,
    port: {
      async sendText(handle, text) {
        sends.push(`${handle}:${text}`);
        if (options.fail) throw new Error("transport unavailable");
        return { messageId: `message-${sends.length}`, threadId: "thread-1" };
      },
      async sendReply() {
        return { messageId: "reply-1" };
      },
      async sendFile() {
        return { messageId: "file-1" };
      },
    },
  };
}

function admitWork(store: StateStore, suffix: string) {
  return store.assistantWork.admitObservation({
    source: "test",
    occurrenceKey: `work-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Peer test ${suffix}`,
    provenance: {
      principal: "system",
      channel: "test",
      subject: "test",
      evidenceId: `test:${suffix}`,
    },
    observedAt: T0,
    evidence: { suffix },
  }, T0).work;
}

async function proposeApproved(store: StateStore, suffix: string, peerRecord = peer) {
  const work = admitWork(store, suffix);
  const action = await proposePeerMessage({
    repository: store.assistantWork,
    workId: work.id,
    peer: peerRecord,
    envelope,
    now: () => T1,
  });
  store.assistantWork.grantExplicitApproval({
    actionId: action.id,
    revision: action.revision,
    digest: action.digest,
    provenance: {
      principal: "owner",
      channel: "test-owner",
      subject: "owner",
      evidenceId: `approval:${suffix}`,
    },
  }, T1);
  return action;
}

describe("peer coordination", () => {
  test("round-trips the strict wire envelope", () => {
    const encoded = encodePeerEnvelope(envelope);
    expect(encoded).toBe(`OI-PEER/1 ${JSON.stringify(envelope)}`);
    expect(decodePeerEnvelope(encoded)).toEqual(envelope);
  });

  test("rejects hostile and malformed envelopes without throwing", () => {
    const encoded = encodePeerEnvelope(envelope);
    const hostile = [
      encoded.replace('"v":1', '"v":2'),
      `${encoded.slice(0, -1)},"unknown":true}`,
      `${encoded}\nattack`,
      `OI-PEER/1 ${JSON.stringify({ ...envelope, subject: "x".repeat(513) })}`,
      encoded.replace(envelope.nonce, "not-a-nonce"),
      "hello from an ordinary chat",
      `OI-PEER/1 ${JSON.stringify({ ...envelope, body: "line\nfeed" })}`,
    ];
    for (const text of hostile) expect(decodePeerEnvelope(text)).toBeUndefined();
  });

  test("persists trusted peers and ignores an untrusted inbound handle", () => {
    const store = createStore();
    const persisted = store.upsertTrustedPeer({
      handle: " +82 10-1234-5678 ",
      displayName: "Alice",
      relation: "household",
    }, T0);
    expect(persisted).toMatchObject({ handle: "+821012345678", state: "trusted" });
    expect(store.listTrustedPeers()).toHaveLength(1);
    const result = admitInboundPeerMessage({
      repository: store.assistantWork,
      peers: store.listTrustedPeers(),
      handle: "+821099999999",
      text: encodePeerEnvelope(envelope),
      receivedAt: T1,
      now: () => T1,
    });
    expect(result).toEqual({ kind: "ignored", reason: "untrusted_peer" });
    expect(store.assistantWork.listObservations()).toHaveLength(0);
    expect(store.assistantWork.listWorks()).toHaveLength(0);
  });

  test("admits one trusted observation and idempotently replays the same nonce", () => {
    const store = createStore();
    store.upsertTrustedPeer({ handle: peer.handle, displayName: peer.displayName, relation: peer.relation }, T0);
    const input = {
      repository: store.assistantWork,
      peers: store.listTrustedPeers(),
      handle: " +82 10-1234-5678 ",
      text: encodePeerEnvelope(envelope),
      receivedAt: T1,
      now: () => T1,
    } as const;
    const first = admitInboundPeerMessage(input);
    const replay = admitInboundPeerMessage(input);
    expect(first).toMatchObject({ kind: "admitted", envelope, workId: expect.any(String) });
    expect(replay).toEqual(first);
    expect(store.assistantWork.listObservations()).toHaveLength(1);
    expect(store.assistantWork.listWorks()).toHaveLength(1);
  });

  test("ignores a revoked peer even when a prior trusted row exists", () => {
    const store = createStore();
    const persisted = store.upsertTrustedPeer({ handle: peer.handle, displayName: peer.displayName, relation: peer.relation }, T0);
    store.revokeTrustedPeer(persisted.id, T1);
    const result = admitInboundPeerMessage({
      repository: store.assistantWork,
      peers: store.listTrustedPeers(),
      handle: peer.handle,
      text: encodePeerEnvelope(envelope),
      receivedAt: T2,
      now: () => T2,
    });
    expect(result).toEqual({ kind: "ignored", reason: "revoked_peer" });
    expect(store.assistantWork.listObservations()).toHaveLength(0);
  });

  test("refuses outbound proposals to untrusted or revoked peers before writing an action", async () => {
    const store = createStore();
    const work = admitWork(store, "untrusted-outbound");
    await expect(proposePeerMessage({
      repository: store.assistantWork,
      workId: work.id,
      peer: { ...peer, state: "revoked" },
      envelope,
      now: () => T1,
    })).rejects.toThrow("revoked peer");
    expect(store.assistantWork.listActions()).toHaveLength(0);
  });

  test("claims, sends, and settles one approved outbound action exactly once", async () => {
    const store = createStore();
    const action = await proposeApproved(store, "confirmed");
    const { port, sends } = fakePort();
    const attemptId = stableAttemptId(action.id, action.revision, "dispatch-1");
    const first = await executePeerMessage({
      repository: store.assistantWork,
      port,
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId,
      workerId: "peer-test",
      peers: () => [peer],
      now: () => T2,
    });
    const second = await executePeerMessage({
      repository: store.assistantWork,
      port,
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId,
      workerId: "peer-test",
      peers: () => [peer],
      now: () => T2,
    });
    expect(first.kind).toBe("confirmed");
    expect(second).toMatchObject({ kind: "rejected", reason: "confirmed" });
    expect(sends).toHaveLength(1);
    expect(store.assistantWork.getAction(action.id)).toMatchObject({ state: "confirmed" });
  });

  test("settles a failed send as ambiguous rather than confirmed", async () => {
    const store = createStore();
    const action = await proposeApproved(store, "ambiguous");
    const { port, sends } = fakePort({ fail: true });
    const result = await executePeerMessage({
      repository: store.assistantWork,
      port,
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId: stableAttemptId(action.id, action.revision, "dispatch-failure"),
      workerId: "peer-test",
      peers: () => [peer],
      now: () => T2,
    });
    expect(result.kind).toBe("ambiguous");
    expect(store.assistantWork.getAction(action.id)).toMatchObject({ state: "ambiguous" });
    expect(sends).toHaveLength(1);
  });

  test("a peer revoked after approval cannot receive the approved envelope", async () => {
    const store = createStore();
    const action = await proposeApproved(store, "revoked-after-approval");
    const { port, sends } = fakePort();
    // The approval is real and the action is authorized; only the trust state
    // changed between approval and dispatch, which must stop the send.
    const revoked: TrustedPeerRecord = { ...peer, state: "revoked", updatedAt: T2 };
    const result = await executePeerMessage({
      repository: store.assistantWork,
      port,
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId: stableAttemptId(action.id, action.revision, "dispatch-revoked"),
      workerId: "peer-test",
      peers: () => [revoked],
      now: () => T2,
    });
    expect(result).toMatchObject({ kind: "rejected", reason: "revoked_peer" });
    expect(sends).toHaveLength(0);
    expect(store.assistantWork.listAttempts(action.id)).toHaveLength(0);
  });

  test("a revoke landing after the pre-claim check still stops the send", async () => {
    const store = createStore();
    const action = await proposeApproved(store, "revoked-mid-dispatch");
    const { port, sends } = fakePort();
    // Trusted on the first read (pre-claim) and revoked on the second
    // (post-claim): only the post-claim recheck can stop this send.
    let reads = 0;
    const result = await executePeerMessage({
      repository: store.assistantWork,
      port,
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId: stableAttemptId(action.id, action.revision, "dispatch-mid-revoke"),
      workerId: "peer-test",
      peers: () => {
        reads += 1;
        return reads === 1 ? [peer] : [{ ...peer, state: "revoked" as const, updatedAt: T2 }];
      },
      now: () => T2,
    });
    expect(reads).toBeGreaterThan(1);
    expect(result).toMatchObject({ kind: "rejected", reason: "revoked_peer" });
    expect(sends).toHaveLength(0);
    // The action is cancelled rather than left claimed, so nothing can later
    // resume an envelope to a peer the owner no longer trusts.
    expect(store.assistantWork.getAction(action.id)).toMatchObject({ state: "cancelled" });
  });

  test("a revoke that lands while the send waits in the transport queue still stops it", async () => {
    const store = createStore();
    const action = await proposeApproved(store, "queued-revoke");
    const sends: string[] = [];
    let trusted = true;
    // Models the real sender: the guard runs inside the queued slot, so a
    // revocation committed while earlier work drains must still stop this send.
    const port: DeliveryPort = {
      sendText: async (handle, text) => { sends.push(`${handle}:${text}`); return { messageId: "unguarded" }; },
      sendTextGuarded: async (handle, text, guard) => {
        trusted = false;
        if (!guard()) throw new Error("send guard refused delivery");
        sends.push(`${handle}:${text}`);
        return { messageId: "guarded" };
      },
      sendReply: async () => { throw new Error("unused"); },
      sendFile: async () => { throw new Error("unused"); },
    };
    const result = await executePeerMessage({
      repository: store.assistantWork,
      port,
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId: stableAttemptId(action.id, action.revision, "dispatch-queued-revoke"),
      workerId: "peer-test",
      peers: () => trusted ? [peer] : [{ ...peer, state: "revoked" as const, updatedAt: T2 }],
      now: () => T2,
    });
    expect(sends).toHaveLength(0);
    // The guard runs before the transport call, so nothing was sent: this is a
    // definitive refusal, not an ambiguous delivery.
    expect(result).toMatchObject({ kind: "rejected", reason: "revoked_peer" });
    expect(store.assistantWork.getAttempt(stableAttemptId(action.id, action.revision, "dispatch-queued-revoke")))
      .toMatchObject({ state: "definitive_failed" });
  });

  test("a peer removed from the allow-list after approval cannot receive it either", async () => {
    const store = createStore();
    const action = await proposeApproved(store, "removed-after-approval");
    const { port, sends } = fakePort();
    const result = await executePeerMessage({
      repository: store.assistantWork,
      port,
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId: stableAttemptId(action.id, action.revision, "dispatch-removed"),
      workerId: "peer-test",
      peers: () => [],
      now: () => T2,
    });
    expect(result).toMatchObject({ kind: "rejected", reason: "untrusted_peer" });
    expect(sends).toHaveLength(0);
    expect(store.assistantWork.listAttempts(action.id)).toHaveLength(0);
  });
});

describe("peer action integration boundaries", () => {
  test("a peer envelope action is approvable and recognizable by the owner-approval boundary", async () => {
    const store = createStore();
    const work = admitWork(store, "approvable");
    const action = await proposePeerMessage({
      repository: store.assistantWork,
      workId: work.id,
      peer,
      envelope,
      now: () => T1,
    });
    // The /approve path refuses actions whose executor it does not recognize,
    // so a peer envelope must be recognized there, not only in the peer lane.
    expect(isPeerEnvelopeAction(action)).toBe(true);
    expect(action.action).toBe(PEER_COORDINATION_ACTION);

    // A tampered payload must not be recognized as approvable.
    const foreign = store.assistantWork.proposeAction({
      workId: work.id,
      semanticKey: "not-a-peer-envelope",
      effectClass: "external_message",
      recipient: peer.handle,
      topic: "trip",
      action: PEER_COORDINATION_ACTION,
      payload: { handle: peer.handle, kind: "propose", threadKey: "trip", subject: "s", body: "b", nonce: "0".repeat(32), encoded: "not-an-envelope" },
    }, T1);
    expect(isPeerEnvelopeAction(foreign)).toBe(false);
  });

  test("a confirmed peer send cannot be given a repeat policy", async () => {
    const store = createStore();
    const action = await proposeApproved(store, "no-repeat");
    const { port } = fakePort();
    const result = await executePeerMessage({
      repository: store.assistantWork,
      port,
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId: stableAttemptId(action.id, action.revision, "dispatch-no-repeat"),
      workerId: "peer-test",
      peers: () => [peer],
      now: () => T2,
    });
    expect(result.kind).toBe("confirmed");

    // A repeat would copy the envelope, reusing its single-use nonce, and the
    // managed dispatcher has no peer executor to run it: accepting the policy
    // would promise the owner a repeat that can only ever be cancelled.
    expect(() => store.assistantWork.setFollowupPolicy({
      workId: action.workId,
      actionId: action.id,
      enabled: true,
      intervalMs: 60_000,
      maxAttempts: 1,
      provenance: { principal: "owner", channel: "test", subject: "owner", evidenceId: "no-repeat" },
    }, T2)).toThrow(/correlated capability actions/);
    expect(store.assistantWork.listFollowupPolicies()).toHaveLength(0);
  });

  test("a peer send claimed before a crash is released rather than stranded", async () => {
    const store = createStore();
    const action = await proposeApproved(store, "crash-claim");
    const attemptId = stableAttemptId(action.id, action.revision, "crashed");
    const claim = store.assistantWork.claimForDispatch({
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId,
      workerId: "crashed-worker",
    }, T2);
    expect(claim.kind).toBe("claimed");

    // Recovery routes every claimed action through the managed dispatcher,
    // which has no peer executor. Without an explicit release the attempt
    // would stay claimed_pre_effect forever and never be re-approvable.
    const result = await dispatchManagedAction({
      repository: store.assistantWork,
      action: store.assistantWork.getAction(action.id)!,
      attemptId,
      workerId: "crashed-worker",
      httpAccess: configuredHttpAccess(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(result).toMatchObject({ kind: "rejected", reason: "cancelled" });
    expect(store.assistantWork.getAction(action.id)).toMatchObject({ state: "cancelled" });
  });

  test("a peer dispatch that no longer owns the claim reports blocked instead of cancelling", async () => {
    const store = createStore();
    const action = await proposeApproved(store, "peer-not-owner");
    const attemptId = stableAttemptId(action.id, action.revision, "peer-not-owner");
    expect(store.assistantWork.claimForDispatch({
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      attemptId,
      workerId: "crashed-worker",
    }, T2).kind).toBe("claimed");
    // The attempt moved past the pre-effect claim, so it is no longer the state
    // the release is scoped to. The dispatcher must decline rather than cancel
    // a claim it does not own.
    store.assistantWork.markEffectStarted({ attemptId, workerId: "crashed-worker" }, T2);

    const result = await dispatchManagedAction({
      repository: store.assistantWork,
      action: store.assistantWork.getAction(action.id)!,
      attemptId,
      workerId: "crashed-worker",
      httpAccess: configuredHttpAccess(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(result).toMatchObject({ kind: "rejected", reason: "blocked" });
    expect(store.assistantWork.getAction(action.id)?.state).not.toBe("cancelled");
    expect(store.assistantWork.getAttempt(attemptId)?.state).toBe("effect_started");
  });
});
