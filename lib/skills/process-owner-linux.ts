import { spawn } from "node:child_process";
import { join } from "node:path";
import { createSkillCgroup } from "./process-owner-cgroup";
import type { OwnedSkillProcess, SkillProcessOwner } from "./execution-runner";

/** Parent remains outside the owned cgroup so it can observe populated=0. */
export function launchLinuxSkill(input: Parameters<SkillProcessOwner["launch"]>[0]): OwnedSkillProcess {
  const group = createSkillCgroup();
  let broker: ReturnType<typeof spawn>;
  try {
    broker = spawn(process.execPath, [join(process.cwd(), "lib", "skills", "process-owner-linux.cjs")], {
      env: {} as NodeJS.ProcessEnv, shell: false, stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
  } catch (error) { group.remove(); throw error; }
  let ended = false;
  let settled = false;
  let resolve!: (value: Awaited<OwnedSkillProcess["completion"]>) => void;
  let reject!: (error: Error) => void;
  const completion: OwnedSkillProcess["completion"] = new Promise((done, fail) => { resolve = done; reject = fail; });
  void completion.catch(() => {});
  const fail = () => {
    if (!settled) { settled = true; reject(new Error("Skill cgroup ownership broker failed")); }
  };
  let stopPromise: Promise<boolean> | undefined;
  const stop = (): Promise<boolean> => stopPromise ??= (async () => {
    clearTimeout(timer);
    // First prevent any late join/spawn, then kill the complete cgroup.
    broker.kill("SIGKILL");
    const deadline = performance.now() + 800;
    while (!ended && performance.now() < deadline) await new Promise((done) => setTimeout(done, 5));
    if (!ended) return false;
    try {
      group.kill();
      while (group.populated() && performance.now() < deadline) await new Promise((done) => setTimeout(done, 5));
      if (group.populated()) return false;
      group.remove();
      return true;
    } catch { return false; }
  })();
  const timer = setTimeout(() => { fail(); void stop(); }, 15_000);
  broker.once("spawn", () => broker.send!({ ...input, group: group.directory }, (error) => {
    if (error) { fail(); void stop(); }
  }));
  broker.once("error", () => { ended = true; fail(); void stop(); });
  broker.once("exit", () => { ended = true; fail(); void stop(); });
  broker.on("message", (value: unknown) => {
    const message = value as { kind?: string; exitCode?: number | null; signal?: string | null } | null;
    if (message?.kind === "ready") clearTimeout(timer);
    else if (message?.kind === "exit" && !settled
      && (message.exitCode === null || Number.isInteger(message.exitCode))
      && (message.signal === null || typeof message.signal === "string")) {
      settled = true;
      resolve({ exitCode: message.exitCode!, signal: message.signal! });
      void stop();
    } else { fail(); void stop(); }
  });
  return { stdout: broker.stdout!, stderr: broker.stderr!, completion, stopAndVerifyTree: stop };
}
