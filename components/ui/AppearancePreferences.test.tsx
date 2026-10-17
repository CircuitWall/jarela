// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider, useTheme } from "@/contexts/ThemeContext";

function PreferenceProbe() {
  const { accentColor, setAccentColor, surfaceStyle, setSurfaceStyle } = useTheme();
  return (
    <div>
      <span data-testid="accent">{accentColor}</span>
      <span data-testid="surface">{surfaceStyle}</span>
      <button onClick={() => setAccentColor("teal")}>Choose teal</button>
      <button onClick={() => setAccentColor("default")}>Choose default</button>
      <button onClick={() => setSurfaceStyle("ambient")}>Choose atmospheric</button>
      <button onClick={() => setSurfaceStyle("liquid")}>Choose Liquid Glass</button>
    </div>
  );
}

describe("ThemeContext appearance preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-accent-color");
    document.documentElement.removeAttribute("data-surface-style");
  });

  it("restores, applies, and resets appearance choices", async () => {
    localStorage.setItem("jarela-accent-color", "rose");
    localStorage.setItem("jarela-surface-style", "calm");
    render(
      <ThemeProvider>
        <PreferenceProbe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("accent").textContent).toBe("rose");
      expect(screen.getByTestId("surface").textContent).toBe("calm");
      expect(document.documentElement.dataset.accentColor).toBe("rose");
      expect(document.documentElement.dataset.surfaceStyle).toBe("calm");
    });

    fireEvent.click(screen.getByRole("button", { name: "Choose teal" }));
    expect(document.documentElement.dataset.accentColor).toBe("teal");
    expect(localStorage.getItem("jarela-accent-color")).toBe("teal");

    fireEvent.click(screen.getByRole("button", { name: "Choose default" }));
    expect(document.documentElement.hasAttribute("data-accent-color")).toBe(false);
    expect(localStorage.getItem("jarela-accent-color")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Choose atmospheric" }));
    expect(document.documentElement.dataset.surfaceStyle).toBe("ambient");
    expect(localStorage.getItem("jarela-surface-style")).toBe("ambient");

    fireEvent.click(screen.getByRole("button", { name: "Choose Liquid Glass" }));
    expect(document.documentElement.dataset.surfaceStyle).toBe("liquid");
    expect(localStorage.getItem("jarela-surface-style")).toBe("liquid");
  });
});