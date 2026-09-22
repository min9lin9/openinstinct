import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FollowupRecoveryService,
  type AuthoredRecoveryReport,
  type FollowupDispatcherResult,
} from "../../src/assistant-work/recovery.ts";
import {
  followupSemanticKey,
  stableAttemptId,
  stableFollowupDispatchId,
  type ActionRecord,
  type EvidenceProvenance,
  type JsonValue,
} from "../../src/assistant-work/model.ts";
import type { AssistantWorkRepository } from "../../src/store/assistant-work.ts";
import { openStateStore } from "../../src/store/db.ts";

const directories: string[] = [];
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const T3 = "2026-01-01T00:03:00.000Z";
const OWNER: EvidenceProvenance = {
  principal: "owner",
  channel: "chat",
  subject: "owner-account",
  evidenceId: "owner-followup-policy",
};

interface CountingExecutor {
  readonly dispatch: (
    action: ActionRecord,
    attemptId: string,
    workerId: string,
  ) => Promise<FollowupDispatcherResult>;
  readonly calls: readonly {
    readonly actionId: string;
    readonly attemptId: string;
    readonly workerId: string;
  }[];
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const storePaths = new WeakMap<object, string>();

/** Direct row access, used only to model a post-approval tamper. */
function stateDbPathFor(store: object): string {
  const path = storePaths.get(store);
  if (path === undefined) throw new Error("store path is unknown");
  return path;
}

function stateDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "openinstinct-recovery-"));
  directories.push(directory);
  return join(directory, "state.db");
}

function openTrackedStore(): ReturnType<typeof openStateStore> {
  const path = stateDbPath();
  const store = openStateStore(path);
  storePaths.set(store, path);
  return store;
}

function setupConfirmedMessage(
  store: ReturnType<typeof openStateStore>,
  suffix: string,
  options: { readonly rule?: boolean; readonly deadlineAt?: string } = { rule: true },
) {
  const work = store.assistantWork.admitObservation({
    source: "test:followup",
    occurrenceKey: `occurrence-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Follow up ${suffix}`,
    provenance: {
      principal: "system",
      channel: "test",
      subject: "fixture",
      evidenceId: `evidence-${suffix}`,
    },
    observedAt: T0,
    evidence: { fixture: suffix },
  }, T0).work;
  const matcher = {
    effectClass: "external_message" as const,
    recipient: `recipient-${suffix}@example.test`,
    topic: `topic-${suffix}`,
    action: "send_follow_up",
  };
  const rule = options.rule === false ? undefined : store.assistantWork.setOwnerRule({
    matcher,
    provenance: { ...OWNER, evidenceId: `owner-rule-${suffix}` },
  }, T0);
  const action = store.assistantWork.proposeAction({
    workId: work.id,
    semanticKey: "original-message",
    ...matcher,
    payload: { body: `Original ${suffix}` },
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  }, T0);
  if (!rule) {
    store.assistantWork.grantExplicitApproval({
      actionId: action.id,
      revision: action.revision,
      digest: action.digest,
      provenance: { ...OWNER, evidenceId: `owner-approval-${suffix}` },
    }, T0);
  }
  const attemptId = stableAttemptId(action.id, action.revision, `original-${suffix}`);
  const claimed = store.assistantWork.claimForDispatch({
    actionId: action.id,
    revision: action.revision,
    digest: action.digest,
    attemptId,
    workerId: "original-worker",
  }, T0);
  if (claimed.kind !== "claimed") throw new Error(`original action was not claimable: ${claimed.reason}`);
  store.assistantWork.markEffectStarted({ attemptId, workerId: "original-worker" }, T0);
  store.assistantWork.confirmAttempt({
    attemptId,
    workerId: "original-worker",
    outcome: { confirmed: true },
  }, T0);
  return { work, action, rule };
}

function setPolicy(
  store: ReturnType<typeof openStateStore>,
  workId: string,
  actionId: string,
  maxAttempts = 2,
) {
  return store.assistantWork.setFollowupPolicy({
    workId,
    actionId,
    enabled: true,
    intervalMs: 60_000,
    maxAttempts,
    provenance: OWNER,
  }, T0);
}

function confirmedExecutor(
  repository: AssistantWorkRepository,
  evidence: (action: ActionRecord) => JsonValue = (action) => ({ confirmedActionId: action.id }),
  beforeSettle?: (action: ActionRecord, attemptId: string, workerId: string) => void | Promise<void>,
  now: () => string = () => T1,
): CountingExecutor {
  const calls: Array<{ readonly actionId: string; readonly attemptId: string; readonly workerId: string }> = [];
  return {
    calls,
    dispatch: async (action, attemptId, workerId) => {
      const at = now();
      const existing = repository.getAttempt(attemptId);
      if (existing?.state === "claimed_pre_effect" && existing.workerId !== workerId) {
        const recovery = repository.recoverAttempt({ attemptId, workerId }, at);
        if (recovery.kind !== "resume_pre_effect") {
          return { kind: "rejected", reason: "terminal", action: recovery.action, attempt: recovery.attempt };
        }
      }
      calls.push({ actionId: action.id, attemptId, workerId });
      const claim = repository.claimForDispatch({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId,
        workerId,
      }, at);
      if (claim.kind === "rejected") return claim;
      repository.markEffectStarted({ attemptId, workerId }, at);
      await beforeSettle?.(action, attemptId, workerId);
      const outcome = evidence(action);
      const settled = repository.confirmAttempt({ attemptId, workerId, outcome }, at);
      return { kind: "confirmed", ...settled, evidence: outcome };
    },
  };
}
function reportsCollector(): {
  readonly reports: AuthoredRecoveryReport[];
  readonly authoredReport: (report: AuthoredRecoveryReport) => void;
} {
  const reports: AuthoredRecoveryReport[] = [];
  return { reports, authoredReport: (report) => { reports.push(report); } };
}

