import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillExecutionArtifact } from "@/lib/skills/execution-artifact";
import { extensionArtifact } from "./extension-artifact";

const root = mkdtempSync(join(tmpdir(), "jarela-extension-lifecycle-"));
const data = join(root, "data"), workspace = join(root, "workspace"), tools = join(root, "tools");
mkdirSync(workspace); mkdirSync(tools);
vi.stubEnv("JARELA_DB_DIR", data);
vi.stubEnv("JARELA_TOOLS_DIR", tools);
vi.stubEnv("JARELA_TOOL_SAFETY", "mostly_safe");
const { resetConfigCache } = await import("@/lib/env/config");
resetConfigCache();
const { ExtensionService, extensionService } = await import("./extension-service");
const { upsertAgentConfig, getAgentConfig, getAgentTools } = await import("@/lib/stores/agent-configs");
const { closeDb } = await import("@/lib/db");
const { isDropinDisabled } = await import("@/lib/stores/disabled-dropin-tools");
const { setDropinDisabled } = await import("@/lib/stores/disabled-dropin-tools");
const { setToolConfig } = await import("@/lib/stores/tool-config");
const { getPendingAction, setActionStatus } = await import("@/lib/stores/pending-actions");
const { loadExternalTools, _resetExternalCache } = await import("@/lib/tools/runtime/external");
const { getSkillProcessOwnerAvailability } = await import("@/lib/skills/process-owner");
const agentId = "synthetic-author";
const input = (name = "fixture_echo") => ({ name, goal: "Read a local synthetic value", discovery: { decision: "author", evidence: "Synthetic fixture needs echo" } });
let serial = 0;
const services: InstanceType<typeof ExtensionService>[] = [];
function service(overrides: Partial<ConstructorParameters<typeof ExtensionService>[0]> = {}) {
  const instance = new ExtensionService({
    toolsDir: () => tools, autoloadDirs: () => [tools], allowed: () => true,
    test: async () => ({ passed: true, evidence: { synthetic: true } }),
    verify: async () => ({ value: "synthetic" }), ...overrides,
  });
  services.push(instance);
  return instance;
}
beforeEach(() => {
  upsertAgentConfig({ id: agentId, name: "Synthetic author", identity: "", instructions: "", tools: ["request_extension_stage"] });
});
afterAll(async () => {
  await Promise.all(services.map((service) => service.close()));
  await extensionService().close();
  closeDb(); vi.unstubAllEnvs(); resetConfigCache();
  rmSync(root, { recursive: true, force: true });
});
async function stage(instance: InstanceType<typeof ExtensionService>, id: string, action: string, extra = {}) {
  const pending = instance.request(agentId, { id, stage: action, ...extra });
  const result = await instance.approve(pending.operation_id);
  return { pending, result };
}
describe("exact staged extension lifecycle", () => {
  it("binds the same artifact identity for in-memory and filesystem capture", async () => {
    const instance = service();
    const session = instance.create(agentId, workspace, input());
    await stage(instance, session.id, "stage");
    const dir = instance.inspect(session.id).staging_directory!;
    expect(SkillExecutionArtifact.capture(dir).revision).toBe(extensionArtifact("fixture_echo").revision);
    expect(() => instance.inspect(session.id, "different-agent")).toThrow(/another/);
  });

  it("denied or cancelled installation never loads staged code", async () => {
    const instance = service();
    const name = `denied_${++serial}`;
    const session = instance.create(agentId, workspace, input(name));
    await stage(instance, session.id, "stage");
    await stage(instance, session.id, "test");
    const pending = instance.request(agentId, { id: session.id, stage: "install" });
    instance.cancel(pending.operation_id, agentId);
    expect(getPendingAction(pending.proposal_id)?.status).toBe("denied");
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/not pending/);
    _resetExternalCache();
    expect(loadExternalTools(new Set()).tools.map((tool) => tool.name)).not.toContain(name);
  });

  it("separates install/configuration/agent enable/verify and supports explicit disable/removal", async () => {
    const instance = service(), name = `accepted_${++serial}`;
    const session = instance.create(agentId, workspace, input(name));
    await stage(instance, session.id, "stage");
    expect(() => instance.request(agentId, { id: session.id, stage: "install" })).toThrow(/tests/);
    await stage(instance, session.id, "test");
    await stage(instance, session.id, "install");
    expect(isDropinDisabled(name)).toBe(true);
    expect(getAgentTools(getAgentConfig(agentId))).not.toContain(name);
    await stage(instance, session.id, "configure", { fixture_origin: "http://127.0.0.1:12345" });
    await stage(instance, session.id, "enable");
    expect(isDropinDisabled(name)).toBe(false);
    expect(getAgentTools(getAgentConfig(agentId))).toContain(name);
    await stage(instance, session.id, "verify");
    expect(instance.inspect(session.id).verified).toBe(true);
    await stage(instance, session.id, "disable");
    expect(instance.inspect(session.id).verified).toBe(false);
    expect(isDropinDisabled(name)).toBe(true);
    const removed = await stage(instance, session.id, "remove");
    expect(removed.result.output).toMatchObject({ removed: true });
    expect(getAgentTools(getAgentConfig(agentId))).not.toContain(name);
    await stage(instance, session.id, "discard");
    expect(instance.inspect(session.id).staging_directory).toBeNull();
  });

  it("blocks failed tests, stale source, scope changes, permissions and replay", async () => {
    const instance = service({ test: async () => ({ passed: false, evidence: {} }) });
    expect(() => instance.create(agentId, workspace, { ...input("oversized_utf8"), source: "//" + "\u00e9".repeat(9000) })).toThrow();
    const session = instance.create(agentId, workspace, input(`failed_${++serial}`));
    const staged = await stage(instance, session.id, "stage");
    await expect(instance.approve(staged.pending.operation_id)).rejects.toThrow(/not pending/);
    await expect(stage(instance, session.id, "test")).rejects.toThrow(/tests failed/);
    expect(() => instance.request(agentId, { id: session.id, stage: "install" })).toThrow(/tests/);
    const dir = instance.inspect(session.id).staging_directory!;
    chmodSync(join(dir, "run.cjs"), 0o600);
    writeFileSync(join(dir, "run.cjs"), "changed");
    expect(() => instance.request(agentId, { id: session.id, stage: "test" })).toThrow(/bytes changed/);
  });

  it("holds ownership until cancelled host work actually settles and never records late success", async () => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const instance = service({ test: async () => { await wait; return { passed: true, evidence: {} }; } });
    const session = instance.create(agentId, workspace, input(`cancel_${++serial}`));
    await stage(instance, session.id, "stage");
    const pending = instance.request(agentId, { id: session.id, stage: "test" });
    const work = instance.approve(pending.operation_id);
    instance.cancel(pending.operation_id);
    expect(() => instance.request(agentId, { id: session.id, stage: "test" })).toThrow(/still executing/);
    finish();
    await expect(work).rejects.toThrow(/cancelled/);
    expect(instance.inspect(session.id).tested).toBe(false);
    expect(instance.inspectOperation(pending.operation_id).status).toBe("unknown");
  });

  it("invalidates configuration/enabled-state changes and preserves unrelated agent settings", async () => {
    const instance = service(), name = `configuration_${++serial}`;
    upsertAgentConfig({ id: agentId, name: "Preserved author", identity: "Synthetic identity", instructions: "Keep these instructions", tools: ["request_extension_stage", "scaffold_extension"] });
    const session = instance.create(agentId, workspace, input(name));
    await stage(instance, session.id, "stage");
    await stage(instance, session.id, "test");
    await stage(instance, session.id, "install");
    const configuration = instance.request(agentId, { id: session.id, stage: "configure", fixture_origin: "http://127.0.0.1:12345" });
    setToolConfig(name, "base_url", "http://127.0.0.1:54321");
    await expect(instance.approve(configuration.operation_id)).rejects.toThrow(/configuration/);
    await stage(instance, session.id, "configure", { fixture_origin: "http://127.0.0.1:12345" });
    const enablement = instance.request(agentId, { id: session.id, stage: "enable" });
    setDropinDisabled(name, false);
    await expect(instance.approve(enablement.operation_id)).rejects.toThrow(/enabled state/);
    await stage(instance, session.id, "enable");
    expect(getAgentConfig(agentId)).toMatchObject({ name: "Preserved author", identity: "Synthetic identity", instructions: "Keep these instructions" });
    await stage(instance, session.id, "remove");
    expect(getAgentTools(getAgentConfig(agentId))).toEqual(["request_extension_stage", "scaffold_extension"]);
    await stage(instance, session.id, "discard");
  });

  it("drains running ownership on shutdown even with an expired pending review", async () => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const instance = service({ test: async () => { await wait; return { passed: true, evidence: {} }; } });
    const expired = instance.create(agentId, workspace, input(`expired_close_${++serial}`));
    instance.request(agentId, { id: expired.id, stage: "stage" });
    const active = instance.create(agentId, workspace, input(`active_close_${++serial}`));
    await stage(instance, active.id, "stage");
    const pending = instance.request(agentId, { id: active.id, stage: "test" });
    const work = instance.approve(pending.operation_id);
    const settlement = expect(work).rejects.toThrow(/cancelled/);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    try {
      let drained = false;
      const closing = instance.close().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      finish();
      await settlement; await closing;
      expect(instance.inspect(active.id).tested).toBe(false);
    } finally { finish(); clock.mockRestore(); }
  });

  it("restores only retained reviewed bytes and requires staging/retest/new enablement", async () => {
    const name = `restore_${++serial}`;
    const source = extensionArtifact(name).readFile(`${name}.cjs`).toString("utf8");
    writeFileSync(join(tools, `${name}.cjs`), source);
    const instance = service();
    const session = instance.create(agentId, workspace, { ...input(name), source: source.replace("Read a value", "Read a checked value") });
    await stage(instance, session.id, "stage");
    await stage(instance, session.id, "test");
    await stage(instance, session.id, "install");
    await stage(instance, session.id, "restore");
    expect(isDropinDisabled(name)).toBe(true);
    expect(() => instance.request(agentId, { id: session.id, stage: "enable" })).toThrow(/staging/);
    await stage(instance, session.id, "stage");
    await stage(instance, session.id, "test");
    await stage(instance, session.id, "install");
    expect(readFileSync(join(tools, `${name}.cjs`), "utf8")).toBe(source);
    await stage(instance, session.id, "enable");
    await stage(instance, session.id, "remove");
  });

  it("blocks autoload overlap, source secrets, denied discovery and expired decisions", async () => {
    const overlapping = service({ autoloadDirs: () => [join(data, "skill-runs")] });
    expect(() => overlapping.create(agentId, workspace, input())).toThrow(/overlaps/);
    expect(() => service().create(agentId, workspace, { ...input(), source: "ghp_" + "a".repeat(36) })).toThrow(/sensitive/);
    expect(() => service().create(agentId, workspace, { ...input(), discovery: { decision: "reuse", evidence: "Existing" } })).toThrow(/reuse/);
    const instance = service(), session = instance.create(agentId, workspace, input(`expiry_${++serial}`));
    const pending = instance.request(agentId, { id: session.id, stage: "stage" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    try { await expect(instance.approve(pending.operation_id)).rejects.toThrow(/expired/); }
    finally { vi.restoreAllMocks(); }
  });

  it("rejects workspace/destination and permission changes after review", async () => {
    let allowed = true;
    const instance = service({ allowed: () => allowed });
    const session = instance.create(agentId, workspace, input(`policy_${++serial}`));
    const pending = instance.request(agentId, { id: session.id, stage: "stage" });
    allowed = false;
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/not currently permitted/);
    expect(instance.inspect(session.id).staging_directory).toBeNull();
    setActionStatus(pending.proposal_id, "failed", { error: "Synthetic denied policy" });
  });
});

describe("production extension execution path", () => {
  it.skipIf(!getSkillProcessOwnerAvailability().available)("runs exact reviewed fixture bytes through the real owned runner and verifies installed synthetic HTTP output 10/10", async () => {
    const server = createServer((request, response) => {
      response.end(JSON.stringify({ value: new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("value") }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const instance = extensionService(), name = `production_${++serial}`;
    const session = instance.create(agentId, workspace, input(name));
    try {
      await stage(instance, session.id, "stage");
      const tests = await stage(instance, session.id, "test");
      expect(tests.result.output).toMatchObject({ status: "succeeded", cleanupVerified: true, output: { passed: true } });
      await stage(instance, session.id, "install");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing synthetic port");
      await stage(instance, session.id, "configure", { fixture_origin: `http://127.0.0.1:${address.port}` });
      await stage(instance, session.id, "enable");
      for (let attempt = 0; attempt < 10; attempt++) await stage(instance, session.id, "verify");
      await stage(instance, session.id, "disable");
      await stage(instance, session.id, "remove");
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 30000);
});
