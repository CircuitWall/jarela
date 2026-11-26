// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DREAMING_SETTINGS_DEFAULTS } from "@/api/dreaming";

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  update: vi.fn(),
  run: vi.fn(),
  models: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  api: {
    dreaming: { getOverview: mocks.overview, update: mocks.update, run: mocks.run },
    models: { list: mocks.models },
  },
}));

const { DreamsPanel } = await import("./DreamsPanel");

const run = {
  id: "run-1",
  agent_id: "agent-a",
  kind: "deep" as const,
  status: "completed" as const,
  started_at: "2026-11-20T03:00:00.000Z",
  finished_at: "2026-11-20T03:01:00.000Z",
  summary: "Memory: 3 records archived. Embeddings: 2 legacy vectors rewritten. Space: 4.0 KB reclaimed.",
  error: null,
  estimated_input_tokens: 419,
  estimated_output_tokens: 7,
  stats: { review: { text: "Weekly consolidation note." } },
};

function overview(overrides: Record<string, unknown> = {}) {
  return {
    settings: { ...DREAMING_SETTINGS_DEFAULTS },
    running: null,
    agents: [{
      agent_id: "agent-a",
      name: "Agent A",
      is_default: true,
      enabled: true,
      last_light_dream_at: "2026-11-20T02:00:00.000Z",
      last_deep_dream_at: "2026-11-20T03:01:00.000Z",
      last_light_boundary_seq: 12,
      last_error: null,
      light: { eligible: false, reason: "already_dreamed" },
      deep: { eligible: false, reason: "deep_not_due" },
    }, {
      agent_id: "agent-b",
      name: "Agent B",
      is_default: false,
      enabled: true,
      last_light_dream_at: null,
      last_deep_dream_at: null,
      last_light_boundary_seq: null,
      last_error: null,
      light: { eligible: true, reason: null },
      deep: { eligible: false, reason: "not_default_agent" },
    }],
    runs: [run],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.overview.mockResolvedValue(overview());
  mocks.update.mockImplementation(async (patch: { settings?: Record<string, unknown> }) =>
    overview({ settings: { ...DREAMING_SETTINGS_DEFAULTS, ...(patch.settings ?? {}) } }));
  mocks.run.mockResolvedValue({ accepted: true, run: { ...run, status: "running", finished_at: null } });
  mocks.models.mockResolvedValue([{
    name: "dream-model",
    provider: "openai",
    model_id: "gpt-4o-mini",
    params: {},
    is_default: false,
    enabled: true,
  }]);
});
afterEach(cleanup);

describe("Dreams panel", () => {
  it("renders settings, readiness, and the journal", async () => {
    render(<DreamsPanel />);
    expect(await screen.findByText("Agent A")).toBeTruthy();
    expect(screen.getByText(/already dreamed this idle window/)).toBeTruthy();
    expect(screen.getByText(/not due until the weekly slot/)).toBeTruthy();
    expect(screen.getByText(/Memory: 3 records archived/)).toBeTruthy();
    expect(screen.getByText(/Weekly note \(model-generated\)/)).toBeTruthy();
  });

  it("toggles dreaming", async () => {
    render(<DreamsPanel />);
    await screen.findByText("Agent A");

    fireEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ settings: { enabled: false } }));
  });

  it("toggles near-duplicate merging", async () => {
    render(<DreamsPanel />);
    await screen.findByText("Agent A");
    fireEvent.click(screen.getByRole("checkbox", { name: "Merge near-duplicates" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      settings: { deep_merge_enabled: false },
    }));
  });

  it("saves idle and budget changes", async () => {
    render(<DreamsPanel />);
    await screen.findByText("Agent A");

    fireEvent.change(screen.getByRole("spinbutton", { name: /Idle threshold/ }), {
      target: { value: "240" },
    });
    await waitFor(() => expect(
      (screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled,
    ).toBe(false), { timeout: 5_000 });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      settings: {
        light_idle_minutes: 240,
        light_daily_token_budget: DREAMING_SETTINGS_DEFAULTS.light_daily_token_budget,
        deep_weekly_token_budget: DREAMING_SETTINGS_DEFAULTS.deep_weekly_token_budget,
        deep_weekday: DREAMING_SETTINGS_DEFAULTS.deep_weekday,
        deep_hour: DREAMING_SETTINGS_DEFAULTS.deep_hour,
      },
    }));
  });

  it("exposes advanced limits and the dream model override", async () => {
    render(<DreamsPanel />);
    await screen.findByText("Agent A");
    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.change(screen.getByRole("spinbutton", { name: /Min new turns/ }), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Dream model" }), {
      target: { value: "dream-model" },
    });
    await waitFor(() => expect(
      (screen.getByRole("button", { name: "Save advanced" }) as HTMLButtonElement).disabled,
    ).toBe(false), { timeout: 5_000 });
    fireEvent.click(screen.getByRole("button", { name: "Save advanced" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      settings: {
        light_min_user_turns: 3,
        light_max_per_day: DREAMING_SETTINGS_DEFAULTS.light_max_per_day,
        deep_idle_minutes: DREAMING_SETTINGS_DEFAULTS.deep_idle_minutes,
        deep_budget_ms: DREAMING_SETTINGS_DEFAULTS.deep_budget_ms,
        deep_document_budget_ms: DREAMING_SETTINGS_DEFAULTS.deep_document_budget_ms,
        deep_reclaim_budget_ms: DREAMING_SETTINGS_DEFAULTS.deep_reclaim_budget_ms,
        deep_merge_max_groups: DREAMING_SETTINGS_DEFAULTS.deep_merge_max_groups,
        deep_model_config_name: "dream-model",
      },
    }));
  });

  it("starts a light dream manually with force", async () => {
    render(<DreamsPanel />);
    await screen.findByText("Agent A");
    fireEvent.click(screen.getAllByRole("button", { name: /Light/ })[0]);
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith({
      agent_id: "agent-a", kind: "light", force: true,
    }));
  });

  it("does not offer deep maintenance for non-default agents", async () => {
    render(<DreamsPanel />);
    await screen.findByText("Agent A");
    expect(screen.getAllByRole("button", { name: /Deep/ })).toHaveLength(1);
  });

  it("shows the empty journal and a load failure", async () => {
    mocks.overview.mockResolvedValueOnce(overview({ runs: [] }));
    render(<DreamsPanel />);
    expect(await screen.findByText("No dreams yet.")).toBeTruthy();
    cleanup();

    mocks.overview.mockRejectedValueOnce(new Error("dream status unavailable"));
    render(<DreamsPanel />);
    expect((await screen.findByRole("alert")).textContent).toContain("dream status unavailable");
  });

  it("shows the running state", async () => {
    mocks.overview.mockResolvedValue(overview({
      running: { agent_id: "agent-b", kind: "light", started_at: "2026-11-20T04:00:00.000Z" },
    }));
    render(<DreamsPanel />);
    expect((await screen.findByRole("status")).textContent).toContain("Light dream running");
  });
});
