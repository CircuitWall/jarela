// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useFirstRunChatKickoff } from "./useFirstRunChatKickoff";

const kickoff = { id: "first-run-1", agentId: "agent-1", message: "Help me personalize this assistant." };

function Probe(props: Parameters<typeof useFirstRunChatKickoff>[0]) {
  useFirstRunChatKickoff(props);
  return <button type="button" onClick={() => props.onConsumed()}>Ready</button>;
}

it("waits for the matching empty chat to load and submits a kickoff only once", async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  const onConsumed = vi.fn();
  const props = {
    kickoff,
    activeTab: "chat" as const,
    agentId: "agent-1",
    threadId: null as string | null,
    sessionLoading: true,
    messagesLoading: true,
    messageCount: 0,
    submit,
    onConsumed,
    onError: vi.fn(),
  };
  const { rerender } = render(<Probe {...props} />);
  expect(submit).not.toHaveBeenCalled();

  rerender(<Probe {...props} threadId="thread-1" sessionLoading={false} />);
  expect(submit).not.toHaveBeenCalled();

  rerender(<Probe {...props} threadId="thread-1" sessionLoading={false} messagesLoading={false} />);
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit).toHaveBeenCalledWith(kickoff.message, {
    quiet: true,
    messageMetadata: { hidden_from_chat: true },
  });
  expect(onConsumed).not.toHaveBeenCalled();

  rerender(<Probe {...props} threadId="thread-1" sessionLoading={false} messagesLoading={false} messageCount={1} />);
  expect(onConsumed).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: "Ready" }));
  rerender(<Probe {...props} threadId="thread-1" sessionLoading={false} messagesLoading={false} messageCount={1} />);
  expect(submit).toHaveBeenCalledOnce();
});

it("consumes the kickoff without sending it into a thread that already has messages", () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  const onConsumed = vi.fn();
  render(
    <Probe
      kickoff={kickoff}
      activeTab="chat"
      agentId="agent-1"
      threadId="thread-1"
      sessionLoading={false}
      messagesLoading={false}
      messageCount={1}
      submit={submit}
      onConsumed={onConsumed}
      onError={vi.fn()}
    />,
  );

  expect(submit).not.toHaveBeenCalled();
  expect(onConsumed).toHaveBeenCalledOnce();
});