import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStore } from "../../src/store/db.ts";
import { createResponseCompletionTool } from "../../src/assistant-work/response.ts";
import { hasMaterialIntegrityViolation } from "../../src/store/assistant-work.ts";

test("response evidence must match a confirmed action and uncertain responses cannot close work", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-response-"));
  const store = openStateStore(join(root, "state.db"));
  const then = "2026-01-01T00:00:00.000Z";
  const owner = { principal: "owner" as const, channel: "panel", subject: "owner", evidenceId: "explicit" };
  try {
    const work = store.assistantWork.admitObservation({ source: "fixture:mail", occurrenceKey: "request", workKey: "thread", workTitle: "Question", observedAt: then, evidence: { question: "When?" }, provenance: { principal: "third_party", channel: "fixture", subject: "sender", evidenceId: "request" } }, then).work;
    const action = store.assistantWork.proposeAction({ workId: work.id, semanticKey: "reply", effectClass: "external_message", recipient: "sender", topic: "schedule", action: "reply", payload: { body: "Friday?" } }, then);
    store.assistantWork.grantExplicitApproval({ actionId: action.id, revision: action.revision, digest: action.digest, provenance: owner }, then);
    store.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision, digest: action.digest, attemptId: "sent", workerId: "fixture" }, then);
    store.assistantWork.markEffectStarted({ attemptId: "sent", workerId: "fixture" }, then);
    store.assistantWork.confirmAttempt({ attemptId: "sent", workerId: "fixture", outcome: { remoteReceipt: "message-1" } }, then);
    const tool = createResponseCompletionTool(store.assistantWork);
    const input = { workId: work.id, responseToActionId: action.id, source: "fixture:mail", observedWorkKey: work.stableKey, occurrenceKey: "response-1", reference: "fixture://thread/response-1", summary: "Friday is confirmed", observedAt: "2026-01-01T00:01:00.000Z", confidence: "uncertain", satisfiesOutstandingRequest: true };
    await tool.execute("uncertain", input as never, undefined, {} as never);
    expect(store.assistantWork.getWork(work.id)?.state).toBe("open");
    await expect(tool.execute("wrong-thread", { ...input, observedWorkKey: "different-thread", reference: "fixture://different-thread/reply", confidence: "clear" } as never, undefined, {} as never)).rejects.toThrow("conversation key");
    expect(store.assistantWork.getWork(work.id)?.state).toBe("open");
    await expect(tool.execute("wrong-source", { ...input, source: "unrelated", occurrenceKey: "response-2", confidence: "clear" } as never, undefined, {} as never)).rejects.toThrow("source");
    await expect(tool.execute("old-response", { ...input, occurrenceKey: "response-old", observedAt: "2025-12-31T23:00:00.000Z", confidence: "clear" } as never, undefined, {} as never)).rejects.toThrow("predates");
    await tool.execute("clear", { ...input, occurrenceKey: "response-confirmed", confidence: "clear" } as never, undefined, {} as never);
    expect(store.assistantWork.getWork(work.id)?.state).toBe("completed");
    expect(store.assistantWork.listExplicitApprovals(action.id)).toHaveLength(1);
    expect(store.assistantWork.listAttempts(action.id)).toHaveLength(1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a confirmation recorded against rewritten material cannot complete work", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-response-tamper-"));
  const path = join(root, "state.db");
  const store = openStateStore(path);
  const then = "2026-01-01T00:00:00.000Z";
  const owner = { principal: "owner" as const, channel: "panel", subject: "owner", evidenceId: "explicit" };
  try {
    const work = store.assistantWork.admitObservation({ source: "fixture:mail", occurrenceKey: "t-request", workKey: "t-thread", workTitle: "Question", observedAt: then, evidence: { question: "When?" }, provenance: { principal: "third_party", channel: "fixture", subject: "sender", evidenceId: "t-request" } }, then).work;
    const action = store.assistantWork.proposeAction({ workId: work.id, semanticKey: "t-reply", effectClass: "external_message", recipient: "sender", topic: "schedule", action: "reply", payload: { body: "Friday?" } }, then);
    store.assistantWork.grantExplicitApproval({ actionId: action.id, revision: action.revision, digest: action.digest, provenance: owner }, then);
    store.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision, digest: action.digest, attemptId: "t-sent", workerId: "fixture" }, then);
    store.assistantWork.markEffectStarted({ attemptId: "t-sent", workerId: "fixture" }, then);
    store.assistantWork.confirmAttempt({ attemptId: "t-sent", workerId: "fixture", outcome: { remoteReceipt: "message-1" } }, then);
    store.close();

    // Rewrite the material after the confirmation: the settlement is still a
    // fact about what ran, but it no longer describes approved material, so it
    // must not be usable as authority to close the work.
    const db = new Database(path);
    try {
      db.query("UPDATE assistant_work_action_revisions SET payload_json = ? WHERE action_id = ?")
        .run(JSON.stringify({ body: "rewritten" }), action.id);
    } finally {
      db.close();
    }

    const reopened = openStateStore(path);
    try {
      const tool = createResponseCompletionTool(reopened.assistantWork);
      const input = { workId: work.id, responseToActionId: action.id, source: "fixture:mail", observedWorkKey: work.stableKey, occurrenceKey: "t-response", reference: "fixture://t-thread/response", summary: "Friday is confirmed", observedAt: "2026-01-01T00:01:00.000Z", confidence: "clear", satisfiesOutstandingRequest: true };
      await expect(tool.execute("tampered", input as never, undefined, {} as never))
        .rejects.toThrow(/no longer matches its approved digest/);
      expect(reopened.assistantWork.getWork(work.id)?.state).toBe("open");
    } finally {
      reopened.close();
    }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a confirmation flagged as material-violating is refused by the integrity filter alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "oi-response-flagged-"));
  const path = join(root, "state.db");
  const store = openStateStore(path);
  const then = "2026-01-01T00:00:00.000Z";
  const owner = { principal: "owner" as const, channel: "panel", subject: "owner", evidenceId: "explicit" };
  try {
    const work = store.assistantWork.admitObservation({ source: "fixture:mail", occurrenceKey: "f-request", workKey: "f-thread", workTitle: "Question", observedAt: then, evidence: { question: "When?" }, provenance: { principal: "third_party", channel: "fixture", subject: "sender", evidenceId: "f-request" } }, then).work;
    const action = store.assistantWork.proposeAction({ workId: work.id, semanticKey: "f-reply", effectClass: "external_message", recipient: "sender", topic: "schedule", action: "reply", payload: { body: "Friday?" } }, then);
    store.assistantWork.grantExplicitApproval({ actionId: action.id, revision: action.revision, digest: action.digest, provenance: owner }, then);
    store.assistantWork.claimForDispatch({ actionId: action.id, revision: action.revision, digest: action.digest, attemptId: "f-sent", workerId: "fixture" }, then);
    store.assistantWork.markEffectStarted({ attemptId: "f-sent", workerId: "fixture" }, then);
    store.close();

    const db = new Database(path);
    let approvedPayload: string;
    try {
      approvedPayload = (db.query("SELECT payload_json FROM assistant_work_action_revisions WHERE action_id = ?")
        .get(action.id) as { readonly payload_json: string }).payload_json;
      db.query("UPDATE assistant_work_action_revisions SET payload_json = ? WHERE action_id = ?")
        .run(JSON.stringify({ body: "rewritten" }), action.id);
    } finally {
      db.close();
    }

    const reopened = openStateStore(path);
    try {
      // Settle while the material is rewritten: the confirmation is recorded
      // but flagged, because the effect already happened.
      const settled = reopened.assistantWork.confirmAttempt({ attemptId: "f-sent", workerId: "fixture", outcome: { remoteReceipt: "message-1" } }, then);
      expect(hasMaterialIntegrityViolation(settled.attempt.outcome)).toBe(true);
      expect(reopened.assistantWork.listAttempts(action.id).some((attempt) => attempt.state === "confirmed")).toBe(true);
      reopened.close();

      // Restore the approved bytes so the digest guard passes again: the
      // flagged-attempt filter is then the only guard left standing, which is
      // what makes this test reach the branch it names.
      const restore = new Database(path);
      try {
        restore.query("UPDATE assistant_work_action_revisions SET payload_json = ? WHERE action_id = ?")
          .run(approvedPayload, action.id);
      } finally {
        restore.close();
      }

      const final = openStateStore(path);
      try {
        const tool = createResponseCompletionTool(final.assistantWork);
        const input = { workId: work.id, responseToActionId: action.id, source: "fixture:mail", observedWorkKey: work.stableKey, occurrenceKey: "f-response", reference: "fixture://f-thread/response", summary: "Friday is confirmed", observedAt: "2026-01-01T00:01:00.000Z", confidence: "clear", satisfiesOutstandingRequest: true };
        await expect(tool.execute("flagged", input as never, undefined, {} as never))
          .rejects.toThrow(/recorded against material/);
        expect(final.assistantWork.getWork(work.id)?.state).toBe("open");
      } finally {
        final.close();
      }
    } finally {
      // reopened/final are closed on their own paths
    }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
