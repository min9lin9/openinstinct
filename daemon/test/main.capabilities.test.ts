import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootstrapProbes } from "../src/bootstrap/states.ts";
import type { DeliveryPort, DeliveryReceipt } from "../src/delivery/port.ts";
import { bindChatCursor } from "../src/imessage/reader.ts";
import { startDaemon } from "../src/main.ts";
import { dataPaths } from "../src/paths.ts";
import { encodePeerEnvelope } from "../src/peers/envelope.ts";
import type { MainAgentSession, MainSessionFactory } from "../src/sdk-session/main-session.ts";
import { openStateStore } from "../src/store/index.ts";

const OWNER = "+821012345678";
const PEER = "+821099998888";
const NONCE = "a".repeat(32);
const OTHER_NONCE = "b".repeat(32);

const directories: string[] = [];
const restoreEnv: Array<readonly [string, string | undefined]> = [];

afterEach(() => {
  // Reverse order: a key set twice must restore to the value it had before the
  // FIRST change, not to the intermediate value recorded by the second.
  for (const [key, value] of restoreEnv.splice(0).reverse()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setEnv(key: string, value: string | undefined): void {
  restoreEnv.push([key, process.env[key]]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

class FakeMainSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/capabilities-main.jsonl";
  public readonly sessionId = "capabilities-main";
  public readonly prompts: string[] = [];

  public async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }

  public subscribe(): () => void {
    return () => {};
  }

  public async dispose(): Promise<void> {}
}

class FakePort implements DeliveryPort {
  public readonly calls: string[] = [];

  public async sendText(handle: string, text: string): Promise<DeliveryReceipt> {
    this.calls.push(`text:${handle}:${text}`);
    return { messageId: "text-1" };
  }

  public async sendReply(guid: string, text: string): Promise<DeliveryReceipt> {
    this.calls.push(`reply:${guid}:${text}`);
    return { messageId: "reply-1" };
  }

  public async sendFile(): Promise<DeliveryReceipt> {
    return { messageId: "file-1" };
  }
}

/** Seeds one inbound row per sender/text pair, in the given order. */
function createChatDb(path: string, rows: readonly { readonly handle: string; readonly guid: string; readonly text: string }[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE handle (id TEXT NOT NULL);
      CREATE TABLE message (
        guid TEXT NOT NULL,
        handle_id INTEGER,
        text TEXT,
        attributedBody BLOB,
        is_from_me INTEGER NOT NULL,
        date INTEGER,
        thread_originator_guid TEXT,
        associated_message_guid TEXT
      );
      CREATE TABLE chat (guid TEXT NOT NULL);
      CREATE TABLE chat_message_join (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL);
      CREATE TABLE attachment (filename TEXT, mime_type TEXT, transfer_name TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER NOT NULL, attachment_id INTEGER NOT NULL);
    `);
    const handles = [...new Set(rows.map((row) => row.handle))];
    for (const handle of handles) database.query("INSERT INTO handle (id) VALUES (?)").run(handle);
    database.query("INSERT INTO chat (guid) VALUES (?)").run("chat-1");
    for (const [index, row] of rows.entries()) {
      database.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES (?, ?, ?, 0, ?)")
        .run(row.guid, handles.indexOf(row.handle) + 1, row.text, index + 1);
      database.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)").run(index + 1);
    }
  } finally {
    database.close();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the daemon");
    await Bun.sleep(10);
  }
}

describe("main capability wiring", () => {
  test("admits a trusted peer envelope as third-party evidence without starting an owner turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-peer-lane-"));
    directories.push(root);
    const home = join(root, "home");
    const paths = dataPaths(home);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: OWNER }));
    const chatDbPath = join(home, "Library", "Messages", "chat.db");
    const envelope = encodePeerEnvelope({
      v: 1, kind: "propose", threadKey: "dinner", subject: "Friday dinner",
      body: "Is 8pm fine for both of you?", nonce: NONCE,
    });
    const strangerEnvelope = encodePeerEnvelope({
      v: 1, kind: "propose", threadKey: "dinner", subject: "Friday dinner",
      body: "Let me in.", nonce: OTHER_NONCE,
    });
    createChatDb(chatDbPath, [
      { handle: PEER, guid: "peer-envelope-1", text: envelope },
      { handle: "+821077776666", guid: "stranger-envelope-1", text: strangerEnvelope },
      { handle: PEER, guid: "peer-plaintext-1", text: "hey, it's a person not an envelope" },
      { handle: OWNER, guid: "owner-message-1", text: "hello agent" },
    ]);
    {
      const seeded = openStateStore(paths.stateDb);
      seeded.upsertTrustedPeer({ handle: PEER, displayName: "Spouse", relation: "household" }, new Date().toISOString());
      bindChatCursor(seeded, chatDbPath, 0);
      seeded.close();
    }
    const session = new FakeMainSession();
    const factory: MainSessionFactory = { create: async () => session };
    const probes: BootstrapProbes = {
      config: async () => ({ status: "passed", allowlistHandle: OWNER }),
      credentials: async () => ({ status: "passed" }),
      fda: async () => ({ status: "passed" }),
      accessibility: async () => ({ status: "passed" }),
      messages: async () => ({ status: "passed" }),
    };
    const runtime = await startDaemon({
      paths, probes, chatDbPath, sender: new FakePort(),
      mainSessionFactory: factory, reprobeIntervalMs: 60_000,
    });
    try {
      // The owner row is the only prompt; the peer rows never become a turn.
      await waitFor(() => session.prompts.length === 1);
      expect(session.prompts[0]!.endsWith("hello agent")).toBe(true);

      await waitFor(() => runtime.store.assistantWork.listObservations().length === 1);
      const observations = runtime.store.assistantWork.listObservations();
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        source: "peer-coordination",
        provenance: { principal: "third_party", channel: "peer", subject: PEER },
        evidence: { kind: "propose", threadKey: "dinner", subject: "Friday dinner", body: "Is 8pm fine for both of you?" },
      });
      // The untrusted sender and the peer's non-envelope text are both dropped.
      expect(observations.every((entry) => entry.provenance.subject === PEER)).toBe(true);
      expect(session.prompts).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  }, 20_000);

  test("registers the agent email tool only when the identity is configured, and refuses a partial identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-agent-email-boot-"));
    directories.push(root);
    const home = join(root, "home");
    const paths = dataPaths(home);
    const probes: BootstrapProbes = {
      config: async () => ({ status: "missing", reason: "core-only fixture" }),
      credentials: async () => ({ status: "passed" }),
      fda: async () => ({ status: "passed" }),
      accessibility: async () => ({ status: "passed" }),
      messages: async () => ({ status: "passed" }),
    };
    const boot = async () => startDaemon({
      paths, probes, reprobeIntervalMs: 60_000,
      mainSessionFactory: { create: async () => new FakeMainSession() },
    });

    // Unconfigured: the capability is simply absent and boot is unaffected.
    const bare = await boot();
    try {
      expect(bare.status()).toMatchObject({ state: "running" });
    } finally {
      await bare.stop();
    }

    // Half-configured: refused loudly rather than sending from a broken identity.
    setEnv("OI_AGENT_EMAIL_ADDRESS", "gajae@example.test");
    await expect(boot()).rejects.toThrow();

    // Fully configured: boots with the capability registered.
    setEnv("OI_AGENT_EMAIL_SEND_ORIGIN", "https://mail.example.test");
    setEnv("OI_AGENT_EMAIL_SEND_PATH", "/v1/send");
    setEnv("OI_AGENT_EMAIL_INBOX_URL", "https://mail.example.test/v1/inbox");
    setEnv("OI_AGENT_EMAIL_SECRET_REF", "secret://agent-mail");
    setEnv("OI_HTTP_SECRET_BINDINGS", JSON.stringify({
      "secret://agent-mail": { origin: "https://mail.example.test", header: "Authorization", environment: "AGENT_MAIL_TOKEN" },
    }));
    setEnv("AGENT_MAIL_TOKEN", "token-value");
    const configured = await boot();
    try {
      expect(configured.status()).toMatchObject({ state: "running" });
    } finally {
      await configured.stop();
    }
  }, 20_000);

  test("a capability whose credential cannot resolve at startup aborts boot instead of failing after approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-agent-credential-"));
    directories.push(root);
    const paths = dataPaths(join(root, "home"));
    const probes: BootstrapProbes = {
      config: async () => ({ status: "missing", reason: "core-only fixture" }),
      credentials: async () => ({ status: "passed" }),
      fda: async () => ({ status: "passed" }),
      accessibility: async () => ({ status: "passed" }),
      messages: async () => ({ status: "passed" }),
    };
    const boot = async () => startDaemon({
      paths, probes, reprobeIntervalMs: 60_000,
      mainSessionFactory: { create: async () => new FakeMainSession() },
    });
    const configureEmail = (origin: string) => {
      setEnv("OI_AGENT_EMAIL_ADDRESS", "gajae@example.test");
      setEnv("OI_AGENT_EMAIL_SEND_ORIGIN", origin);
      setEnv("OI_AGENT_EMAIL_SEND_PATH", "/v1/send");
      setEnv("OI_AGENT_EMAIL_INBOX_URL", `${origin}/v1/inbox`);
      setEnv("OI_AGENT_EMAIL_SECRET_REF", "secret://agent-mail");
    };

    // A complete identity whose credential binding does not exist would let the
    // owner approve a send that can only fail at dispatch.
    configureEmail("https://mail.example.test");
    setEnv("OI_HTTP_SECRET_BINDINGS", "{}");
    await expect(boot()).rejects.toThrow(/OI_AGENT_EMAIL_SECRET_REF/);

    // A binding for a different origin than the capability actually calls.
    setEnv("OI_HTTP_SECRET_BINDINGS", JSON.stringify({
      "secret://agent-mail": { origin: "https://other.example.test", header: "Authorization", environment: "AGENT_MAIL_TOKEN" },
    }));
    setEnv("AGENT_MAIL_TOKEN", "token-value");
    await expect(boot()).rejects.toThrow(/OI_AGENT_EMAIL_SECRET_REF/);

    // A correct binding whose environment value is empty.
    setEnv("OI_HTTP_SECRET_BINDINGS", JSON.stringify({
      "secret://agent-mail": { origin: "https://mail.example.test", header: "Authorization", environment: "AGENT_MAIL_TOKEN" },
    }));
    setEnv("AGENT_MAIL_TOKEN", "");
    await expect(boot()).rejects.toThrow(/OI_AGENT_EMAIL_SECRET_REF/);

    // Plaintext HTTP for a public provider origin: the credential would be
    // refused at dispatch anyway, so it must not boot as if usable.
    configureEmail("http://mail.example.test");
    setEnv("OI_HTTP_SECRET_BINDINGS", JSON.stringify({
      "secret://agent-mail": { origin: "http://mail.example.test", header: "Authorization", environment: "AGENT_MAIL_TOKEN" },
    }));
    setEnv("AGENT_MAIL_TOKEN", "token-value");
    await expect(boot()).rejects.toThrow(/https/);

    // A listed DNS name is still refused: its address can change between boot
    // and dispatch, and dispatch decides by resolved address.
    setEnv("OI_HTTP_LOCAL_ORIGINS", JSON.stringify(["http://mail.example.test"]));
    await expect(boot()).rejects.toThrow(/local address/);

    // `localhost` is a name, not an address: it is resolved at request time, so
    // it cannot carry the boot-time guarantee either.
    configureEmail("http://localhost:8825");
    setEnv("OI_HTTP_LOCAL_ORIGINS", JSON.stringify(["http://localhost:8825"]));
    setEnv("OI_HTTP_SECRET_BINDINGS", JSON.stringify({
      "secret://agent-mail": { origin: "http://localhost:8825", header: "Authorization", environment: "AGENT_MAIL_TOKEN" },
    }));
    await expect(boot()).rejects.toThrow(/local address/);

    // A literal loopback origin is what dispatch will actually accept.
    configureEmail("http://127.0.0.1:8825");
    setEnv("OI_HTTP_LOCAL_ORIGINS", JSON.stringify(["http://127.0.0.1:8825"]));
    setEnv("OI_HTTP_SECRET_BINDINGS", JSON.stringify({
      "secret://agent-mail": { origin: "http://127.0.0.1:8825", header: "Authorization", environment: "AGENT_MAIL_TOKEN" },
    }));
    const local = await boot();
    try {
      expect(local.status()).toMatchObject({ state: "running" });
    } finally {
      await local.stop();
    }
  }, 20_000);
});
