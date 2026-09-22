import { PROTECTED_MONITOR_IDS } from "../../daemon/src/monitors/types.ts";

interface ToggleCandidate {
  readonly id: string;
  readonly enabled: boolean;
  readonly revision: number;
}

type MonitorSelection =
  | { readonly outcome: "READY"; readonly monitor: ToggleCandidate }
  | { readonly outcome: "SKIP" | "FAIL"; readonly reason: string };

/** No monitor mutation is authorized without an explicit operator selection. */
export function selectPanelToggleMonitor(rows: readonly unknown[], monitorId: string | undefined): MonitorSelection {
  if (!monitorId?.trim()) {
    return { outcome: "SKIP", reason: "toggle round-trip not exercised; set OI_ACCEPTANCE_MONITOR_ID to an operator-selected, unprotected monitor to authorize toggling and restoring it" };
  }
  if (PROTECTED_MONITOR_IDS.has(monitorId)) {
    return { outcome: "FAIL", reason: `selected monitor ${monitorId} is protected; no toggle attempted` };
  }
  const candidate = rows.find((row) => typeof row === "object" && row !== null && "id" in row && row.id === monitorId);
  if (!candidate || typeof candidate !== "object") {
    return { outcome: "SKIP", reason: `selected monitor ${monitorId} is absent from monitors.list; toggle round-trip not exercised` };
  }
  if ("protected" in candidate && candidate.protected === true) {
    return { outcome: "FAIL", reason: `selected monitor ${monitorId} is protected; no toggle attempted` };
  }
  if (!("protected" in candidate) || candidate.protected !== false ||
      !("enabled" in candidate) || typeof candidate.enabled !== "boolean" ||
      !("revision" in candidate) || typeof candidate.revision !== "number" || !Number.isSafeInteger(candidate.revision)) {
    return { outcome: "FAIL", reason: `selected monitor ${monitorId} lacks valid protection, enabled, or revision evidence; no toggle attempted` };
  }
  return { outcome: "READY", monitor: { id: monitorId, enabled: candidate.enabled, revision: candidate.revision } };
}
