import { test, expect } from "@playwright/test";
import { seedMockAgent } from "./helpers";

test.describe.configure({ mode: "serial" });

function adoptionState(agentId: string, status: "pending" | "running" | "done" | "failed" | "dismissed", version = "9.9.9") {
  return {
    current_version: version,
    previous_version: null,
    is_first_adoption: true,
    status,
    phase: status === "running" ? "impact_radius" : status === "done" || status === "dismissed" ? "complete" : null,
    default_agent_id: agentId,
    default_agent_name: "E2E Mock",
    adoption_thread_id: status === "running" ? "adoption-thread" : null,
    adoption_prompt: status === "running" ? "Phase 1 — impact radius analysis\nPhase 2 — adoption\nIf Phase 1 finds no adoption work, skip Phase 2." : null,
    started_at: status === "running" || status === "done" || status === "dismissed" ? "2026-08-30T00:00:00.000Z" : null,
    completed_at: status === "done" || status === "dismissed" ? "2026-08-30T00:00:01.000Z" : null,
    dismissed_at: status === "dismissed" ? "2026-08-30T00:00:01.000Z" : null,
    summary: `Current version ${version} baseline is ready; review current guidance before relying on long-lived prompts.`,
    checklist: [
      { id: "fetch-changes", label: "Fetch changes", status: status === "done" ? "done" : "pending", reason: "Compare versions.", affected_files: [] },
      { id: "build-todo-list", label: "Build todo list", status: status === "done" ? "done" : "pending", reason: "Build Phase 2 checklist.", affected_files: [] },
    ],
    stale_prompt_risks: ["Review scheduled tasks and watchers"],
    error: status === "failed" ? "simulated adoption failure" : null,
  };
}

test.beforeEach(async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "version adoption E2E mutates global lifecycle state");
  await request.delete("/api/v1/memory/app-lifecycle/version_adoption_state").catch(() => undefined);
});

test("boot screen shows version adoption checklist without moving the brand chrome", async ({ page, request }) => {
  const { agent } = await seedMockAgent(request);
  const update = await request.get("/api/v1/update");
  const current = ((await update.json()) as { current?: string }).current ?? "9.9.9";
  await request.put("/api/v1/memory/app-lifecycle/version_adoption_state", {
    data: { value: { ...adoptionState(agent, "failed", current), last_adopted_version: null } },
  });

  await page.goto("/");

  const boot = page.locator('[role="status"][aria-live="polite"].fixed.inset-0');
  await expect(boot).toBeVisible({ timeout: 15_000 });

  await expect(boot.locator('img[src="/logo-mark-transparent.png"], img[src="/logo-mark-transparent-dark.png"]').first()).toBeAttached();
  await expect(boot.locator(".animate-pulse")).toContainText("pick an agent to begin");
  await expect(boot.getByRole("button", { name: "Open E2E Mock" }).first()).toBeVisible();

  await expect(boot.getByText("Version check")).toBeVisible({ timeout: 10_000 });
  await expect(boot.getByText(/(Adopting|Updated to) \d+\.\d+\.\d+/)).toBeVisible();
  await expect(boot.getByText("Fetch changes")).toBeVisible();
  await expect(boot.getByText("Build todo list")).toBeVisible();

  await boot.getByRole("button", { name: "Dismiss" }).click();
  await expect(boot.getByText("Version check")).toBeHidden({ timeout: 10_000 });
});

test("opening after automatic adoption uses the default agent without duplicate startup surfaces", async ({ page, request }) => {
  await seedMockAgent(request);

  await page.goto("/");

  const boot = page.locator('[role="status"][aria-live="polite"].fixed.inset-0');
  await boot.getByText("Version check").waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  const openDefaultAgent = boot.getByRole("button", { name: "Open E2E Mock" }).last();
  await expect(openDefaultAgent).toBeEnabled({ timeout: 20_000 });
  await openDefaultAgent.click();

  await expect(boot.locator(".animate-pulse")).toContainText(/loading your profile|loading agent config|preparing conversation|loading recent messages|opening E2E Mock/);
  await boot.waitFor({ state: "detached", timeout: 30_000 });
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 15_000 });
});