describe("durable follow-up policy", () => {
  test("only authenticated owner provenance can set explicit enabled/interval/maxAttempts", () => {
    const store = openStateStore(stateDbPath());
    try {
      const { work, action } = setupConfirmedMessage(store, "owner-policy");
      expect(() => store.assistantWork.setFollowupPolicy({
        workId: work.id,
        actionId: action.id,
        enabled: true,
        intervalMs: 60_000,
        maxAttempts: 2,
        provenance: {
          principal: "third_party",
          channel: "mail",
          subject: "sender@example.test",
          evidenceId: "mail-policy-text",
        },
      }, T0)).toThrow("third_party evidence cannot create owner authorization");

      const policy = setPolicy(store, work.id, action.id);
      expect(policy).toMatchObject({
        workId: work.id,
        actionId: action.id,
        revision: 1,
        enabled: true,
        intervalMs: 60_000,
        maxAttempts: 2,
        nextDueAt: T1,
        nextOrdinal: 1,
        provenance: OWNER,
      });
      expect(setPolicy(store, work.id, action.id).revision).toBe(1);
      expect(store.assistantWork.setFollowupPolicy({
        workId: work.id,
        actionId: action.id,
        enabled: true,
        intervalMs: 120_000,
        maxAttempts: 3,
        provenance: { ...OWNER, evidenceId: "owner-followup-policy-changed" },
      }, T1)).toMatchObject({ revision: 2, intervalMs: 120_000, maxAttempts: 3 });
    } finally {
      store.close();
    }
  });

  test("missing policy never invokes the real executor", async () => {
    const store = openStateStore(stateDbPath());
    const { work } = setupConfirmedMessage(store, "missing-policy");
    const executor = confirmedExecutor(store.assistantWork);
    const reports = reportsCollector();
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "recovery-worker",
      now: () => T1,
      dispatch: executor.dispatch,
      authoredReport: reports.authoredReport,
    });
    try {
      expect(await service.tick(work.id)).toEqual({ kind: "not_dispatched", reason: "missing_policy" });
      expect(executor.calls).toHaveLength(0);
      expect(store.assistantWork.listFollowupDispatches(work.id)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("creates stable distinct ordinal actions, persists actual executor settlements, and enforces the cap", async () => {
    const store = openStateStore(stateDbPath());
    const { work, action } = setupConfirmedMessage(store, "ordinals");
    const policy = setPolicy(store, work.id, action.id, 2);
    let now = T1;
    const executor = confirmedExecutor(
      store.assistantWork,
      (followup) => ({ confirmedActionId: followup.id }),
      undefined,
      () => now,
    );
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "recovery-worker",
      now: () => now,
      dispatch: executor.dispatch,
      authoredReport: () => undefined,
    });
    try {
      const first = await service.tick(work.id);
      expect(first).toMatchObject({
        kind: "dispatched",
        dispatch: { ordinal: 1, state: "completed", outcome: { kind: "confirmed" } },
        result: { kind: "confirmed", attempt: { state: "confirmed" } },
      });
      if (first.kind !== "dispatched") throw new Error("first follow-up was not dispatched");
      const firstAction = store.assistantWork.getAction(first.dispatch.actionId);
      if (!firstAction) throw new Error("first follow-up action was not persisted");
      expect(firstAction).toMatchObject({
        semanticKey: followupSemanticKey(action.id, policy.revision, 1),
        recipient: action.recipient,
        topic: action.topic,
        action: action.action,
        payload: action.payload,
        state: "confirmed",
      });
      expect(firstAction.id).not.toBe(action.id);
      expect(firstAction.digest).toBe(action.digest);
      expect(first.dispatch.id).toBe(stableFollowupDispatchId(work.id, policy.revision, 1));
      expect(first.result).toMatchObject({
        kind: "confirmed",
        action: { id: firstAction.id, state: "confirmed" },
        attempt: { actionId: firstAction.id, state: "confirmed", workerId: "recovery-worker" },
        evidence: { confirmedActionId: firstAction.id },
      });
      expect(store.assistantWork.getFollowupPolicy(work.id)).toMatchObject({ nextDueAt: T2, nextOrdinal: 2 });

      now = T2;
      const second = await service.tick(work.id);
      expect(second).toMatchObject({ kind: "dispatched", dispatch: { ordinal: 2, state: "completed" } });
      if (second.kind !== "dispatched") throw new Error("second follow-up was not dispatched");
      const secondAction = store.assistantWork.getAction(second.dispatch.actionId);
      if (!secondAction) throw new Error("second follow-up action was not persisted");
      expect(secondAction).toMatchObject({
        semanticKey: followupSemanticKey(action.id, policy.revision, 2),
        state: "confirmed",
      });
      expect(secondAction.id).not.toBe(firstAction.id);
      expect(second.result).toMatchObject({
        kind: "confirmed",
        attempt: { actionId: secondAction.id, state: "confirmed", workerId: "recovery-worker" },
      });
      expect(store.assistantWork.getFollowupPolicy(work.id)?.nextOrdinal).toBe(3);
      expect(store.assistantWork.getFollowupPolicy(work.id)?.nextDueAt).toBeUndefined();

      now = T3;
      expect(await service.tick(work.id)).toEqual({ kind: "not_dispatched", reason: "cap_reached" });
      expect(executor.calls.map((call) => call.actionId)).toEqual([firstAction.id, secondAction.id]);
      expect(store.assistantWork.listAttempts(firstAction.id)).toHaveLength(1);
      expect(store.assistantWork.listAttempts(secondAction.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("a previous one-shot approval never authorizes the distinct follow-up action", async () => {
    const store = openStateStore(stateDbPath());
    const { work, action } = setupConfirmedMessage(store, "one-shot", { rule: false });
    setPolicy(store, work.id, action.id, 1);
    const executor = confirmedExecutor(store.assistantWork);
    const reports = reportsCollector();
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "recovery-worker",
      now: () => T1,
      dispatch: executor.dispatch,
      authoredReport: reports.authoredReport,
    });
    try {
      expect(await service.tick(work.id)).toEqual({ kind: "not_dispatched", reason: "approval_required" });
      expect(executor.calls).toHaveLength(0);
      expect(reports.reports).toContainEqual(expect.objectContaining({ code: "followup_approval_required" }));
      const due = store.assistantWork.listFollowupDispatches(work.id);
      expect(due).toMatchObject([{ state: "due", ordinal: 1 }]);
      const followup = store.assistantWork.getAction(due[0]!.actionId);
      if (!followup) throw new Error("approval-required follow-up action was not persisted");
      expect(followup.state).toBe("approval_pending");

      store.assistantWork.grantExplicitApproval({
        actionId: followup.id,
        revision: followup.revision,
        digest: followup.digest,
        provenance: { ...OWNER, evidenceId: "owner-followup-specific-approval" },
      }, T1);
      expect(await service.tick(work.id)).toMatchObject({
        kind: "dispatched",
        dispatch: { ordinal: 1, state: "completed" },
        result: { kind: "confirmed", attempt: { authorizationSource: "owner_explicit", state: "confirmed" } },
      });
      expect(executor.calls).toHaveLength(1);
      expect(store.assistantWork.listExplicitApprovals(followup.id)).toMatchObject([{ state: "consumed" }]);
    } finally {
      store.close();
    }
  });
});

describe("follow-up dispatch races and recovery", () => {
  test("recovery returns the original executor failure and continues later claimed dispatches", async () => {
    const store = openStateStore(stateDbPath());
    try {
      const first = setupConfirmedMessage(store, "executor-fails");
      const second = setupConfirmedMessage(store, "executor-healthy");
      setPolicy(store, first.work.id, first.action.id, 1);
      setPolicy(store, second.work.id, second.action.id, 1);
      const failed = store.assistantWork.claimDueFollowup(first.work.id, "worker", T1);
      const healthy = store.assistantWork.claimDueFollowup(second.work.id, "worker", T1);
      if (failed.kind !== "claimed" || healthy.kind !== "claimed") throw new Error("expected claimed fixtures");
      const cause = new Error("executor unavailable before effect");
      const executor = confirmedExecutor(store.assistantWork);
      const service = new FollowupRecoveryService({ repository: store.assistantWork, workerId: "worker", now: () => T1,
        dispatch: async (action, attemptId, workerId) => {
          if (action.id === failed.action.id) throw cause;
          return executor.dispatch(action, attemptId, workerId);
        } });
      const results = await service.recover();
      const failure = results.find((result) => result.kind === "recovery_failed");
      expect(failure).toMatchObject({ kind: "recovery_failed", actionId: failed.action.id, dispatchId: failed.dispatch.id });
      if (failure?.kind !== "recovery_failed") throw new Error("expected explicit failure");
      expect(failure.error.cause).toBe(cause);
      expect(executor.calls.map((call) => call.actionId)).toEqual([healthy.action.id]);
      expect(store.assistantWork.getFollowupDispatch(healthy.dispatch.id)?.state).toBe("completed");
      expect(store.assistantWork.listAttempts(failed.action.id)).toHaveLength(0);
    } finally { store.close(); }
  });
  test("concurrent ticks invoke one real executor and persist one ordinal settlement", async () => {
    const path = stateDbPath();
    const firstStore = openStateStore(path);
    const { work, action } = setupConfirmedMessage(firstStore, "concurrent");
    setPolicy(firstStore, work.id, action.id, 1);
    const secondStore = openStateStore(path);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const effectStarted = new Promise<void>((resolve) => { started = resolve; });
    const firstExecutor = confirmedExecutor(
      firstStore.assistantWork,
      (followup) => ({ confirmed: followup.id }),
      async (_followup, attemptId) => {
        expect(firstStore.assistantWork.getAttempt(attemptId)).toMatchObject({ state: "effect_started" });
        started();
        await blocked;
      },
    );
    const secondExecutor = confirmedExecutor(secondStore.assistantWork, () => ({ duplicate: true }));
    const firstService = new FollowupRecoveryService({
      repository: firstStore.assistantWork,
      workerId: "worker-a",
      now: () => T1,
      dispatch: firstExecutor.dispatch,
      authoredReport: () => undefined,
    });
    const secondService = new FollowupRecoveryService({
      repository: secondStore.assistantWork,
      workerId: "worker-b",
      now: () => T1,
      dispatch: secondExecutor.dispatch,
      authoredReport: () => undefined,
    });
    try {
      const firstTick = firstService.tick(work.id);
      await effectStarted;
      expect(firstExecutor.calls).toHaveLength(1);
      expect(secondExecutor.calls).toHaveLength(0);
      const secondTick = secondService.tick(work.id);
      expect(await secondTick).toEqual({ kind: "not_dispatched", reason: "active_effect" });
      expect(secondExecutor.calls).toHaveLength(0);
      release();
      expect(await firstTick).toMatchObject({
        kind: "dispatched",
        dispatch: { ordinal: 1, state: "completed" },
        result: { kind: "confirmed", attempt: { state: "confirmed" } },
      });
      expect(firstExecutor.calls).toHaveLength(1);
      expect(firstStore.assistantWork.listFollowupDispatches(work.id)).toHaveLength(1);
      const followup = firstStore.assistantWork.getAction(firstStore.assistantWork.listFollowupDispatches(work.id)[0]!.actionId);
      expect(followup).toMatchObject({ state: "confirmed" });
      expect(firstStore.assistantWork.listAttempts(followup!.id)).toHaveLength(1);
    } finally {
      release();
      secondStore.close();
      firstStore.close();
    }
  });

  test("revoked current rule prevents effect start after an ordinal was prepared", async () => {
    const store = openStateStore(stateDbPath());
    const { work, action, rule } = setupConfirmedMessage(store, "rule-revoked");
    setPolicy(store, work.id, action.id, 1);
    const prepared = store.assistantWork.claimDueFollowup(work.id, "recovery-worker", T1);
    expect(prepared).toMatchObject({ kind: "claimed", dispatch: { ordinal: 1 } });
    store.assistantWork.revokeOwnerRule(
      rule!.id,
      rule!.revision,
      { ...OWNER, evidenceId: "owner-revoked-rule" },
      T1,
    );
    const executor = confirmedExecutor(store.assistantWork);
    const reports = reportsCollector();
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "recovery-worker",
      now: () => T1,
      dispatch: executor.dispatch,
      authoredReport: reports.authoredReport,
    });
    try {
      const result = await service.tick(work.id);
      expect(result).toEqual({ kind: "not_dispatched", reason: "approval_required" });
      expect(executor.calls).toHaveLength(0);
      const followup = store.assistantWork.listFollowupDispatches(work.id)[0];
      expect(followup).toMatchObject({ state: "due" });
      expect(store.assistantWork.listAttempts(followup!.actionId)).toHaveLength(0);
      expect(reports.reports).toContainEqual(expect.objectContaining({ code: "followup_approval_required" }));
    } finally {
      store.close();
    }
  });

  test("rejects a callback that claims success without a matching durable settlement", async () => {
    const store = openStateStore(stateDbPath());
    const { work, action } = setupConfirmedMessage(store, "unbacked-success");
    setPolicy(store, work.id, action.id, 1);
    const prepared = store.assistantWork.claimDueFollowup(work.id, "recovery-worker", T1);
    if (prepared.kind !== "claimed") throw new Error(`unbacked-success follow-up was not claimable: ${prepared.reason}`);
    let callbackCalls = 0;
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "recovery-worker",
      now: () => T1,
      dispatch: async (followup, attemptId, workerId) => {
        callbackCalls += 1;
        return {
          kind: "confirmed",
          action: followup,
          attempt: {
            id: attemptId,
            actionId: followup.id,
            actionRevision: followup.revision,
            actionDigest: followup.digest,
            sequence: 1,
            state: "confirmed",
            workerId,
            authorizationSource: "owner_rule",
            claimedAt: T1,
            effectStartedAt: T1,
            settledAt: T1,
            recoveryCount: 0,
            updatedAt: T1,
          },
          evidence: { fabricated: true },
        };
      },
      authoredReport: () => undefined,
    });
    try {
      await expect(service.tick(work.id)).rejects.toThrow("executor result lacks matching durable settlement");
      expect(callbackCalls).toBe(1);
      const dispatch = store.assistantWork.listFollowupDispatches(work.id)[0];
      expect(dispatch).toMatchObject({ state: "claimed" });
      expect(store.assistantWork.getAction(dispatch!.actionId)).toMatchObject({ state: "approval_pending" });
      expect(store.assistantWork.listAttempts(dispatch!.actionId)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("restart resumes claimed_pre_effect through the real executor exactly once", async () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const { work, action } = setupConfirmedMessage(initial, "restart-preeffect");
    const policy = setPolicy(initial, work.id, action.id, 1);
    const claimed = initial.assistantWork.claimDueFollowup(work.id, "worker-before", T1);
    if (claimed.kind !== "claimed") throw new Error("expected claimed follow-up");
    const attemptId = stableAttemptId(claimed.action.id, claimed.action.revision, claimed.dispatch.id);
    const actionClaim = initial.assistantWork.claimForDispatch({
      actionId: claimed.action.id,
      revision: claimed.action.revision,
      digest: claimed.action.digest,
      attemptId,
      workerId: "worker-before",
    }, T1);
    if (actionClaim.kind !== "claimed") throw new Error(`follow-up attempt was not claimed: ${actionClaim.reason}`);
    initial.close();

    const reopened = openStateStore(path);
    const executor = confirmedExecutor(
      reopened.assistantWork,
      () => ({ confirmedAfterRestart: true }),
      undefined,
      () => T2,
    );
    const service = new FollowupRecoveryService({
      repository: reopened.assistantWork,
      workerId: "worker-after",
      now: () => T2,
      dispatch: executor.dispatch,
      authoredReport: () => undefined,
    });
    try {
      const results = await service.recover();
      expect(results).toContainEqual(expect.objectContaining({ kind: "dispatched" }));
      expect(executor.calls).toEqual([{
        actionId: claimed.action.id,
        attemptId,
        workerId: "worker-after",
      }]);
      expect(reopened.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "confirmed",
        workerId: "worker-after",
        outcome: { confirmedAfterRestart: true },
      });
      expect(reopened.assistantWork.getFollowupDispatch(
        stableFollowupDispatchId(work.id, policy.revision, 1),
      )).toMatchObject({ state: "completed", outcome: { kind: "confirmed" } });
    } finally {
      reopened.close();
    }
  });

  test("effect_started becomes ambiguous on restart and is never redispatched", async () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const { work, action } = setupConfirmedMessage(initial, "restart-ambiguous");
    setPolicy(initial, work.id, action.id, 1);
    const claimed = initial.assistantWork.claimDueFollowup(work.id, "worker-before", T1);
    if (claimed.kind !== "claimed") throw new Error("expected claimed follow-up");
    const attemptId = stableAttemptId(claimed.action.id, claimed.action.revision, claimed.dispatch.id);
    const actionClaim = initial.assistantWork.claimForDispatch({
      actionId: claimed.action.id,
      revision: claimed.action.revision,
      digest: claimed.action.digest,
      attemptId,
      workerId: "worker-before",
    }, T1);
    if (actionClaim.kind !== "claimed") throw new Error(`follow-up attempt was not claimed: ${actionClaim.reason}`);
    initial.assistantWork.markEffectStarted({ attemptId, workerId: "worker-before" }, T1);
    initial.close();

    const reopened = openStateStore(path);
    const executor = confirmedExecutor(reopened.assistantWork, () => ({ duplicate: true }));
    const reports = reportsCollector();
    const service = new FollowupRecoveryService({
      repository: reopened.assistantWork,
      workerId: "worker-after",
      now: () => T2,
      dispatch: executor.dispatch,
      authoredReport: reports.authoredReport,
    });
    try {
      const results = await service.recover();
      expect(executor.calls).toHaveLength(0);
      expect(reopened.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "ambiguous",
        workerId: "worker-before",
      });
      expect(reopened.assistantWork.getFollowupDispatch(claimed.dispatch.id)).toMatchObject({
        state: "completed",
        outcome: { kind: "ambiguous", detail: { reason: "recovered_effect_started_without_outcome" } },
      });
      const recoveredDispatch = results.find((result) => result.kind === "dispatched");
      if (recoveredDispatch?.kind !== "dispatched") throw new Error("expected recovered dispatch");
      expect(recoveredDispatch.result).toMatchObject({ kind: "ambiguous", attempt: { id: attemptId, state: "ambiguous" } });
      expect(reports.reports).toContainEqual(expect.objectContaining({ code: "followup_ambiguous" }));
      await service.recover();
      expect(executor.calls).toHaveLength(0);
    } finally {
      reopened.close();
    }
  });

  test("confirmed attempt is completed on restart without replay", async () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const { work, action } = setupConfirmedMessage(initial, "restart-confirmed");
    setPolicy(initial, work.id, action.id, 1);
    const claimed = initial.assistantWork.claimDueFollowup(work.id, "worker-before", T1);
    if (claimed.kind !== "claimed") throw new Error("expected claimed follow-up");
    const attemptId = stableAttemptId(claimed.action.id, claimed.action.revision, claimed.dispatch.id);
    const actionClaim = initial.assistantWork.claimForDispatch({
      actionId: claimed.action.id,
      revision: claimed.action.revision,
      digest: claimed.action.digest,
      attemptId,
      workerId: "worker-before",
    }, T1);
    if (actionClaim.kind !== "claimed") throw new Error(`follow-up attempt was not claimed: ${actionClaim.reason}`);
    initial.assistantWork.markEffectStarted({ attemptId, workerId: "worker-before" }, T1);
    initial.assistantWork.confirmAttempt({
      attemptId,
      workerId: "worker-before",
      outcome: { remoteConfirmed: true },
    }, T1);
    initial.close();

    const reopened = openStateStore(path);
    const executor = confirmedExecutor(reopened.assistantWork, () => ({ duplicate: true }));
    const service = new FollowupRecoveryService({
      repository: reopened.assistantWork,
      workerId: "worker-after",
      now: () => T2,
      dispatch: executor.dispatch,
      authoredReport: () => undefined,
    });
    try {
      await service.recover();
      expect(executor.calls).toHaveLength(0);
      expect(reopened.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "confirmed",
        workerId: "worker-before",
        outcome: { remoteConfirmed: true },
      });
      expect(reopened.assistantWork.getFollowupDispatch(claimed.dispatch.id)).toMatchObject({
        state: "completed",
        outcome: { kind: "confirmed", detail: { remoteConfirmed: true } },
      });
    } finally {
      reopened.close();
    }
  });

  test("deadline expiry during preeffect recovery cancels without executor invocation", async () => {
    const path = stateDbPath();
    const initial = openStateStore(path);
    const { work, action } = setupConfirmedMessage(initial, "restart-expired", { deadlineAt: T2 });
    setPolicy(initial, work.id, action.id, 1);
    const claimed = initial.assistantWork.claimDueFollowup(work.id, "worker-before", T1);
    if (claimed.kind !== "claimed") throw new Error("expected claimed follow-up");
    const attemptId = stableAttemptId(claimed.action.id, claimed.action.revision, claimed.dispatch.id);
    const actionClaim = initial.assistantWork.claimForDispatch({
      actionId: claimed.action.id,
      revision: claimed.action.revision,
      digest: claimed.action.digest,
      attemptId,
      workerId: "worker-before",
    }, T1);
    if (actionClaim.kind !== "claimed") throw new Error(`follow-up attempt was not claimed: ${actionClaim.reason}`);
    initial.close();

    const reopened = openStateStore(path);
    const executor = confirmedExecutor(reopened.assistantWork, () => ({ duplicate: true }), undefined, () => T2);
    const reports = reportsCollector();
    const service = new FollowupRecoveryService({
      repository: reopened.assistantWork,
      workerId: "worker-after",
      now: () => T2,
      dispatch: executor.dispatch,
      authoredReport: reports.authoredReport,
    });
    try {
      const results = await service.recover();
      expect(executor.calls).toHaveLength(0);
      expect(reopened.assistantWork.getAction(claimed.action.id)).toMatchObject({ state: "expired" });
      expect(reopened.assistantWork.getAttempt(attemptId)).toMatchObject({
        state: "cancelled",
        workerId: "worker-before",
        outcome: { reason: "deadline_expired" },
      });
      expect(reopened.assistantWork.getFollowupDispatch(claimed.dispatch.id)).toMatchObject({
        state: "completed",
        outcome: { kind: "rejected", detail: { reason: "terminal" } },
      });
      const expiredDispatch = results.find((result) => result.kind === "dispatched");
      if (expiredDispatch?.kind !== "dispatched") throw new Error("expected expired dispatch bookkeeping");
      expect(expiredDispatch.result).toMatchObject({ kind: "rejected", reason: "terminal" });
      expect(reports.reports).toContainEqual(expect.objectContaining({ code: "followup_rejected" }));
    } finally {
      reopened.close();
    }
  });
});

