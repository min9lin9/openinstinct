import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeliveryPort, DeliveryReceipt } from "../../src/delivery/port.ts";
import { decodePeerEnvelope } from "../../src/peers/envelope.ts";
import { createPeerCoordinationTool } from "../../src/peers/tool.ts";
import type { TrustedPeerRecord } from "../../src/peers/trusted.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const T0 = "2026-09-18T00:00:00.000Z";
const roots: string[] = [];
const stores: StateStore[] = [];

const trusted: TrustedPeerRecord = {
  id: "peer:alice", handle: "+821012345678", displayName: "Alice",
  relation: "household", state: "trusted", createdAt: T0, updatedAt: T0,
};
const revoked: TrustedPeerRecord = { ...trusted, id: "peer:bob", handle: "+821099998888", displayName: "Bob", state: "revoked" };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(): StateStore {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-peer-tool-"));
  roots.push(root);
  const store = openStateStore(join(root, "state.db"));
  stores.push(store);
  return store;
}

function fakePort(): { readonly port: DeliveryPort; readonly sends: string[] } {
  const sends: string[] = [];
  return {
    sends,
    port: {
      sendText: async (handle, text): Promise<DeliveryReceipt> => {
        sends.push(`${handle}:${text}`);
        return { messageId: `msg-${sends.length}` };
      },
      sendReply: async (): Promise<DeliveryReceipt> => { throw new Error("unused"); },
      sendFile: async (): Promise<DeliveryReceipt> => { throw new Error("unused"); },
    },
  };
}

function admitWork(store: StateStore, suffix: string) {
  return store.assistantWork.admitObservation({
    source: "test", occurrenceKey: `work-${suffix}`, workKey: `work-${suffix}`,
    workTitle: `Peer tool ${suffix}`, observedAt: T0, evidence: { suffix },
    provenance: { principal: "system", channel: "test", subject: "test", evidenceId: `test:${suffix}` },
  }, T0).work;
}

function toolFor(store: StateStore, peers: readonly TrustedPeerRecord[], port?: DeliveryPort) {
  return createPeerCoordinationTool({
    repository: store.assistantWork,
    peers: () => peers,
    port: () => port,
    now: () => new Date(T0),
  });
}

async function call(tool: ReturnType<typeof createPeerCoordinationTool>, params: Record<string, unknown>) {
  return tool.execute("tool-call", { request: params } as never, undefined, {} as never, undefined);
}

/** Tool results are a content union; a peer tool reply is always one text part. */
function resultText(result: { readonly content: readonly unknown[] }): string {
  const first = result.content[0];
  if (first === null || typeof first !== "object" || (first as { readonly type?: unknown }).type !== "text") {
    throw new Error("tool result did not contain text");
  }
  const text = (first as { readonly text?: unknown }).text;
  if (typeof text !== "string") {
    throw new Error("tool result text was not a string");
  }
  return text;
}

