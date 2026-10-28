import { getSkillExecutionPolicy, isSkillTrustWorkspace } from "@/lib/stores/app-settings";
import { resolveSafetyMode } from "@/lib/tools/security/safety";
import { evaluateSkillExecutionPolicy, type SkillExecutionTarget, type SkillExecutionPolicyDecision } from "./execution-policy";

export function resolveSkillExecutionConsentRequirement(
  target: SkillExecutionTarget, executeAllowed: boolean,
): SkillExecutionPolicyDecision {
  if (!isSkillTrustWorkspace(target.workspace)) {
    return { kind: "blocked", reason: "Workspace must be an absolute normalized host path" };
  }
  return evaluateSkillExecutionPolicy(getSkillExecutionPolicy(), target, {
    safetyMode: resolveSafetyMode(), executeAllowed,
  });
}
