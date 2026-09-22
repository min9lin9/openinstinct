import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentEmailClientReference,
  agentEmailPlanAuthorizer,
  agentEmailSemanticKey,
  fetchAgentInbox,
  ingestAgentEmail,
  proposeAgentEmail,
  type InboundAgentEmail,
} from "../../src/email/agent-email.ts";
import { createAgentEmailTool } from "../../src/email/tool.ts";
import {
  AGENT_EMAIL_SEND_ACTION,
  configuredAgentEmail,
  type AgentEmailIdentity,
} from "../../src/email/identity.ts";
import { executeManagedHttpAction, parseManagedHttpPlan, proposeManagedHttpAction } from "../../src/assistant-work/http-effects.ts";
import { configuredHttpAccess } from "../../src/assistant-work/http-policy.ts";
import { stableAttemptId } from "../../src/assistant-work/model.ts";
import { dispatchManagedAction } from "../../src/assistant-work/dispatch.ts";
import { openStateStore } from "../../src/store/db.ts";

const NOW = "2026-09-18T10:00:00.000Z";
const SECRET = "Bearer agent-email-test-secret";

interface ProviderRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}

interface EmailProvider {
  readonly origin: string;
  readonly requests: ProviderRequest[];
  readonly inbox: InboundAgentEmail[];
  readonly stop: () => void;
}

/**
 * Mirrors the documented provider contract: the send echoes the client
 * reference it was given, and the status GET answers only about the reference
 * it was asked about. An uncorrelated success can therefore never confirm.
 */
function acceptedResponse(request: Request, clientReference: string, accepted = true): Response {
  const credential = request.headers.get("authorization") ?? "";
  // `acceptedReference` is present only for a message the provider accepted,
  // so one expectation proves correlation and success together.
  return new Response(JSON.stringify({
    accepted,
    clientReference,
    ...(accepted ? { acceptedReference: clientReference } : {}),
  }), {
    headers: { "content-type": `application/json; provider-credential=${credential}` },
  });
}

async function startProvider(): Promise<EmailProvider> {
  const requests: ProviderRequest[] = [];
  const inbox: InboundAgentEmail[] = [];
  const accepted: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
      });
      if (request.method === "GET" && url.pathname === "/send") {
        const asked = url.searchParams.get("clientReference") ?? "";
        // Only a reference this provider actually accepted is echoed back.
        return acceptedResponse(request, asked, accepted.includes(asked));
      }
      if (request.method === "GET" && url.pathname === "/inbox") {
        return Response.json({ messages: inbox });
      }
      if (request.method === "POST" && url.pathname === "/send") {
        const parsed = JSON.parse(body) as { readonly clientReference?: string };
        accepted.push(parsed.clientReference ?? "");
        return acceptedResponse(request, parsed.clientReference ?? "");
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    inbox,
    stop: () => server.stop(true),
  };
}

function identityFor(provider: EmailProvider): AgentEmailIdentity {
  const identity = configuredAgentEmail({
    OI_AGENT_EMAIL_ADDRESS: "assistant@Example.TEST",
    OI_AGENT_EMAIL_SEND_ORIGIN: provider.origin,
    OI_AGENT_EMAIL_SEND_PATH: "/send",
    OI_AGENT_EMAIL_SECRET_REF: "secret://provider/agent-email",
    OI_AGENT_EMAIL_INBOX_URL: `${provider.origin}/inbox`,
  });
  if (identity === undefined) throw new Error("test identity was not configured");
  return identity;
}

function accessFor(provider: EmailProvider, identity: AgentEmailIdentity) {
  return configuredHttpAccess({
    OI_HTTP_LOCAL_ORIGINS: JSON.stringify([provider.origin]),
    OI_HTTP_SECRET_BINDINGS: JSON.stringify({
      [identity.secretRef]: {
        origin: provider.origin,
        header: "authorization",
        environment: "OI_TEST_EMAIL_TOKEN",
      },
    }),
    OI_TEST_EMAIL_TOKEN: SECRET,
  });
}

function createStore() {
  const root = mkdtempSync(join(tmpdir(), "oi-agent-email-"));
  const store = openStateStore(join(root, "state.db"));
  return { root, store };
}

