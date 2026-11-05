// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IdleCompactionChoice } from "./IdleCompactionChoice";

describe("IdleCompactionChoice", () => {
  it("reuses the shared choice fields and submits the selected answer", async () => {
    const onAnswer = vi.fn(async () => true);
    render(<IdleCompactionChoice open busy={false} onAnswer={onAnswer} />);

    expect(screen.getByRole("dialog").textContent).toContain("Would you like to compact this conversation now?");
    fireEvent.click(screen.getByLabelText("Yes, compact and keep the latest topic hot"));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("compact"));
  });

  it("keeps the choice visible and reports a failed answer", async () => {
    render(<IdleCompactionChoice open busy={false} onAnswer={async () => false} />);
    fireEvent.click(screen.getByLabelText("No, keep the current context"));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The current context was kept");
  });
});