test("a rejected pre-effect recovery releases the claim instead of stranding it", async () => {
  const store = openStateStore(stateDbPath());
  try {
    const at = "2026-01-01T00:00:00.000Z";
    const work = store.assistantWork.admitObservation({
      source: "fixture", occurrenceKey: "strand", workKey: "strand", workTitle: "strand", observedAt: at,
      evidence: {}, provenance: { principal: "system", channel: "fixture", subject: "strand", evidenceId: "strand" },
    }, at).work;
    const action = store.assistantWork.proposeAction({
      workId: work.id, semanticKey: "strand", effectClass: "external_mutation",
      recipient: "someone", topic: "topic", action: "unsupported_executor",
      payload: { note: "no executor exists for this" },
    }, at);
    store.assistantWork.grantExplicitApproval({
      actionId: action.id, revision: action.revision, digest: action.digest,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "strand" },
    }, at);
    const attemptId = "strand-attempt";
    expect(store.assistantWork.claimForDispatch({
      actionId: action.id, revision: action.revision, digest: action.digest, attemptId, workerId: "crashed",
    }, at).kind).toBe("claimed");

    // The daemon crashed after the claim. Recovery has no executor for this
    // action, so without a release the attempt stays claimed_pre_effect and
    // every later drain retries it while nothing can ever settle it.
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "crashed",
      dispatch: async () => ({ kind: "rejected", reason: "blocked" }),
      now: () => at,
    });
    const recovered = await service.recoverAttempt(attemptId);
    expect(recovered.kind).toBe("resumed_attempt");
    expect(store.assistantWork.getAction(action.id)).toMatchObject({ state: "cancelled" });
    // The attempt is terminal, so no later drain can retry it and nothing is
    // left waiting for a settlement that can never come.
    expect(store.assistantWork.getAttempt(attemptId)?.state).toBe("cancelled");
  } finally {
    store.close();
  }
});