function admitWork(store: ReturnType<typeof createStore>["store"], suffix: string) {
  return store.assistantWork.admitObservation({
    source: "email-test",
    occurrenceKey: `work-${suffix}`,
    workKey: `work-${suffix}`,
    workTitle: `Email work ${suffix}`,
    provenance: {
      principal: "system",
      channel: "test",
      subject: "email-test",
      evidenceId: `email-test:${suffix}`,
    },
    observedAt: NOW,
    evidence: { suffix },
  }, NOW).work;
}

test("email schema accepts only complete mode-specific requests", () => {
  const provider = { origin: "http://127.0.0.1:1" } as EmailProvider;
  const identity = identityFor(provider);
  const { root, store } = createStore();
  try {
    const tool = createAgentEmailTool({
      repository: store.assistantWork,
      identity,
      endpointPolicy: accessFor(provider, identity).endpointPolicy,
    });
    const parameters = tool.parameters as { safeParse(input: unknown): { success: boolean } };
    const proposal = { mode: "propose", workId: "work", to: "owner@example.com", subject: "Status", body: "Exact body.\n" };
    const send = { mode: "send", actionId: "action", revision: 1, digest: "a".repeat(64) };
    const inbox = { mode: "inbox" };
    expect(tool.strict).toBe(true);
    for (const request of [proposal, send, inbox]) {
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
      { ...proposal, actionId: send.actionId },
      { ...proposal, revision: send.revision },
      { ...proposal, digest: send.digest },
      ...["workId", "to", "subject", "body"].map((field) => ({ ...send, [field]: "forbidden" })),
      ...Object.entries({ ...proposal, ...send }).filter(([field]) => field !== "mode").map(([field, value]) => ({ ...inbox, [field]: value })),
      { ...send, revision: 0 },
      { ...send, digest: "invalid" },
      { ...proposal, body: "" },
      { mode: "unknown" },
    ]) {
      expect(parameters.safeParse({ request }).success).toBe(false);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("proposed send is externally bound to the exact agent email message template", async () => {
  const provider = await startProvider();
  const { root, store } = createStore();
  try {
    const identity = identityFor(provider);
    const access = accessFor(provider, identity);
    const work = admitWork(store, "binding");
    const draft = { to: "owner@example.com", subject: "Status", body: "The build is ready." } as const;
    const proposed = await proposeAgentEmail({
      repository: store.assistantWork,
      workId: work.id,
      identity,
      draft,
      endpointPolicy: access.endpointPolicy,
      now: () => NOW,
    });
    const plan = parseManagedHttpPlan(proposed.action.payload);
    expect(proposed.action.effectClass).toBe("external_message");
    expect(proposed.action.action).toBe(AGENT_EMAIL_SEND_ACTION);
    expect(JSON.parse(plan.body ?? "null")).toEqual({
      clientReference: agentEmailClientReference(draft, identity, work.id),
      from: identity.address,
      to: draft.to,
      subject: draft.subject,
      text: draft.body,
    });
    expect(agentEmailSemanticKey(draft, identity)).toBe(proposed.action.semanticKey);
    // The capability authorizes its own plan, and the generic host binding set
    // deliberately contains no email template at all.
    expect(agentEmailPlanAuthorizer(identity, work.id)(plan))
      .toEqual({ capabilityId: "agent-email-send", capabilityVersion: 3 });
    expect(access.authorizeMessage(plan)).toBeUndefined();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    provider.stop();
  }
});

test("a generic managed-HTTP request cannot claim the agent-email template with a different or missing sender", async () => {
  const provider = await startProvider();
  const { root, store } = createStore();
  try {
    const identity = identityFor(provider);
    const access = accessFor(provider, identity);
    const draft = { to: "counterparty@example.test", subject: "Booking", body: "Please confirm." };
    const work = admitWork(store, "spoof-baseline");
    const reference = agentEmailClientReference(draft, identity, work.id);
    const sendUrl = `${identity.sendOrigin}${identity.sendPath}`;
    // Exactly the shape the capability produces, so only the sender differs.
    const authorizedPlan = parseManagedHttpPlan((await proposeAgentEmail({
      repository: store.assistantWork,
      workId: work.id,
      identity,
      draft,
      endpointPolicy: access.endpointPolicy,
      now: () => NOW,
    })).action.payload);
    const authorize = agentEmailPlanAuthorizer(identity, work.id);
    expect(authorize(authorizedPlan)).toMatchObject({ capabilityId: "agent-email-send" });

    // Every effect-bearing field must be part of the authorized identity, not
    // just the body: a swapped credential or a verification pointed somewhere
    // harmless would otherwise ride an owner send rule.
    const swapHeader = authorizedPlan.headers.map((header) => "secretRef" in header
      ? { name: header.name, secretRef: "secret://other/token" }
      : header);
    expect(authorize({ ...authorizedPlan, headers: swapHeader })).toBeUndefined();
    expect(authorize({
      ...authorizedPlan,
      verification: { ...authorizedPlan.verification, url: `${identity.sendOrigin}/elsewhere` },
    })).toBeUndefined();
    expect(authorize({
      ...authorizedPlan,
      verification: {
        ...authorizedPlan.verification,
        expected: { kind: "json_field" as const, path: ["accepted"], value: true },
      },
    })).toBeUndefined();
    expect(authorize({
      ...authorizedPlan,
      messageOperation: { ...authorizedPlan.messageOperation!, recipient: "someone@else.test" },
    })).toBeUndefined();
    expect(authorize({
      ...authorizedPlan,
      messageOperation: { ...authorizedPlan.messageOperation!, topic: "Different subject" },
    })).toBeUndefined();

    // The generic host binding set has no email template, so a managed-HTTP
    // request can never obtain this classification by composing a body.
    expect(access.authorizeMessage(authorizedPlan)).toBeUndefined();

    const forge = (body: Record<string, unknown>) => authorize({
      ...authorizedPlan,
      url: sendUrl,
      body: JSON.stringify(body),
    });
    const base = { clientReference: reference, to: draft.to, subject: draft.subject, text: draft.body };
    // An impersonated sender, an omitted sender, and a smuggled extra field
    // must all fail to obtain this template's external_message authorization.
    expect(forge({ ...base, from: "ceo@victim.example" })).toBeUndefined();
    expect(forge(base)).toBeUndefined();
    expect(forge({ ...base, from: identity.address, replyTo: "attacker@example.test" })).toBeUndefined();
    // Even a body with the right fields in a different order is not the plan
    // this capability builds, and byte equality is what makes duplicate
    // members and escaped key spellings unrepresentable.
    expect(forge({ ...base, from: identity.address })).toBeUndefined();
    expect(authorize(authorizedPlan)).toMatchObject({ capabilityId: "agent-email-send" });

    // A duplicate member is parser-dependent: JSON.parse keeps the last value
    // while the raw body is what ships, so a first-wins provider would send the
    // attacker's sender. Both orderings must be refused outright.
    const rawForge = (rawBody: string) => authorize({ ...authorizedPlan, url: sendUrl, body: rawBody });
    const pinned = JSON.stringify(base.clientReference);
    const duplicateLastWins = `{"clientReference":${pinned},"from":"ceo@victim.example","to":${JSON.stringify(base.to)},"subject":${JSON.stringify(base.subject)},"text":${JSON.stringify(base.text)},"from":${JSON.stringify(identity.address)}}`;
    const duplicateFirstWins = `{"clientReference":${pinned},"from":${JSON.stringify(identity.address)},"to":${JSON.stringify(base.to)},"subject":${JSON.stringify(base.subject)},"text":${JSON.stringify(base.text)},"from":"ceo@victim.example"}`;
    expect(rawForge(duplicateLastWins)).toBeUndefined();
    expect(rawForge(duplicateFirstWins)).toBeUndefined();
    // A unicode-escaped key spelling parses the same but is a different body.
    const escapedKey = authorizedPlan.body!.replace('"from"', '"\\u0066rom"');
    expect(rawForge(escapedKey)).toBeUndefined();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    provider.stop();
  }
});

test("approved send invokes one mutation and one verification with redacted credential evidence", async () => {
  const provider = await startProvider();
  const { root, store } = createStore();
  try {
    const identity = identityFor(provider);
    const access = accessFor(provider, identity);
    const work = admitWork(store, "execute");
    const proposed = await proposeAgentEmail({
      repository: store.assistantWork,
      workId: work.id,
      identity,
      draft: { to: "owner@example.com", subject: "Status", body: "The build is ready." },
      endpointPolicy: access.endpointPolicy,
      now: () => NOW,
    });
    store.assistantWork.grantExplicitApproval({
      actionId: proposed.action.id,
      revision: proposed.action.revision,
      digest: proposed.action.digest,
      provenance: {
        principal: "owner",
        channel: "test",
        subject: "owner",
        evidenceId: "approval:execute",
      },
    }, NOW);
    const tool = createAgentEmailTool({
      repository: store.assistantWork,
      identity,
      endpointPolicy: access.endpointPolicy,
      resolveSecret: access.resolveSecret,
      now: () => new Date(NOW),
      workerId: "email-test-worker",
    });
    const result = await tool.execute("send-call", { request: {
      mode: "send",
      actionId: proposed.action.id,
      revision: proposed.action.revision,
      digest: proposed.action.digest,
    } } as never, undefined, {} as never, undefined);
    expect(result.details).toMatchObject({ mode: "send", kind: "confirmed" });
    expect(provider.requests.filter((request) => request.method === "POST" && request.path === "/send")).toHaveLength(1);
    expect(provider.requests.filter((request) => request.method === "GET" && request.path === "/send")).toHaveLength(1);
    expect(provider.requests.every((request) => request.authorization === SECRET)).toBe(true);
    const attempt = store.assistantWork.listAttempts(proposed.action.id)[0];
    expect(attempt).toBeDefined();
    expect(JSON.stringify(attempt?.outcome)).not.toContain(SECRET);
    expect(JSON.stringify(attempt?.outcome)).toContain("[REDACTED]");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    provider.stop();
  }
});

test("send without approval is rejected before the provider is invoked", async () => {
  const provider = await startProvider();
  const { root, store } = createStore();
  try {
    const identity = identityFor(provider);
    const access = accessFor(provider, identity);
    const proposed = await proposeAgentEmail({
      repository: store.assistantWork,
      workId: admitWork(store, "approval").id,
      identity,
      draft: { to: "owner@example.com", subject: "Needs approval", body: "Please review." },
      endpointPolicy: access.endpointPolicy,
      now: () => NOW,
    });
    const result = await executeManagedHttpAction({
      repository: store.assistantWork,
      actionId: proposed.action.id,
      revision: proposed.action.revision,
      digest: proposed.action.digest,
      attemptId: stableAttemptId(proposed.action.id, proposed.action.revision, "approval-gate"),
      workerId: "email-test-worker",
      endpointPolicy: access.endpointPolicy,
      resolveSecret: access.resolveSecret,
      authorizeMessage: agentEmailPlanAuthorizer(identity, proposed.action.workId),
      now: () => NOW,
    });
    expect(result).toMatchObject({ kind: "rejected", reason: "approval_required" });
    expect(provider.requests).toHaveLength(0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    provider.stop();
  }
});

test("inbound email admission is idempotent and stores third-party provenance", () => {
  const provider = { origin: "http://127.0.0.1:1" } as EmailProvider;
  const identity = identityFor(provider);
  const { root, store } = createStore();
  try {
    const message: InboundAgentEmail = {
      providerId: "provider-message-1",
      from: "sender@Example.com",
      subject: "Re: Status",
      text: "The build is ready.",
      receivedAt: NOW,
    };
    expect(ingestAgentEmail({ repository: store.assistantWork, identity, messages: [message], now: () => NOW })).toEqual({ admitted: 1, duplicates: 0 });
    expect(ingestAgentEmail({ repository: store.assistantWork, identity, messages: [message], now: () => NOW })).toEqual({ admitted: 0, duplicates: 1 });
    const observation = store.assistantWork.listObservations()[0];
    expect(observation).toMatchObject({
      source: "agent-email",
      occurrenceKey: message.providerId,
      provenance: {
        principal: "third_party",
        channel: "email",
        subject: "sender@example.com",
        evidenceId: "agent-email:provider-message-1",
      },
    });
    expect(observation?.evidence).toEqual({ from: "sender@example.com", subject: message.subject, text: message.text });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-addressed inbound email is rejected", () => {
  const provider = { origin: "http://127.0.0.1:1" } as EmailProvider;
  const identity = identityFor(provider);
  const { root, store } = createStore();
  try {
    expect(() => ingestAgentEmail({
      repository: store.assistantWork,
      identity,
      messages: [{
        providerId: "loop",
        from: "ASSISTANT@example.test",
        subject: "loop",
        text: "loop",
        receivedAt: NOW,
      }],
      now: () => NOW,
    })).toThrow(/self-addressed/);
    expect(store.assistantWork.listObservations()).toHaveLength(0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity configuration is optional but validates every required field", () => {
  expect(configuredAgentEmail({})).toBeUndefined();
  const base = {
    OI_AGENT_EMAIL_ADDRESS: "assistant@example.test",
    OI_AGENT_EMAIL_SEND_ORIGIN: "https://mail.example.test",
    OI_AGENT_EMAIL_SEND_PATH: "/send",
    OI_AGENT_EMAIL_SECRET_REF: "secret://mail/token",
    OI_AGENT_EMAIL_INBOX_URL: "https://mail.example.test/inbox",
  };
  expect(configuredAgentEmail(base)?.address).toBe("assistant@example.test");
  expect(() => configuredAgentEmail({ ...base, OI_AGENT_EMAIL_ADDRESS: "not-an-email" })).toThrow(/OI_AGENT_EMAIL_ADDRESS/);
  expect(() => configuredAgentEmail({ ...base, OI_AGENT_EMAIL_SEND_ORIGIN: "https://mail.example.test/send" })).toThrow(/OI_AGENT_EMAIL_SEND_ORIGIN/);
  expect(() => configuredAgentEmail({ ...base, OI_AGENT_EMAIL_SEND_PATH: "send" })).toThrow(/OI_AGENT_EMAIL_SEND_PATH/);
  expect(() => configuredAgentEmail({ ...base, OI_AGENT_EMAIL_SECRET_REF: "Bearer plaintext" })).toThrow(/OI_AGENT_EMAIL_SECRET_REF/);
  expect(() => configuredAgentEmail({ ...base, OI_AGENT_EMAIL_INBOX_URL: "not-a-url" })).toThrow(/OI_AGENT_EMAIL_INBOX_URL/);
});

test("inbox fetch is bounded, strict, and feeds the typed ingestion path", async () => {
  const provider = await startProvider();
  const { root, store } = createStore();
  try {
    const identity = identityFor(provider);
    const access = accessFor(provider, identity);
    provider.inbox.push({
      providerId: "provider-inbox-1",
      from: "sender@example.com",
      subject: "Question",
      text: "Can you confirm?",
      receivedAt: NOW,
    });
    const messages = await fetchAgentInbox({
      identity,
      endpointPolicy: access.endpointPolicy,
      resolveSecret: access.resolveSecret,
    });
    expect(messages).toEqual(provider.inbox);
    const counts = ingestAgentEmail({ repository: store.assistantWork, identity, messages, now: () => NOW });
    expect(counts).toEqual({ admitted: 1, duplicates: 0 });
    expect(provider.requests.filter((request) => request.method === "GET" && request.path === "/inbox")).toHaveLength(1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    provider.stop();
  }
});

test("a correlated capability action can neither be given a repeat policy nor honour a pre-existing one", async () => {
  const provider = await startProvider();
  const { root, store } = createStore();
  try {
    const identity = identityFor(provider);
    const access = accessFor(provider, identity);
    const work = admitWork(store, "followup-fence");
    const proposed = await proposeAgentEmail({
      repository: store.assistantWork,
      workId: work.id,
      identity,
      draft: { to: "owner@example.com", subject: "Repeat", body: "Body." },
      endpointPolicy: access.endpointPolicy,
      now: () => NOW,
    });
    // A repeat copies the payload verbatim, so its verification would be
    // satisfied by the first send's provider status. Refuse the schedule
    // rather than let a later repeat report a success that never happened.
    expect(() => store.assistantWork.setFollowupPolicy({
      workId: work.id,
      actionId: proposed.action.id,
      enabled: true,
      intervalMs: 60_000,
      maxAttempts: 1,
      provenance: { principal: "owner", channel: "test", subject: "owner", evidenceId: "followup-fence" },
    }, NOW)).toThrow(/correlated capability actions/);
    expect(store.assistantWork.listFollowupPolicies()).toHaveLength(0);

    // The fence must also hold at claim time, not only at creation. The source
    // has to be confirmed first, otherwise claimDueFollowup stops earlier and
    // the claim-time fence is never reached.
    store.assistantWork.grantExplicitApproval({
      actionId: proposed.action.id,
      revision: proposed.action.revision,
      digest: proposed.action.digest,
      provenance: { principal: "owner", channel: "test", subject: "owner", evidenceId: "followup-fence" },
    }, NOW);
    const attemptId = stableAttemptId(proposed.action.id, proposed.action.revision, "fence-confirm");
    store.assistantWork.claimForDispatch({
      actionId: proposed.action.id, revision: proposed.action.revision, digest: proposed.action.digest,
      attemptId, workerId: "fixture-worker",
    }, NOW);
    store.assistantWork.markEffectStarted({ attemptId, workerId: "fixture-worker" }, NOW);
    store.assistantWork.confirmAttempt({ attemptId, workerId: "fixture-worker", outcome: { confirmed: true } }, NOW);
    expect(store.assistantWork.getAction(proposed.action.id)?.state).toBe("confirmed");

    // Plant the policy row a build predating the fence would have written, then
    // confirm it cannot materialize a repeat that reuses the correlation
    // reference.
    const planted = new Database(join(root, "state.db"));
    try {
      planted.query(
        `INSERT INTO assistant_work_followup_policies (
           work_id, action_id, action_revision, action_digest, revision, enabled,
           interval_ms, max_attempts, next_due_at, next_ordinal,
           provenance_principal, provenance_channel, provenance_subject, provenance_evidence_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, 1, 60000, 1, ?, 1, 'owner', 'test', 'owner', ?, ?, ?)`,
      ).run(work.id, proposed.action.id, proposed.action.revision, proposed.action.digest,
        "2026-01-01T00:00:30.000Z", "followup-fence", NOW, NOW);
    } finally {
      planted.close();
    }
    const claimed = store.assistantWork.claimDueFollowup(work.id, "fixture-worker", "2026-01-01T01:00:00.000Z");
    expect(claimed).toMatchObject({ kind: "none" });
    expect(store.assistantWork.listActions(work.id)).toHaveLength(1);

    // An extra body field must not disable the fence: repeats would still
    // reuse the original correlation reference.
    const padded = store.assistantWork.proposeAction({
      workId: work.id,
      semanticKey: "padded-capability-body",
      effectClass: "external_message",
      recipient: "owner@example.com",
      topic: "Repeat",
      action: "managed_http_request",
      payload: {
        ...(proposed.action.payload as Record<string, never>),
        body: JSON.stringify({
          clientReference: "agent-email-ref-x", from: identity.address, to: "owner@example.com",
          subject: "Repeat", text: "Body.", extra: "padding",
        }),
      },
    }, NOW);
    expect(() => store.assistantWork.setFollowupPolicy({
      workId: work.id,
      actionId: padded.id,
      enabled: true,
      intervalMs: 60_000,
      maxAttempts: 1,
      provenance: { principal: "owner", channel: "test", subject: "owner", evidenceId: "padded" },
    }, NOW)).toThrow(/correlated capability actions/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    provider.stop();
  }

});

test("the email tool refuses byte-identical email material proposed without capability authorization", async () => {
  const provider = await startProvider();
  const { root, store } = createStore();
  try {
    const identity = identityFor(provider);
    const access = accessFor(provider, identity);
    const draft = { to: "counterparty@example.test", subject: "Quote", body: "Please confirm." };

    // A genuine capability proposal, used only as the source of exact material.
    const genuine = await proposeAgentEmail({
      repository: store.assistantWork,
      workId: admitWork(store, "genuine").id,
      identity,
      draft,
      endpointPolicy: access.endpointPolicy,
      now: () => NOW,
    });
    const genuinePlan = parseManagedHttpPlan(genuine.action.payload);

    // The same transport material and message operation, proposed generically
    // with no authorizer: the ledger stores messageAuthorization = null, which
    // execution treats as an ordinary external mutation rather than a send.
    const foreign = await proposeManagedHttpAction({
      workId: admitWork(store, "foreign").id,
      semanticKey: "foreign-send",
      method: "POST",
      url: genuinePlan.url,
      headers: [...genuinePlan.headers],
      body: genuinePlan.body!,
      verification: {
        url: genuinePlan.verification.url,
        headers: [...genuinePlan.verification.headers],
        expected: genuinePlan.verification.expected,
      },
      messageOperation: { ...genuinePlan.messageOperation! },
    }, { repository: store.assistantWork, endpointPolicy: access.endpointPolicy, now: () => NOW });
    const foreignPlan = parseManagedHttpPlan(foreign.action.payload);
    expect(foreignPlan.body).toBe(genuinePlan.body);
    expect(foreignPlan.messageAuthorization).toBeNull();
    expect(foreign.action.effectClass).not.toBe("external_message");

    store.assistantWork.grantExplicitApproval({
      actionId: foreign.action.id,
      revision: foreign.action.revision,
      digest: foreign.action.digest,
      provenance: { principal: "owner", channel: "test", subject: "owner", evidenceId: "foreign" },
    }, NOW);

    const tool = createAgentEmailTool({
      repository: store.assistantWork,
      identity,
      endpointPolicy: access.endpointPolicy,
      resolveSecret: access.resolveSecret,
      now: () => new Date(NOW),
    });
    await expect(tool.execute("send-foreign", { request: {
      mode: "send",
      actionId: foreign.action.id,
      revision: foreign.action.revision,
      digest: foreign.action.digest,
    } } as never, undefined, {} as never, undefined)).rejects.toThrow(/not an agent email proposal/);
    expect(provider.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    provider.stop();
  }
});

test("a draft whose transported material would exceed the managed limits is refused at propose time", async () => {
  const provider = await startProvider();
  const { root, store } = createStore();
  try {
    const identity = identityFor(provider);
    const access = accessFor(provider, identity);
    const work = admitWork(store, "oversize");
    // Within the draft's character limit, but each character is multi-byte, so
    // the transported UTF-8 body exceeds the managed byte cap.
    const oversized = "\u00e9".repeat(700_000);
    await expect(proposeAgentEmail({
      repository: store.assistantWork,
      workId: work.id,
      identity,
      draft: { to: "owner@example.com", subject: "Big", body: oversized },
      endpointPolicy: access.endpointPolicy,
      now: () => NOW,
    })).rejects.toThrow(/transport limit/);
    expect(store.assistantWork.listActions(work.id)).toHaveLength(0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    provider.stop();
  }
});

test("a claimed-pre-effect email action is reauthorized and resumed by recovery", async () => {
  const provider = await startProvider();
  const { root, store } = createStore();
  try {
    const identity = identityFor(provider);
    const access = accessFor(provider, identity);
    const work = admitWork(store, "recovery");
    const proposed = await proposeAgentEmail({
      repository: store.assistantWork,
      workId: work.id,
      identity,
      draft: { to: "owner@example.com", subject: "Resume me", body: "Body." },
      endpointPolicy: access.endpointPolicy,
      now: () => NOW,
    });
    store.assistantWork.grantExplicitApproval({
      actionId: proposed.action.id,
      revision: proposed.action.revision,
      digest: proposed.action.digest,
      provenance: { principal: "owner", channel: "test", subject: "owner", evidenceId: "recovery" },
    }, NOW);
    // Crash after the claim, before the effect started.
    const attemptId = stableAttemptId(proposed.action.id, proposed.action.revision, "recovery-dispatch");
    expect(store.assistantWork.claimForDispatch({
      actionId: proposed.action.id,
      revision: proposed.action.revision,
      digest: proposed.action.digest,
      attemptId,
      workerId: "crashed-worker",
    }, NOW).kind).toBe("claimed");

    // Recovery dispatches through the generic managed-HTTP path, which has no
    // email binding: without the capability authorizer it would refuse and
    // strand an approved send.
    const result = await dispatchManagedAction({
      repository: store.assistantWork,
      action: store.assistantWork.getAction(proposed.action.id)!,
      attemptId,
      workerId: "crashed-worker",
      httpAccess: access,
      agentEmail: identity,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(result.kind).toBe("confirmed");
    expect(provider.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    provider.stop();
  }
});
