// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AppProvider, clearFirstRunChatKickoff, persistFirstRunChatKickoff, useAppContext } from "@/contexts/AppContext";

function KickoffProbe() {
  const { state } = useAppContext();
  return <output>{state.firstRunChatKickoff?.message ?? "no pending kickoff"}</output>;
}

afterEach(() => {
  clearFirstRunChatKickoff();
  window.localStorage.clear();
});

it("restores an unfinished first-chat kickoff after a same-tab refresh", async () => {
  persistFirstRunChatKickoff({
    id: "first-run-1",
    agentId: "assistant-1",
    message: "Let's get to know each other.",
  });

  render(<AppProvider><KickoffProbe /></AppProvider>);

  expect(await screen.findByText("Let's get to know each other.")).toBeTruthy();
});
