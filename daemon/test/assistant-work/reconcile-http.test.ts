import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStore } from "../../src/store/db.ts";
import { reconcileManagedAttempt } from "../../src/assistant-work/reconcile.ts";
import { proposeManagedHttpAction } from "../../src/assistant-work/http-effects.ts";
import { configuredHttpAccess } from "../../src/assistant-work/http-policy.ts";
import { startHttpServiceFixture } from "../fixtures/assistant-work/http-service.ts";
import { verifyManagedHttpPlan, type ManagedHttpPlan } from "../../src/assistant-work/http-effects.ts";

test("reconciliation does not match JSON object numeric keys as array indices", async () => {
  const service = await startHttpServiceFixture();
  try {
    await fetch(service.url("/numeric-object"), { method: "POST", body: JSON.stringify({ "0": "expected" }) });
    const plan: ManagedHttpPlan = { version: 1, method: "POST", url: service.url("/numeric-object"), headers: [], body: "{}", messageOperation: null, messageAuthorization: null,
      verification: { url: service.url("/numeric-object"), headers: [], expected: { kind: "json_field", path: ["resource", "value", 0], value: "expected" } } };
    const options = { endpointPolicy: () => ({ allowed: true, allowPrivateNetwork: true }) };
    expect(await verifyManagedHttpPlan(plan, options)).toBeUndefined();
    expect(await verifyManagedHttpPlan({ ...plan, verification: { ...plan.verification, expected: { kind: "json_field", path: ["resource", "value", "0"], value: "expected" } } }, options)).toBeDefined();
    expect(service.requestCount("POST", "/numeric-object")).toBe(1);
  } finally { await service.stop(); }
});

test("redacted display tokens cannot falsely confirm raw remote evidence", async () => {
  const service = await startHttpServiceFixture();
  try {
    const plan: ManagedHttpPlan = { version: 1, method: "POST", url: service.url("/unused"), headers: [], body: "{}", messageOperation: null, messageAuthorization: null,
      verification: { url: service.url("/read/echo-auth"), headers: [{ name: "authorization", secretRef: "secret://fixture/token" }], expected: { kind: "text_contains", text: "[REDACTED]" } } };
    expect(await verifyManagedHttpPlan(plan, { endpointPolicy: () => ({ allowed: true, allowPrivateNetwork: true }), resolveSecret: () => "fixture-token-never-display" })).toBeUndefined();
    expect(service.requestCount("POST", "/unused")).toBe(0);
  } finally { await service.stop(); }
});

test("reconciliation validates the approved material before it fetches anything", async () => {
  const service = await startHttpServiceFixture();
  const root = mkdtempSync(join(tmpdir(), "oi-reconcile-tamper-"));
  const path = join(root, "state.db");
  const store = openStateStore(path);
  const at = "2026-01-01T00:00:00.000Z";
  const access = {
    ...configuredHttpAccess(),
    endpointPolicy: () => ({ allowed: true, allowPrivateNetwork: true }),
    resolveSecret: () => "token",
  };
  try {
    const work = store.assistantWork.admitObservation({
      source: "fixture", occurrenceKey: "reconcile", workKey: "reconcile", workTitle: "reconcile", observedAt: at,
      evidence: {}, provenance: { principal: "system", channel: "fixture", subject: "reconcile", evidenceId: "reconcile" },
    }, at).work;
    const url = service.url("/reconcile-target");
    // Built through the real proposal path so the payload is a valid plan.
    const proposed = await proposeManagedHttpAction({
      workId: work.id, semanticKey: "reconcile", method: "POST", url,
      headers: [], body: JSON.stringify({ value: { status: "safe" } }),
      verification: { url, headers: [], expected: { kind: "json_field", path: ["resource", "value", "status"], value: "safe" } },
    }, { repository: store.assistantWork, endpointPolicy: access.endpointPolicy, now: () => at });
    store.assistantWork.grantExplicitApproval({
      actionId: proposed.action.id, revision: proposed.action.revision, digest: proposed.action.digest,
      provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "reconcile" },
    }, at);
    const attemptId = "reconcile-attempt";
    store.assistantWork.claimForDispatch({
      actionId: proposed.action.id, revision: proposed.action.revision, digest: proposed.action.digest, attemptId, workerId: "w",
    }, at);
    store.assistantWork.markEffectStarted({ attemptId, workerId: "w" }, at);
    store.assistantWork.markAttemptAmbiguous({ attemptId, workerId: "w", outcome: { reason: "timeout" } }, at);

    // The fixture only serves a stored resource, so stand in for the original
    // effect having reached the provider before the attempt went ambiguous.
    await fetch(url, { method: "POST", body: JSON.stringify({ status: "safe" }) });

    // First: the untampered action reconciles and does fetch, which is what
    // makes the tampered case below meaningful rather than vacuous.
    expect(await reconcileManagedAttempt(store.assistantWork, attemptId, "w", access)).toBe(true);
    expect(service.requestCount("GET", "/reconcile-target")).toBeGreaterThan(0);
    store.close();

    // Rewrite the verification target while a second attempt is ambiguous: a
    // reconciliation must not aim a network request with material the owner
    // never approved.
    const reopened = openStateStore(path);
    try {
      const second = await proposeManagedHttpAction({
        workId: work.id, semanticKey: "reconcile-2", method: "POST", url,
        headers: [], body: JSON.stringify({ value: { status: "safe" } }),
        verification: { url, headers: [], expected: { kind: "json_field", path: ["resource", "value", "status"], value: "safe" } },
      }, { repository: reopened.assistantWork, endpointPolicy: access.endpointPolicy, now: () => at });
      reopened.assistantWork.grantExplicitApproval({
        actionId: second.action.id, revision: second.action.revision, digest: second.action.digest,
        provenance: { principal: "owner", channel: "fixture", subject: "owner", evidenceId: "reconcile-2" },
      }, at);
      await fetch(url, { method: "POST", body: JSON.stringify({ status: "safe" }) });
      const secondAttempt = "reconcile-attempt-2";
      reopened.assistantWork.claimForDispatch({
        actionId: second.action.id, revision: second.action.revision, digest: second.action.digest, attemptId: secondAttempt, workerId: "w",
      }, at);
      reopened.assistantWork.markEffectStarted({ attemptId: secondAttempt, workerId: "w" }, at);
      reopened.assistantWork.markAttemptAmbiguous({ attemptId: secondAttempt, workerId: "w", outcome: { reason: "timeout" } }, at);
      reopened.close();

      const tamper = new Database(path);
      try {
        tamper.query("UPDATE assistant_work_action_revisions SET payload_json = ? WHERE action_id = ?")
          .run(JSON.stringify({ ...(JSON.parse((tamper.query("SELECT payload_json FROM assistant_work_action_revisions WHERE action_id = ?").get(second.action.id) as { readonly payload_json: string }).payload_json) as object), url: service.url("/attacker-target"),
            verification: { url: service.url("/attacker-target"), headers: [], expected: { kind: "json_field", path: ["resource", "value", "status"], value: "safe" } } }), second.action.id);
      } finally {
        tamper.close();
      }

      const final = openStateStore(path);
      try {
        expect(await reconcileManagedAttempt(final.assistantWork, secondAttempt, "w", access)).toBe(false);
        expect(service.requestCount("GET", "/attacker-target")).toBe(0);
        expect(final.assistantWork.getAttempt(secondAttempt)?.state).toBe("ambiguous");
      } finally {
        final.close();
      }
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    await service.stop();
  }
});
