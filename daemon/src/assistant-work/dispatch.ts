import type { AssistantWorkRepository } from "../store/assistant-work.ts";
import type { ActionRecord } from "./model.ts";
import { executeManagedLocalFileAction } from "./execution.ts";
import { MANAGED_LOCAL_FILE_ACTION } from "./local-effects.ts";
import { executeManagedInstall, MANAGED_INSTALL_ACTION } from "./install.ts";
import { executeManagedHttpAction, isManagedHttpActionRecord } from "./http-effects.ts";
import { configuredHttpAccess } from "./http-policy.ts";
import type { FollowupDispatcherResult } from "./recovery.ts";
import { PEER_COORDINATION_ACTION } from "../peers/coordination.ts";
import { agentEmailPlanAuthorizer } from "../email/agent-email.ts";
import type { AgentEmailIdentity } from "../email/identity.ts";

export async function dispatchManagedAction(input: {
  readonly repository: AssistantWorkRepository;
  readonly action: ActionRecord;
  readonly attemptId: string;
  readonly workerId: string;
  /**
   * Required, matching `AssistantWorkRuntime`: a fresh `configuredHttpAccess()`
   * fallback would lack the capability-derived message bindings the daemon
   * booted with, so a recovered capability action would be refused instead of
   * resumed.
   */
  readonly httpAccess: ReturnType<typeof configuredHttpAccess>;
  /**
   * Recovery must be able to reauthorize a persisted capability action. The
   * generic binding set deliberately cannot classify agent email, so without
   * the capability's own authorizer a recovered claimed-pre-effect send would
   * be refused and stranded rather than safely resumed.
   */
  readonly agentEmail?: AgentEmailIdentity;
  /**
   * The clock used for ledger writes. Injected so this path cannot introduce a
   * second time source beside the one recovery and the runtime already hold.
   */
  readonly now: () => string;
}): Promise<FollowupDispatcherResult> {
  const action = input.action;
  const common = {
    repository: input.repository,
    actionId: action.id,
    revision: action.revision,
    digest: action.digest,
    attemptId: input.attemptId,
    workerId: input.workerId,
  };
  const access = input.httpAccess;
  const capabilityAuthorizer = input.agentEmail === undefined
    ? undefined
    : agentEmailPlanAuthorizer(input.agentEmail, action.workId);
  const authorizeMessage = capabilityAuthorizer === undefined
    ? access.authorizeMessage
    // Generic bindings first, then the capability's own plan check; neither can
    // authorize what the other owns, so trying both widens nothing.
    : (plan: Parameters<typeof access.authorizeMessage>[0]) =>
      access.authorizeMessage(plan) ?? capabilityAuthorizer(plan);
  const result = isManagedHttpActionRecord(action)
    ? await executeManagedHttpAction({ ...common, ...access, authorizeMessage })
    : action.action === MANAGED_LOCAL_FILE_ACTION
      ? await executeManagedLocalFileAction(common)
      : action.action === MANAGED_INSTALL_ACTION
        ? await executeManagedInstall(common)
        : undefined;
  if (!result || result.kind === "preflight_rejected") {
    // A peer envelope has no managed-HTTP executor here, and leaving it
    // claimed would strand the attempt forever: recovery can neither deliver
    // it (trust and transport are owned by the peer lane) nor release it.
    // Cancel it so the owner can re-propose and re-approve deliberately.
    if (action.action === PEER_COORDINATION_ACTION) {
      // Same scoped release as the recovery path: only cancel while the attempt
      // this dispatcher resumed is still the action's pre-effect claim.
      const released = input.repository.releaseClaimedPreEffectAttempt({
        actionId: action.id,
        revision: action.revision,
        digest: action.digest,
        attemptId: input.attemptId,
        workerId: input.workerId,
        reason: "peer_envelope_not_resumable_after_crash",
      }, input.now());
      return released.released
        ? { kind: "rejected", reason: "cancelled", action: released.action }
        : { kind: "rejected", reason: "blocked", action: released.action };
    }
    return { kind: "rejected", reason: "blocked", action };
  }
  return result;
}
