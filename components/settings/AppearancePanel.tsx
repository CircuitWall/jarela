"use client";
import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import { PanelHeader } from "@/components/ui/PanelHeader";
import { useTheme, type AccentColor, type SurfaceStyle, type Theme } from "@/contexts/ThemeContext";
import { useAppContext, type ExperienceMode } from "@/contexts/AppContext";
import { getAppAccentColor } from "@/lib/env/app-config";

// Visual + chrome settings that used to live in the MenuPanel footer
// (theme) and the top of the menu (Workspace mode). Hoisted here so
// every settings surface has the same shape: a Settings sub-tab with
// its own header.

export function AppearancePanel() {
  const { state, dispatch } = useAppContext();
  const { theme, setTheme, accentColor, setAccentColor, surfaceStyle, setSurfaceStyle } = useTheme();
  const isFullMode = state.experienceMode === "full";
  const defaultAccent = getAppAccentColor() ?? "#2563eb";

  const themeOptions: { value: Theme; label: string; icon: React.ReactNode; description: string }[] = [
    { value: "light",  label: "Light",  icon: <Sun size={14} />,     description: "Bright UI; ignores system preference." },
    { value: "dark",   label: "Dark",   icon: <Moon size={14} />,    description: "Dimmed UI; ignores system preference." },
    { value: "system", label: "System", icon: <Monitor size={14} />, description: "Follow the OS-level light/dark preference." },
  ];

  const modeOptions: { value: ExperienceMode; label: string; description: string }[] = [
    { value: "essential", label: "Essential", description: "Day-to-day surfaces only. Hides Memory, Bridges, Harness, Logs, Defaults from the menu." },
    { value: "full",      label: "Full",      description: "Everything visible: engine-room tabs, power-user settings, all advanced sub-tabs." },
  ];

  const hasBrandAccent = getAppAccentColor() !== null;
  const accentOptions: { value: AccentColor; label: string; swatch: string }[] = [
    { value: "default", label: hasBrandAccent ? "Brand" : "Blue", swatch: defaultAccent },
    ...(hasBrandAccent ? [{ value: "blue" as const, label: "Blue", swatch: "#2563eb" }] : []),
    { value: "teal", label: "Teal", swatch: "#0f766e" },
    { value: "violet", label: "Violet", swatch: "#6d28d9" },
    { value: "rose", label: "Rose", swatch: "#be123c" },
  ];

  const surfaceOptions: { value: SurfaceStyle; label: string; description: string }[] = [
    { value: "ambient", label: "Atmospheric", description: "Keep the background glow and current glass surfaces." },
    { value: "calm", label: "Calm", description: "Keep navigation glass subtle and the background quiet." },
    { value: "liquid", label: "Liquid Glass", description: "Let background colors show through with brighter edge reflections." },
  ];

  function setMode(mode: ExperienceMode) {
    if (mode === state.experienceMode) return;
    dispatch({ type: "SET_EXPERIENCE_MODE", mode });
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader icon={<Palette size={14} />} title="Appearance" />

      <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 space-y-6">
        <section>
          <h3 className="text-[11px] uppercase tracking-wide text-fg-faint mb-2 px-1">Accent color</h3>
          <div className="flex flex-wrap gap-2">
            {accentOptions.map((option) => {
              const active = accentColor === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setAccentColor(option.value)}
                  aria-label={`${option.label} accent color`}
                  aria-pressed={active}
                  title={option.label}
                  className={`control-tap inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                    active ? "border-accent bg-accent/10 text-fg" : "border-border bg-surface-2 text-fg-muted hover:bg-surface-3"
                  }`}
                >
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full" style={{ backgroundColor: option.swatch }}>
                    {active && <Check size={11} className="text-white" />}
                  </span>
                  {option.label}
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <h3 className="text-[11px] uppercase tracking-wide text-fg-faint mb-2 px-1">Theme</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {themeOptions.map((o) => {
              const active = theme === o.value;
              return (
                <button
                  key={o.value}
                  onClick={() => setTheme(o.value)}
                  aria-pressed={active}
                  className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                    active
                      ? "border-accent bg-accent/10 text-fg"
                      : "border-border bg-surface-2 text-fg-muted hover:bg-surface-3"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-fg-subtle">{o.icon}</span>
                    <span className="text-sm font-medium text-fg">{o.label}</span>
                  </div>
                  <p className="text-[11px] text-fg-faint leading-snug">{o.description}</p>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <h3 className="text-[11px] uppercase tracking-wide text-fg-faint mb-2 px-1">Surface style</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {surfaceOptions.map((option) => {
              const active = surfaceStyle === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSurfaceStyle(option.value)}
                  aria-pressed={active}
                  className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                    active ? "border-accent bg-accent/10 text-fg" : "border-border bg-surface-2 text-fg-muted hover:bg-surface-3"
                  }`}
                >
                  <div className="text-sm font-medium text-fg mb-1">{option.label}</div>
                  <p className="text-[11px] text-fg-faint leading-snug">{option.description}</p>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <h3 className="text-[11px] uppercase tracking-wide text-fg-faint mb-2 px-1">Workspace mode</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {modeOptions.map((o) => {
              const active = isFullMode ? o.value === "full" : o.value === "essential";
              return (
                <button
                  key={o.value}
                  onClick={() => setMode(o.value)}
                  aria-pressed={active}
                  className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                    active
                      ? "border-accent bg-accent/10 text-fg"
                      : "border-border bg-surface-2 text-fg-muted hover:bg-surface-3"
                  }`}
                >
                  <div className="text-sm font-medium text-fg mb-1">{o.label}</div>
                  <p className="text-[11px] text-fg-faint leading-snug">{o.description}</p>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