test("a tampered pre-effect resume is refused and released rather than retried forever", async () => {
  const store = openTrackedStore();
  try {
    const at = "2026-01-01T00:00:00.000Z";
    const work = store.assistantWork.admitObservation({
      source: "fixture", occurrenceKey: "tamper", workKey: "tamper", workTitle: "tamper", observedAt: at,
      evidence: {}, provenance: { principal: "system", channel: "fixture", subject: "tamper", evidenceId: "tamper" },
    }, at).work;
    const action = store.assistantWork.proposeAction({
      workId: work.id, semanticKey: "tamper", effectClass: "external_mutation",
      recipient: "someone", topic: "topic", action: "managed_http_request",
      payload: { body: JSON.stringify({ status: "safe" }) },
    }, at);
    store.assistantWork.grantExplicitApproval({
      actionId: action.id, revision: action.revision, digest: action.digest,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "tamper" },
    }, at);
    const attemptId = "tamper-attempt";
    store.assistantWork.claimForDispatch({
      actionId: action.id, revision: action.revision, digest: action.digest, attemptId, workerId: "w",
    }, at);
    // Rewrite the material after the claim, keeping the approved digest.
    const db = new Database(stateDbPathFor(store));
    try {
      db.query("UPDATE assistant_work_action_revisions SET payload_json = ? WHERE action_id = ?")
        .run(JSON.stringify({ body: JSON.stringify({ status: "pwned" }) }), action.id);
    } finally {
      db.close();
    }

    let dispatched = 0;
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "w",
      dispatch: async () => { dispatched += 1; return { kind: "rejected", reason: "blocked" }; },
      now: () => at,
    });
    const recovered = await service.recoverAttempt(attemptId);
    // Refused: the tampered snapshot never reaches an executor.
    expect(dispatched).toBe(0);
    expect(recovered).toMatchObject({ kind: "resumed_attempt", result: { kind: "rejected" } });
    // Released: without this the attempt stays claimed_pre_effect and every
    // later drain retries it while nothing can ever settle it.
    expect(store.assistantWork.getAction(action.id)).toMatchObject({ state: "cancelled" });
    expect(store.assistantWork.getAttempt(attemptId)?.state).toBe("cancelled");
  } finally {
    store.close();
  }
});

