import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

import {
  executeAgentCall,
  proposeAgentCall,
  type AgentCallRequest,
} from "../../src/calls/agent-call.ts";
import { createAgentCallTool } from "../../src/calls/tool.ts";
import {
  configuredCallProvider,
  normalizeCallNumber,
  type CallProviderConfig,
} from "../../src/calls/provider.ts";
import {
  authorizationRequirementForEffect,
  ownerRuleCanAuthorize,
  type ActionRecord,
} from "../../src/assistant-work/model.ts";
import { parseManagedHttpPlan } from "../../src/assistant-work/http-effects.ts";
import { openStateStore } from "../../src/store/db.ts";
import type { ManagedHttpEndpointPolicy } from "../../src/assistant-work/http-effects.ts";
import type { StateStore } from "../../src/store/db.ts";

const T0 = "2026-09-18T10:00:00.000Z";
const T1 = "2026-09-18T10:01:00.000Z";
const T2 = "2026-09-18T10:02:00.000Z";
const roots: string[] = [];
const servers: Bun.Server<undefined>[] = [];

interface ProviderFixture {
  readonly origin: string;
  readonly provider: CallProviderConfig;
  readonly endpointPolicy: ManagedHttpEndpointPolicy;
  readonly resolveSecret: (reference: string) => string;
  readonly setMode: (mode: "placed" | "failure" | "hang") => void;
  readonly postCount: () => number;
  readonly setForeignPlacedOnly: (value: boolean) => void;
  readonly stop: () => void;
}

