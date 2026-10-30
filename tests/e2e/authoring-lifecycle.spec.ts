import { test, expect, type APIRequestContext } from "@playwright/test";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dismissOverlayBanners, enableFullExperienceMode, seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });
test.skip(!!process.env.JARELA_E2E_BASE_URL, "Authoring writes require the runner-owned isolated app and drop-in directory");
let workspace: string;
let repository: string;
let agentId: string;
function gitOutput(...args: string[]) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(repository, "absent-gitconfig") } });
}
const git = (...args: string[]) => gitOutput(...args).trim();
test.beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "jarela-e2e-authoring-"));
  const cache = join(process.cwd(), "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  repository = mkdtempSync(join(cache, "jarela-e2e-contribution-"));
  mkdirSync(join(repository, "src"));
  writeFileSync(join(repository, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repository, "package.json"), '{"name":"synthetic-contribution","private":true,"type":"module"}\n');
  writeFileSync(join(repository, "src", "value.mjs"), 'export const value = () => "before";\n');
  writeFileSync(join(repository, "src", "value.test.mjs"), 'import { expect, test } from "vitest";\nimport { value } from "./value.mjs";\ntest("value", () => expect(value()).toBe("before"));\n');
  git("init", "--initial-branch=main");
  git("config", "user.name", "Synthetic Contributor");
  git("config", "user.email", "contributor@example.invalid");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(repository, ".git", "hooks"));
  git("remote", "add", "origin", "https://github.com/synthetic-owner/synthetic-repo.git");
  git("add", "."); git("commit", "-m", "test(fixture): initialize browser contribution");
  mkdirSync(join(repository, "node_modules"));
  cpSync(join(process.cwd(), "node_modules", "vitest"), join(repository, "node_modules", "vitest"), { recursive: true });
});
test.afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(repository, { recursive: true, force: true });
});
test.beforeEach(async ({ request }) => {
  agentId = (await seedMockAgent(request)).agent;
  expect((await request.put(`/api/v1/agents/${agentId}`, { data: { tools: [
    "request_extension_stage", "request_contribution_tests", "request_contribution_commit", "request_contribution_push", "request_contribution_draft_pr",
  ] } })).ok()).toBe(true);
});

function contributionInput(branch: string) {
  return {
    destination: "synthetic-owner/synthetic-repo", branch, base_revision: git("rev-parse", "HEAD"),
    classification: "core", summary: "Verify selected synthetic value", ownership: "user_owned",
    license_review: "Synthetic user-owned fixture authorized for contribution", commit_message: "fix(fixture): verify reviewed value",
    files: [
      { path: "src/value.mjs", content: 'export const value = () => "after";\n' },
      { path: "src/value.test.mjs", content: 'import { expect, test } from "vitest";\nimport { value } from "./value.mjs";\ntest("value", () => expect(value()).toBe("after"));\n' },
    ], test_files: ["src/value.test.mjs"],
  };
}
test("contribution UI denial keeps a real clean repository unchanged and unpublished", async ({ request, page }) => {
  const policy = await request.get("/api/v1/security/skill-execution");
  test.skip(!(await policy.json()).execution_available, "Native owned execution backend unavailable on this host");
  await dismissOverlayBanners(page); await enableFullExperienceMode(page);
  await page.goto("/?tab=tools&item=skills");
  await page.getByText("Extension and contribution workflows", { exact: true }).click();
  await page.getByLabel("Authoring agent").selectOption(agentId);
  await page.getByLabel("Authoring workflow type").selectOption("contribution");
  await page.getByLabel("Authoring canonical absolute workspace").fill(repository);
  await page.getByRole("button", { name: "Load inert authoring example" }).click();
  await expect(page.getByLabel("Authoring request JSON")).toHaveValue(/REPLACE_WITH_EXACT_BASE_COMMIT/);
  await page.getByLabel("Authoring request JSON").fill(JSON.stringify({ action: "create", input: contributionInput("fix/browser-denial") }));
  await page.getByRole("button", { name: "Submit authoring request" }).click();
  await expect(page.getByLabel("Exact authoring operation").last()).toContainText("src/value.mjs");
  await expect(page.getByRole("button", { name: "Approve this authoring stage" })).toBeDisabled();
  await page.getByRole("button", { name: "Deny this authoring stage" }).click();
  await expect(page.getByLabel("Authoring result")).toContainText('"denied"');
  expect(git("branch", "--list", "fix/browser-denial")).toBe("");
  expect(git("status", "--porcelain")).toBe("");
});