test("recovery releases only the attempt it resumed, and only while it is still pre-effect", async () => {
  const store = openStateStore(stateDbPath());
  try {
    const at = "2026-01-01T00:00:00.000Z";
    const work = store.assistantWork.admitObservation({
      source: "fixture", occurrenceKey: "fence", workKey: "fence", workTitle: "fence", observedAt: at,
      evidence: {}, provenance: { principal: "system", channel: "fixture", subject: "fence", evidenceId: "fence" },
    }, at).work;
    const action = store.assistantWork.proposeAction({
      workId: work.id, semanticKey: "fence", effectClass: "external_mutation",
      recipient: "someone", topic: "topic", action: "unsupported_executor",
      payload: { note: "no executor" },
    }, at);
    store.assistantWork.grantExplicitApproval({
      actionId: action.id, revision: action.revision, digest: action.digest,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "fence" },
    }, at);
    const attemptId = "fence-attempt";
    store.assistantWork.claimForDispatch({
      actionId: action.id, revision: action.revision, digest: action.digest, attemptId, workerId: "worker-a",
    }, at);

    // A different component worker drained recovery and hit a rejection. The
    // ledger handed it this interrupted attempt, so it must release it: fencing
    // on worker names would strand every attempt another component owns.
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "main-session:managed-http",
      dispatch: async () => ({ kind: "rejected", reason: "blocked" }),
      now: () => at,
    });
    await service.recoverAttempt(attemptId);
    expect(store.assistantWork.getAction(action.id)).toMatchObject({ state: "cancelled" });
    expect(store.assistantWork.getAttempt(attemptId)?.state).toBe("cancelled");

    // An attempt that moved on to effect_started is never cancelled by the
    // release: something may already have reached the outside world.
    const later = store.assistantWork.proposeAction({
      workId: work.id, semanticKey: "fence-later", effectClass: "external_mutation",
      recipient: "someone", topic: "topic", action: "unsupported_executor",
      payload: { note: "no executor" },
    }, at);
    store.assistantWork.grantExplicitApproval({
      actionId: later.id, revision: later.revision, digest: later.digest,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "fence-later" },
    }, at);
    const laterAttempt = "fence-later-attempt";
    store.assistantWork.claimForDispatch({
      actionId: later.id, revision: later.revision, digest: later.digest, attemptId: laterAttempt, workerId: "worker-a",
    }, at);
    store.assistantWork.markEffectStarted({ attemptId: laterAttempt, workerId: "worker-a" }, at);
    await service.recoverAttempt(laterAttempt);
    expect(store.assistantWork.getAction(later.id)?.state).not.toBe("cancelled");
    expect(store.assistantWork.getAttempt(laterAttempt)?.state).toBe("ambiguous");
  } finally {
    store.close();
  }
});