interface FixtureState {
  mode: "placed" | "failure" | "hang";
  postCount: number;
  nextCallId: number;
  /** References this provider actually accepted, for status correlation. */
  placed: Set<string>;
  /** When true the status endpoint only ever reports another call's reference. */
  foreignPlacedOnly: boolean;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed agent calls", () => {
  test("call schema accepts only complete mode-specific requests", () => {
    const store = createStore();
    try {
      const tool = createAgentCallTool({
        repository: store.assistantWork,
        provider: {
          origin: "http://127.0.0.1:1",
          createPath: "/calls",
          statusPath: "/calls/status",
          callerId: "+14155552671",
          secretRef: "secret://telephony/api",
        },
        endpointPolicy: () => ({ allowed: false }),
      });
      const parameters = tool.parameters as { safeParse(input: unknown): { success: boolean } };
      const proposal = { mode: "propose", workId: "work", ...request() };
      const place = { mode: "place", actionId: "action", revision: 1, digest: "a".repeat(64) };
      expect(tool.strict).toBe(true);
      for (const request of [proposal, place]) {
        expect(parameters.safeParse({ request }).success).toBe(true);
        expect(parameters.safeParse(request).success).toBe(false);
        expect(parameters.safeParse({ request, mode: request.mode }).success).toBe(false);
        expect(parameters.safeParse({ request: { ...request, unexpected: true } }).success).toBe(false);
        for (const field of Object.keys(request)) {
          const incomplete: Record<string, unknown> = { ...request };
          delete incomplete[field];
          expect(parameters.safeParse({ request: incomplete }).success).toBe(false);
          expect(parameters.safeParse({ request: { ...request, [field]: null } }).success).toBe(false);
        }
      }
      for (const request of [
        { ...proposal, actionId: place.actionId },
        { ...proposal, revision: place.revision },
        { ...proposal, digest: place.digest },
        ...Object.entries(proposal).filter(([field]) => field !== "mode").map(([field, value]) => ({ ...place, [field]: value })),
        { ...proposal, maxMinutes: 0 },
        { ...proposal, maxMinutes: 31 },
        { ...proposal, maxMinutes: 1.5 },
        { ...proposal, script: "" },
        { ...place, revision: 0 },
        { ...place, digest: "invalid" },
        { mode: "unknown" },
      ]) {
        expect(parameters.safeParse({ request }).success).toBe(false);
      }
    } finally {
      store.close();
    }
  });
  test("proposals are external_mutation and owner rules cannot authorize them", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "classification");
    const proposed = await proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: request(),
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });

    expect(proposed.action.effectClass).toBe("external_mutation");
    expect(authorizationRequirementForEffect(proposed.action.effectClass)).toBe("owner_explicit");
    expect(ownerRuleCanAuthorize(proposed.action.effectClass)).toBe(false);
    expect(proposed.action.state).toBe("approval_pending");
    expect(proposed.action.cost).toEqual({ kind: "call", maxMinutes: 5 });
    // The owner approves a digest, so the exact authorized words must be part
    // of the approval-legible scope and bound to the transported body.
    const script = request().script;
    expect(proposed.action.scope).toEqual({
      kind: "agent_call",
      callee: "+14155552671",
      purpose: "Confirm the appointment",
      script,
      scriptSha256: createHash("sha256").update(script, "utf8").digest("hex"),
    });
    const plan = parseManagedHttpPlan(proposed.action.payload);
    expect(JSON.parse(plan.body ?? "null")).toMatchObject({ script });
  });

  test("execution without explicit approval is rejected by the ledger", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "approval");
    const proposed = await proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: request(),
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });

    const result = await execute(proposed.action, store, fixture);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failed result");
    expect(result.managed?.kind).toBe("rejected");
    if (result.managed?.kind === "rejected") expect(result.managed.reason).toBe("approval_required");
    expect(fixture.postCount()).toBe(0);
  });

  test("explicit approval places exactly once and verification confirms it", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "placed");
    const proposed = await proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: request(),
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });
    approve(store, proposed.action, "placed");

    const result = await execute(proposed.action, store, fixture, "dispatch-placed");
    expect(result.kind).toBe("placed");
    expect(fixture.postCount()).toBe(1);
    expect(store.assistantWork.getAction(proposed.action.id)?.state).toBe("confirmed");

    const replay = await execute(proposed.action, store, fixture, "dispatch-replay");
    expect(replay.kind).toBe("failed");
    expect(fixture.postCount()).toBe(1);
  });

  test("another call's placed status cannot confirm this billable call", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "foreign-status");
    const proposed = await proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: request(),
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });
    approve(store, proposed.action, "foreign-status");
    // The provider reports a placed call, but for a different reference: a
    // prior or concurrent call must never confirm this irreversible effect.
    fixture.setForeignPlacedOnly(true);

    const result = await execute(proposed.action, store, fixture, "dispatch-foreign");
    expect(result.kind).toBe("uncertain");
    expect(fixture.postCount()).toBe(1);
    expect(store.assistantWork.getAction(proposed.action.id)?.state).toBe("ambiguous");
  });

  test("an aborted invocation never reaches the billable POST", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "aborted");
    const proposed = await proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: request(),
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });
    approve(store, proposed.action, "aborted");
    const controller = new AbortController();
    controller.abort();

    const result = await executeAgentCall({
      repository: store.assistantWork,
      provider: fixture.provider,
      actionId: proposed.action.id,
      revision: proposed.action.revision,
      digest: proposed.action.digest,
      dispatchKey: "dispatch-aborted",
      workerId: "agent-call-test",
      endpointPolicy: fixture.endpointPolicy,
      resolveSecret: fixture.resolveSecret,
      signal: controller.signal,
      now: () => T0,
    });
    expect(result.kind).not.toBe("placed");
    expect(fixture.postCount()).toBe(0);
  });

  test("the registered tool proposes and places through its own surface and rejects mode crossing", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "tool-surface");
    const tool = createAgentCallTool({
      repository: store.assistantWork,
      provider: fixture.provider,
      endpointPolicy: fixture.endpointPolicy,
      resolveSecret: fixture.resolveSecret,
      now: () => new Date(T0),
      workerId: "agent-call-tool-test",
    });
    const call = async (params: Record<string, unknown>) => call2(tool, params);

    const proposed = await call({
      mode: "propose", workId: work.id, to: "+14155559999",
      purpose: "Confirm the booking", script: "Ask whether 8pm is available.", maxMinutes: 5,
    });
    const summary = (proposed.details as { readonly action: { readonly id: string; readonly revision: number; readonly digest: string } }).action;
    expect(proposed.details).toMatchObject({ mode: "propose", effectInvoked: false });
    expect(store.assistantWork.getAction(summary.id)?.effectClass).toBe("external_mutation");

    // Placing without the owner's explicit approval must fail through the tool
    // surface too, not only through the direct executor.
    const refused = await call({ mode: "place", actionId: summary.id, revision: summary.revision, digest: summary.digest });
    expect(refused.details).toMatchObject({ mode: "place" });
    expect(refused.details).not.toMatchObject({ kind: "placed" });
    expect(fixture.postCount()).toBe(0);

    approve(store, store.assistantWork.getAction(summary.id)!, "tool-surface");
    const placed = await call({ mode: "place", actionId: summary.id, revision: summary.revision, digest: summary.digest });
    expect(placed.details).toMatchObject({ mode: "place", kind: "placed" });
    expect(fixture.postCount()).toBe(1);

    await expect(call({
      mode: "propose", workId: work.id, to: "+14155559999", purpose: "p", script: "s", maxMinutes: 5, revision: 1,
    })).rejects.toThrow();
    await expect(call({
      mode: "place", actionId: summary.id, revision: summary.revision, digest: summary.digest, to: "+14155559999",
    })).rejects.toThrow();
  });

  test("an already-aborted invocation of the registered tool never reaches the POST", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "tool-abort");
    const tool = createAgentCallTool({
      repository: store.assistantWork,
      provider: fixture.provider,
      endpointPolicy: fixture.endpointPolicy,
      resolveSecret: fixture.resolveSecret,
      now: () => new Date(T0),
      workerId: "agent-call-tool-abort",
    });
    const proposed = await call2(tool, {
      mode: "propose", workId: work.id, to: "+14155559999",
      purpose: "Confirm the booking", script: "Ask whether 8pm is available.", maxMinutes: 5,
    });
    const summary = (proposed.details as { readonly action: { readonly id: string; readonly revision: number; readonly digest: string } }).action;
    approve(store, store.assistantWork.getAction(summary.id)!, "tool-abort");
    const controller = new AbortController();
    controller.abort();

    // The signal must survive the registered tool boundary, not just the
    // executor: this is where a cancelled invocation would otherwise bill.
    const placed = await tool.execute("tool-call", { request: {
      mode: "place", actionId: summary.id, revision: summary.revision, digest: summary.digest,
    } } as never, undefined, {} as never, controller.signal);
    expect(placed.details).not.toMatchObject({ kind: "placed" });
    expect(fixture.postCount()).toBe(0);
  });

  test("a correlated status that reports the call was not placed cannot confirm it", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "correlated-failure");
    const proposed = await proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: request(),
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });
    approve(store, proposed.action, "correlated-failure");
    // The provider answers about exactly this call but reports it was not
    // placed: correlation alone must not be read as success.
    fixture.setMode("failure");

    const result = await execute(proposed.action, store, fixture, "dispatch-correlated-failure");
    expect(result.kind).not.toBe("placed");
    expect(store.assistantWork.getAction(proposed.action.id)?.state).not.toBe("confirmed");
  });

  test("a post-approval payload tamper cannot redirect an approved call", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "tamper");
    const proposed = await proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: request(),
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });
    approve(store, proposed.action, "tamper");

    // Rewrite the persisted callee in both the transported body and the
    // approval-legible scope, keeping the original digest: the owner approved
    // a call to one number, so a call to another must never be placed.
    const db = new Database(storePath(store));
    try {
      const row = db.query("SELECT payload_json, scope_json FROM assistant_work_action_revisions WHERE action_id = ?")
        .get(proposed.action.id) as { readonly payload_json: string; readonly scope_json: string };
      const payload = JSON.parse(row.payload_json) as { body: string };
      const body = JSON.parse(payload.body) as Record<string, unknown>;
      body.to = "+14155550000";
      payload.body = JSON.stringify(body);
      const scope = JSON.parse(row.scope_json) as Record<string, unknown>;
      scope.callee = "+14155550000";
      db.query("UPDATE assistant_work_action_revisions SET payload_json = ?, scope_json = ? WHERE action_id = ?")
        .run(JSON.stringify(payload), JSON.stringify(scope), proposed.action.id);
    } finally {
      db.close();
    }

    const result = await execute(store.assistantWork.getAction(proposed.action.id)!, store, fixture, "dispatch-tamper");
    expect(result.kind).not.toBe("placed");
    expect(fixture.postCount()).toBe(0);
    expect(store.assistantWork.getAction(proposed.action.id)?.state).not.toBe("confirmed");
  });

  test("a placed call cannot be given a repeat policy", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "call-repeat-fence");
    const proposed = await proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: request(),
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });
    approve(store, proposed.action, "call-repeat-fence");
    expect((await execute(proposed.action, store, fixture, "dispatch-repeat-fence")).kind).toBe("placed");

    // Verification is bound to one work-scoped reference, so a repeat that
    // copied the payload could be confirmed by the original call's status.
    expect(() => store.assistantWork.setFollowupPolicy({
      workId: work.id,
      actionId: proposed.action.id,
      enabled: true,
      intervalMs: 60_000,
      maxAttempts: 1,
      provenance: { principal: "owner", channel: "test", subject: "owner", evidenceId: "call-repeat-fence" },
    }, T0)).toThrow(/correlated capability actions/);
    expect(store.assistantWork.listFollowupPolicies()).toHaveLength(0);
  });

  test("provider 5xx settles definitive_failed without a second POST", async () => {
    const fixture = startProviderFixture();
    fixture.setMode("failure");
    const store = createStore();
    const work = admitWork(store, "server-failure");
    const proposed = await proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: request(),
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });
    approve(store, proposed.action, "server-failure");

    const result = await execute(proposed.action, store, fixture, "dispatch-failure");
    expect(result.kind).toBe("failed");
    expect(store.assistantWork.getAction(proposed.action.id)?.state).toBe("definitive_failed");
    expect(fixture.postCount()).toBe(1);
  });

  test("provider timeout settles uncertain and is not auto-retried", async () => {
    const fixture = startProviderFixture();
    fixture.setMode("hang");
    const store = createStore();
    const work = admitWork(store, "timeout");
    const proposed = await proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: request(),
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });
    approve(store, proposed.action, "timeout");

    const result = await execute(proposed.action, store, fixture, "dispatch-timeout", { timeoutMs: 50 });
    expect(result.kind).toBe("uncertain");
    expect(store.assistantWork.getAction(proposed.action.id)?.state).toBe("ambiguous");
    expect(fixture.postCount()).toBe(1);

    const replay = await execute(proposed.action, store, fixture, "dispatch-timeout-replay", { timeoutMs: 50 });
    expect(replay.kind).toBe("failed");
    expect(fixture.postCount()).toBe(1);
  });

  test("normalizes valid E.164 input and rejects malformed numbers", () => {
    expect(normalizeCallNumber("+1 (415) 555-2671")).toBe("+14155552671");
    const malformed = ["14155552671", "+123", "+1234567890123456", "+12x345678", "+123/456789"];
    for (const value of malformed) expect(() => normalizeCallNumber(value)).toThrow();
  });

  test("proposal validation rejects invalid duration and empty script", async () => {
    const fixture = startProviderFixture();
    const store = createStore();
    const work = admitWork(store, "validation");
    const invalid = (overrides: Partial<AgentCallRequest>) => proposeAgentCall({
      repository: store.assistantWork,
      workId: work.id,
      provider: fixture.provider,
      request: { ...request(), ...overrides },
      endpointPolicy: fixture.endpointPolicy,
      now: () => T0,
    });
    await expect(invalid({ maxMinutes: 0 })).rejects.toThrow("maxMinutes");
    await expect(invalid({ maxMinutes: 31 })).rejects.toThrow("maxMinutes");
    await expect(invalid({ script: "   " })).rejects.toThrow("script");
  });

  test("provider configuration is optional only when origin is absent", () => {
    expect(configuredCallProvider({})).toBeUndefined();
    expect(() => configuredCallProvider({ OI_AGENT_CALL_ORIGIN: "http://example.test" })).toThrow();
    expect(() => configuredCallProvider({
      OI_AGENT_CALL_ORIGIN: "http://example.test/",
      OI_AGENT_CALL_CREATE_PATH: "/calls?unsafe=1",
      OI_AGENT_CALL_STATUS_PATH: "/status",
      OI_AGENT_CALL_CALLER_ID: "+14155552671",
      OI_AGENT_CALL_SECRET_REF: "secret://telephony/api",
    })).toThrow();
    expect(() => configuredCallProvider({
      OI_AGENT_CALL_ORIGIN: "http://example.test",
      OI_AGENT_CALL_CREATE_PATH: "/calls",
      OI_AGENT_CALL_STATUS_PATH: "/status",
      OI_AGENT_CALL_CALLER_ID: "14155552671",
      OI_AGENT_CALL_SECRET_REF: "secret://telephony/api",
    })).toThrow();
  });
});