test("actual contribution tests produce a local bundle and a separately approved local-only commit", async ({ request }) => {
  test.setTimeout(120000);
  const policy = await request.get("/api/v1/security/skill-execution");
  test.skip(!(await policy.json()).execution_available, "Native owned execution backend unavailable on this host");
  const input = contributionInput("fix/browser-reviewed-value");
  const response = await request.post("/api/v1/contribution-authoring", { data: { action: "create", agentId, workspace: repository, input } });
  expect(response.ok(), await response.text()).toBe(true);
  const pending = await response.json() as { operation_id: string; proposal_id: string };
  expect((await decide(request, pending)).status).toBe("approved");
  const local = await request.get(`/api/v1/authoring-operations/${pending.operation_id}?type=contribution`);
  expect(await local.text()).toContain("local_contribution_review_bundle");
  expect(git("rev-parse", "HEAD")).toBe(input.base_revision);
  expect(readFileSync(join(repository, "src", "value.mjs"), "utf8")).toContain('"before"');
  const commit = await request.post("/api/v1/contribution-authoring", { data: { action: "commit", agentId, operation_id: pending.operation_id } });
  expect(commit.ok(), await commit.text()).toBe(true);
  const review = await commit.json() as { operation_id: string; proposal_id: string };
  expect(review.operation_id).toBe(pending.operation_id);
  expect(review.proposal_id).not.toBe(pending.proposal_id);
  expect((await decide(request, review)).status).toBe("approved");
  expect(git("rev-parse", input.branch)).not.toBe(input.base_revision);
  expect(git("diff", "--name-only", input.base_revision, input.branch).split(/\r?\n/).sort()).toEqual(input.files.map((file) => file.path).sort());
  for (const file of input.files) expect(gitOutput("show", `${input.branch}:${file.path}`)).toBe(file.content);
  expect(git("for-each-ref", "--format=%(refname)", "refs/remotes")).toBe("");
  expect(git("status", "--porcelain")).toBe("");
  expect((await request.post(`/api/v1/pending-actions/${review.proposal_id}/approve`, { data: {} })).status()).toBe(409);
});
const input = (name: string) => ({ name, goal: "Read a local synthetic value", discovery: { decision: "author", evidence: "No fixture echo tool" } });
async function create(request: APIRequestContext, name: string, source?: string) {
  const response = await request.post("/api/v1/extension-authoring", { data: { action: "create", agentId, workspace, input: { ...input(name), ...(source ? { source } : {}) } } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ id: string; staging_directory: string | null }>;
}
async function pending(request: APIRequestContext, id: string, stage: string, extra = {}) {
  const response = await request.post("/api/v1/extension-authoring", { data: { action: "request", agentId, input: { id, stage, ...extra } } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ operation_id: string; proposal_id: string }>;
}
async function decide(request: APIRequestContext, proposal: { proposal_id: string }, allowed = true) {
  const response = await request.post(`/api/v1/pending-actions/${proposal.proposal_id}/${allowed ? "approve" : "deny"}`, { data: {} });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ status: string; result: unknown }>;
}
async function stage(request: APIRequestContext, id: string, name: string, extra = {}) {
  const proposal = await pending(request, id, name, extra);
  const result = await decide(request, proposal);
  expect(result.status, JSON.stringify(result)).toBe("approved");
  return { proposal, result };
}
test("inert authoring UI requires exact review and denial leaves drafts un-staged", async ({ request, page }) => {
  await dismissOverlayBanners(page); await enableFullExperienceMode(page);
  await page.goto("/?tab=tools&item=skills");
  await page.getByText("Extension and contribution workflows", { exact: true }).click();
  await page.getByRole("button", { name: "Load inert authoring example" }).click();
  await expect(page.getByLabel("Authoring request JSON")).toHaveValue(/"decision": "author"/);
  const session = await create(request, "browser_fixture");
  expect(session.staging_directory).toBeNull();
  await page.getByLabel("Authoring agent").selectOption(agentId);
  await page.getByLabel("Authoring request JSON").fill(JSON.stringify({ action: "request", input: { id: session.id, stage: "stage" } }));
  await page.getByRole("button", { name: "Submit authoring request" }).click();
  await expect(page.getByLabel("Exact authoring operation").last()).toContainText("browser_fixture.cjs");
  const approval = page.getByRole("button", { name: "Approve this authoring stage" });
  await expect(approval).toBeDisabled();
  await page.getByRole("button", { name: "Deny this authoring stage" }).click();
  await expect(page.getByLabel("Authoring result")).toContainText('"denied"');
  const observed = await request.get(`/api/v1/extension-authoring?id=${session.id}&agentId=${agentId}`);
  expect(await observed.json()).toMatchObject({ staging_directory: null, tested: false });
});

test("staged source is never loaded after installation denial or cancelled review", async ({ request }) => {
  const session = await create(request, "denied_fixture");
  await stage(request, session.id, "stage");
  const before = await request.get("/api/v1/tools");
  expect(await before.text()).not.toContain('"name":"denied_fixture"');
  const pendingTest = await pending(request, session.id, "test");
  const cancellation = await request.delete(`/api/v1/authoring-operations/${pendingTest.operation_id}?type=extension`);
  expect(cancellation.ok()).toBe(true);
  expect((await request.post(`/api/v1/pending-actions/${pendingTest.proposal_id}/approve`, { data: {} })).status()).toBe(409);
});

test("real approved lifecycle verifies 10/10 and blocks a failed update before explicit restoration", async ({ request }) => {
  test.setTimeout(120000);
  const policy = await request.get("/api/v1/security/skill-execution");
  const { execution_available } = await policy.json();
  test.skip(!execution_available, "Native owned execution backend unavailable on this host");
  const server = createServer((request, response) => {
    response.end(JSON.stringify({ value: new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("value") }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic port");
    const fixture_origin = `http://127.0.0.1:${address.port}`;
    const session = await create(request, "accepted_fixture");
    const first = await stage(request, session.id, "stage");
    const preview = await request.get(`/api/v1/authoring-operations/${first.proposal.operation_id}?type=extension`);
    const detail = await preview.json() as { files: Array<{ path: string; content: string }> };
    const source = detail.files.find((file) => file.path === "accepted_fixture.cjs")!.content;
    await stage(request, session.id, "test");
    const deniedInstall = await pending(request, session.id, "install");
    expect((await decide(request, deniedInstall, false)).status).toBe("denied");
    expect(await (await request.get("/api/v1/tools")).text()).not.toContain('"name":"accepted_fixture"');
    await stage(request, session.id, "install");
    await stage(request, session.id, "configure", { fixture_origin });
    await stage(request, session.id, "enable");
    for (let attempt = 0; attempt < 10; attempt++) await stage(request, session.id, "verify");

    const update = await create(request, "accepted_fixture", source.replace("async run(args, ctx) {", 'async run(args, ctx) { throw new Error("Synthetic failed update");'));
    await stage(request, update.id, "stage");
    expect((await decide(request, await pending(request, update.id, "test"))).status).toBe("failed");
    const refused = await request.post("/api/v1/extension-authoring", { data: { action: "request", agentId, input: { id: update.id, stage: "install" } } });
    expect(refused.status()).toBe(400);
    await stage(request, session.id, "verify");
    await stage(request, update.id, "disable");
    await stage(request, update.id, "remove");
    expect(await (await request.get("/api/v1/tools")).text()).not.toContain('"name":"accepted_fixture"');
    await stage(request, update.id, "restore");
    await stage(request, update.id, "stage");
    await stage(request, update.id, "test");
    await stage(request, update.id, "install");
    await stage(request, update.id, "configure", { fixture_origin });
    await stage(request, update.id, "enable");
    await stage(request, update.id, "verify");
    await stage(request, update.id, "disable");
    await stage(request, update.id, "remove");
    await stage(request, update.id, "discard");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
