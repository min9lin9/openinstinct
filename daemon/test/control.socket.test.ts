import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootstrapSnapshot } from "../src/bootstrap/states.ts";
import { startControlServer, type ControlServer, type ControlStatusContext } from "../src/control/socket.ts";
import { openStateStore, type StateStore } from "../src/store/index.ts";
import { MonitorStore } from "../src/monitors/store.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function readFrames(socket: Socket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const frames: unknown[] = [];
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        frames.push(JSON.parse(line));
        if (frames.length === count) {
          socket.off("data", onData);
          socket.off("error", onError);
          resolve(frames);
          return;
        }
      }
    };
    const onError = (error: Error): void => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

describe("control socket", () => {
  test("negotiates then returns bootstrap status over a real 0600 socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-control-"));
    directories.push(directory);
    const path = join(directory, "run", "control.sock");
    const store = openStateStore(join(directory, "state.db"));
    let control: ControlServer | undefined;
    let socket: Socket | undefined;

    try {
      control = await startControlServer({
        path,
        store,
        getStatus: () => ({
          state: "credentials_blocked",
          probes: {
            config: { status: "passed" },
            credentials: { status: "missing", reason: "No AI account yet." },
          },
          reason: "No AI account yet.",
        }),
        getStatusContext: () => ({
          sessionState: "inactive",
          mainSessionFilePresent: false,
          allowlistHandle: "+821012345678",
          imessage: { state: "detached", reason: "core_lane_down", handle: "+821012345678" },
          credentialsReady: false,
        }),
      });

      expect(statSync(path).mode & 0o777).toBe(0o600);

      socket = createConnection({ path });
      await once(socket, "connect");
      const response = readFrames(socket, 2);
      socket.write(`${JSON.stringify({ type: "hello", v: 1, client: "control-test" })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "status-1", verb: "status.get", payload: {} })}\n`);

      const [negotiated, status] = await response;
      expect(negotiated).toEqual(expect.objectContaining({ type: "negotiated", v: 1 }));
      expect(status).toEqual({
        type: "response",
        id: "status-1",
        ok: true,
        payload: {
          bootstrap: {
            state: "credentials_blocked",
            remediation: "Sign in to an AI account or paste an API key in Settings → AI account.",
            probes: {
              config: { status: "passed" },
              credentials: { status: "missing", reason: "No AI account yet." },
            },
          },
          session: { state: "inactive", mainSessionFilePresent: false, paused: false, hasReplied: false },
          activeChildren: [],
          recentChildren: [],
          monitors: [],
          settings: { allowlistHandle: "+821012345678" },
          imessage: {
            state: "detached",
            reason: "core_lane_down",
            detail: "Gajae's session is not running yet.",
            handle: "+821012345678",
          },
          attention: null,
        },
      });

    } finally {
      socket?.destroy();
      if (control) {
        await control.close();
      }
      store.close();
    }
  });

  test("lists monitors and applies revision-fenced toggles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-control-monitor-"));
    directories.push(directory);
    const path = join(directory, "run", "control.sock");
    const store = openStateStore(join(directory, "state.db"));
    const monitors = new MonitorStore(store, { hostTimeZone: "Asia/Seoul" });
    monitors.create({
      id: "daily-briefing",
      name: "Daily briefing",
      trigger: { kind: "cron", expression: "30 8 * * 1-5" },
      instruction: "Summarize priorities.",
    });
    let control: ControlServer | undefined;
    let socket: Socket | undefined;

    let changes = 0;
    try {
      control = await startControlServer({
        path,
        store,
        onMonitorsChanged: () => { changes += 1; },
        getStatus: () => ({ state: "running", probes: { config: { status: "passed" } } }),
      });
      socket = createConnection({ path });
      await once(socket, "connect");
      const response = readFrames(socket, 3);
      socket.write(`${JSON.stringify({ type: "hello", v: 1, client: "control-test" })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "list", verb: "monitors.list", payload: {} })}\n`);
      socket.write(`${JSON.stringify({
        type: "request",
        id: "toggle",
        verb: "monitors.toggle",
        payload: { id: "daily-briefing", enabled: false, expectedRevision: 1 },
      })}\n`);
      const [, list, toggle] = await response;
      expect(list).toEqual(expect.objectContaining({
        type: "response",
        id: "list",
        payload: expect.objectContaining({ monitors: [expect.objectContaining({ id: "daily-briefing", enabled: true, revision: 1 })] }),
      }));
      expect(toggle).toEqual(expect.objectContaining({
        type: "response",
        id: "toggle",
        payload: expect.objectContaining({ monitor: expect.objectContaining({ enabled: false, revision: 2 }) }),
      }));
      expect(changes).toBe(1);
    } finally {
      socket?.destroy();
      if (control) {
        await control.close();
      }
      store.close();
    }
  });


  test("projects status context, active child kinds, monitor summaries, and persisted pause state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-control-status-"));
    directories.push(directory);
    const path = join(directory, "run", "control.sock");
    const store = openStateStore(join(directory, "state.db"));
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const task = store.createChild({
      id: "task-child",
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "Draft reply",
      prompt: "Draft a reply.",
      timeoutMs: 60_000,
    }, "2026-01-01T00:00:00.000Z");
    store.markChildRunning(task.id, "2026-01-01T00:01:00.000Z");
    store.markChildIdle(task.id, { lastAssistantText: "Drafted reply.", turnSeq: 1 }, "2026-01-01T00:01:01.000Z");
    const daemon = store.createChild({
      id: "daemon-child",
      kind: "daemon",
      priority: "monitor",
      origin: "monitor",
      title: "Monitor: Daily briefing",
      prompt: "Summarize priorities.",
      timeoutMs: 60_000,
    }, "2026-01-01T00:00:00.000Z");
    store.markChildRunning(daemon.id, "2026-01-01T00:01:00.000Z");
    monitors.create({
      id: "daily-briefing",
      name: "Daily briefing",
      trigger: { kind: "cron", expression: "30 8 * * 1-5" },
      instruction: "Summarize priorities.",
    });
    let control: ControlServer | undefined;
    let socket: Socket | undefined;

    try {
      control = await startControlServer({
        path,
        store,
        now: () => new Date("2026-01-05T00:00:00.000Z"),
        getStatus: () => ({
          state: "running",
          probes: {
            config: { status: "passed" },
            messages: { status: "passed", aliases: ["gajae@example.com"] },
            credentials: { status: "passed" },
          },
        }),
        getStatusContext: () => ({
          sessionState: "active",
          mainSessionId: "main-session-001",
          mainSessionFilePresent: true,
          allowlistHandle: "+821012345678",
          imessage: { state: "attached", handle: "+821012345678" },
          credentialsReady: true,
        }),
      });
      socket = createConnection({ path });
      await once(socket, "connect");
      const response = readFrames(socket, 5);
      socket.write(`${JSON.stringify({ type: "hello", v: 1, client: "control-test" })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "status", verb: "status.get", payload: {} })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "pause", verb: "daemon.pause", payload: {} })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "paused-status", verb: "status.get", payload: {} })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "resume", verb: "daemon.resume", payload: {} })}\n`);
      const [, status, paused, pausedStatus, resumed] = await response;
      expect(status).toEqual(expect.objectContaining({
        type: "response",
        id: "status",
        payload: {
          bootstrap: {
            state: "running",
            remediation: "Daemon is ready.",
            probes: {
              config: { status: "passed" },
              messages: { status: "passed", aliases: ["gajae@example.com"] },
              credentials: { status: "passed" },
            },
          },
          session: {
            state: "active",
            mainSessionId: "main-session-001",
            mainSessionFilePresent: true,
            paused: false,
            hasReplied: false,
          },
          activeChildren: [
            expect.objectContaining({ id: "task-child", title: "Draft reply", kind: "task_tool", origin: "owner", state: "idle", lastActivityAt: "2026-01-01T00:01:01.000Z", toolCalls: 0 }),
            expect.objectContaining({ id: "daemon-child", title: "Monitor: Daily briefing", kind: "daemon", origin: "monitor", state: "running", toolCalls: 0 }),
          ],
          recentChildren: [],
          monitors: [{
            id: "daily-briefing",
            name: "Daily briefing",
            enabled: true,
            revision: 1,
            nextFire: "2026-01-05T08:30:00.000Z",
          }],
          settings: { allowlistHandle: "+821012345678" },
          imessage: { state: "attached", handle: "+821012345678" },
          attention: null,
        },
      }));
      expect(paused).toEqual({ type: "response", id: "pause", ok: true, payload: { paused: true } });
      expect(pausedStatus).toEqual(expect.objectContaining({
        id: "paused-status",
        payload: expect.objectContaining({ session: expect.objectContaining({ paused: true }) }),
      }));
      expect(resumed).toEqual({ type: "response", id: "resume", ok: true, payload: { paused: false } });
      expect(store.getMeta("daemon.paused")).toBe("false");
    } finally {
      socket?.destroy();
      if (control) {
        await control.close();
      }
      store.close();
    }
  });
  test("discovers credentials and maps an unknown adoption id to invalid_frame", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-control-accounts-"));
    directories.push(directory);
    const path = join(directory, "run", "control.sock");
    const store = openStateStore(join(directory, "state.db"));
    let control: ControlServer | undefined;
    let socket: Socket | undefined;

    try {
      control = await startControlServer({
        path,
        store,
        getStatus: () => ({ state: "running", probes: { config: { status: "passed" } } }),
        settings: {
          get: async () => ({}),
          set: async () => ({}),
          models: async () => ({}),
          accounts: async () => ({}),
          login: async () => ({}),
          logout: async () => ({}),
          finishLogin: async () => ({}),
          providers: async () => ({}),
          customProvider: async () => ({}),
          discoverCredentials: async () => ({
            credentials: [{
              id: "anthropic:claude-code-keychain",
              provider: "anthropic",
              label: "Claude (Anthropic)",
              source: "Claude Code (macOS Keychain)",
              kind: "oauth",
              redactedToken: "sk-ant-…1234",
              identity: "owner@example.com",
              expiresAt: "2026-01-01T00:00:00.000Z",
              adoptable: false,
              reason: "This login has expired. Sign in to Claude Code again, or sign in here separately.",
            }],
          }),
          adoptCredential: async () => {
            throw new Error("no such credential: anthropic:missing");
          },
          restart: async () => ({}),
          openBrowser: async () => ({}),
        },
      });
      socket = createConnection({ path });
      await once(socket, "connect");
      const response = readFrames(socket, 3);
      socket.write(`${JSON.stringify({ type: "hello", v: 1, client: "control-accounts-test" })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "discover", verb: "accounts.discover", payload: {} })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "adopt", verb: "accounts.adopt", payload: { id: "anthropic:missing" } })}\n`);

      const [, discovered, adopted] = await response;
      expect(discovered).toEqual({
        type: "response",
        id: "discover",
        ok: true,
        payload: {
          credentials: [{
            id: "anthropic:claude-code-keychain",
            provider: "anthropic",
            label: "Claude (Anthropic)",
            source: "Claude Code (macOS Keychain)",
            kind: "oauth",
            redactedToken: "sk-ant-…1234",
            identity: "owner@example.com",
            expiresAt: "2026-01-01T00:00:00.000Z",
            adoptable: false,
            reason: "This login has expired. Sign in to Claude Code again, or sign in here separately.",
          }],
        },
      });
      expect(adopted).toEqual({
        type: "error",
        id: "adopt",
        ok: false,
        code: "invalid_frame",
        message: "no such credential: anthropic:missing",
      });
    } finally {
      socket?.destroy();
      if (control) {
        await control.close();
      }
      store.close();
    }
  });

  test("administers trusted peers through the real control server", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-control-peers-"));
    directories.push(directory);
    const path = join(directory, "run", "control.sock");
    const store = openStateStore(join(directory, "state.db"));
    let control: ControlServer | undefined;
    let socket: Socket | undefined;

    try {
      control = await startControlServer({
        path,
        store,
        getStatus: () => ({
          state: "running",
          probes: { config: { status: "passed" }, credentials: { status: "passed" } },
        }),
      });
      socket = createConnection({ path });
      await once(socket, "connect");
      // The allow-list is administered only here, so the production socket
      // branches must actually work: a clean install cannot enroll otherwise.
      const response = readFrames(socket, 5);
      socket.write(`${JSON.stringify({ type: "hello", v: 1, client: "control-test" })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "list-0", verb: "peers.list", payload: {} })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "add-1", verb: "peers.upsert", payload: { handle: "+821099998888", displayName: "Alex", relation: "household" } })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "list-1", verb: "peers.list", payload: {} })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "revoke-1", verb: "peers.revoke", payload: { handle: "+821099998888" } })}\n`);

      const [, empty, added, listed, revoked] = await response;
      expect(empty).toMatchObject({ id: "list-0", ok: true, payload: { peers: [] } });
      expect(added).toMatchObject({
        id: "add-1",
        ok: true,
        payload: { peer: { handle: "+821099998888", displayName: "Alex", relation: "household", state: "trusted" } },
      });
      expect(listed).toMatchObject({ id: "list-1", ok: true });
      expect((listed as { payload: { peers: unknown[] } }).payload.peers).toHaveLength(1);
      expect(revoked).toMatchObject({ id: "revoke-1", ok: true, payload: { peer: { state: "revoked" } } });

      // The durable effect of those ops is what the peer lane reads.
      expect(store.listTrustedPeers("trusted")).toHaveLength(0);
      expect(store.listTrustedPeers()).toHaveLength(1);
    } finally {
      socket?.destroy();
      await control?.close();
      store.close();
    }
  });
});
