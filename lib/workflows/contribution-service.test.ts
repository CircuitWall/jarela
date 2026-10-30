import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, utimesSync, cpSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const root = join(process.cwd(), "node_modules", ".cache", `contribution-tests-${randomUUID().slice(0, 8)}`);
mkdirSync(root, { recursive: true });
const data = join(root, "data");
const tools = join(root, "tools");
mkdirSync(tools);
vi.stubEnv("JARELA_DB_DIR", data);
vi.stubEnv("JARELA_TOOLS_DIR", tools);
vi.stubEnv("JARELA_TOOL_SAFETY", "mostly_safe");
const { resetConfigCache } = await import("@/lib/env/config");
resetConfigCache();
const { closeDb } = await import("@/lib/db");
const { getPendingAction, setActionStatus } = await import("@/lib/stores/pending-actions");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { getSkillProcessOwnerAvailability, createSkillProcessOwner } = await import("@/lib/skills/process-owner");
const { ContributionService } = await import("./contribution-service");

const agentId = "synthetic-contribution-agent";
const services: InstanceType<typeof ContributionService>[] = [];
let serial = 0;
const candidateSource = `export const value = () => "after";\n`;
const candidateTest = `import { expect, test } from "vitest";\nimport { value } from "./value.mjs";\ntest("reviewed contribution", () => expect(value()).toBe("after"));\n`;
const baseTest = `import { expect, test } from "vitest";\nimport { value } from "./value.mjs";\ntest("base fixture", () => expect(value()).toBe("before"));\n`;

function command(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, windowsHide: true, stdio: "ignore" });
}

function makeRepo(options: { remote?: boolean; githubRewrite?: boolean } = {}) {
  const name = `r-${++serial}`;
  const workspace = join(root, name);
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, "node_modules"), { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name, private: true, type: "module" }), "utf8");
  writeFileSync(join(workspace, "src", "value.mjs"), `export const value = () => "before";\n`, "utf8");
  writeFileSync(join(workspace, "src", "value.test.mjs"), baseTest, "utf8");
  command(workspace, "init");
  command(workspace, "config", "user.name", "Synthetic Contributor");
  command(workspace, "config", "user.email", "synthetic@example.invalid");
  command(workspace, "add", ".gitignore", "package.json", "src/value.mjs", "src/value.test.mjs");
  command(workspace, "commit", "-m", "test: create synthetic contribution fixture");
  command(workspace, "branch", "-M", "main");
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  const remotePath = join(root, `${name}-remote.git`);
  if (options.remote || options.githubRewrite) {
    command(root, "init", "--bare", remotePath);
    if (options.githubRewrite) {
      command(workspace, "remote", "add", "origin", "https://github.com/synthetic-owner/synthetic-repo.git");
      const fileUrl = new URL(`file:///${remotePath.replace(/\\/g, "/")}`).href;
      command(workspace, "config", `url.${fileUrl}.insteadOf`, "https://github.com/synthetic-owner/synthetic-repo.git");
    } else {
      command(workspace, "remote", "add", "origin", remotePath);
    }
  }
  return { workspace, base, remotePath, name };
}

function input(repo: ReturnType<typeof makeRepo>, override: Record<string, unknown> = {}) {
  return {
    destination: "synthetic-owner/synthetic-repo",
    branch: `feat/contribution-${serial}`,
    base_revision: repo.base,
    classification: "core",
    summary: "Synthetic reviewed contribution",
    ownership: "user_owned",
    license_review: "Synthetic fixture source is owned by this test",
    commit_message: "feat(contribution): verify lifecycle",
    files: [
      { path: "src/value.mjs", content: candidateSource },
      { path: "src/value.test.mjs", content: candidateTest },
    ],
    test_files: ["src/value.test.mjs"],
    ...override,
  };
}

function service(overrides: Partial<ConstructorParameters<typeof ContributionService>[0]> = {}) {
  const instance = new ContributionService({
    allowed: () => true,
    githubAuth: () => ({ token: "synthetic-github-token-not-a-real-credential" }),
    githubFetch: async (_auth, path, init) => path.endsWith("/pulls") && init?.method === "POST"
      ? {
        number: 7, draft: true, html_url: "https://github.com/synthetic-owner/synthetic-repo/pull/7",
        head: { ref: "feat/contribution-1", sha: "synthetic" }, base: { ref: "main" },
      }
      : { default_branch: "main" },
    ...overrides,
  });
  services.push(instance);
  return instance;
}

