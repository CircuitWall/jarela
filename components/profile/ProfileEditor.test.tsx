// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("ProfileEditor", () => {
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
