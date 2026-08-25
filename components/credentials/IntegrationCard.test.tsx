// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntegrationCard } from "./IntegrationCard";
import type { IntegrationDefinition } from "@/api/types";

const claudeCodeDefinition: IntegrationDefinition = {
  name: "claude-code",
  label: "Claude Code",
  category: "infrastructure",
  description: "Used by claude_delegate.",
  fields: [
    { key: "cli_path", label: "CLI path (optional)", placeholder: "/opt/homebrew/bin/claude", secret: false, required: false },
    { key: "api_key", label: "Anthropic API key (optional)", placeholder: "sk-ant-...", secret: true, required: false },
    { key: "auth_token", label: "Anthropic auth token (optional)", placeholder: "auth_...", secret: true, required: false },
    { key: "base_url", label: "Anthropic base URL (optional)", placeholder: "https://api.anthropic.com", secret: false, required: false },
    { key: "default_opus_model", label: "Default Opus model (optional)", placeholder: "claude-opus-4-1", secret: false, required: false },
    { key: "default_sonnet_model", label: "Default Sonnet model (optional)", placeholder: "claude-sonnet-4-5", secret: false, required: false },
    { key: "default_haiku_model", label: "Default Haiku model (optional)", placeholder: "claude-haiku-4-5", secret: false, required: false },
    { key: "default_model", label: "Default delegate model (optional)", placeholder: "sonnet", secret: false, required: false },
    { key: "default_tools", label: "Default Claude tools (optional)", placeholder: "default", secret: false, required: false },
    { key: "default_add_dirs", label: "Extra directories (optional)", placeholder: "/path/one, /path/two", secret: false, required: false },
    { key: "default_permission_mode", label: "Permission mode (optional)", placeholder: "dontAsk", secret: false, required: false },
    { key: "default_allow_unsafe", label: "Allow unsafe by default (optional)", placeholder: "false", secret: false, required: false },
    { key: "default_background", label: "Run in background by default (optional)", placeholder: "false", secret: false, required: false },
    { key: "default_timeout_seconds", label: "Timeout seconds (optional)", placeholder: "600", secret: false, required: false },
    { key: "default_sync_memory", label: "Memory sync mode (optional)", placeholder: "both", secret: false, required: false },
    { key: "default_escalate_questions", label: "Ask design questions by default (optional)", placeholder: "true", secret: false, required: false },
  ],
};

describe("IntegrationCard — Claude Code launch profile", () => {
  it("groups Claude connection fields separately from launch defaults", () => {
    render(
      <IntegrationCard
        definition={claudeCodeDefinition}
        status={{
          name: "claude-code",
          configured: true,
          values: {
            cli_path: "/opt/homebrew/bin/claude",
            default_model: "sonnet",
            default_background: "true",
          },
          updated_at: "2026-08-25T00:00:00.000Z",
        }}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Connection").some((el) => el.tagName === "DIV")).toBe(true);
    expect(screen.getAllByText("Launch defaults").some((el) => el.tagName === "DIV")).toBe(true);
    expect(screen.getByText(/These defaults apply whenever an agent calls/)).toBeTruthy();
    expect(screen.getByLabelText(/CLI path/)).toHaveProperty("value", "/opt/homebrew/bin/claude");
    expect(screen.getByLabelText(/Default delegate model/)).toHaveProperty("value", "sonnet");
    expect(screen.getByLabelText(/Run in background by default/)).toHaveProperty("value", "true");
  });
});