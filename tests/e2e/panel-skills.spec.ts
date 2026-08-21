import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await page.goto("/?tab=tools&item=skills");
});

test("Skills tab mounts under Tools with header + repo add affordance", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder("Pick or paste an absolute path")).toBeVisible();
});

test("built-in skills list with a Clone affordance", async ({ page }) => {
  // Other spec files (and other projects running this same file in
  // parallel) share one E2E server/DB, so a writable repo may already
  // exist by the time this runs — assert the affordances exist, not their
  // enabled state, which depends on that ambient repo config.
  await expect(page.getByText("Jarela Configuration")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Clone/ }).first()).toBeVisible();
});

test("add a repo, write a skill, edit it, then delete it", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  const repoDir = mkdtempSync(join(tmpdir(), "jarela-e2e-skill-repo-"));
  try {
    await page.getByPlaceholder("Pick or paste an absolute path").fill(repoDir);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(repoDir)).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New skill" })).toBeVisible();
    await page.getByPlaceholder("e.g. code-review").fill("e2e-smoke-skill");
    await page.getByRole("textbox", { name: /Content/ }).fill("# E2E Smoke Skill\n\nWritten by the panel-skills e2e test.\n");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New skill" })).toBeHidden();

    await expect(page.getByText("E2E Smoke Skill")).toBeVisible({ timeout: 10_000 });
    await page.getByText("E2E Smoke Skill").click();
    await expect(page.getByRole("heading", { name: /Edit skill/ })).toBeVisible();
    await page.getByRole("textbox", { name: /Content/ }).fill("# E2E Smoke Skill\n\nEdited by the panel-skills e2e test.\n");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Edit skill/ })).toBeHidden();

    await page.getByText("E2E Smoke Skill").click();
    await expect(page.getByRole("textbox", { name: /Content/ })).toHaveValue(/Edited by the panel-skills e2e test/);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("E2E Smoke Skill")).toHaveCount(0);

    // Clean up the repo row too, so it doesn't linger (pointing at a
    // now-removed directory) for other tests sharing this E2E database.
    await page.getByText(repoDir).locator("..").getByRole("button", { name: "Remove repo" }).click();
    await expect(page.getByText(repoDir)).toHaveCount(0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
