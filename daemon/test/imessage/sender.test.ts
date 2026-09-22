import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImessageSender, type ImessageCliRunResult } from "../../src/imessage/sender.ts";

function recorder(response: Partial<ImessageCliRunResult> = {}, delayMs = 0): { seen: string[][]; runner: (argv: readonly string[]) => Promise<ImessageCliRunResult> } {
  const seen: string[][] = [];
  return {
    seen,
    runner: async (argv) => {
      seen.push([...argv]);
      if (delayMs > 0) {
        await Bun.sleep(delayMs);
      }
      return { exitCode: 0, stdout: "", stderr: "", ...response };
    },
  };
}

describe("ImessageSender (AppleScript bridge)", () => {
  test("text goes to Messages via osascript with the handle and body as argv", async () => {
    const { seen, runner } = recorder();
    const sender = new ImessageSender({ runner });
    const receipt = await sender.sendText("+821012345678", "안녕");
    expect(receipt.messageId).toMatch(/^applescript:/);
    expect(seen[0]![0]).toBe("/usr/bin/osascript");
    expect(seen[0]![2]).toContain('tell application "Messages"');
    expect(seen[0]!.slice(-2)).toEqual(["+821012345678", "안녕"]);
  });

  test("attachments are staged into an indexed folder and sent as a file", async () => {
    const { seen, runner } = recorder();
    const sender = new ImessageSender({ runner });
    const shot = join(mkdtempSync(join(tmpdir(), "oi-shot-")), "image.jpg");
    writeFileSync(shot, "jpg");
    await expect(sender.sendFile("+821012345678", shot)).resolves.toMatchObject({ messageId: expect.stringMatching(/^applescript:/) });
    expect(seen[0]![2]).toContain("POSIX file");
    expect(seen[0]![seen[0]!.length - 1]).toMatch(/\/Pictures\/OpenInstinct\/\d+-image\.jpg$/);
    await expect(sender.sendFile("+821012345678", "/nonexistent/x.png")).rejects.toMatchObject({ code: "cli_error" });
  });

  test("threaded replies are unavailable; Automation denial, failures, and timeouts are classified", async () => {
    await expect(new ImessageSender({ runner: recorder().runner }).sendReply("guid", "x")).rejects.toMatchObject({ code: "cli_error" });
    const denied = new ImessageSender({ runner: recorder({ exitCode: 1, stderr: "execution error: Not authorized to send Apple events to Messages. (-1743)" }).runner });
    await expect(denied.sendText("+1", "x")).rejects.toMatchObject({ code: "permission", ambiguous: false });
    const broken = new ImessageSender({ runner: recorder({ exitCode: 1, stderr: "Messages got an error: Can’t get participant." }).runner });
    await expect(broken.sendText("+1", "x")).rejects.toMatchObject({ code: "cli_error" });
    const slow = new ImessageSender({ timeoutMs: 50, runner: recorder({ timedOut: true }, 10).runner });
    await expect(slow.sendText("+1", "x")).rejects.toMatchObject({ code: "timeout", ambiguous: true });
  });

  test("serialises concurrent sends", async () => {
    const order: string[] = [];
    const sender = new ImessageSender({
      runner: async (argv) => {
        order.push(`start:${argv.at(-1)}`);
        await Bun.sleep(20);
        order.push(`end:${argv.at(-1)}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await Promise.all([sender.sendText("+1", "a"), sender.sendText("+1", "b")]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("a guarded send runs its guard inside the queued slot, not before it", async () => {
    // A queue with one slow send ahead of the guarded one: the guard must be
    // evaluated when the guarded send reaches the transport, not when it was
    // enqueued, or a revocation landing while it waits would go unnoticed.
    const { seen, runner } = recorder({}, 60);
    const sender = new ImessageSender({ runner });
    const slow = sender.sendText("+821011111111", "first");
    let trusted = true;
    const guarded = sender.sendTextGuarded("+821012345678", "second", () => trusted);
    trusted = false;
    await slow;
    await expect(guarded).rejects.toThrow(/guard refused/);
    // Only the first send reached osascript; the refused one never did.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.slice(-2)).toEqual(["+821011111111", "first"]);

    // The inverse: a guard that still holds sends exactly once.
    const allowed = recorder();
    const second = new ImessageSender({ runner: allowed.runner });
    await expect(second.sendTextGuarded("+821012345678", "third", () => true))
      .resolves.toMatchObject({ messageId: expect.stringMatching(/^applescript:/) });
    expect(allowed.seen).toHaveLength(1);
    expect(allowed.seen[0]!.slice(-2)).toEqual(["+821012345678", "third"]);
  });
});
