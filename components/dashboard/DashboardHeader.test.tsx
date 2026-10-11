// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { DashboardPricingTaskStatus } from "@/api/types";
import { DashboardHeader } from "./DashboardHeader";

function status(overrides: Partial<DashboardPricingTaskStatus> = {}): DashboardPricingTaskStatus {
  return {
    configured: false,
    default_agent_configured: true,
    default_agent_name: "Jassy",
    task_agent_name: null,
    next_run_at: null,
    enabled: false,
    schedule: null,
    time_zone: "Europe/Stockholm",
    ...overrides,
  };
}

function renderHeader(pricingTask: DashboardPricingTaskStatus | null, onSetupPricingTask = vi.fn()) {
  return render(
    <DashboardHeader
      days={30}
      onDaysChange={vi.fn()}
      refreshingPricing={false}
      refreshHint={null}
      onRefreshPricing={vi.fn()}
      pricingTask={pricingTask}
      settingUpPricingTask={false}
      pricingTaskHint={null}
      onSetupPricingTask={onSetupPricingTask}
    />,
  );
}

describe("DashboardHeader weekly pricing setup", () => {
  it("offers setup when no task exists and a default agent is configured", () => {
    const onSetup = vi.fn();
    renderHeader(status(), onSetup);

    fireEvent.click(screen.getByRole("button", { name: "Set up weekly updates" }));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("disables setup until a default agent is configured", () => {
    renderHeader(status({ default_agent_configured: false, default_agent_name: null }));

    expect(screen.getByRole("button", { name: "Set up weekly updates" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Set a default agent to enable weekly updates.")).toBeTruthy();
  });

  it("hides setup and reports status when the weekly task is enabled", () => {
    renderHeader(status({ configured: true, enabled: true, task_agent_name: "Jassy" }));

    expect(screen.queryByRole("button", { name: "Set up weekly updates" })).toBeNull();
    expect(screen.getByText("Weekly updates on")).toBeTruthy();
  });

  it("offers resume when the task exists but is paused", () => {
    const onSetup = vi.fn();
    renderHeader(status({ configured: true, enabled: false }), onSetup);

    fireEvent.click(screen.getByRole("button", { name: "Resume weekly updates" }));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });
});