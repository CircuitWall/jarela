// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocalFileAction } from "./LocalFileAction";

const pushToast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ui/toasts", () => ({ pushToast }));

function response(ok: boolean, body: unknown): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

describe("LocalFileAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pushToast.mockReset();
  });

  it("opens the file through the OS default app", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(true, { ok: true }));
    render(<LocalFileAction href="/repo/README.md" threadId="thread-1">README.md</LocalFileAction>);

    fireEvent.click(screen.getByRole("button", { name: /README\.md/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/local-file");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({ href: "/repo/README.md", thread_id: "thread-1" });
  });

  it("reports a failure instead of pretending the file opened", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(false, { error: "ENOENT" }));
    render(<LocalFileAction href="/repo/missing.md">missing.md</LocalFileAction>);

    fireEvent.click(screen.getByRole("button", { name: /missing\.md/ }));

    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      kind: "error",
      title: "Could not open file",
      body: "ENOENT",
    })));
  });
});
