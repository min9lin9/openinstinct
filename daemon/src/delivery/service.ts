import { randomUUID } from "node:crypto";

import { DEFAULT_DELIVERY_BACKOFF_MS, DEFAULT_DELIVERY_MAX_ATTEMPTS } from "../runtime-config.ts";

import type { NdjsonLogger } from "../log.ts";
import type { DeliveryInput, DeliveryRecord, StateStore } from "../store/index.ts";
import { toPlainText } from "./plaintext.ts";
import type { DeliveryPort, DeliveryReceipt } from "./port.ts";

export const DEFAULT_MAX_ATTEMPTS = DEFAULT_DELIVERY_MAX_ATTEMPTS;
export const DEFAULT_RETRY_BACKOFF_MS = DEFAULT_DELIVERY_BACKOFF_MS;
const STALE_INFLIGHT_MS = 5 * 60_000;

export interface OutboundDelivery {
  readonly idempotencyKey: string;
  readonly handle: string;
  readonly text?: string;
  readonly filePath?: string;
  /** Owner-visible caption used when an image send degrades to a text message. */
  readonly caption?: string;
  readonly replyToGuid?: string;
  readonly quotedText?: string;
  readonly childId?: string;
  /** Internal attribution: only MainSession may set this for background owner replies. */
  readonly authoredBy?: "main_session";
}

export interface DeliveryServiceOptions {
  readonly store: StateStore;
  readonly port: DeliveryPort;
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
  readonly logger?: NdjsonLogger;
  readonly maxAttempts?: number;
  readonly retryBackoffMs?: readonly number[];
}

interface AttemptFailure {
  readonly code: string;
  readonly message: string;
  readonly ambiguous: boolean;
}

/**
 * Owns durable outbound admission and settlement. The platform adapter only
 * receives a delivery after a pending row has been atomically claimed.
 */
const DUPLICATE_TEXT_WINDOW_MS = 10 * 60_000;

export class DeliveryService {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: readonly number[];
  private running = false;
  private flushing: Promise<void> | undefined;
  private readonly recentTexts = new Map<string, { readonly id: string; readonly at: number }>();

  public constructor(private readonly options: DeliveryServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts");
    this.retryBackoffMs = positiveBackoffLadder(options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("delivery poll interval must be positive");
    }
  }

  public admit(outbound: OutboundDelivery): DeliveryRecord {
    const sanitized: OutboundDelivery = {
      ...outbound,
      ...(outbound.text === undefined ? {} : { text: toPlainText(outbound.text) }),
      ...(outbound.caption === undefined ? {} : { caption: toPlainText(outbound.caption) }),
    };
    const input = toDeliveryInput(sanitized);
    // The same owner text arriving again within a short window (a monitor
    // firing that re-reports what a chat turn already said, or a steered turn
    // repeating its last segment) is noise, not news. Return the earlier row.
    if (sanitized.text !== undefined && sanitized.filePath === undefined && !sanitized.idempotencyKey.startsWith("inbound-turn:")) {
      const key = `${sanitized.handle}\u0000${sanitized.text.trim()}`;
      const nowMs = this.now().getTime();
      const seen = this.recentTexts.get(key);
      if (seen && nowMs - seen.at < DUPLICATE_TEXT_WINDOW_MS) {
        const existing = this.options.store.getDelivery(seen.id);
        if (existing) {
          this.options.logger?.write("info", "delivery", "duplicate_text_suppressed", { deliveryId: existing.id, idempotencyKey: sanitized.idempotencyKey });
          return existing;
        }
      }
      for (const [k, v] of this.recentTexts) { if (nowMs - v.at >= DUPLICATE_TEXT_WINDOW_MS) this.recentTexts.delete(k); }
      const record = this.options.store.admitDelivery(input, this.now().toISOString());
      this.recentTexts.set(key, { id: record.id, at: nowMs });
      this.log("admitted", record);
      if (this.running) {
        void this.flush().catch((error) => this.logError("flush_failed", error));
      }
      return record;
    }
    const record = this.options.store.admitDelivery(input, this.now().toISOString());
    this.log("admitted", record);
    if (this.running) {
      void this.flush().catch((error) => this.logError("flush_failed", error));
    }
    return record;
  }

  /**
   * The attached platform adapter. Effects with their own durable ledger (peer
   * coordination) settle their own attempt and send through this directly; owner
   * text keeps going through the delivery outbox.
   */
  public get port(): DeliveryPort {
    return this.options.port;
  }

  public async markRead(handle: string): Promise<void> {
    await this.options.port.markRead?.(handle);
  }

  /** Presence pass-through; the port may not support it. */
  public async setTyping(handle: string, typing: boolean): Promise<void> {
    await this.options.port.setTyping?.(handle, typing);
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const redelivered = this.reconcile();
    if (redelivered > 0) {
      this.options.logger?.write("warn", "delivery", "inflight_requeued", { count: redelivered });
    }
    this.timer = setInterval(() => {
      void this.flush().catch((error) => this.logError("flush_failed", error));
    }, this.pollIntervalMs);
    void this.flush().catch((error) => this.logError("flush_failed", error));
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flushing;
  }

  public reconcile(): number {
    const now = this.now();
    return this.options.store.requeueStaleInflightDeliveries(
      new Date(now.getTime() - STALE_INFLIGHT_MS).toISOString(),
      now.toISOString(),
    );
  }

