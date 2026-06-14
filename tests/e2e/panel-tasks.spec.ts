import { test, expect } from "@playwright/test";
import { dismissOverlayBanners, seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request, page }) => {
  await seedMockAgent(request);
  await dismissOverlayBanners(page);
  await page.goto("/?tab=tasks");
});

test("Tasks panel renders Scheduled Tasks + Event-driven Tasks sections", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Scheduled Tasks" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Event-driven Tasks" })).toBeVisible();
});

test("Tasks panel empty-state copy is shown when no tasks/watchers exist", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Scheduled Tasks" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("No scheduled tasks.")).toBeVisible();
  await expect(page.getByText("No watchers.")).toBeVisible();
});
