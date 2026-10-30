import { z } from "zod";
import { extensionService } from "./extension-service";

export const AuthoringOperationType = z.enum(["extension", "contribution"]);
export const AuthoringApprovalPayload = z.object({
  operation_id: z.uuid(), operation_type: AuthoringOperationType,
  stage: z.string().min(1), revision: z.string().min(1),
});
const receipt = z.object({ stage: z.string(), revision: z.string(), status: z.string(), proposal_id: z.uuid() });
export async function inspectAuthoringOperation(id: string, type: z.infer<typeof AuthoringOperationType>, agentId?: string) {
  if (type === "extension") return extensionService().inspectOperation(id, agentId);
  const { contributionService } = await import("./contribution-service");
  return contributionService().inspectOperation(id, agentId);
}
export async function approveAuthoringOperation(payload: unknown, agentId: string, proposalId: string) {
  const input = AuthoringApprovalPayload.parse(payload);
  const reviewed = receipt.parse(await inspectAuthoringOperation(input.operation_id, input.operation_type, agentId));
  if (reviewed.proposal_id !== proposalId || reviewed.stage !== input.stage || reviewed.revision !== input.revision) {
    throw new Error("Stored approval no longer matches the exact stage and revision");
  }
  const result = input.operation_type === "extension"
    ? await extensionService().approve(input.operation_id, agentId)
    : await (await import("./contribution-service")).contributionService().approve(input.operation_id);
  const observed = receipt.omit({ proposal_id: true }).parse(result);
  return { operation_id: input.operation_id, operation_type: input.operation_type, proposal_id: proposalId, ...observed,
    review_endpoint: `/api/v1/authoring-operations/${input.operation_id}?type=${input.operation_type}` };
}
export async function cancelAuthoringOperation(id: string, type: z.infer<typeof AuthoringOperationType>, agentId?: string) {
  if (type === "extension") return extensionService().cancel(id, agentId);
  const { contributionService } = await import("./contribution-service");
  return contributionService().cancel(id, agentId);
}
export async function shutdownAuthoringOperations() {
  const { contributionService } = await import("./contribution-service");
  const settled = await Promise.allSettled([extensionService().close(), contributionService().close()]);
  const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Authoring shutdown failed after all owners settled");
}
