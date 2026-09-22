import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_IMESSAGE_CLI_TIMEOUT_MS } from "../runtime-config.ts";

import type { DeliveryPort, DeliveryReceipt } from "../delivery/port.ts";

export type ImessageSenderErrorCode = "cli_error" | "not_pasted" | "permission" | "timeout";

export class ImessageSenderError extends Error {
  public readonly ambiguous: boolean;

  public constructor(
    public readonly code: ImessageSenderErrorCode,
    message: string,
    options: { readonly ambiguous?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ImessageSenderError";
    this.ambiguous = options.ambiguous ?? code === "timeout";
  }
}

export interface ImessageCliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

/** Spawns argv and captures the result; tests inject a fake. */
export type ImessageCliRunner = (
  command: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
) => Promise<ImessageCliRunResult>;

export interface ImessageSenderOptions {
  readonly timeoutMs?: number;
  readonly runner?: ImessageCliRunner;
  /** Path to the oi-presence helper (typing/read via Accessibility); absent → presence is a no-op. */
  readonly presenceBinary?: string;
  readonly presence?: { readonly enabled: boolean; readonly idleSec: number };
}

const DEFAULT_PRESENCE_BINARY = join(homedir(), ".openinstinct", "bin", "oi-presence");

export const DEFAULT_IMESSAGE_TIMEOUT_MS = DEFAULT_IMESSAGE_CLI_TIMEOUT_MS;

/**
 * Outbound iMessage through Messages' own AppleScript bridge — the only
 * dependency is macOS. No Accessibility grant, no window, no third-party
 * binary (imessage-cli drove the compose field via AX and broke on current
 * Messages builds). The bridge does not expose threaded replies, typing
 * indicators, or read receipts: replies degrade to the caller's quote-prefix
 * fallback and presence is a no-op.
 *
 * Messages serialises sends internally; every method still enters one promise
 * queue so a slow send never overlaps the next.
 */
export class ImessageSender implements DeliveryPort {
  private readonly timeoutMs: number;
  private readonly runner: ImessageCliRunner;
  private readonly presenceBinary: string | undefined;
  private readonly presenceIdleSec: number;
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: ImessageSenderOptions = {}) {
    const presence = options.presenceBinary ?? DEFAULT_PRESENCE_BINARY;
    this.presenceBinary = options.presence?.enabled === false ? undefined : (existsSync(presence) ? presence : undefined);
    this.presenceIdleSec = options.presence?.idleSec ?? 3;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_IMESSAGE_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("imessage send timeout must be positive");
    }
    this.runner = options.runner ?? runOsascript;
  }

  public sendText(handle: string, text: string): Promise<DeliveryReceipt> {
    return this.enqueue(() => this.appleScriptSend(handle, { text }));
  }

  /** The guard runs inside the queued slot, immediately before the send. */
  public sendTextGuarded(handle: string, text: string, guard: () => boolean): Promise<DeliveryReceipt> {
    return this.enqueue(async () => {
      if (!guard()) {
        throw new ImessageSenderError("cli_error", `send guard refused delivery to ${handle}`);
      }
      return await this.appleScriptSend(handle, { text });
    });
  }

  public sendReply(messageGuid: string, _text: string): Promise<DeliveryReceipt> {
    return Promise.reject(new ImessageSenderError("cli_error", `threaded reply is not exposed by the Messages scripting bridge (${messageGuid})`));
  }

  public sendFile(handle: string, path: string): Promise<DeliveryReceipt> {
    return this.enqueue(async () => {
      if (!path.startsWith("/") || !existsSync(path)) {
        throw new ImessageSenderError("cli_error", `attachment does not exist: ${path}`);
      }
      // imagent refuses files without Spotlight metadata ("could not create
      // MDItem"); /tmp and ~/.openinstinct are not indexed, so stage a copy in
      // a user-visible, indexed folder and let mdimport see it first.
      const staged = join(homedir(), "Pictures", "OpenInstinct", `${Date.now()}-${basename(path)}`);
      mkdirSync(dirname(staged), { recursive: true });
      copyFileSync(path, staged);
      Bun.spawnSync(["/usr/bin/mdimport", staged]);
      return this.appleScriptSend(handle, { file: staged });
    });
  }

  /** Read receipt via the oi-presence helper (Accessibility); silent no-op without it. */
  public async markRead(handle: string): Promise<void> {
    await this.presence(["read", handle]);
  }

  /** Typing indicator via the oi-presence helper (Accessibility); silent no-op without it. */
  public async setTyping(handle: string, typing: boolean): Promise<void> {
    await this.presence(["typing", handle, typing ? "on" : "off"]);
  }

  /** Last presence outcome, surfaced by the daemon log so a silent failure is visible. */
  public onPresence?: (argv: readonly string[], result: ImessageCliRunResult | Error) => void;

  private async presence(argv: readonly string[]): Promise<void> {
    if (!this.presenceBinary) {
      this.onPresence?.(argv, new Error("oi-presence binary missing"));
      return;
    }
    // Presence drives the Messages UI; overlapping invocations fight over
    // focus. Serialise them behind the same queue as sends.
    try {
      const result = await this.enqueue(() => this.runner([this.presenceBinary!, ...argv], 10_000, { OI_PRESENCE_IDLE_SEC: String(this.presenceIdleSec) }));
      this.onPresence?.(argv, result);
    } catch (error) {
      this.onPresence?.(argv, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async appleScriptSend(handle: string, payload: { readonly text: string } | { readonly file: string }): Promise<DeliveryReceipt> {
    const isFile = "file" in payload;
    const script = [
      "on run argv",
      "  set h to item 1 of argv",
      isFile ? "  set p to POSIX file (item 2 of argv)" : "  set p to item 2 of argv",
      '  tell application "Messages"',
      "    set svc to 1st account whose service type = iMessage",
      "    set who to participant h of svc",
      "    send p to who",
      "  end tell",
      "end run",
    ].join("\n");
    let result: ImessageCliRunResult;
    try {
      result = await this.runner(["/usr/bin/osascript", "-e", script, handle, isFile ? payload.file : payload.text], this.timeoutMs);
    } catch (error) {
      if (error instanceof ImessageSenderError) {
        throw error;
      }
      throw new ImessageSenderError("cli_error", messageOf(error));
    }
    if (result.timedOut) {
      throw new ImessageSenderError("timeout", `osascript send timed out after ${this.timeoutMs} ms`, { ambiguous: true });
    }
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      // -1743: not authorised to send Apple events to Messages (Automation TCC).
      const code = /not allowed|-1743|assistive|not authori[sz]ed/i.test(detail) ? "permission" : "cli_error";
      throw new ImessageSenderError(code, detail || "osascript send failed");
    }
    return { messageId: `applescript:${randomUUID()}` };
  }
}

async function runOsascript(command: readonly string[], timeoutMs: number, env?: Record<string, string>): Promise<ImessageCliRunResult> {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : process.env });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
