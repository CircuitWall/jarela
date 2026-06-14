import type { APIRequestContext, Page } from "@playwright/test";

/** Seed a mock model + agent via the public API so the app skips the
 *  first-run setup wizard. Returns the agent id. */
export async function seedMockAgent(request: APIRequestContext): Promise<{ model: string; agent: string }> {
  const modelName = "e2e-mock";
  const agentName = "E2E Mock";

  // Idempotent: upsertModelConfig uses name as the key.
  const modelRes = await request.post("/api/v1/models", {
    data: {
      name: modelName,
      provider: "mock",
      model_id: "mock-1",
      params: {},
      is_default: true,
    },
  });
  if (!modelRes.ok()) {
    throw new Error(`seed model failed: ${modelRes.status()} ${await modelRes.text()}`);
  }

  // Look up existing agents first so re-runs don't create duplicates.
  const list = await request.get("/api/v1/agents");
  if (list.ok()) {
    const existing = (await list.json()) as Array<{ id: string; name: string }>;
    const hit = existing.find((a) => a.name === agentName);
    if (hit) return { model: modelName, agent: hit.id };
  }

  const agentRes = await request.post("/api/v1/agents", {
    data: {
      name: agentName,
      identity: "A deterministic test agent backed by the mock provider.",
      instructions: "Respond exactly as the user's MOCK: directives instruct.",
      tools: [],
      model_config_name: modelName,
      is_default: true,
    },
  });
  if (!agentRes.ok()) {
    throw new Error(`seed agent failed: ${agentRes.status()} ${await agentRes.text()}`);
  }
  const body = (await agentRes.json()) as { id: string };
  return { model: modelName, agent: body.id };
}

// BootScreen (components/ui/BootScreen.tsx) overlays the whole app at
// z-[70] until an agent is picked AND prefetch settles, intercepting
// clicks on the header menu button. `toBeVisible()` on the chat input
// passes while the overlay is still mounted because the placeholder
// lives below it in the DOM. Click the default agent tile (the tile is
// labelled `Open <agent name>` during the `pick` phase) and wait until
// the overlay actually unmounts before driving the UI in tests that
// click headers, menus, or modals.
export async function waitForAppReady(page: Page, timeout = 30_000): Promise<void> {
  const overlay = page.locator('[role="status"][aria-live="polite"].fixed.inset-0');
  if (await overlay.count()) {
    const pickTile = page.locator('button[aria-label^="Open "]').first();
    if (await pickTile.isVisible().catch(() => false)) {
      await pickTile.click({ timeout: 5_000 }).catch(() => { /* already opening */ });
    }
  }
  await overlay.waitFor({ state: "detached", timeout });
}

// Dismiss the floating banners that overlay the top of the chat
// surface. The crypto-fallback banner (`absolute` left/right, z-30,
// `top: calc(3rem + safe-top)`) and the OS-notification banner
// (`absolute top-9 z-30`) both sit right where the Settings/Tools
// sub-tab strips render, so without dismissing them, clicks on tabs
// like "Credentials" or "Packages" fail under headless chromium
// (which reports Notification.permission === "denied"). Mobile-Safari
// happens to pass because `Notification === undefined` in that
// engine, which is why the failure is project-specific.
//
// Call this in test.beforeEach BEFORE `page.goto("/")` so the keys
// are seeded on the target origin before React mounts.
export async function dismissOverlayBanners(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("jarela:crypto-fallback-banner-dismissed", "1");
      localStorage.setItem("jarela:notif-banner-dismissed", "1");
    } catch {
      /* sandboxed origin — banner stays, individual specs deal with it */
    }
  });
}
