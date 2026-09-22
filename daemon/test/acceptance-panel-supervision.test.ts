import { describe, expect, test } from "bun:test";

import { selectPanelToggleMonitor } from "../../scripts/acceptance/panel-supervision-checks.ts";

const protectedMonitor = { id: "memory-canonicalize", protected: true, enabled: true, revision: 1 };
const selectedMonitor = { id: "operator-monitor", protected: false, enabled: false, revision: 7 };

 describe("panel acceptance monitor selection", () => {
  test("does not authorize arbitrary monitors without explicit operator selection", () => {
    for (const id of [undefined, "", "   "]) {
      const result = selectPanelToggleMonitor([protectedMonitor, selectedMonitor], id);
      expect(result.outcome).toBe("SKIP");
      if (result.outcome !== "READY") {
        expect(result.reason).toContain("toggle round-trip not exercised");
        expect(result.reason).toContain("OI_ACCEPTANCE_MONITOR_ID");
      }
    }
  });

  test("selects the exact operator monitor rather than the first row", () => {
    expect(selectPanelToggleMonitor([protectedMonitor, selectedMonitor], selectedMonitor.id)).toEqual({
      outcome: "READY",
      monitor: { id: selectedMonitor.id, enabled: false, revision: 7 },
    });
  });

  test("missing selection skips rather than falling back to another monitor", () => {
    const result = selectPanelToggleMonitor([selectedMonitor], "missing");
    expect(result.outcome).toBe("SKIP");
    if (result.outcome !== "READY") expect(result.reason).toContain("absent from monitors.list");
  });

  test("rejects protected IDs and server-declared protection before authorizing mutation", () => {
    for (const monitor of [
      protectedMonitor,
      { ...selectedMonitor, id: "memory-audit" },
      { ...selectedMonitor, id: "memory-canonicalize" },
      { ...selectedMonitor, protected: true },
    ]) {
      const result = selectPanelToggleMonitor([monitor], monitor.id);
      expect(result.outcome).toBe("FAIL");
      if (result.outcome !== "READY") expect(result.reason).toContain("protected; no toggle attempted");
    }
  });

  test("rejects incomplete or malformed toggle evidence without choosing another row", () => {
    for (const monitor of [
      { id: selectedMonitor.id, enabled: true, revision: 1 },
      { ...selectedMonitor, protected: "false" },
      { ...selectedMonitor, enabled: "true" },
      { ...selectedMonitor, revision: 1.5 },
      { ...selectedMonitor, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...selectedMonitor, revision: "7" },
    ]) {
      expect(selectPanelToggleMonitor([null, monitor, protectedMonitor], selectedMonitor.id).outcome).toBe("FAIL");
    }
  });
});
