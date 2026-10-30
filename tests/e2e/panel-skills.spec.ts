import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dismissOverlayBanners, enableFullExperienceMode, seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await enableFullExperienceMode(page);
  await page.goto("/?tab=tools&item=skills");
});

test("Skills tab mounts under Tools with header + repo add affordance", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder("Pick or paste an absolute path")).toBeVisible();
});

test("execution controls expose full-trust warnings while loading a workflow stays inert", async ({ page }) => {
  const launches: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/v1\/(skill-executions|workflows)(\/|$)/.test(request.url())) launches.push(request.url());
  });
  await page.getByText("Run a checked skill", { exact: true }).click();
  await expect(page.getByText(/Explicit full-trust execution, not a sandbox/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Request execution", exact: true })).toBeDisabled();
  await page.getByText("Durable workflows", { exact: true }).click();
  await page.getByRole("button", { name: "Load read-only Memory Organization example" }).click();
  await expect(page.getByLabel("Versioned definition JSON")).toHaveValue(/memory-cleanup-review/);
  await expect(page.getByLabel("Workflow invocation JSON")).toHaveValue(/"entries": \[\]/);
  expect(launches).toEqual([]);
});

test("built-in skills list with frontmatter names and a Clone affordance", async ({ page, request }) => {
  // Other spec files (and other projects running this same file in
  // parallel) share one E2E server/DB, so a writable repo may already
  // exist by the time this runs — assert the affordances exist, not their
  // enabled state, which depends on that ambient repo config.
  const res = await request.get("/api/v1/skills");
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.skills).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "jarela-configuration", name: "jarela-configuration", source: "builtin" }),
  ]));
  await expect(page.locator("span").filter({ hasText: /^jarela-configuration$/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Clone/ }).first()).toBeVisible();
});

test("add a repo, write a skill, edit it, then delete it", async ({ page }) => {
  const repoDir = mkdtempSync(join(tmpdir(), "jarela-e2e-skill-repo-"));
  try {
    await page.getByPlaceholder("Pick or paste an absolute path").fill(repoDir);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const repoRow = page.locator("span.font-mono", { hasText: repoDir });
    await expect(repoRow).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New skill" })).toBeVisible();
    await page.getByPlaceholder("e.g. code-review").fill("e2e-smoke-skill");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: /Content/ }).fill("# E2E Smoke Skill\n\nWritten by the panel-skills e2e test.\n");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New skill" })).toBeHidden();

    const skillName = page.locator("span").filter({ hasText: /^E2E Smoke Skill$/ });
    await expect(skillName).toBeVisible({ timeout: 10_000 });
    await skillName.click();
    await expect(page.getByRole("heading", { name: /Edit skill/ })).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: /Content/ }).fill("# E2E Smoke Skill\n\nEdited by the panel-skills e2e test.\n");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Edit skill/ })).toBeHidden();

    await skillName.click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("textbox", { name: /Content/ })).toHaveValue(/Edited by the panel-skills e2e test/);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").last().getByRole("button", { name: "Delete", exact: true }).click();
    await expect(skillName).toHaveCount(0);

    // Clean up the repo row too, so it doesn't linger (pointing at a
    // now-removed directory) for other tests sharing this E2E database.
    await repoRow.locator("..").getByRole("button", { name: "Remove repo" }).click();
    await page.getByRole("dialog").last().getByRole("button", { name: "Remove", exact: true }).click();
    await expect(repoRow).toHaveCount(0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
