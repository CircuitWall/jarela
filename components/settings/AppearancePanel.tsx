"use client";
import { EyeOff, Monitor, Moon, Palette, SlidersHorizontal, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/contexts/ThemeContext";
import { useAppContext, type ExperienceMode } from "@/contexts/AppContext";

// Visual + chrome settings that used to live in the MenuPanel footer
// (theme) and the top of the menu (Workspace mode). Hoisted here so
// every settings surface has the same shape: a Settings sub-tab with
// its own header.

export function AppearancePanel() {
  const { state, dispatch } = useAppContext();
  const { theme, setTheme } = useTheme();
  const isFullMode = state.experienceMode === "full";

  const themeOptions: { value: Theme; label: string; icon: React.ReactNode; description: string }[] = [
    { value: "light",  label: "Light",  icon: <Sun size={14} />,     description: "Bright UI; ignores system preference." },
    { value: "dark",   label: "Dark",   icon: <Moon size={14} />,    description: "Dimmed UI; ignores system preference." },
    { value: "system", label: "System", icon: <Monitor size={14} />, description: "Follow the OS-level light/dark preference." },
  ];

  const hiddenConfigHint = "Harnesses, Environment, Logs, per-function tool controls, and advanced agent tuning stay hidden until Advanced view is enabled.";
  const modeOptions: { value: ExperienceMode; label: string; eyebrow: string; icon: React.ReactNode; description: string }[] = [
    { value: "essential", label: "Basic", eyebrow: "guided", icon: <EyeOff size={14} />, description: "Day-to-day setup only. Advanced configuration is intentionally hidden." },
    { value: "full",      label: "Advanced", eyebrow: "complete", icon: <SlidersHorizontal size={14} />, description: "Everything visible: engine-room tabs, power-user settings, all advanced sub-tabs." },
  ];

  function setMode(mode: ExperienceMode) {
    if (mode === state.experienceMode) return;
    dispatch({ type: "SET_EXPERIENCE_MODE", mode });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Palette size={14} className="text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg mr-auto">Appearance</h2>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 space-y-6">
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
          <h3 className="text-[11px] uppercase tracking-wide text-fg-faint mb-2 px-1">Workspace mode</h3>
          {!isFullMode && (
            <div className="mb-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200/85">
              <div className="flex items-start gap-2">
                <EyeOff size={13} className="mt-0.5 shrink-0" />
                <span>{hiddenConfigHint}</span>
              </div>
            </div>
          )}
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
                  <div className="flex items-start gap-2 mb-1">
                    <span className={active ? "text-accent" : "text-fg-subtle"}>{o.icon}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-fg">{o.label}</div>
                      <div className="text-[9px] uppercase tracking-wide text-fg-faint">{o.eyebrow}</div>
                    </div>
                  </div>
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
