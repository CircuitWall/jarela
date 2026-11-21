// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IdleCompactionChoice } from "./IdleCompactionChoice";

describe("IdleCompactionChoice", () => {
  it("asks through the shared choice card instead of a modal", async () => {
    const onAnswer = vi.fn(async () => true);
    render(<IdleCompactionChoice open busy={false} hotMessageCount={12} onAnswer={onAnswer} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Idle compaction question" })).toBeTruthy();
    expect(screen.getByText("12 messages in the hot window")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Submit response" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("Yes, compact and keep the latest topic hot"));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("compact"));
  });

  it("keeps the current context when dismissed", async () => {
    const onAnswer = vi.fn(async () => true);
    render(<IdleCompactionChoice open busy={false} hotMessageCount={10} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("keep"));
  });

  it("keeps the question visible and reports a failed answer", async () => {
    render(<IdleCompactionChoice open busy={false} hotMessageCount={10} onAnswer={async () => false} />);
    fireEvent.click(screen.getByLabelText("No, keep the current context"));
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The current context was kept");
  });

  it("renders nothing while closed", () => {
    render(<IdleCompactionChoice open={false} busy={false} hotMessageCount={20} onAnswer={async () => true} />);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("disables the answer while a run or compaction is busy", () => {
    render(<IdleCompactionChoice open busy hotMessageCount={10} onAnswer={async () => true} />);
    expect((screen.getByRole("button", { name: /Submitting/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Wait for the current run or compaction/)).toBeTruthy();
  });
});