async function approve(instance: InstanceType<typeof ContributionService>, requested: { operation_id: string; proposal_id: string }) {
  const result = await instance.approve(requested.operation_id);
  setActionStatus(requested.proposal_id, "approved", { outcome: "succeeded" });
  return result;
}

function start(instance: InstanceType<typeof ContributionService>, repo: ReturnType<typeof makeRepo>, overrides: Record<string, unknown> = {}) {
  return instance.start(agentId, repo.workspace, input(repo, overrides));
}

function pathForHook(workspace: string, name: string) {
  return join(workspace, ".git", "hooks", name);
}

function hook(workspace: string, name: string, source: string) {
  const path = pathForHook(workspace, name);
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
  return path;
}

async function tested(instance: InstanceType<typeof ContributionService>, repo: ReturnType<typeof makeRepo>) {
  const pending = await start(instance, repo);
  const before = instance.inspectOperation(pending.operation_id);
  expect(before.status).toBe("pending");
  expect(before.test_execution).toMatchObject({ status: "not_run" });
  const result = await approve(instance, pending);
  expect(result.status).toBe("finished");
  expect(result.outcome).toBe("succeeded");
  return { pending, result };
}

async function waitForFile(path: string) {
  const end = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error("Owned hook did not reach the observed startup marker");
    await new Promise((done) => setTimeout(done, 25));
  }
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const hangingHook = `#!/bin/sh
node -e 'const {spawn}=require("node:child_process");const fs=require("node:fs");const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync("child.pid",String(p.pid));setInterval(()=>{},1000)'
`;

beforeEach(() => {
  upsertAgentConfig({ id: agentId, name: "Synthetic contributor", identity: "", instructions: "", tools: ["request_contribution_tests"] });
});

afterAll(async () => {
  await Promise.all(services.map((entry) => entry.close()));
  closeDb();
  vi.unstubAllEnvs();
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
});