function request(): AgentCallRequest {
  return {
    to: "+1 (415) 555-2671",
    purpose: "Confirm the appointment",
    script: "Please confirm whether Friday at 3 PM still works.",
    maxMinutes: 5,
  };
}

const storePaths = new WeakMap<StateStore, string>();

function createStore(): StateStore {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-agent-call-"));
  roots.push(root);
  const path = join(root, "state.db");
  const store = openStateStore(path);
  storePaths.set(store, path);
  return store;
}

/** Direct row access, used only to model a post-approval tamper. */
function storePath(store: StateStore): string {
  const path = storePaths.get(store);
  if (path === undefined) throw new Error("store path is unknown");
  return path;
}

function admitWork(store: StateStore, suffix: string) {
  return store.assistantWork.admitObservation({
    source: "test:agent-call",
    occurrenceKey: `observation-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Agent call ${suffix}`,
    provenance: {
      principal: "system",
      channel: "test",
      subject: "agent-call-test",
      evidenceId: `evidence-${suffix}`,
    },
    observedAt: T0,
    evidence: { suffix },
  }, T0).work;
}

function approve(store: StateStore, action: ActionRecord, suffix: string): void {
  store.assistantWork.grantExplicitApproval({
    actionId: action.id,
    revision: action.revision,
    digest: action.digest,
    provenance: {
      principal: "owner",
      channel: "test-owner",
      subject: "authenticated-owner",
      evidenceId: `approval-${suffix}`,
    },
  }, T1);
}

