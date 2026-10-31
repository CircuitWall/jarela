// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentEditorForm } from "./useAgentEditorForm";
import type { AgentConfig } from "@/api/types";
import { USAGE_PROFILES } from "@/lib/agents/usage-profile";
import { IdentitySection } from "./IdentitySection";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

vi.mock("@/hooks/useTools", () => {
  const tools: never[] = [];
  return { useTools: () => ({ tools }) };
});
vi.mock("./useAgentExternalData", () => ({ useAgentExternalData: () => ({}) }));
vi.mock("./useAgentToolHandlers", () => ({ useAgentToolHandlers: () => ({}) }));

describe("agent icon file lifecycle", () => {
  it("keeps the newest selection when an older file finishes later", () => {
    const readers: FileReader[] = [];
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      readers.push(this);
    });
    const { container } = render(<IconEditor />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["old"], "old.png")] } });
    fireEvent.change(input, { target: { files: [new File(["new"], "new.png")] } });
    act(() => {
      Object.defineProperty(readers[1], "result", { value: "data:image/png;base64,new" });
      readers[1].dispatchEvent(new ProgressEvent("load"));
      Object.defineProperty(readers[0], "result", { value: "data:image/png;base64,old" });
      readers[0].dispatchEvent(new ProgressEvent("load"));
    });
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,new");
  });

  it("shows a file-read failure instead of silently keeping the previous icon", () => {
    let reader!: FileReader;
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      reader = this;
    });
    const { container } = render(<IconEditor />);
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["synthetic"], "avatar.png")] },
    });
    act(() => reader.dispatchEvent(new ProgressEvent("error")));
    expect(screen.getByRole("alert").textContent).toContain("Could not read that image");
  });
});

function IconEditor() {
  const form = useAgentEditorForm(undefined);
  return <IdentitySection form={form} />;
}

describe("agent usage profile defaults", () => {
  it("shows one persona editor with direct accessible sliders and no MBTI picker", () => {
    function Editor() {
      const form = useAgentEditorForm(undefined);
      return <IdentitySection form={form} />;
    }
    render(<Editor />);
    expect(screen.getByRole("group", { name: "Persona" })).toBeTruthy();
    expect(screen.queryByText(/MBTI/)).toBeNull();
    const warmth = screen.getByRole("slider", { name: "Warmth" }) as HTMLInputElement;
    expect(warmth.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Home/ }));
    expect(warmth.disabled).toBe(false);
    expect(warmth.value).toBe("80");
    const detail = screen.getByRole("slider", { name: "Response detail" }) as HTMLInputElement;
    expect(detail.value).toBe("25");
    fireEvent.change(detail, { target: { value: "89" } });
    fireEvent.click(screen.getByRole("button", { name: /^Home/ }));
    expect(detail.value).toBe("89");
    fireEvent.click(screen.getByRole("checkbox", { name: "Customize response style" }));
    expect(detail.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Customize response style" }));
    expect(detail.disabled).toBe(false);
    expect(detail.value).toBe("89");
    fireEvent.click(screen.getByRole("button", { name: /^Custom/ }));
    expect(detail.value).toBe("89");
  });

  it.each([
    ["home", "standard"],
    ["work", "standard"],
    ["dev", "strict"],
  ] as const)("suggests editable %s defaults and persists the profile", (profile, citation) => {
    const { result } = renderHook(() => useAgentEditorForm(undefined));
    act(() => result.current.selectUsageProfile(profile));
    expect(result.current.buildPayload()).toMatchObject({
      usage_profile: profile,
      adaptive_persona_enabled: true, citation_strictness: citation,
      adaptive_empathy: USAGE_PROFILES[profile].style!.empathy,
      adaptive_expressiveness: USAGE_PROFILES[profile].style!.expressiveness,
      adaptive_verbosity: USAGE_PROFILES[profile].style!.verbosity,
      adaptive_persona_strength: USAGE_PROFILES[profile].style!.strength,
    });
    expect(result.current.buildPayload()).not.toHaveProperty("adaptive_mbti");
    act(() => {
      result.current.setAdaptiveEmpathy(42);
      result.current.setAdaptiveVerbosity(91);
      result.current.setCitationStrictness("informational");
    });
    act(() => result.current.selectUsageProfile(profile));
    expect(result.current.buildPayload()).toMatchObject({
      usage_profile: profile, adaptive_empathy: 42, adaptive_verbosity: 91, citation_strictness: "informational",
    });
    act(() => result.current.selectUsageProfile("custom"));
    expect(result.current.buildPayload()).toMatchObject({
      usage_profile: "custom", adaptive_empathy: 42, adaptive_verbosity: 91, citation_strictness: "informational",
    });
  });

  it("does not reset tuned settings just by opening a saved profile", () => {
    const agent = {
      usage_profile: "home", adaptive_mbti: "ISFJ", adaptive_persona_enabled: false,
      adaptive_persona_strength: 13, adaptive_empathy: 27,
      adaptive_expressiveness: 81, adaptive_verbosity: 93, citation_strictness: "strict",
    } as AgentConfig;
    const { result } = renderHook(() => useAgentEditorForm(agent));
    expect(result.current.buildPayload()).toMatchObject({
      usage_profile: "home", adaptive_persona_enabled: false,
      adaptive_persona_strength: 13, adaptive_empathy: 27,
      adaptive_expressiveness: 81, adaptive_verbosity: 93,
      citation_strictness: "strict",
    });
    expect(result.current.buildPayload()).not.toHaveProperty("adaptive_mbti");
    act(() => result.current.setAdaptivePersonaEnabled(true));
    expect(result.current.buildPayload().adaptive_verbosity).toBe(93);
  });
});