test("the recovery service surfaces a material-integrity marker on the settled result", async () => {
  const store = openTrackedStore();
  try {
    const at = "2026-01-01T00:00:00.000Z";
    const work = store.assistantWork.admitObservation({
      source: "fixture", occurrenceKey: "surface", workKey: "surface", workTitle: "surface", observedAt: at,
      evidence: {}, provenance: { principal: "system", channel: "fixture", subject: "surface", evidenceId: "surface" },
    }, at).work;
    const action = store.assistantWork.proposeAction({
      workId: work.id, semanticKey: "surface", effectClass: "external_mutation",
      recipient: "someone", topic: "topic", action: "managed_http_request",
      payload: { body: JSON.stringify({ status: "safe" }) },
    }, at);
    store.assistantWork.grantExplicitApproval({
      actionId: action.id, revision: action.revision, digest: action.digest,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "surface" },
    }, at);
    const attemptId = "surface-attempt";
    store.assistantWork.claimForDispatch({
      actionId: action.id, revision: action.revision, digest: action.digest, attemptId, workerId: "w",
    }, at);

    // The tamper lands AFTER the pre-dispatch digest check and before the
    // executor settles, so the settlement is recorded (the effect happened) and
    // the marker must travel out on the result the reports are built from.
    const path = stateDbPathFor(store);
    const executor = confirmedExecutor(store.assistantWork, () => ({ ok: true }), () => {
      const db = new Database(path);
      try {
        db.query("UPDATE assistant_work_action_revisions SET payload_json = ? WHERE action_id = ?")
          .run(JSON.stringify({ body: JSON.stringify({ status: "pwned" }) }), action.id);
      } finally {
        db.close();
      }
    }, () => at);
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "w",
      dispatch: executor.dispatch,
      now: () => at,
    });

    const recovered = await service.recoverAttempt(attemptId);
    expect(recovered).toMatchObject({
      kind: "resumed_attempt",
      result: { kind: "confirmed", evidence: { materialIntegrityViolation: true, outcome: { ok: true } } },
    });
  } finally {
    store.close();
  }

});

