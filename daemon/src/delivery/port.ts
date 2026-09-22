export interface DeliveryReceipt {
  readonly messageId: string;
  readonly threadId?: string;
  readonly linkedMessageId?: string;
}

/** Platform settlement adapter; durable admission belongs to DeliveryService. */
export interface DeliveryPort {
  sendText(handle: string, text: string): Promise<DeliveryReceipt>;
  /**
   * Sends only if `guard()` still holds at the moment the transport slot is
   * reached. A queued send can otherwise wait behind earlier work while the
   * decision that authorized it (for example peer trust) is revoked. Ports that
   * do not implement it fall back to a pre-queue check, which is weaker.
   */
  sendTextGuarded?(handle: string, text: string, guard: () => boolean): Promise<DeliveryReceipt>;
  sendReply(messageGuid: string, text: string): Promise<DeliveryReceipt>;
  sendFile(handle: string, path: string): Promise<DeliveryReceipt>;
  /** Best-effort typing indicator; failures are swallowed by callers. */
  setTyping?(handle: string, typing: boolean): Promise<void>;
  /** Best-effort read receipt for the 1:1 chat with `handle`. */
  markRead?(handle: string): Promise<void>;
}
