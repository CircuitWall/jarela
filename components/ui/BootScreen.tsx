"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentConfig } from "@/api/types";
import { api } from "@/api/client";
import { Logo } from "@/components/ui/Logo";

// Hash an agent id to a deterministic gradient so the same agent always
// renders the same color, but the colors are spread across the agent set.
const GRADIENTS = [
  "from-violet-500 to-indigo-600",
  "from-blue-500 to-cyan-600",
  "from-emerald-500 to-teal-600",
  "from-orange-500 to-amber-600",
  "from-rose-500 to-pink-600",
  "from-fuchsia-500 to-purple-600",
];
function gradientFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

interface Props {
  agents: AgentConfig[];
  agentsLoaded: boolean;
  activeAgentId: string | null;
  onPickAgent: (agentId: string) => void;
  // Boot picker is a chat-tab gate; suppress on non-chat tabs so it doesn't overlay them.
  suppressed?: boolean;
}

// Three-phase first-screen experience:
//   1. `loading` — agents haven't resolved yet. Logo + pulsing "loading agents".
//   2. `pick`    — agents resolved, no active selection. Logo + default agent
//                  big tile + up to 3 recent agents in a row.
//   3. `opening` — user clicked an agent (or one was persisted). Logo + just
//                  that agent's icon + animated "opening <name>…" text. Fades
//                  out 600ms after the active agent is set, giving ChatView
//                  time to mount and request the session.
//
// Replaces the previous splash + ChatView empty-state agent picker. The
// header (z-40) is hidden while this is visible so the user lands on a
// focused, one-purpose screen.
export function BootScreen({ agents, agentsLoaded, activeAgentId, onPickAgent, suppressed }: Props) {
  // Capture which agent we transitioned through so the icon can keep
  // showing during the fade-out, even if a parent state shift would
  // otherwise clear it.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [done, setDone] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Prefetch checklist. Drives both the step display and the dismiss
  // gate — we don't fade out until every step is settled so ChatView
  // mounts onto warm data instead of showing its own loading spinners.
  type StepStatus = "pending" | "active" | "done";
  type Step = { key: string; label: string; status: StepStatus };
  const [steps, setSteps] = useState<Step[]>([]);
  const prefetchStartedRef = useRef(false);

  const defaultAgent = useMemo(
    () => agents.find((a) => a.is_default) ?? null,
    [agents],
  );
  const recentAgents = useMemo(
    () =>
      agents
        .filter((a) => !a.is_default)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 3),
    [agents],
  );

  // The agent whose icon we show during the opening phase. Prefer the
  // explicitly-picked one (so a click animates that icon even if the
  // active-agent state changes), fall back to the active agent, then
  // the default if available.
  const focusAgent = useMemo(() => {
    const id = pickedId ?? activeAgentId;
    if (!id) return null;
    return agents.find((a) => a.id === id) ?? null;
  }, [pickedId, activeAgentId, agents]);

  const markStep = useCallback((key: string, status: StepStatus) => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, status } : s)));
  }, []);

  // Prefetch agent profile, config, thread, and recent messages BEFORE
  // we let the chat view take over. The user stays on the boot screen
  // and sees each step tick off, which is far better than landing on a
  // half-rendered chat that has to fetch the same data anyway.
  useEffect(() => {
    const id = activeAgentId ?? pickedId;
    if (!id || !agentsLoaded) return;
    if (prefetchStartedRef.current) return;
    prefetchStartedRef.current = true;

    setSteps([
      { key: "profile", label: "loading your profile", status: "active" },
      { key: "agent", label: "loading agent config", status: "active" },
      { key: "thread", label: "preparing conversation", status: "active" },
      { key: "messages", label: "loading recent messages", status: "pending" },
    ]);

    let cancelled = false;

    void (async () => {
      await Promise.allSettled([
        api.profile.get().finally(() => {
          if (!cancelled) markStep("profile", "done");
        }),
        api.agents
          .get(id)
          .finally(() => {
            if (!cancelled) markStep("agent", "done");
          }),
        (async () => {
          try {
            const t = await api.agents.getThread(id);
            if (cancelled) return;
            markStep("thread", "done");
            markStep("messages", "active");
            await api.threads.get(t.thread_id);
          } catch {
            // Errors here are non-fatal for boot — ChatView will surface
            // them with its own retry path. Just mark the steps done so
            // we don't block the user behind the splash forever.
          } finally {
            if (!cancelled) {
              markStep("thread", "done");
              markStep("messages", "done");
            }
          }
        })(),
      ]);
      if (cancelled) return;
      // Short grace period so the user actually sees the final "all
      // done" state before the screen fades.
      const settleTimer = setTimeout(() => {
        if (cancelled) return;
        setDismissing(true);
        dismissTimerRef.current = setTimeout(() => setDone(true), 500);
      }, 250);
      dismissTimerRef.current = settleTimer;
    })();

    return () => {
      cancelled = true;
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [activeAgentId, pickedId, agentsLoaded, markStep]);

  if (done) return null;
  if (suppressed) return null;

  const phase: "loading" | "pick" | "opening" =
    !agentsLoaded
      ? "loading"
      : activeAgentId || pickedId
        ? "opening"
        : "pick";

  // Show the in-flight step in the headline so the user always knows
  // what we're waiting on. Falls back to "opening <name>" before the
  // checklist initialises and after every step is done.
  const activeStep = steps.find((s) => s.status === "active");
  const statusText =
    phase === "loading"
      ? "loading agents"
      : phase === "opening"
        ? activeStep?.label ?? `opening ${focusAgent?.name ?? "agent"}`
        : "pick an agent to begin";

  function handlePick(id: string) {
    if (pickedId) return;
    setPickedId(id);
    onPickAgent(id);
  }

  // The agent rendered in the centered tile. During `loading` and
  // `pick` it's the default (so the user sees the same artwork as soon
  // as agents resolve). During `opening` it's whatever was picked.
  // Keeping this slot stable across phases is what makes the transition
  // feel seamless — only the surrounding chrome (pill, recent list)
  // fades in or out.
  const tileAgent = focusAgent ?? defaultAgent;
  const tileClickable = phase === "pick" && tileAgent !== null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={dismissing}
      className={[
        "fixed inset-0 z-[70]",
        "bg-surface text-fg",
        "transition-opacity duration-500 ease-out",
        dismissing ? "opacity-0 pointer-events-none" : "opacity-100",
      ].join(" ")}
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      {/*
        Fixed three-row layout so the Logo and headline never reflow as
        the phase changes:
          - Logo + headline pinned in a stable block above center
          - Tile slot always 11rem tall, centered
          - Recent list sits in its own slot below the tile and just
            fades its opacity in/out — it never adds or removes layout
            height, so the tile and headline stay put.
      */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
        <Logo className="h-16 w-auto" />
        <p
          className="text-[11px] uppercase tracking-[0.3em] text-fg-faint animate-pulse min-h-[1.25rem] text-center px-6"
        >
          {statusText}
        </p>

        {/* Tile slot — always reserves the same 11rem so neighbours don't shift. */}
        <div className="w-44 h-44 relative">
          {tileAgent ? (
            <button
              type="button"
              onClick={tileClickable ? () => handlePick(tileAgent.id) : undefined}
              disabled={!tileClickable}
              aria-label={
                tileClickable
                  ? `Open ${tileAgent.name}`
                  : `Opening ${tileAgent.name}`
              }
              className={[
                "absolute inset-0 rounded-3xl overflow-hidden",
                "ring-2 ring-accent/40 ring-offset-4 ring-offset-surface",
                "shadow-2xl shadow-accent/20",
                tileClickable
                  ? "hover:ring-accent/70 hover:shadow-accent/30 transition-all cursor-pointer"
                  : "cursor-default",
              ].join(" ")}
            >
              <div
                className={`absolute inset-0 bg-gradient-to-br ${gradientFor(tileAgent.id)} flex items-center justify-center text-5xl font-bold text-white select-none`}
              >
                {tileAgent.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={tileAgent.icon}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  tileAgent.name.charAt(0).toUpperCase()
                )}
              </div>

              {/*
                "default" pill — only meaningful in the picker. Fades
                out as we transition to opening so the same tile keeps
                showing without a remount flash.
              */}
              <span
                className={[
                  "absolute top-2 right-2 text-[9px] uppercase tracking-wider",
                  "px-1.5 py-0.5 rounded-full text-white bg-accent/80",
                  "backdrop-blur-sm shadow transition-opacity duration-300",
                  phase === "pick" && tileAgent.is_default
                    ? "opacity-100"
                    : "opacity-0",
                ].join(" ")}
              >
                default
              </span>

              <div className="absolute inset-x-0 bottom-0 pt-10 pb-3 px-3 bg-gradient-to-t from-black/85 via-black/55 to-transparent">
                <p className="text-base font-semibold text-white drop-shadow-sm truncate text-center">
                  {tileAgent.name}
                </p>
              </div>
            </button>
          ) : (
            <div
              className="absolute inset-0 rounded-3xl bg-surface-2/60 ring-2 ring-border/30 ring-offset-4 ring-offset-surface"
              aria-hidden
            />
          )}
        </div>

        {/*
          Recent list slot. Fixed size (so neighbours don't reflow when
          phase changes). Opacity-toggled instead of conditionally
          rendered so the picker→opening transition is a fade, not a
          layout shift.
        */}
        <div className="w-48 min-h-[8rem] relative">
          <div
            className={[
              "absolute inset-x-0 top-0 flex flex-col items-center gap-2",
              "transition-opacity duration-300",
              phase === "pick" && recentAgents.length > 0
                ? "opacity-100"
                : "opacity-0 pointer-events-none",
            ].join(" ")}
          >
            <p className="text-[10px] text-fg-faint uppercase tracking-wider">
              Recent
            </p>
            <div className="flex flex-col gap-1.5 w-full">
              {recentAgents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => handlePick(a.id)}
                  title={a.identity || a.name}
                  aria-label={`Open ${a.name}`}
                  disabled={phase !== "pick"}
                  className="flex items-center gap-3 px-3 py-2 rounded-xl border border-border/60 bg-surface-2/60 hover:bg-surface-3 hover:border-border transition-colors text-left"
                >
                  <div
                    className={`w-9 h-9 shrink-0 rounded-lg bg-gradient-to-br ${gradientFor(a.id)} flex items-center justify-center text-sm font-bold text-white select-none overflow-hidden`}
                  >
                    {a.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.icon}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      a.name.charAt(0).toUpperCase()
                    )}
                  </div>
                  <p className="text-sm text-fg-muted truncate flex-1">
                    {a.name}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {phase === "pick" &&
            !defaultAgent &&
            recentAgents.length === 0 && (
              <p className="absolute inset-x-0 top-0 text-xs text-fg-faint px-6 text-center">
                No agents configured yet. Open the menu to create one.
              </p>
            )}
        </div>
      </div>
    </div>
  );
}
