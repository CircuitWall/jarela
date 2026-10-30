import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSkillProcessOwner, getSkillProcessOwnerAvailability } from "./process-owner";
import { runStagedSkill } from "./execution-runner";
import { SkillExecutionArtifact } from "./execution-artifact";
import { SkillRunConsent, skillInvocationDigest } from "./execution-consent";

const root = vi.hoisted(() => ({ path: "" }));
vi.mock("@/lib/db/data-dir", () => ({ getDataDir: () => root.path }));
const directory = join(realpathSync(process.cwd()), `.process-owner-test-${randomUUID()}`);
mkdirSync(directory);
root.path = directory;
afterAll(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function launch(source: string, args: string[] = [], cwd = directory) {
  return createSkillProcessOwner().launch({
    executable: process.execPath, args: ["--eval", source, "--", ...args],
    cwd, stdin: "exact input \u2603\n\0", env: {},
  });
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function waitGone(pid: number) {
  const deadline = performance.now() + 4000;
  while (alive(pid) && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(alive(pid), `owned pid ${pid} still exists`).toBe(false);
}
async function firstLine(stream: AsyncIterable<Uint8Array>) {
  let text = "";
  for await (const bytes of stream) {
    text += Buffer.from(bytes).toString("utf8");
    if (text.includes("\n")) return JSON.parse(text.slice(0, text.indexOf("\n")));
  }
  throw new Error("Missing child fixture output");
}
const descendants = `
const { spawn } = require("node:child_process");
const source = 'const {spawn}=require("node:child_process"); const grand=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{env:{},stdio:"ignore"}); console.log(JSON.stringify({grand:grand.pid})); setInterval(()=>{},1000);';
const child=spawn(process.execPath, ["-e",source], {env:{},stdio:["ignore","pipe","ignore"]});
child.stdout.once("data", data => {
  console.log(JSON.stringify({root:process.pid, broker:process.ppid, child:child.pid, ...JSON.parse(data)}));
  child.stdout.destroy(); child.unref();
  if (process.argv[1] !== "stay") process.exit(0);
});
setInterval(()=>{},1000);
`;

describe("checked-skill process ownership availability", () => {
  it("reports containment limits explicitly", () => {
    const availability = getSkillProcessOwnerAvailability();
    if (!availability.available) {
      expect(availability.available).toBe(false);
      expect(() => createSkillProcessOwner()).toThrow();
      return;
    }
    expect(availability.available).toBe(true);
    if (!availability.available) return;
    expect(availability.backend).toBe(process.platform === "win32" ? "windows-job" : "linux-cgroup");
    expect(availability.limitations.join(" ")).toMatch(/not a.*sandbox/);
    if (process.platform === "win32") expect(availability.limitations.join(" ")).toMatch(/SystemRoot/);
  });

  for (const platform of ["linux", "darwin"]) {
    it(`refuses ${platform} process-group cleanup claims for escaped/live descendants`, () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", { ...descriptor, value: platform });
        vi.stubEnv("JARELA_SKILL_CGROUP_ROOT", join(directory, "not-a-delegated-cgroup"));
        const availability = getSkillProcessOwnerAvailability();
        expect(availability).toEqual({ available: false, reason: expect.any(String) });
        // No success-shaped process handle (and therefore no true cleanup
        // attestation) can be returned on these unsupported production hosts.
        expect(() => createSkillProcessOwner()).toThrow(platform === "linux" ? /delegated cgroup-v2/ : /no supported containment backend/);
      } finally { Object.defineProperty(process, "platform", descriptor); vi.unstubAllEnvs(); }
    });
  }
});

describe.skipIf(!getSkillProcessOwnerAvailability().available)("real supported-host checked-skill process ownership", () => {
  it.skipIf(process.platform !== "linux")("kills session-escaped descendants using actual delegated cgroup.kill", async () => {
    const child = launch(`
const {spawn}=require("node:child_process");
const descendant=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{
  detached:true,env:{},stdio:"ignore"
});
console.log(JSON.stringify({root:process.pid,escaped:descendant.pid}));
setInterval(()=>{},1000);
`);
    const err = collect(child.stderr);
    try {
      const pids = await firstLine(child.stdout);
      expect(alive(pids.escaped)).toBe(true);
      expect(await child.stopAndVerifyTree()).toBe(true);
      await Promise.all([waitGone(pids.root), waitGone(pids.escaped)]);
      await err;
    } finally { await child.stopAndVerifyTree(); }
  }, 15_000);

  it("runs real Memory Organization within its original 5s manifest including broker compilation", async () => {
    const artifact = SkillExecutionArtifact.capture(join(process.cwd(), "lib", "skills", "builtins", "memory-organization"));
    const manifest = artifact.getManifest();
    expect(manifest.timeoutMs).toBe(5000);
    const controller = new AbortController();
    const inputJson = JSON.stringify({ now: "2026-10-30T00:00:00Z", entries: [] });
    const binding = {
      agentId: "process-owner-test", runId: randomUUID(), workspace: directory,
      artifactRevision: artifact.revision, inputDigest: skillInvocationDigest(inputJson),
      runtimeVersion: process.version, timeoutMs: manifest.timeoutMs, maxOutputBytes: manifest.maxOutputBytes,
    };
    const consent = new SkillRunConsent({
      agentId: binding.agentId, runId: binding.runId, workspace: binding.workspace,
    }, controller.signal);
    const proposal = consent.propose(binding);
    consent.decide(proposal.id, "approve");
    try {
      const result = await runStagedSkill({
        artifact, inputJson, binding, consent, proposalId: proposal.id, signal: controller.signal,
        policy: () => ({ executeAllowed: true, safeMode: false, blocked: false }),
        owner: createSkillProcessOwner(),
      });
      expect(result).toMatchObject({
        status: "succeeded", cleanupVerified: true, exitCode: 0,
        output: { ok: true, expired_keys: [], duplicate_groups: [] },
      });
      expect(result.elapsedMs).toBeLessThan(5000);
      expect(readdirSync(join(directory, "skill-runs"))).toEqual([]);
      expect(readdirSync(join(directory, "skill-run-owners"))).toEqual([]);
    } finally { consent.close(); }
  }, 15_000);

  it("uses exact argv, cwd, stdin and no inherited environment with raw separate output", async () => {
    const args = ["space argument", 'quote"and\\', "", "$(not-a-command); & |", "unicode \u2603"];
    const child = launch(`
let input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", b=>input+=b);
process.stdin.on("end",()=>{
  console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),input,env:process.env}));
  process.stderr.write(Buffer.from([0,255,1,13,10]));
});`, args);
    const out = collect(child.stdout);
    const err = collect(child.stderr);
    try {
      expect(await child.completion).toEqual({ exitCode: 0, signal: null });
      expect(JSON.parse((await out).toString())).toEqual({
        args, cwd: directory, input: "exact input \u2603\n\0",
        env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
      });
      expect(await err).toEqual(Buffer.from([0, 255, 1, 13, 10]));
    } finally { expect(await child.stopAndVerifyTree()).toBe(true); }
  }, 25_000);

  it("preserves nonzero exit without interpreting output as control", async () => {
    const child = launch('console.log(\'{"kind":"drained"}\'); process.exitCode=19;');
    const out = collect(child.stdout);
    const err = collect(child.stderr);
    try {
      expect(await child.completion).toEqual({ exitCode: 19, signal: null });
      expect((await out).toString()).toContain('"drained"');
      expect(await err).toHaveLength(0);
    } finally { expect(await child.stopAndVerifyTree()).toBe(true); }
  }, 25_000);

  it("owns grandchildren even when their immediate parent has already exited", async () => {
    const child = launch(descendants);
    const output = firstLine(child.stdout);
    const err = collect(child.stderr);
    try {
      const pids = await output;
      expect(await child.completion).toEqual({ exitCode: 0, signal: null });
      expect(await child.stopAndVerifyTree()).toBe(true);
      await Promise.all([waitGone(pids.child), waitGone(pids.grand)]);
      await err;
    } finally { await child.stopAndVerifyTree(); }
  }, 25_000);

  for (const reason of ["timeout", "cancellation"]) {
    it(`drains an active tree on ${reason} and is idempotent`, async () => {
      const child = launch(descendants, ["stay"]);
      const err = collect(child.stderr);
      try {
        const pids = await firstLine(child.stdout);
        const controller = new AbortController();
        const stopped = new Promise<boolean>((resolve) => {
          if (reason === "cancellation") controller.signal.addEventListener("abort", () => {
            void child.stopAndVerifyTree().then(resolve);
          }, { once: true });
          setTimeout(() => {
            if (reason === "cancellation") controller.abort();
            else void child.stopAndVerifyTree().then(resolve);
          }, 30);
        });
        expect(await stopped).toBe(true);
        expect(await child.stopAndVerifyTree()).toBe(true);
        await Promise.all([waitGone(pids.root), waitGone(pids.child), waitGone(pids.grand)]);
        await err;
      } finally { await child.stopAndVerifyTree(); }
    }, 25_000);
  }

  it("rejects unsafe launch contracts without launching", () => {
    const owner = createSkillProcessOwner();
    const input = { executable: process.execPath, args: [], cwd: directory, stdin: "", env: {} };
    expect(() => owner.launch({ ...input, executable: "node" })).toThrow(/exact Node/);
    expect(() => owner.launch({ ...input, env: { SECRET_FIXTURE: "not-inherited" } })).toThrow(/empty environment/);
    expect(() => owner.launch({ ...input, args: ["\0"] })).toThrow(/literal argv/);
  });

  it("can stop during asynchronous startup without releasing a later launch", async () => {
    const marker = join(directory, "must-not-launch");
    const child = launch(`require("node:fs").writeFileSync(${JSON.stringify(marker)},"launched");`);
    const out = collect(child.stdout);
    const err = collect(child.stderr);
    const start = performance.now();
    expect(await child.stopAndVerifyTree()).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
    await expect(child.completion).rejects.toThrow(/broker failed/);
    await Promise.all([out, err]);
    expect(existsSync(marker)).toBe(false);
  }, 25_000);

  it("terminates a tree even while the bounded-pipe stdin writer is blocked", async () => {
    const child = createSkillProcessOwner().launch({
      executable: process.execPath,
      args: ["--eval", "console.log(JSON.stringify({root:process.pid})); setInterval(()=>{},1000);"],
      cwd: directory, stdin: "x".repeat(2 * 1024 * 1024), env: {},
    });
    const err = collect(child.stderr);
    try {
      const { root } = await firstLine(child.stdout);
      expect(await child.stopAndVerifyTree()).toBe(true);
      await waitGone(root);
      await err;
    } finally { await child.stopAndVerifyTree(); }
  }, 25_000);

  it("fails closed for an invalid launch and verifies the empty job/group", async () => {
    const child = launch("", [], join(directory, "does-not-exist"));
    const out = collect(child.stdout);
    const err = collect(child.stderr);
    try {
      await expect(child.completion).rejects.toThrow(/broker failed/);
      expect(await child.stopAndVerifyTree()).toBe(true);
      await Promise.all([out, err]);
    } finally { await child.stopAndVerifyTree(); }
  }, 25_000);

  it("cleans up a crashed broker and only attests a verified drain", async () => {
    const child = launch(descendants, ["stay"]);
    const err = collect(child.stderr);
    try {
      const pids = await firstLine(child.stdout);
      process.kill(pids.broker, "SIGKILL");
      await expect(child.completion).rejects.toThrow(/broker failed/);
      expect(await child.stopAndVerifyTree()).toBe(process.platform === "linux");
      await Promise.all([waitGone(pids.root), waitGone(pids.child), waitGone(pids.grand)]);
      await err;
    } finally { await child.stopAndVerifyTree(); }
  }, 25_000);

  it("cleans up when the owning application dies without calling stop", async () => {
    const fixture = join(directory, "app.mjs");
    const moduleUrl = pathToFileURL(join(process.cwd(), "lib", "skills", "process-owner.ts")).href;
    writeFileSync(fixture, `
import {registerHooks} from "node:module";
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith("./") && !/\\.[a-z]+$/i.test(specifier)) return next(specifier+".ts",context);
  return next(specifier,context);
}});
const {createSkillProcessOwner}=await import(${JSON.stringify(moduleUrl)});
const child=createSkillProcessOwner().launch(${JSON.stringify({
      executable: process.execPath, args: ["--eval", descendants, "--", "stay"],
      cwd: directory, stdin: "", env: {},
    })});
void child.completion.catch(()=>{});
for await (const bytes of child.stdout) { process.stdout.write(bytes); }
`);
    const app = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", fixture], {
      cwd: process.cwd(), env: {}, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    const errors = collect(app.stderr);
    const exit = new Promise((resolve) => app.once("exit", resolve));
    try {
      const pids = await firstLine(app.stdout);
      app.kill("SIGKILL");
      await exit;
      await Promise.all([waitGone(pids.root), waitGone(pids.child), waitGone(pids.grand)]);
      await errors;
    } finally { if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL"); }
  }, 25_000);
});
