import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: vi.fn() };
});
const root = mkdtempSync(join(tmpdir(), "jarela-api-authoring-"));
const workspace = join(root, "workspace");
mkdirSync(workspace);
vi.stubEnv("JARELA_DB_DIR", join(root, "data"));
vi.stubEnv("JARELA_TOOLS_DIR", join(root, "tools"));
vi.stubEnv("JARELA_TOOL_SAFETY", "mostly_safe");
const { closeDb } = await import("@/lib/db");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { extensionService } = await import("@/lib/workflows/extension-service");
const { contributionService } = await import("@/lib/workflows/contribution-service");
const { getSkillProcessOwnerAvailability } = await import("@/lib/skills/process-owner");
const { getOrCreateAgentThread } = await import("@/lib/stores/threads");
const { inspectAuthoringOperationTool, cancelAuthoringOperationTool } = await import("@/lib/tools/general/authoring-operations");
const { POST: contribution } = await import("@/app/api/v1/contribution-authoring/route");
const { createPendingAction, getPendingAction } = await import("@/lib/stores/pending-actions");
const { POST, GET } = await import("@/app/api/v1/extension-authoring/route");
const { GET: preview, DELETE: cancel } = await import("@/app/api/v1/authoring-operations/[id]/route");
const { POST: approve } = await import("@/app/api/v1/pending-actions/[id]/approve/route");
const { POST: deny } = await import("@/app/api/v1/pending-actions/[id]/deny/route");
const agentId = "synthetic-authoring-api";
upsertAgentConfig({ id: agentId, name: "Synthetic author", identity: "", instructions: "", tools: [
  "request_extension_stage", "request_contribution_tests", "request_contribution_commit", "request_contribution_push", "request_contribution_draft_pr",
] });
afterAll(async () => { await extensionService().close(); await contributionService().close(); closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function req(path: string, method = "GET", data?: unknown, host = "localhost") {
  return new NextRequest(`http://localhost/api/v1/${path}`, { method, headers: { host, "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}
async function create() {
  const response = await POST(req("extension-authoring", "POST", { action: "create", agentId, workspace,
    input: { name: "fixture_api", goal: "Synthetic echo", discovery: { decision: "author", evidence: "No fixture" } } }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string }>;
}
async function requestStage(id: string) {
  const response = await POST(req("extension-authoring", "POST", { action: "request", agentId, input: { id, stage: "stage" } }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ operation_id: string; proposal_id: string }>;
}
describe("trusted local authoring lifecycle endpoints", () => {
  it("keeps capture inert, previews exact bytes and applies one approval once", async () => {
    const session = await create();
    expect(await (await GET(req(`extension-authoring?id=${session.id}&agentId=${agentId}`))).json()).toMatchObject({ staging_directory: null, tested: false });
    const pending = await requestStage(session.id);
    const context = { params: Promise.resolve({ id: pending.operation_id }) };
    const detail = await preview(req(`authoring-operations/${pending.operation_id}?type=extension`), context);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    expect(await detail.json()).toMatchObject({ stage: "stage", status: "pending", files: expect.arrayContaining([expect.objectContaining({ path: "fixture_api.cjs" })]) });
    const stored = JSON.parse(getPendingAction(pending.proposal_id)!.payload);
    for (const owner of ["another-agent", agentId]) {
      const foreign = createPendingAction({ agent_id: owner, kind: "authoring_operation", payload: stored });
      const refused = await approve(req("pending-actions/approve", "POST", {}), { params: Promise.resolve({ id: foreign.id }) });
      expect(await refused.json()).toMatchObject({ status: "failed" });
    }
    expect(extensionService().inspectOperation(pending.operation_id).status).toBe("pending");
    const response = await approve(req("pending-actions/approve", "POST", {}), { params: Promise.resolve({ id: pending.proposal_id }) });
    expect(response.status).toBe(200);
    const observed = await response.json();
    expect(observed).toMatchObject({ status: "approved", result: { status: "succeeded", stage: "stage" } });
    expect(observed.result).not.toHaveProperty("files");
    expect(observed.result).not.toHaveProperty("output");
    expect(getPendingAction(pending.proposal_id)?.result).not.toContain("fixture_api.cjs");
    expect(extensionService().inspect(session.id).staging_directory).not.toBeNull();
    expect((await approve(req("pending-actions/approve", "POST", {}), { params: Promise.resolve({ id: pending.proposal_id }) })).status).toBe(409);
  });
  it("denies/cancels pending work without changing staging and rejects remote mutation/preview", async () => {
    const session = await create(), pending = await requestStage(session.id);
    const copied = createPendingAction({ agent_id: agentId, kind: "authoring_operation", payload: JSON.parse(getPendingAction(pending.proposal_id)!.payload) });
    expect((await deny(req("pending-actions/deny", "POST", {}), { params: Promise.resolve({ id: copied.id }) })).status).toBe(200);
    expect(extensionService().inspectOperation(pending.operation_id).status).toBe("pending");
    const context = { params: Promise.resolve({ id: pending.operation_id }) };
    expect((await preview(req(`authoring-operations/${pending.operation_id}?type=extension`, "GET", undefined, "remote.invalid"), context)).status).toBe(403);
    expect((await approve(req("pending-actions/approve", "POST", {}, "remote.invalid"), { params: Promise.resolve({ id: pending.proposal_id }) })).status).toBe(403);
    expect((await deny(req("pending-actions/deny", "POST", {}), { params: Promise.resolve({ id: pending.proposal_id }) })).status).toBe(200);
    expect(extensionService().inspect(session.id).staging_directory).toBeNull();
    expect(extensionService().inspectOperation(pending.operation_id).status).toBe("cancelled");
    const other = await requestStage(session.id);
    expect((await cancel(req(`authoring-operations/${other.operation_id}?type=extension`, "DELETE"), { params: Promise.resolve({ id: other.operation_id }) })).status).toBe(200);
    expect(getPendingAction(other.proposal_id)?.status).toBe("denied");
  });
  it("rejects malformed, oversized and invented authority inputs", async () => {
    for (const body of [{ action: "approve" }, { action: "create", agentId, workspace, input: { publication_authorized: true } }, { x: "a".repeat(65537) }]) {
      expect((await POST(req("extension-authoring", "POST", body))).status).toBe(400);
    }
    const stale = createPendingAction({ agent_id: agentId, kind: "authoring_operation", payload: { operation_type: "extension", operation_id: "00000000-0000-4000-8000-000000000001" } });
    const response = await approve(req("pending-actions/approve", "POST", {}), { params: Promise.resolve({ id: stale.id }) });
    expect(await response.json()).toMatchObject({ status: "failed" });
  });

  it.skipIf(!getSkillProcessOwnerAvailability().available)("keeps actual repository inspection/local review inert until a distinct approval", async () => {
    const repository = join(root, "contribution");
    mkdirSync(join(repository, "src"), { recursive: true });
    writeFileSync(join(repository, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repository, "src", "value.mjs"), 'export const value = () => "before";\n');
    writeFileSync(join(repository, "src", "value.test.mjs"), 'import { expect, test } from "vitest";\nimport { value } from "./value.mjs";\ntest("value", () => expect(value()).toBe("before"));\n');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "absent-gitconfig") };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--initial-branch=main");
    git("config", "user.name", "Synthetic Contributor");
    git("config", "user.email", "contributor@example.invalid");
    git("remote", "add", "origin", "https://github.com/synthetic-owner/synthetic-repo.git");
    git("add", "."); git("commit", "-m", "test(fixture): initialize synthetic repository");
    const vitest = join(repository, "node_modules", "vitest");
    mkdirSync(vitest, { recursive: true });
    writeFileSync(join(vitest, "package.json"), JSON.stringify({ name: "vitest", type: "module", exports: {
      "./package.json": "./package.json", "./vitest.mjs": "./vitest.mjs",
    } }));
    writeFileSync(join(vitest, "vitest.mjs"), 'throw new Error("Synthetic inert Vitest fixture must never execute");\n');
    const input = {
      destination: "synthetic-owner/synthetic-repo", branch: "fix/reviewed-value", base_revision: git("rev-parse", "HEAD"),
      classification: "core", summary: "Verify selected synthetic value", ownership: "user_owned",
      license_review: "Synthetic user-owned fixture authorized for contribution", commit_message: "fix(fixture): verify reviewed value",
      files: [
        { path: "src/value.mjs", content: 'export const value = () => "after";\n' },
        { path: "src/value.test.mjs", content: 'import { expect, test } from "vitest";\nimport { value } from "./value.mjs";\ntest("value", () => expect(value()).toBe("after"));\n' },
      ], test_files: ["src/value.test.mjs"],
    };
    const body = { action: "create", agentId, workspace: repository, input };
    const response = await contribution(req("contribution-authoring", "POST", body));
    expect(response.status).toBe(200);
    const pending = await response.json() as { operation_id: string; proposal_id: string };
    expect(getPendingAction(pending.proposal_id)?.status).toBe("pending");
    const review = await preview(req(`authoring-operations/${pending.operation_id}?type=contribution`), { params: Promise.resolve({ id: pending.operation_id }) });
    expect(review.headers.get("cache-control")).toBe("no-store");
    expect(await review.text()).toContain("src/value.mjs");
    const metadata = JSON.parse(String(await inspectAuthoringOperationTool.invoke(
      { id: pending.operation_id, type: "contribution" },
      { configurable: { thread_id: getOrCreateAgentThread(agentId).thread_id } },
    )));
    for (const field of ["files", "diff", "test_sources", "repository_evidence"]) expect(metadata).not.toHaveProperty(field);
    expect((await contribution(req("contribution-authoring", "POST", { action: "commit", agentId, operation_id: pending.operation_id }))).status).toBe(400);
    expect((await deny(req("pending-actions/deny", "POST", {}), { params: Promise.resolve({ id: pending.proposal_id }) })).status).toBe(200);
    expect(git("branch", "--list", input.branch)).toBe("");
    expect(readFileSync(join(repository, "src", "value.mjs"), "utf8")).toContain('"before"');
    expect(git("status", "--porcelain")).toBe("");
    const another = await (await contribution(req("contribution-authoring", "POST", body))).json() as { operation_id: string; proposal_id: string };
    const cancellation = JSON.parse(String(await cancelAuthoringOperationTool.invoke(
      { id: another.operation_id, type: "contribution" },
      { configurable: { thread_id: getOrCreateAgentThread(agentId).thread_id } },
    )));
    expect(cancellation).toMatchObject({ cancellation_requested: true, rollback: false, inspect_required: true });
    expect(cancellation).not.toHaveProperty("files");
    expect(getPendingAction(another.proposal_id)?.status).toBe("denied");
    expect((await contribution(req("contribution-authoring", "POST", { ...body, input: { ...input, ownership: "unknown" } }))).status).toBe(400);
    expect((await contribution(req("contribution-authoring", "POST", body, "remote.invalid"))).status).toBe(403);
  });
});