test("a throwing pre-effect executor releases the claim instead of stranding it", async () => {
  const store = openStateStore(stateDbPath());
  try {
    const at = "2026-01-01T00:00:00.000Z";
    const work = store.assistantWork.admitObservation({
      source: "fixture", occurrenceKey: "throw", workKey: "throw", workTitle: "throw", observedAt: at,
      evidence: {}, provenance: { principal: "system", channel: "fixture", subject: "throw", evidenceId: "throw" },
    }, at).work;
    const action = store.assistantWork.proposeAction({
      workId: work.id, semanticKey: "throw", effectClass: "external_mutation",
      recipient: "someone", topic: "topic", action: "managed_http_request",
      payload: { body: JSON.stringify({ status: "safe" }) },
    }, at);
    store.assistantWork.grantExplicitApproval({
      actionId: action.id, revision: action.revision, digest: action.digest,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "throw" },
    }, at);
    const attemptId = "throw-attempt";
    store.assistantWork.claimForDispatch({
      actionId: action.id, revision: action.revision, digest: action.digest, attemptId, workerId: "w",
    }, at);

    // An executor that throws before the effect started leaves nothing to
    // reconcile: without a release the attempt stays claimed_pre_effect and
    // every later drain retries it forever.
    const service = new FollowupRecoveryService({
      repository: store.assistantWork,
      workerId: "w",
      dispatch: async () => { throw new Error("executor exploded"); },
      now: () => at,
    });
    await expect(service.recoverAttempt(attemptId)).rejects.toThrow(/executor exploded/);
    expect(store.assistantWork.getAction(action.id)).toMatchObject({ state: "cancelled" });
    expect(store.assistantWork.getAttempt(attemptId)?.state).toBe("cancelled");
  } finally {
    store.close();
  }
});