describe("peer coordination tool", () => {
  test("nested mode branches remain strict-compatible after the actual SDK CustomTool conversion", async () => {
    const sdkEntry = import.meta.resolve("@gajae-code/coding-agent");
    const sessionSource = await Bun.file(new URL(import.meta.resolve("@gajae-code/coding-agent/sdk/session"))).text();
    // The SDK helper is private. Compile that exact installed function, not a copy
    // of its field mapping, without booting a credentialed session or modifying SDK files.
    const start = sessionSource.indexOf("function customToolToDefinition(");
    const end = sessionSource.indexOf("\nfunction createCustomToolsExtension(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(sessionSource.slice(start, end));
    const convert = new Function("TOOL_DEFINITION_MARKER", `${compiled}; return customToolToDefinition;`)(Symbol("test"));
    const tool = toolFor(createStore(), [trusted]);
    const definition = convert(tool);
    expect(tool.strict).toBe(true);
    expect(definition.strict).toBeUndefined(); // SDK 0.16 loses the flag in extension-enabled sessions.
    expect(convert({ ...tool, strict: false }).strict).toBeUndefined();
    expect(definition.parameters).toBe(tool.parameters);
    const { convertTools } = await import(import.meta.resolve("@gajae-code/ai/providers/openai-responses", sdkEntry));
    const model = {
      id: "schema-regression", name: "Schema regression", provider: "schema-regression",
      api: "openai-responses", baseUrl: "https://provider.example.test/v1",
      reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 1_024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const [outbound] = convertTools([definition], true, model);
    expect(outbound.strict).toBe(true);
    expect(outbound.parameters.required).toEqual(["request"]);
    expect(outbound.parameters.additionalProperties).toBe(false);
    const branches = outbound.parameters.properties.request.anyOf;
    expect(branches).toHaveLength(3);
    const expectedFields = [
      ["mode"],
      ["mode", "workId", "handle", "kind", "threadKey", "subject", "body"],
      ["mode", "actionId", "revision", "digest"],
    ];
    for (const [index, branch] of branches.entries()) {
      expect(Object.keys(branch.properties)).toEqual(expectedFields[index]);
      expect(branch.required).toEqual(expectedFields[index]);
      expect(branch.additionalProperties).toBe(false);
    }
    expect(branches[0].properties.mode.enum).toEqual(["list"]);
  });

  test("host schema accepts only complete nested requests for the selected mode", () => {
    const tool = toolFor(createStore(), [trusted]);
    const parameters = tool.parameters as { safeParse(input: unknown): { success: boolean } };
    const proposal = {
      mode: "propose", workId: "work", handle: trusted.handle, kind: "propose",
      threadKey: "trip", subject: "Plans", body: "Friday?",
    };
    const send = { mode: "send", actionId: "action", revision: 1, digest: "a".repeat(64) };
    for (const request of [{ mode: "list" }, proposal, send]) {
      expect(parameters.safeParse({ request }).success).toBe(true);
      expect(parameters.safeParse(request).success).toBe(false);
      expect(parameters.safeParse({ request, extra: true }).success).toBe(false);
      expect(parameters.safeParse({ request: { ...request, extra: true } }).success).toBe(false);
      for (const field of Object.keys(request)) {
        const incomplete: Record<string, unknown> = { ...request };
        delete incomplete[field];
        expect(parameters.safeParse({ request: incomplete }).success).toBe(false);
        expect(parameters.safeParse({ request: { ...request, [field]: null } }).success).toBe(false);
      }
    }
    for (const request of [
      { mode: "unknown" }, { ...proposal, revision: 1 }, { ...send, handle: trusted.handle },
      { ...send, revision: 0 }, { ...proposal, kind: "unknown" },
    ]) expect(parameters.safeParse({ request }).success).toBe(false);
  });

  test("minimal list is read-only and rejects every proposal or send field from the live regression", async () => {
    const store = createStore();
    const work = admitWork(store, "list-regression");
    const transport = fakePort();
    const tool = toolFor(store, [trusted], transport.port);
    const parameters = tool.parameters as { safeParse(input: unknown): { success: boolean } };
    expect(parameters.safeParse({ request: { mode: "list" } }).success).toBe(true);
    const listed = await call(tool, { mode: "list" });
    expect(listed.details).toMatchObject({ mode: "list", effectInvoked: false });
    const crossModeFields = {
      workId: work.id, handle: "list", kind: "info", threadKey: "OI-LIVE-20260922-A",
      subject: "Trusted peer list", body: "Read-only trusted-peer list check.",
      actionId: "OI-LIVE-20260922-A", revision: 1, digest: "0".repeat(64),
    };
    await expect(call(tool, { mode: "list", ...crossModeFields })).rejects.toThrow("workId is not accepted in list mode");
    for (const [field, value] of Object.entries(crossModeFields)) {
      expect(parameters.safeParse({ request: { mode: "list", [field]: value } }).success).toBe(false);
      await expect(call(tool, { mode: "list", [field]: value })).rejects.toThrow(`${field} is not accepted in list mode`);
    }
    expect(transport.sends).toHaveLength(0);
    expect(store.assistantWork.listActions(work.id)).toHaveLength(0);
  });
  test("lists only trusted peers and reports an empty allow-list plainly", async () => {
    const store = createStore();
    const listed = await call(toolFor(store, [trusted, revoked]), { mode: "list" });
    expect(listed.details).toMatchObject({ mode: "list", peers: [{ handle: trusted.handle, relation: "household" }] });
    expect(resultText(listed)).toContain("Alice");
    expect(resultText(listed)).not.toContain("Bob");

    const empty = await call(toolFor(store, []), { mode: "list" });
    expect(resultText(empty)).toContain("No trusted peers");
  });

  test("proposes an approval-gated external message and never one for an untrusted or revoked handle", async () => {
    const store = createStore();
    const tool = toolFor(store, [trusted, revoked]);
    const work = admitWork(store, "propose");
    await expect(call(tool, {
      mode: "propose", workId: work.id, handle: trusted.handle,
      threadKey: "trip", subject: "Weekend plans", body: "Can we leave Friday evening?",
    })).rejects.toThrow("kind is required");
    expect(store.assistantWork.listActions(work.id)).toHaveLength(0);
    const proposed = await call(tool, {
      mode: "propose", workId: work.id, handle: trusted.handle, kind: "propose",
      threadKey: "trip", subject: "Weekend plans", body: "Can we leave Friday evening?",
    });
    expect(proposed.details).toMatchObject({
      mode: "propose",
      action: { effectClass: "external_message", recipient: trusted.handle, topic: "trip", authorizationRequirement: "owner_rule_or_explicit" },
      effectInvoked: false,
    });
    // The relayed text must carry the exact approval identity, not a paraphrase.
    const action = store.assistantWork.getAction(String((proposed.details as { readonly action: { readonly id: string } }).action.id));
    expect(resultText(proposed)).toContain(`/approve ${action!.id} ${action!.revision} ${action!.digest}`);
    // The persisted payload is a decodable envelope bound to that handle.
    const payload = action!.payload as { readonly encoded: string; readonly handle: string };
    expect(decodePeerEnvelope(payload.encoded)).toMatchObject({ threadKey: "trip", subject: "Weekend plans" });
    expect(payload.handle).toBe(trusted.handle);

    const before = store.assistantWork.listActions(work.id).length;
    await expect(call(tool, {
      mode: "propose", workId: work.id, handle: "+821000000000", kind: "propose",
      threadKey: "trip", subject: "Hi", body: "Let me in.",
    })).rejects.toThrow(/not a trusted peer/);
    await expect(call(tool, {
      mode: "propose", workId: work.id, handle: revoked.handle, kind: "propose",
      threadKey: "trip", subject: "Hi", body: "Let me in.",
    })).rejects.toThrow(/not a trusted peer/);
    expect(store.assistantWork.listActions(work.id)).toHaveLength(before);
  });

  test("refuses to send without approval, then sends exactly once after approval", async () => {
    const store = createStore();
    const transport = fakePort();
    const tool = toolFor(store, [trusted], transport.port);
    const work = admitWork(store, "send");
    const proposed = await call(tool, {
      mode: "propose", workId: work.id, handle: trusted.handle, kind: "propose",
      threadKey: "dinner", subject: "Friday", body: "8pm works?",
    });
    const summary = (proposed.details as { readonly action: { readonly id: string; readonly revision: number; readonly digest: string } }).action;

    const refused = await call(tool, { mode: "send", actionId: summary.id, revision: summary.revision, digest: summary.digest });
    expect(refused.details).toMatchObject({ mode: "send", kind: "rejected", reason: "approval_required", effectInvoked: false });
    expect(transport.sends).toHaveLength(0);

    store.assistantWork.grantExplicitApproval({
      actionId: summary.id, revision: summary.revision, digest: summary.digest,
      provenance: { principal: "owner", channel: "test", subject: "owner", evidenceId: "approval:send" },
    }, T0);
    const sent = await call(tool, { mode: "send", actionId: summary.id, revision: summary.revision, digest: summary.digest });
    expect(sent.details).toMatchObject({ mode: "send", kind: "confirmed", effectInvoked: true });
    expect(transport.sends).toHaveLength(1);
    expect(transport.sends[0]!.startsWith(`${trusted.handle}:`)).toBe(true);
    expect(decodePeerEnvelope(transport.sends[0]!.slice(trusted.handle.length + 1))).toMatchObject({ threadKey: "dinner" });

    // A repeat send of the same identity must not put a second copy on the wire.
    await call(tool, { mode: "send", actionId: summary.id, revision: summary.revision, digest: summary.digest });
    expect(transport.sends).toHaveLength(1);
  });

  test("cannot send while the iMessage lane is detached, and rejects mode-crossing fields", async () => {
    const store = createStore();
    const detached = toolFor(store, [trusted]);
    await expect(call(detached, {
      mode: "send", actionId: "aw:action:x", revision: 1, digest: "a".repeat(64),
    })).rejects.toThrow(/iMessage lane is not attached/);

    const tool = toolFor(store, [trusted], fakePort().port);
    await expect(call(tool, { mode: "list", handle: trusted.handle })).rejects.toThrow(/not accepted in list mode/);
    await expect(call(tool, {
      mode: "propose", workId: "w", handle: trusted.handle, kind: "propose", threadKey: "t", subject: "s", body: "b", revision: 1,
    })).rejects.toThrow(/not accepted in propose mode/);
    await expect(call(tool, {
      mode: "send", actionId: "aw:action:x", revision: 1, digest: "a".repeat(64), handle: trusted.handle,
    })).rejects.toThrow(/not accepted in send mode/);
  });
});
