import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTROL_CAPABILITIES } from "../src/control/schema.ts";

const daemonFixtures = fileURLToPath(new URL("./fixtures/control/", import.meta.url));
const panelFixtures = fileURLToPath(new URL("../../panel/Tests/OpenInstinctPanelTests/Resources/control/", import.meta.url));

describe("panel control fixture sync", () => {
  test("negotiation fixture covers every advertised daemon capability", () => {
    const negotiated = JSON.parse(readFileSync(`${daemonFixtures}negotiated.json`, "utf8"));
    expect(negotiated.capabilities).toEqual([...CONTROL_CAPABILITIES]);
  });
  test("keeps every Swift test fixture byte-identical to the daemon golden source", () => {
    const sourceFiles = readdirSync(daemonFixtures).filter((file) => file.endsWith(".json")).sort();
    const syncedFiles = readdirSync(panelFixtures).filter((file) => file.endsWith(".json")).sort();
    expect(syncedFiles).toEqual(sourceFiles);
    for (const file of sourceFiles) {
      expect(readFileSync(`${panelFixtures}${file}`)).toEqual(readFileSync(`${daemonFixtures}${file}`));
    }
  });

  test("ships the Phase 4 settings limits and idle child activity timestamp", () => {
    const settings = JSON.parse(readFileSync(`${daemonFixtures}settings-get-response.json`, "utf8")) as {
      readonly payload: Record<string, unknown>;
    };
    expect(settings.payload).toMatchObject({
      childWarmTtlSec: 600,
      childIdleTimeoutSec: 86_400,
      childMaxLive: 16,
      childInterimBatchSec: 3,
      childInterimRatePerMinute: 6,
      childInterimMaxBytes: 1_024,
      childStatusListLimit: 20,
      childStatusTextBytes: 512,
      childToolGuardMs: 50,
    });
    const status = JSON.parse(readFileSync(`${daemonFixtures}status-response.json`, "utf8")) as {
      readonly payload: { readonly activeChildren: readonly { readonly state: string; readonly lastActivityAt?: string }[] };
    };
    expect(status.payload.activeChildren.find((child) => child.state === "idle")?.lastActivityAt).toBe("2026-01-01T00:00:05.000Z");
  });
});