async function execute(
  action: ActionRecord,
  store: StateStore,
  fixture: ProviderFixture,
  dispatchKey = "dispatch",
  overrides: { readonly timeoutMs?: number } = {},
) {
  return await executeAgentCall({
    repository: store.assistantWork,
    provider: fixture.provider,
    actionId: action.id,
    revision: action.revision,
    digest: action.digest,
    dispatchKey,
    workerId: "agent-call-test",
    endpointPolicy: fixture.endpointPolicy,
    resolveSecret: fixture.resolveSecret,
    now: () => T2,
    ...overrides,
  });
}

function startProviderFixture(): ProviderFixture {
  const state: FixtureState = { mode: "placed", postCount: 0, nextCallId: 1, placed: new Set<string>(), foreignPlacedOnly: false };
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/calls" && request.method === "POST") {
        state.postCount += 1;
        if (state.mode === "hang") return await new Promise<Response>(() => undefined);
        if (state.mode === "failure") return Response.json({ status: "rejected" }, { status: 502 });
        const body = await request.json() as Record<string, unknown>;
        if (Object.keys(body).sort().join(",") !== "clientReference,from,maxMinutes,purpose,script,to") {
          return Response.json({ status: "invalid" }, { status: 400 });
        }
        const callId = `call-${state.nextCallId}`;
        state.nextCallId += 1;
        state.placed.add(String(body.clientReference));
        return Response.json({ status: "accepted", callId, clientReference: body.clientReference });
      }
      if (url.pathname === "/calls/status" && request.method === "GET") {
        if (state.mode === "hang") return await new Promise<Response>(() => undefined);
        // Correlated but unsuccessful: the reference is echoed without the
        // success-bearing field, which must never confirm.
        if (state.mode === "failure") {
          return Response.json({ status: "not_placed", clientReference: url.searchParams.get("clientReference") ?? "" });
        }
        // The provider answers only about the reference it was asked about, and
        // only if that exact call was actually placed here.
        const asked = url.searchParams.get("clientReference") ?? "";
        if (state.foreignPlacedOnly || !state.placed.has(asked)) {
          // A placed call, but not this one: `placedReference` names the other.
          return Response.json({ status: "placed", placedReference: "agent-call-ref-someone-elses-call" });
        }
        // `placedReference` appears only for a call actually placed here.
        return Response.json({ status: "placed", placedReference: asked, clientReference: asked });
      }
      return Response.json({ status: "not_found" }, { status: 404 });
    },
  });
  servers.push(server);
  const origin = server.url.origin;
  const provider: CallProviderConfig = {
    origin,
    createPath: "/calls",
    statusPath: "/calls/status",
    callerId: "+14155552671",
    secretRef: "secret://telephony/api",
  };
  return {
    origin,
    provider,
    endpointPolicy: (endpoint) => ({
      allowed: endpoint.origin === origin,
      allowPrivateNetwork: endpoint.origin === origin,
    }),
    resolveSecret: () => "test-token",
    setMode: (mode) => { state.mode = mode; },
    postCount: () => state.postCount,
    setForeignPlacedOnly: (value) => { state.foreignPlacedOnly = value; },
    stop: () => server.stop(true),
  };
}

async function call2(tool: ReturnType<typeof createAgentCallTool>, params: Record<string, unknown>) {
  return tool.execute("tool-call", { request: params } as never, undefined, {} as never, undefined);
}
