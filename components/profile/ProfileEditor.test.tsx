// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profileGet: vi.fn(),
  profileUpdate: vi.fn(),
  setLocationConsent: vi.fn(),
  accessList: vi.fn(),
  tailscaleStatus: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  api: {
    profile: {
      get: mocks.profileGet,
      update: mocks.profileUpdate,
      setLocationConsent: mocks.setLocationConsent,
    },
    access: { list: mocks.accessList },
    tailscale: { status: mocks.tailscaleStatus },
  },
}));
vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ state: { experienceMode: "essential" }, dispatch: mocks.dispatch }),
}));
vi.mock("@/hooks/useLocationSharing", () => ({ useLocationSharing: vi.fn() }));
vi.mock("@/components/ui/MarkdownTextarea", () => ({
  MarkdownTextarea: ({ value, onChange, ...props }: {
    value: string;
    onChange: (value: string) => void;
    [key: string]: unknown;
  }) => <textarea {...props} value={value} onChange={(event) => onChange(event.target.value)} />,
}));
vi.mock("@/components/ui/TextField", () => ({
  FIELD_CLASS: "",
  TextInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

import { ProfileEditor } from "./ProfileEditor";

const profile = { name: "Robin", icon: null, about: "Profile details" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.profileGet.mockResolvedValue(profile);
  mocks.accessList.mockResolvedValue([]);
  mocks.tailscaleStatus.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProfileEditor", () => {
  it("reports icon read errors and clears them on a successful retry", async () => {
    const readers: FileReader[] = [];
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      readers.push(this);
    });
    const { container } = render(<ProfileEditor />);
    await screen.findByDisplayValue(profile.name);
    const input = container.querySelector('input[type="file"]')!;
    const file = new File(["synthetic"], "avatar.png");
    fireEvent.change(input, { target: { files: [file] } });
    act(() => readers[0].dispatchEvent(new ProgressEvent("error")));
    expect(screen.getByRole("alert").textContent).toContain("Could not read that image");
    fireEvent.change(input, { target: { files: [file] } });
    act(() => {
      Object.defineProperty(readers[1], "result", { value: "data:image/png;base64,retry" });
      readers[1].dispatchEvent(new ProgressEvent("load"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("img", { name: "avatar" }).getAttribute("src")).toBe("data:image/png;base64,retry");
  });

  it("keeps a removed avatar removed when an older replacement finishes", async () => {
    mocks.profileGet.mockResolvedValueOnce({ ...profile, icon: "data:image/png;base64,saved" });
    let reader!: FileReader;
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      reader = this;
    });
    const { container } = render(<ProfileEditor />);
    await screen.findByRole("img", { name: "avatar" });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["synthetic"], "replacement.png")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove", exact: true }));
    act(() => {
      Object.defineProperty(reader, "result", { value: "data:image/png;base64,late" });
      reader.dispatchEvent(new ProgressEvent("load"));
    });
    expect(screen.queryByRole("img", { name: "avatar" })).toBeNull();
  });

  it("shows a save error and clears it when retrying successfully", async () => {
    mocks.profileUpdate
      .mockRejectedValueOnce(new Error("Profile save failed. Try again."))
      .mockResolvedValueOnce({ ...profile, name: "Updated" });

    render(<ProfileEditor />);
    const nameInput = await screen.findByPlaceholderText("Your name");
    fireEvent.change(nameInput, { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Profile save failed. Try again.");

    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(mocks.profileUpdate).toHaveBeenCalledTimes(2);
    expect((await screen.findByRole("status")).textContent).toContain("Profile saved");
  });
});