test("the release does not cancel a claim that moved on before it ran", async () => {
  const store = openStateStore(stateDbPath());
  try {
    const at = "2026-01-01T00:00:00.000Z";
    const work = store.assistantWork.admitObservation({
      source: "fixture", occurrenceKey: "cas", workKey: "cas", workTitle: "cas", observedAt: at,
      evidence: {}, provenance: { principal: "system", channel: "fixture", subject: "cas", evidenceId: "cas" },
    }, at).work;
    const action = store.assistantWork.proposeAction({
      workId: work.id, semanticKey: "cas", effectClass: "external_mutation",
      recipient: "someone", topic: "topic", action: "unsupported_executor",
      payload: { note: "no executor" },
    }, at);
    store.assistantWork.grantExplicitApproval({
      actionId: action.id, revision: action.revision, digest: action.digest,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "cas" },
    }, at);
    const attemptId = "cas-attempt";
    store.assistantWork.claimForDispatch({
      actionId: action.id, revision: action.revision, digest: action.digest, attemptId, workerId: "worker-a",
    }, at);

    // The attempt reached effect_started before the release ran, so the effect
    // may already have touched the outside world: the release must decline
    // rather than cancel a claim that is no longer pre-effect.
    store.assistantWork.markEffectStarted({ attemptId, workerId: "worker-a" }, at);
    const declined = store.assistantWork.releaseClaimedPreEffectAttempt({
      actionId: action.id, revision: action.revision, digest: action.digest,
      attemptId, workerId: "worker-a", reason: "pre_effect_dispatch_rejected",
    }, at);
    expect(declined.released).toBe(false);
    expect(store.assistantWork.getAction(action.id)?.state).not.toBe("cancelled");
    expect(store.assistantWork.getAttempt(attemptId)?.state).toBe("effect_started");

    // The same call declines for a worker that does not own the claim.
    const otherAttempt = "cas-other-attempt";
    const other = store.assistantWork.proposeAction({
      workId: work.id, semanticKey: "cas-2", effectClass: "external_mutation",
      recipient: "someone", topic: "topic", action: "unsupported_executor",
      payload: { note: "no executor either" },
    }, at);
    store.assistantWork.grantExplicitApproval({
      actionId: other.id, revision: other.revision, digest: other.digest,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "cas-2" },
    }, at);
    store.assistantWork.claimForDispatch({
      actionId: other.id, revision: other.revision, digest: other.digest, attemptId: otherAttempt, workerId: "worker-a",
    }, at);
    expect(store.assistantWork.releaseClaimedPreEffectAttempt({
      actionId: other.id, revision: other.revision, digest: other.digest,
      attemptId: otherAttempt, workerId: "worker-b", reason: "pre_effect_dispatch_rejected",
    }, at).released).toBe(false);
    expect(store.assistantWork.getAction(other.id)?.state).not.toBe("cancelled");

    // The owner's own release still works.
    expect(store.assistantWork.releaseClaimedPreEffectAttempt({
      actionId: other.id, revision: other.revision, digest: other.digest,
      attemptId: otherAttempt, workerId: "worker-a", reason: "pre_effect_dispatch_rejected",
    }, at).released).toBe(true);
    expect(store.assistantWork.getAction(other.id)).toMatchObject({ state: "cancelled" });
    expect(store.assistantWork.getAttempt(otherAttempt)?.state).toBe("cancelled");
  } finally {
    store.close();
  }
});