  public async flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing;
    }

    const run = this.flushDue();
    this.flushing = run;
    try {
      await run;
    } finally {
      if (this.flushing === run) {
        this.flushing = undefined;
      }
    }
  }

  private async flushDue(): Promise<void> {
    const due = this.options.store.listDueDeliveries(this.now().toISOString());
    for (const pending of due) {
      const claimed = this.options.store.claimDelivery(pending.id, this.now().toISOString());
      if (!claimed) {
        continue;
      }
      this.log("inflight", claimed);
      await this.settleClaimed(claimed);
    }
  }

  private async settleClaimed(delivery: DeliveryRecord): Promise<void> {
    try {
      const receipt = await this.send(delivery);
      const now = this.now().toISOString();
      this.options.store.confirmDelivery(delivery.id, receipt, now);
      const confirmed = this.options.store.getDelivery(delivery.id);
      if (confirmed) {
        this.log("confirmed", confirmed);
      }
    } catch (error) {
      this.settleFailure(delivery, toAttemptFailure(error));
    }
  }

  private async send(delivery: DeliveryRecord): Promise<DeliveryReceipt> {
    if (delivery.kind === "file") {
      if (!delivery.filePath) {
        throw new Error("file delivery has no file path");
      }
      try {
        return await this.options.port.sendFile(delivery.handle, delivery.filePath);
      } catch (error) {
        // Attachment paste is the documented weak link (Accessibility TCC). Degrade
        // to a captioned text so the owner still learns what was produced, and mark
        // the row degraded so the ledger never reports this as a clean image send.
        if (delivery.body === undefined) {
          throw error;
        }
        this.options.store.markDeliveryDegraded(delivery.id, this.now().toISOString());
        return this.options.port.sendText(delivery.handle, delivery.body);
      }
    }

    if (delivery.body === undefined) {
      throw new Error("text delivery has no body");
    }
    if (!delivery.replyToGuid) {
      return this.options.port.sendText(delivery.handle, delivery.body);
    }

    // The Messages scripting bridge has no reply-to: every reply is a plain
    // flat text. No quote prefix — a chat reads fine without it.
    return this.options.port.sendText(delivery.handle, delivery.body);
  }

  private settleFailure(delivery: DeliveryRecord, failure: AttemptFailure): void {
    const now = this.now();
    if (failure.ambiguous) {
      this.options.store.failDeliveryAmbiguous(delivery.id, failure, now.toISOString());
      const failed = this.options.store.getDelivery(delivery.id);
      if (failed) {
        this.log("failed_ambiguous", failed, failure);
      }
      return;
    }

    if (delivery.attempts >= this.maxAttempts) {
      this.options.store.expireDelivery(delivery.id, failure, now.toISOString());
      const expired = this.options.store.getDelivery(delivery.id);
      if (expired) {
        this.log("expired", expired, failure);
      }
      return;
    }

    const delay = this.retryBackoffMs[delivery.attempts - 1] ?? this.retryBackoffMs.at(-1)!;
    const nextAttemptAt = new Date(now.getTime() + delay).toISOString();
    this.options.store.retryDelivery(delivery.id, nextAttemptAt, failure, now.toISOString());
    const pending = this.options.store.getDelivery(delivery.id);
    if (pending) {
      this.log("retry_scheduled", pending, failure);
    }
  }

  private log(event: string, delivery: DeliveryRecord, failure?: AttemptFailure): void {
    this.options.logger?.write("info", "delivery", event, {
      deliveryId: delivery.id,
      state: delivery.state,
      attempts: delivery.attempts,
      degraded: delivery.degraded,
      redelivered: delivery.redelivered,
      ...(failure === undefined ? {} : { errorCode: failure.code }),
    });
  }

  private logError(event: string, error: unknown): void {
    this.options.logger?.write("error", "delivery", event, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function positiveBackoffLadder(value: readonly number[]): readonly number[] {
  if (value.length === 0) {
    throw new Error("retryBackoffMs must not be empty");
  }
  return value.map((delay, index) => positiveInteger(delay, `retryBackoffMs[${index}]`));
}


function toDeliveryInput(outbound: OutboundDelivery): DeliveryInput {
  if (outbound.idempotencyKey.trim().length === 0) {
    throw new Error("delivery idempotency key is required");
  }
  if (outbound.handle.trim().length === 0) {
    throw new Error("delivery handle is required");
  }

  const hasText = outbound.text !== undefined;
  const hasFile = outbound.filePath !== undefined;
  if (hasText === hasFile) {
    throw new Error("delivery must contain exactly one of text or filePath");
  }
  if (outbound.replyToGuid !== undefined && !hasText) {
    throw new Error("file deliveries cannot target a text reply thread");
  }

  return {
    id: randomUUID(),
    idempotencyKey: outbound.idempotencyKey,
    handle: outbound.handle,
    kind: hasText ? "text" : "file",
    ...(hasText ? { body: outbound.text } : { filePath: outbound.filePath }),
    ...(hasText || outbound.caption === undefined ? {} : { body: outbound.caption }),
    ...(outbound.replyToGuid === undefined ? {} : { replyToGuid: outbound.replyToGuid }),
    ...(outbound.quotedText === undefined ? {} : { quotedText: outbound.quotedText }),
    ...(outbound.childId === undefined ? {} : { childId: outbound.childId }),
  };
}

function toAttemptFailure(error: unknown): AttemptFailure {
  if (error !== null && typeof error === "object" && "code" in error) {
    const value = error as { readonly code?: unknown; readonly message?: unknown; readonly ambiguous?: unknown };
    if (typeof value.code === "string") {
      return {
        code: value.code,
        message: typeof value.message === "string" ? value.message : value.code,
        ambiguous: value.ambiguous === true,
      };
    }
  }

  return {
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
    // We cannot prove an arbitrary adapter exception happened before a send.
    ambiguous: true,
  };
}