describe("trusted repository contribution lifecycle", { timeout: 120_000 }, () => {
  it.runIf(process.env.JARELA_CONTRIBUTION_PRODUCTION_TEST === "1")("executes exact repository tests and commit through the built production HTTP dependency path", async () => {
    expect(existsSync(join(process.cwd(), ".next", "standalone", "server.js"))).toBe(true);
    const repo = makeRepo();
    command(repo.workspace, "config", "core.autocrlf", "false");
    command(repo.workspace, "config", "commit.gpgsign", "false");
    command(repo.workspace, "config", "core.hooksPath", join(repo.workspace, ".git", "hooks"));
    command(repo.workspace, "remote", "add", "origin", "https://github.com/synthetic-owner/synthetic-repo.git");
    cpSync(join(process.cwd(), "node_modules", "vitest"), join(repo.workspace, "node_modules", "vitest"), { recursive: true });
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing isolated production port");
    const port = address.port;
    await new Promise<void>((done) => listener.close(() => done()));
    const server = spawn(process.execPath, ["scripts/start-prod.mjs"], {
      cwd: process.cwd(), windowsHide: true, stdio: "ignore",
      env: {
        ...process.env, NODE_ENV: "production", JARELA_PORT: String(port), JARELA_HOSTNAME: "127.0.0.1",
        JARELA_DB_DIR: join(root, "production-data"), JARELA_TOOLS_DIR: join(root, "production-tools"),
        JARELA_TOOL_SAFETY: "mostly_safe", JARELA_ENABLE_MOCK_PROVIDER: "1", JARELA_DISABLE_UPDATE_CHECK: "1",
      },
    });
    const base = `http://127.0.0.1:${port}`;
    async function request(path: string, method = "GET", body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method, headers: { "content-type": "application/json", origin: base },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      expect(response.ok, JSON.stringify(result)).toBe(true);
      return result;
    }
    try {
      const deadline = Date.now() + 60_000;
      while (true) {
        try { if ((await fetch(`${base}/api/v1/health`)).ok) break; } catch { /* Wait for the owned test server. */ }
        if (Date.now() >= deadline || server.exitCode !== null) throw new Error("Isolated production server did not become ready");
        await new Promise((done) => setTimeout(done, 100));
      }
      await request("/api/v1/models", "POST", { name: "synthetic-production-model", provider: "mock", model_id: "mock-1", params: {}, is_default: true });
      const agent = await request("/api/v1/agents", "POST", {
        name: "Synthetic production contributor", identity: "", instructions: "", is_default: true,
        model_config_name: "synthetic-production-model",
        tools: ["request_contribution_tests", "request_contribution_commit"],
      });
      const pending = await request("/api/v1/contribution-authoring", "POST", {
        action: "create", agentId: agent.id, workspace: repo.workspace, input: input(repo),
      });
      const approved = await request(`/api/v1/pending-actions/${pending.proposal_id}/approve`, "POST", {});
      const preview = await request(`/api/v1/authoring-operations/${pending.operation_id}?type=contribution`);
      expect(approved.status, JSON.stringify(preview)).toBe("approved");
      expect(preview.test_execution).toMatchObject({ status: "passed", cleanup_verified: true, passed_files: 1 });
      const commit = await request("/api/v1/contribution-authoring", "POST", {
        action: "commit", agentId: agent.id, operation_id: pending.operation_id,
      });
      const committed = await request(`/api/v1/pending-actions/${commit.proposal_id}/approve`, "POST", {});
      expect(committed.status).toBe("approved");
      expect(execFileSync("git", ["show", `${input(repo).branch}:src/value.mjs`], { cwd: repo.workspace, encoding: "utf8" })).toBe(candidateSource);
    } finally {
      if (server.exitCode === null) {
        server.kill();
        await new Promise<void>((done) => server.once("exit", () => done()));
      }
    }
  });

  it("rejects multibyte candidate content beyond the filesystem UTF-8 byte limit before approval", async () => {
    const repo = makeRepo();
    const instance = service();
    expect(() => start(instance, repo, {
      files: [{ path: "src/value.mjs", content: "é".repeat(9000) }],
    })).toThrow(/16 KiB/);
    expect(execFileSync("git", ["branch", "--list", input(repo).branch], { cwd: repo.workspace, encoding: "utf8" })).toBe("");
  });

  it("fails closed when the owned process host is unavailable", async () => {
    const repo = makeRepo();
    const instance = service({ ownedProcessAvailable: () => false });
    await expect(instance.start(agentId, repo.workspace, input(repo))).rejects.toThrow(/Owned process execution is unavailable/);
    expect(getSkillProcessOwnerAvailability().available).toBeTypeOf("boolean");
  });

  it("builds a local exact preview without testing or publishing before approval", async () => {
    const repo = makeRepo();
    const instance = service();
    const pending = await start(instance, repo);
    const preview = instance.inspectOperation(pending.operation_id, agentId);
    expect(preview).toMatchObject({
      operation_type: "contribution", stage: "tests", status: "pending",
      repository_evidence: { status: "verified", worktree: "clean", selected_bytes_match_base: true },
      reported_tests: { status: "not_run" },
      publication_authorized: false, execution_authorized: false,
    });
    expect(preview.diff).toContain("export const value = () => \"after\"");
    expect(preview.test_sources[0]).toMatchObject({ path: "src/value.test.mjs", content: candidateTest });
    expect(existsSync(join(repo.workspace, "node_modules", ".cache", "jarela-contributions", pending.operation_id))).toBe(false);
    expect(execFileSync("git", ["branch", "--list", input(repo).branch], { cwd: repo.workspace, encoding: "utf8" })).toBe("");
  });

  it("denies and cancels approval without creating a branch or running tests", async () => {
    const repo = makeRepo();
    const instance = service();
    const pending = await start(instance, repo);
    const cancelled = await instance.cancel(pending.operation_id, agentId);
    expect(cancelled).toMatchObject({ status: "finished", outcome: "cancelled" });
    expect(getPendingAction(pending.proposal_id)?.status).toBe("denied");
    await expect(instance.approve(pending.operation_id)).rejects.toThrow();
    expect(execFileSync("git", ["branch", "--list", input(repo).branch], { cwd: repo.workspace, encoding: "utf8" })).toBe("");
  });

  it("blocks dirty worktrees and stale selected base bytes", async () => {
    const dirty = makeRepo();
    writeFileSync(join(dirty.workspace, "untracked.txt"), "not selected", "utf8");
    await expect(service().start(agentId, dirty.workspace, input(dirty))).rejects.toThrow(/dirty/);

    const stale = makeRepo();
    writeFileSync(join(stale.workspace, "src", "value.mjs"), "export const value = () => \"changed\";\n", "utf8");
    await expect(service().start(agentId, stale.workspace, input(stale))).rejects.toThrow(/dirty/);
  });

  it("blocks sensitive candidate and selected test bytes", async () => {
    const repo = makeRepo();
    const instance = service();
    await expect(start(instance, repo, {
      files: [
        { path: "src/value.mjs", content: "const api_key = 'synthetic-secret-value';\n" },
        { path: "src/value.test.mjs", content: candidateTest },
      ],
    })).rejects.toThrow(/blocked|Sensitive/i);
    const secretBase = makeRepo();
    writeFileSync(join(secretBase.workspace, "src", "value.test.mjs"), `// api_key = "synthetic-secret-marker-value"\n${baseTest}`, "utf8");
    command(secretBase.workspace, "add", "src/value.test.mjs");
    command(secretBase.workspace, "commit", "-m", "test: add synthetic marker fixture");
    secretBase.base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: secretBase.workspace, encoding: "utf8" }).trim();
    await expect(start(instance, secretBase, {
      files: [{ path: "src/value.mjs", content: candidateSource }],
    })).rejects.toThrow(/Sensitive markers detected/);
  });

  it("requires passing observed tests before the separate exact commit review", async () => {
    const repo = makeRepo();
    const instance = service();
    await expect(instance.requestCommit(randomUUID(), agentId)).rejects.toThrow();
    const pending = await start(instance, repo);
    await expect(instance.requestCommit(pending.operation_id, agentId)).rejects.toThrow(/passing/);
    const result = await approve(instance, pending);
    expect(result.test_execution).toMatchObject({ status: "passed", cleanup_verified: true });
    expect(result.reported_tests).toMatchObject({ status: "passed", evidence: expect.stringContaining("output sha256") });
    const commit = await instance.requestCommit(pending.operation_id, agentId);
    expect(commit).toMatchObject({ status: "pending", stage: "commit" });
    expect(instance.inspectOperation(pending.operation_id).exact_diff).toContain(candidateSource.trim());
  });

  it("marks failed approved repository tests unknown and blocks retry", async () => {
    const repo = makeRepo();
    const instance = service();
    const pending = await start(instance, repo, {
      files: [
        { path: "src/value.mjs", content: candidateSource },
        { path: "src/value.test.mjs", content: `import { expect, test } from "vitest"; test("fails", () => expect(1).toBe(2));\n` },
      ],
    });

    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/failed|unknown/i);
    expect(instance.inspectOperation(pending.operation_id)).toMatchObject({ status: "unknown", outcome: null });
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/not pending/);
  });

  it.each(["skipped", "excluded"] as const)("blocks exit-zero %s tests instead of claiming passing evidence", async (mode) => {
    const repo = makeRepo();
    if (mode === "excluded") {
      writeFileSync(join(repo.workspace, "vitest.config.mjs"), 'export default { test: { include: ["absent.test.mjs"], passWithNoTests: true } };\n');
      command(repo.workspace, "add", "vitest.config.mjs");
      command(repo.workspace, "commit", "-m", "test: configure synthetic no-tests fixture");
      repo.base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.workspace, encoding: "utf8" }).trim();
    }
    const instance = service();
    const testContent = mode === "skipped"
      ? 'import { test } from "vitest"; test.skip("not execution evidence", () => {});\n'
      : candidateTest;
    const pending = await start(instance, repo, {
      files: [
        { path: "src/value.mjs", content: candidateSource },
        { path: "src/value.test.mjs", content: testContent },
      ],
    });
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/incomplete evidence|unknown|failed/);
    expect(instance.inspectOperation(pending.operation_id).status).toBe("unknown");
    await expect(instance.requestCommit(pending.operation_id)).rejects.toThrow(/passing/);
  });

  it("rejects stale approvals and replays", async () => {
    const repo = makeRepo();
    const instance = service();
    const pending = await start(instance, repo);
    setActionStatus(pending.proposal_id, "failed", { error: "synthetic stale request" });
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/stale|claimed|unavailable/i);

    const freshRepo = makeRepo();
    const fresh = service();
    const request = await tested(fresh, freshRepo);
    await expect(fresh.approve(request.pending.operation_id)).rejects.toThrow(/not pending/);
  });

  it("marks failing Git commit hooks unknown and does not bypass them", async () => {
    const repo = makeRepo();
    const instance = service();
    const result = await tested(instance, repo);
    const hookFile = hook(repo.workspace, "pre-commit", "#!/bin/sh\nprintf hook-ran > hook-side-effect.txt\nexit 1\n");
    const pending = await instance.requestCommit(result.pending.operation_id, agentId);
    expect((instance.inspectOperation(pending.operation_id).commit as { hooks: unknown[] }).hooks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pre-commit", content: expect.stringContaining("exit 1") })]),
    );
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/failed|unknown/i);
    expect(instance.inspectOperation(pending.operation_id).status).toBe("unknown");
    expect(existsSync(join((instance.inspectOperation(pending.operation_id).test_execution as { isolated_worktree: string }).isolated_worktree, "hook-side-effect.txt"))).toBe(true);
    expect(existsSync(hookFile)).toBe(true);
  });

  it("blocks noncooperative test side effects outside the exact patch", async () => {
    const repo = makeRepo();
    const sideEffectTest = `import { expect, test } from "vitest";\nimport { writeFileSync } from "node:fs";\nimport { resolve } from "node:path";\nimport { value } from "./value.mjs";\ntest("passes but writes an extra file", () => { writeFileSync(resolve("side-effect.txt"), "synthetic"); expect(value()).toBe("after"); });\n`;
    const instance = service();
    const pending = await start(instance, repo, {
      files: [
        { path: "src/value.mjs", content: candidateSource },
        { path: "src/value.test.mjs", content: sideEffectTest },
      ],
    });
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/untracked|unknown/i);
    const preview = instance.inspectOperation(pending.operation_id);
    expect(preview.status).toBe("unknown");
    expect(existsSync(join((preview.test_execution as { isolated_worktree: string }).isolated_worktree, "side-effect.txt"))).toBe(true);
  });

  it.each(Array.from({ length: 10 }, (_, index) => index + 1))("completes owned local-remote and fake-HTTP lifecycle (%i/10)", async () => {
    const repo = makeRepo({ githubRewrite: true });
    const calls: Array<{ path: string; method: string }> = [];
    const instance = service({
      allowGitUrlRewriteForTests: true,
      githubFetch: async (_auth, path, init) => {
        calls.push({ path, method: init?.method ?? "GET" });
        if (path.endsWith("/pulls") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { head: string; base: string; draft: boolean };
          const commit = execFileSync("git", ["rev-parse", `refs/heads/${body.head}`], { cwd: repo.workspace, encoding: "utf8" }).trim();
          return {
            number: 7, draft: true, html_url: "https://github.com/synthetic-owner/synthetic-repo/pull/7",
            head: { ref: body.head, sha: commit }, base: { ref: body.base },
          };
        }
        return { default_branch: "main" };
      },
    });
    const testedResult = await tested(instance, repo);
    const commitApproval = await instance.requestCommit(testedResult.pending.operation_id, agentId);
    await approve(instance, commitApproval);
    const pushApproval = await instance.requestPush(testedResult.pending.operation_id, agentId);
    expect(pushApproval.status).toBe("pending");
    await approve(instance, pushApproval);
    const prApproval = await instance.requestDraftPr(testedResult.pending.operation_id, agentId);
    const preview = instance.inspectOperation(prApproval.operation_id);
    expect(preview.pull_request).toMatchObject({ base: "main", draft: true, head: `feat/contribution-${serial}` });
    const pr = await approve(instance, prApproval);
    expect(pr.result).toMatchObject({ draft_pr: true, number: 7 });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "POST" }),
    ]));
    const pushedRef = `refs/heads/feat/contribution-${serial}`;
    expect(execFileSync("git", ["ls-remote", repo.remotePath, pushedRef], { encoding: "utf8" })).toContain(pushedRef);
    expect(calls.every((call) => call.path.includes("synthetic-owner/synthetic-repo"))).toBe(true);
  });

  it("keeps all repository discovery free of fsmonitor, filter, diff, hook and credential execution", async () => {
    const repo = makeRepo({ remote: true });
    writeFileSync(join(repo.workspace, ".gitattributes"), "*.mjs filter=reviewed diff=reviewed\n");
    command(repo.workspace, "add", ".gitattributes");
    command(repo.workspace, "commit", "-m", "test: declare synthetic attributes");
    repo.base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.workspace, encoding: "utf8" }).trim();
    command(repo.workspace, "config", "core.fsmonitor", "node -e \"require('node:fs').writeFileSync('fsmonitor-ran','yes')\"");
    command(repo.workspace, "config", "filter.reviewed.clean", "node -e \"require('node:fs').writeFileSync('filter-ran','yes');process.stdin.pipe(process.stdout)\"");
    command(repo.workspace, "config", "filter.reviewed.process", "node -e \"require('node:fs').writeFileSync('process-ran','yes')\"");
    command(repo.workspace, "config", "diff.reviewed.command", "node -e \"require('node:fs').writeFileSync('diff-ran','yes')\"");
    command(repo.workspace, "config", "diff.reviewed.textconv", "node -e \"require('node:fs').writeFileSync('textconv-ran','yes')\"");
    command(repo.workspace, "config", "credential.helper", "!node -e \"require('node:fs').writeFileSync('credential-ran','yes')\"");
    hook(repo.workspace, "post-checkout", "#!/bin/sh\nprintf yes > checkout-ran\n");
    utimesSync(join(repo.workspace, "src", "value.mjs"), new Date(), new Date());
    const instance = service();
    const pending = await start(instance, repo);
    expect(instance.inspectOperation(pending.operation_id).status).toBe("pending");
    for (const marker of ["fsmonitor-ran", "filter-ran", "process-ran", "diff-ran", "textconv-ran", "credential-ran", "checkout-ran"]) {
      expect(existsSync(join(repo.workspace, marker))).toBe(false);
    }
    await instance.cancel(pending.operation_id);
  });

  it("rejects an independently clean stale base and a clean source revision change after review", async () => {
    const repo = makeRepo();
    const oldBase = repo.base;
    writeFileSync(join(repo.workspace, "unrelated.txt"), "synthetic independent commit\n");
    command(repo.workspace, "add", "unrelated.txt");
    command(repo.workspace, "commit", "-m", "test: advance clean base");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo.workspace, encoding: "utf8" })).toBe("");
    await expect(start(service(), repo)).rejects.toThrow(/actual current HEAD/);
    repo.base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.workspace, encoding: "utf8" }).trim();
    const instance = service();
    const pending = await start(instance, repo);
    command(repo.workspace, "commit", "--allow-empty", "-m", "test: advance reviewed base");
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/Source repository changed/);
    expect(oldBase).not.toBe(repo.base);
    expect(execFileSync("git", ["branch", "--list", input(repo).branch], { cwd: repo.workspace, encoding: "utf8" })).toBe("");
  });

  it("expires pending approvals and invalidates receipts across service restart", async () => {
    const repo = makeRepo();
    let now = Date.now();
    const instance = service({ now: () => now });
    const pending = await start(instance, repo);
    now += 31 * 60 * 1000;
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/expired/);
    expect(getPendingAction(pending.proposal_id)?.status).toBe("denied");
    const freshRepo = makeRepo();
    const fresh = service();
    const request = await start(fresh, freshRepo);
    await fresh.close();
    const restarted = service();
    expect(() => restarted.inspectOperation(request.operation_id)).toThrow(/previous app instance/);
    await expect(restarted.approve(request.operation_id)).rejects.toThrow(/previous app instance/);
    expect(getPendingAction(request.proposal_id)?.status).toBe("denied");
  });

  it.each(["cancel", "shutdown"] as const)("awaits real owned hook descendant settlement on %s", async (action) => {
    const repo = makeRepo();
    let reachedCleanup!: () => void;
    let releaseCleanup!: () => void;
    const cleanupReached = new Promise<void>((done) => { reachedCleanup = done; });
    const cleanupGate = new Promise<void>((done) => { releaseCleanup = done; });
    let delayCleanup = false;
    let verified = false;
    const instance = service({
      processOwner: () => {
        const owner = createSkillProcessOwner();
        return { launch(input) {
          const child = owner.launch(input);
          return {
            ...child,
            async stopAndVerifyTree() {
              const result = await child.stopAndVerifyTree();
              if (delayCleanup) {
                verified = result;
                reachedCleanup();
                await cleanupGate;
              }
              return result;
            },
          };
        } };
      },
    });
    const result = await tested(instance, repo);
    hook(repo.workspace, "pre-commit", hangingHook);
    const pending = await instance.requestCommit(result.pending.operation_id);
    const worktree = (instance.inspectOperation(pending.operation_id).test_execution as { isolated_worktree: string }).isolated_worktree;
    const approval = instance.approve(pending.operation_id).catch((error: unknown) => error);
    await waitForFile(join(worktree, "child.pid"));
    const pid = Number(readFileSync(join(worktree, "child.pid"), "utf8"));
    expect(isAlive(pid)).toBe(true);
    delayCleanup = true;
    let returned = false;
    const stop = (action === "cancel" ? instance.cancel(pending.operation_id) : instance.close()).then(() => { returned = true; });
    try {
      await cleanupReached;
      expect(returned).toBe(false);
      expect(verified).toBe(true);
      expect(isAlive(pid)).toBe(false);
    } finally { releaseCleanup(); }
    await stop;
    expect(await approval).toBeInstanceOf(Error);
    expect(instance.inspectOperation(pending.operation_id)).toMatchObject({ status: "unknown", outcome: null });
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/not pending/);
  });

  it("times out an owned hook and reaps its child before reporting unknown", async () => {
    const repo = makeRepo();
    const instance = service({ gitTimeoutMs: 5_000 });
    const result = await tested(instance, repo);
    hook(repo.workspace, "pre-commit", hangingHook);
    const pending = await instance.requestCommit(result.pending.operation_id);
    const worktree = (instance.inspectOperation(pending.operation_id).test_execution as { isolated_worktree: string }).isolated_worktree;
    const approval = instance.approve(pending.operation_id).catch((error: unknown) => error);
    await waitForFile(join(worktree, "child.pid"));
    const pid = Number(readFileSync(join(worktree, "child.pid"), "utf8"));
    expect(await approval).toBeInstanceOf(Error);
    expect(isAlive(pid)).toBe(false);
    expect(instance.inspectOperation(pending.operation_id).status).toBe("unknown");
  });

  it("blocks a remote baseline race after push approval and preserves the existing remote ref", async () => {
    const repo = makeRepo({ remote: true });
    const instance = service();
    const result = await tested(instance, repo);
    await approve(instance, await instance.requestCommit(result.pending.operation_id));
    const pending = await instance.requestPush(result.pending.operation_id);
    const ref = `refs/heads/${input(repo).branch}`;
    command(repo.workspace, "push", repo.remotePath, `${repo.base}:${ref}`);
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/baseline changed/);
    expect(execFileSync("git", ["--git-dir", repo.remotePath, "rev-parse", ref], { encoding: "utf8" }).trim()).toBe(repo.base);
    expect(instance.inspectOperation(pending.operation_id).status).toBe("unknown");
  });

  it("atomically refuses a topic ref created after the owned remote baseline check", async () => {
    const repo = makeRepo({ remote: true });
    const instance = service();
    const result = await tested(instance, repo);
    await approve(instance, await instance.requestCommit(result.pending.operation_id));
    const ref = `refs/heads/${input(repo).branch}`;
    command(repo.workspace, "push", repo.remotePath, `${repo.base}:refs/heads/baseline`);
    // The local-only receive hook inserts a ref after Git's advertisement but before the reference transaction.
    const hooks = join(repo.remotePath, "hooks");
    writeFileSync(join(hooks, "pre-receive"), "#!/bin/sh\nread old new ref\nunset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit update-ref \"$ref\" \"$(git rev-parse refs/heads/baseline)\"\n");
    chmodSync(join(hooks, "pre-receive"), 0o755);
    const pending = await instance.requestPush(result.pending.operation_id);
    await expect(instance.approve(pending.operation_id)).rejects.toThrow(/Push failed|unknown/);
    expect(instance.inspectOperation(pending.operation_id).status).toBe("unknown");
    expect(execFileSync("git", ["--git-dir", repo.remotePath, "rev-parse", ref], { encoding: "utf8" }).trim()).toBe(repo.base);
  });

  it("reports missing GitHub credentials before requesting a draft PR", async () => {
    const repo = makeRepo({ githubRewrite: true });
    const instance = service({
      allowGitUrlRewriteForTests: true,
      githubAuth: () => ({ error: "not configured" }),
    });
    const testedResult = await tested(instance, repo);
    const commitApproval = await instance.requestCommit(testedResult.pending.operation_id, agentId);
    await approve(instance, commitApproval);
    const pushApproval = await instance.requestPush(testedResult.pending.operation_id, agentId);
    await approve(instance, pushApproval);
    await expect(instance.requestDraftPr(testedResult.pending.operation_id, agentId)).rejects.toThrow(/credentials are unavailable/);
  });
});
