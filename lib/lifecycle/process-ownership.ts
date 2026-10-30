import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ProcessOwnerSchema = z.strictObject({
  pid: z.number().int().positive(), instanceId: z.string().uuid(),
});
export type ProcessOwner = z.infer<typeof ProcessOwnerSchema>;
const host = globalThis as typeof globalThis & { __jarelaProcessOwner?: Readonly<ProcessOwner> };
const owner = host.__jarelaProcessOwner ??= Object.freeze({ pid: process.pid, instanceId: randomUUID() });

export function currentProcessOwner(): ProcessOwner {
  return { ...owner };
}

// An expired lease, different UUID, reused PID or permission error is not proof
// of death. Conservative false negatives retain state rather than replay writes.
export async function isProcessOwnerDead(value: ProcessOwner): Promise<boolean> {
  const parsed = ProcessOwnerSchema.safeParse(value);
  if (!parsed.success || parsed.data.pid === process.pid) return false;
  try { process.kill(parsed.data.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
