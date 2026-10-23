// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { OnboardingWizard } from "./OnboardingWizard";

const apiMocks = vi.hoisted(() => ({
  profileGet: vi.fn(),
  profileUpdate: vi.fn(),
  modelsList: vi.fn(),
  agentsList: vi.fn(),
  agentsCreate: vi.fn(),
  integrationsList: vi.fn(),
  toolsList: vi.fn(),
  threadCreate: vi.fn(),
  persistKickoff: vi.fn(),
  dispatch: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  api: {
    profile: { get: apiMocks.profileGet, update: apiMocks.profileUpdate },
    models: { list: apiMocks.modelsList },
    agents: { list: apiMocks.agentsList, create: apiMocks.agentsCreate },
    integrations: { list: apiMocks.integrationsList },
    tools: { list: apiMocks.toolsList },
    threads: { create: apiMocks.threadCreate },
  },
}));
vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ state: { experienceMode: "essential" }, dispatch: apiMocks.dispatch }),
  persistFirstRunChatKickoff: apiMocks.persistKickoff,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: apiMocks.routerPush }) }));
vi.mock("@/lib/env/app-config", () => ({ getAppName: () => "Jarela" }));
vi.mock("@/components/ui/Logo", () => ({ Logo: () => null }));
vi.mock("./wizard/StepProfile", () => ({
  StepProfile: ({ name, onNameChange }: { name: string; onNameChange: (value: string) => void }) => (
    <input aria-label="Profile name" value={name} onChange={(event) => onNameChange(event.target.value)} />
  ),
}));
vi.mock("./wizard/StepCredentials", () => ({ StepCredentials: () => null }));
vi.mock("./wizard/StepModel", () => ({
  StepModel: ({ defaultProvider }: { defaultProvider?: string }) => (
    <div data-testid="model-step-provider">{defaultProvider ?? "no-default-provider"}</div>
  ),
}));
vi.mock("./wizard/StepAgent", () => ({
  StepAgent: ({ starter }: { starter?: { name: string; onNameChange: (value: string) => void; goal: string; onGoalChange: (value: string) => void } }) => starter ? (
    <>
      <input aria-label="Assistant name" value={starter.name} onChange={(event) => starter.onNameChange(event.target.value)} />
      <textarea aria-label="Starter goal" value={starter.goal} onChange={(event) => starter.onGoalChange(event.target.value)} />
    </>
  ) : null,
}));
vi.mock("./wizard/StepReview", () => ({ StepReview: () => null }));
vi.mock("./wizard/WizardStepper", () => ({ WizardStepper: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.profileGet.mockResolvedValue({ name: "", about: "" });
  apiMocks.profileUpdate.mockResolvedValue({});
  apiMocks.modelsList.mockResolvedValue([]);
  apiMocks.agentsList.mockResolvedValue([]);
  apiMocks.agentsCreate.mockResolvedValue({ id: "starter-agent", name: "Assistant", is_default: true, model_config_name: "model" });
  apiMocks.integrationsList.mockResolvedValue({ definitions: [], statuses: [] });
  apiMocks.toolsList.mockResolvedValue([]);
  apiMocks.threadCreate.mockResolvedValue({ thread_id: "first-run-thread" });
});

it("explains setup-data failures and retries loading", async () => {
  apiMocks.modelsList.mockRejectedValueOnce(new Error("offline"));
  render(<OnboardingWizard context="setup" />);

  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  await waitFor(() => expect(apiMocks.modelsList).toHaveBeenCalledTimes(2));
  await screen.findByRole("button", { name: "Continue" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("creates the minimal starter agent and starts a personalized first chat on finish", async () => {
  apiMocks.profileGet.mockResolvedValue({ name: "Robin", about: "I manage a small project team." });
  apiMocks.modelsList.mockResolvedValue([{
    name: "default-model",
    provider: "openai",
    model_id: "gpt-test",
    is_default: true,
  }]);
  apiMocks.agentsCreate.mockResolvedValue({
    id: "starter-agent",
    name: "Robin's assistant",
    is_default: true,
    model_config_name: "default-model",
  });
  apiMocks.toolsList.mockResolvedValue([{ name: "update_agent_instruction", category: "Config", status: "enabled" }]);
  render(<OnboardingWizard context="setup" />);

  await screen.findByRole("button", { name: "Continue" });
  for (let index = 0; index < 3; index++) {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  }
  fireEvent.change(screen.getByRole("textbox", { name: "Assistant name" }), {
    target: { value: "Robin's assistant" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Starter goal" }), {
    target: { value: "Help me plan weekly team check-ins." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Start our first chat" }));

  await waitFor(() => expect(apiMocks.agentsCreate).toHaveBeenCalledOnce());
  expect(apiMocks.agentsCreate).toHaveBeenCalledWith(expect.objectContaining({
    name: "Robin's assistant",
    is_default: true,
    model_config_name: "default-model",
    tools: ["update_agent_instruction"],
    instructions: expect.stringContaining("Help me plan weekly team check-ins."),
  }));
  expect(apiMocks.agentsCreate.mock.calls[0][0].instructions).toContain("Never change saved instructions without my explicit approval.");
  expect(apiMocks.profileUpdate).toHaveBeenCalledWith(expect.objectContaining({
    name: "Robin",
    about: "I manage a small project team.",
  }));
  expect(apiMocks.dispatch).toHaveBeenCalledWith({
    type: "SELECT_THREAD",
    threadId: "first-run-thread",
    agentId: "starter-agent",
  });
  expect(apiMocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_FIRST_RUN_CHAT_KICKOFF" }));
  expect(apiMocks.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
    type: "SET_FIRST_RUN_CHAT_KICKOFF",
    kickoff: {
      agentId: "starter-agent",
      message: expect.stringContaining("Help me plan weekly team check-ins."),
    },
  });
  expect(apiMocks.dispatch.mock.calls.at(-1)?.[0].kickoff.message).toContain("I named you Robin's assistant.");
  expect(apiMocks.dispatch.mock.calls.at(-1)?.[0].kickoff.message).toContain("openai gpt-test");
  expect(apiMocks.routerPush).toHaveBeenCalledWith("/");
});

it.each([
  { statuses: [{ name: "openai", configured: true }], expected: "openai" },
  { statuses: [{ name: "google", configured: true }], expected: "gemini" },
  { statuses: [{ name: "openai", configured: true }, { name: "anthropic", configured: true }], expected: "no-default-provider" },
])("passes the sole configured provider into model setup", async ({ statuses, expected }) => {
  apiMocks.profileGet.mockResolvedValue({ name: "Robin", about: "" });
  apiMocks.integrationsList.mockResolvedValue({ definitions: [], statuses });
  render(<OnboardingWizard context="setup" />);

  await screen.findByRole("button", { name: "Continue" });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  expect((await screen.findByTestId("model-step-provider")).textContent).toBe(expected);
});

it("does not let disabled-only models satisfy setup readiness", async () => {
  apiMocks.profileGet.mockResolvedValue({ name: "Robin", about: "" });
  apiMocks.modelsList.mockResolvedValue([{
    name: "disabled-model",
    provider: "openai",
    model_id: "gpt-test",
    is_default: false,
    enabled: false,
  }]);
  render(<OnboardingWizard context="setup" />);

  await screen.findByRole("button", { name: "Continue" });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
});

async function advanceToFirstChat() {
  await screen.findByRole("button", { name: "Continue" });
  for (let index = 0; index < 3; index++) {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  }
  fireEvent.change(screen.getByRole("textbox", { name: "Assistant name" }), {
    target: { value: "Personal assistant" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

it.each([true, false])("uses an enabled starter model when the first model is disabled (default=%s)", async (isDefault) => {
  apiMocks.profileGet.mockResolvedValue({ name: "Robin" });
  apiMocks.modelsList.mockResolvedValue([
    { name: "disabled", provider: "openai", model_id: "disabled-test", enabled: false, is_default: isDefault },
    { name: "enabled", provider: "anthropic", model_id: "enabled-test", enabled: true, is_default: false },
  ]);
  apiMocks.agentsCreate.mockResolvedValue({
    id: "starter-agent", name: "Personal assistant", model_config_name: "enabled", is_default: true,
  });
  render(<OnboardingWizard context="setup" />);
  await advanceToFirstChat();
  fireEvent.click(screen.getByRole("button", { name: "Start our first chat" }));

  await waitFor(() => expect(apiMocks.routerPush).toHaveBeenCalledWith("/"));
  expect(apiMocks.agentsCreate).toHaveBeenCalledWith(expect.objectContaining({
    model_config_name: "enabled",
  }));
  expect(apiMocks.persistKickoff).toHaveBeenCalledWith(expect.objectContaining({
    message: expect.stringContaining("anthropic enabled-test"),
  }));
});

it("reports tool-catalog failure accessibly and retries without creating an incomplete assistant", async () => {
  apiMocks.profileGet.mockResolvedValue({ name: "Robin" });
  apiMocks.modelsList.mockResolvedValue([
    { name: "model", provider: "openai", model_id: "gpt-test", enabled: true, is_default: true },
  ]);
  apiMocks.toolsList.mockRejectedValueOnce(new Error("Tool catalog unavailable. Try again."));
  render(<OnboardingWizard context="setup" />);
  await advanceToFirstChat();
  fireEvent.click(screen.getByRole("button", { name: "Start our first chat" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Tool catalog unavailable. Try again.");
  expect(alert.className.split(/\s+/)).not.toContain("hidden");
  expect(apiMocks.agentsCreate).not.toHaveBeenCalled();
  expect(apiMocks.profileUpdate).not.toHaveBeenCalled();
  expect(apiMocks.threadCreate).not.toHaveBeenCalled();
  expect(apiMocks.routerPush).not.toHaveBeenCalled();

  apiMocks.toolsList.mockResolvedValue([
    { name: "update_agent_instruction", category: "Config", status: "enabled" },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Start our first chat" }));
  await waitFor(() => expect(apiMocks.routerPush).toHaveBeenCalledWith("/"));
  expect(apiMocks.agentsCreate).toHaveBeenCalledOnce();
  expect(apiMocks.agentsCreate).toHaveBeenCalledWith(expect.objectContaining({
    tools: ["update_agent_instruction"],
  }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("reuses a created assistant when retrying a failed profile save", async () => {
  apiMocks.profileGet.mockResolvedValue({ name: "Robin" });
  apiMocks.modelsList.mockResolvedValue([
    { name: "model", provider: "openai", model_id: "gpt-test", enabled: true, is_default: true },
  ]);
  apiMocks.profileUpdate.mockRejectedValueOnce(new Error("Profile save failed. Try again."));
  render(<OnboardingWizard context="setup" />);
  await advanceToFirstChat();
  fireEvent.click(screen.getByRole("button", { name: "Start our first chat" }));

  expect((await screen.findByRole("alert")).textContent).toContain("Profile save failed.");
  expect(apiMocks.threadCreate).not.toHaveBeenCalled();
  expect(apiMocks.routerPush).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Start our first chat" }));
  await waitFor(() => expect(apiMocks.routerPush).toHaveBeenCalledWith("/"));
  expect(apiMocks.agentsCreate).toHaveBeenCalledOnce();
  expect(apiMocks.profileUpdate).toHaveBeenCalledTimes(2);
  expect(apiMocks.threadCreate).toHaveBeenCalledOnce();
});