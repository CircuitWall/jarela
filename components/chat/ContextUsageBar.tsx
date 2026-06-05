"use client";
import { useState } from "react";
import type { MessageUsage } from "@/api/types";

interface Props {
  usage: MessageUsage;
  // Thread-level cap from ThreadDetail.context_window_tokens. Used as the
  // bar's 100% baseline when the per-row snapshot doesn't carry its own
  // (older rows persisted before the tier columns existed).
  fallbackContextWindow: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Thin diagnostic bar shown under each assistant turn. The full bar width
 * represents the agent's full context window. Inside it:
 *
 *  - Hot / Warm / Facts / Overhead each get a *slot* whose width = the
 *    budget that tier was allocated at run time.
 *  - Within each slot, the *filled* portion shows the tokens that tier
 *    actually consumed; the unfilled remainder shows headroom.
 *
 * A tier pegged at its slot's right edge (no headroom) is the signal to
 * widen its share on the agent's tier-proportion slider. A tier with a lot
 * of empty space could give some up. Trailing unallocated window space
 * (output-token reserve) is rendered as a dim track.
 *
 * Pre-tier-columns rows have NULL per-tier fields; we fall back to a single
 * grey "total input" segment so the bar still surfaces *something*.
 */
export function ContextUsageBar({ usage, fallbackContextWindow }: Props) {
  const [showDetails, setShowDetails] = useState(false);

  const cap = (usage.context_window_tokens ?? fallbackContextWindow) || 0;
  if (cap <= 0) return null;

  const hasTierBreakdown =
    usage.hot_tokens !== null
    && usage.warm_tokens !== null
    && usage.facts_tokens !== null
    && usage.overhead_tokens !== null
    && usage.hot_budget_tokens !== null
    && usage.warm_budget_tokens !== null
    && usage.facts_budget_tokens !== null;

  if (!hasTierBreakdown) {
    const usedPct = Math.min(100, (usage.input_tokens / cap) * 100);
    return (
      <div className="w-full">
        <div
          className="h-[3px] w-full overflow-hidden bg-surface-3"
          title={`${usage.input_tokens.toLocaleString()} / ${cap.toLocaleString()} input tokens (${usedPct.toFixed(1)}%) — tier breakdown unavailable on legacy rows`}
        >
          <div className="h-full bg-fg-faint/40" style={{ width: `${usedPct}%` }} />
        </div>
      </div>
    );
  }

  const hotBudget = usage.hot_budget_tokens!;
  const warmBudget = usage.warm_budget_tokens!;
  const factsBudget = usage.facts_budget_tokens!;
  const hotUsed = usage.hot_tokens!;
  const warmUsed = usage.warm_tokens!;
  const factsUsed = usage.facts_tokens!;
  const overheadUsed = usage.overhead_tokens!;
  // Anthropic prompt-cache breakdown (ADR-0062). Disjoint from
  // hot/warm/facts/overhead: those tiers count fresh input, while these
  // count tokens served from / written to the prompt cache. Surface them
  // in the tooltip and expanded panel so the user can see when caching
  // is firing for this turn.
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheActive = cacheRead > 0 || cacheCreation > 0;

  // Overhead's "budget" is whatever it actually consumed — there's no slider
  // for it. Shown as a fixed-size segment so it doesn't visually compete
  // with the tunable tiers.
  const overheadBudget = overheadUsed;
  const totalBudget = hotBudget + warmBudget + factsBudget + overheadBudget;
  const trailing = Math.max(0, cap - totalBudget);

  const toPct = (n: number) => (cap > 0 ? (n / cap) * 100 : 0);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setShowDetails((v) => !v)}
        className="block w-full text-left"
        aria-label={`Context usage: ${fmtTokens(hotUsed + warmUsed + factsUsed + overheadUsed)} of ${fmtTokens(cap)} tokens`}
        title={[
          `Context window: ${cap.toLocaleString()} tokens (the model's full capacity)`,
          `This turn's prompt used ${(hotUsed + warmUsed + factsUsed + overheadUsed).toLocaleString()} tokens`,
          `Reply generated: ${usage.output_tokens.toLocaleString()} tokens`,
          ...(cacheActive
            ? [
                "",
                `Prompt cache: ${cacheRead.toLocaleString()} read · ${cacheCreation.toLocaleString()} written`,
                "(cache reads bill at 0.1× input, writes at 1.25×)",
              ]
            : []),
          "",
          "Each coloured slot's width = budget for that tier; filled portion = actually used.",
          "Red = tier overflowed its budget. Grey tail = headroom reserved for the reply.",
          "Click to expand numbers.",
        ].join("\n")}
      >
        <div className="flex h-[3px] w-full overflow-hidden bg-surface-3">
          <Slot widthPct={toPct(hotBudget)}     usedPct={hotBudget   > 0 ? (hotUsed   / hotBudget)   * 100 : 0} fill="bg-accent/70"    empty="bg-accent/15"    overflow={hotUsed   > hotBudget} title={`Hot — recent messages\n${hotUsed.toLocaleString()} / ${hotBudget.toLocaleString()} tokens used (${hotBudget > 0 ? Math.round((hotUsed/hotBudget)*100) : 0}%)`} />
          <Slot widthPct={toPct(warmBudget)}    usedPct={warmBudget  > 0 ? (warmUsed  / warmBudget)  * 100 : 0} fill="bg-amber-500/70" empty="bg-amber-500/15" overflow={warmUsed  > warmBudget} title={`Warm — summarised older history\n${warmUsed.toLocaleString()} / ${warmBudget.toLocaleString()} tokens used (${warmBudget > 0 ? Math.round((warmUsed/warmBudget)*100) : 0}%)`} />
          <Slot widthPct={toPct(factsBudget)}   usedPct={factsBudget > 0 ? (factsUsed / factsBudget) * 100 : 0} fill="bg-teal-500/70"  empty="bg-teal-500/15"  overflow={factsUsed > factsBudget} title={`Facts — retrieved memory + recall\n${factsUsed.toLocaleString()} / ${factsBudget.toLocaleString()} tokens used (${factsBudget > 0 ? Math.round((factsUsed/factsBudget)*100) : 0}%)`} />
          <Slot widthPct={toPct(overheadBudget)} usedPct={100}                                                  fill="bg-fg-faint/60"  empty="bg-fg-faint/15"  overflow={false} title={`Overhead — system prompt + scaffolding\n${overheadUsed.toLocaleString()} tokens (no budget — measured after assembly)`} />
          {trailing > 0 && <div className="h-full bg-surface-3" style={{ width: `${toPct(trailing)}%` }} aria-hidden title={`Reserved for reply: ${trailing.toLocaleString()} tokens (${Math.round((trailing/cap)*100)}% of window)`} />}
        </div>
      </button>
      {cacheActive && !showDetails && (
        <div
          className="mt-0.5 px-2 text-[10px] text-violet-500/80"
          title={[
            "Prompt cache (ADR-0062). Reads bill at 0.1× input, writes at 1.25×.",
            cacheRead > 0 ? `${cacheRead.toLocaleString()} tokens served from cache.` : "",
            cacheCreation > 0 ? `${cacheCreation.toLocaleString()} tokens written to cache.` : "",
          ].filter(Boolean).join("\n")}
        >
          {cacheRead > 0 && <>cache hit · {fmtTokens(cacheRead)} read</>}
          {cacheRead > 0 && cacheCreation > 0 && " · "}
          {cacheCreation > 0 && <>cache write · {fmtTokens(cacheCreation)}</>}
        </div>
      )}
      {showDetails && (
        <div className="mt-1 px-2 pb-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-fg-faint">
          <Row label="Hot"      color="text-accent"    used={hotUsed}      budget={hotBudget}      hint="Recent messages kept verbatim" />
          <Row label="Warm"     color="text-amber-500" used={warmUsed}     budget={warmBudget}     hint="Older history compressed into rolling summary" />
          <Row label="Facts"    color="text-teal-500"  used={factsUsed}    budget={factsBudget}    hint="Retrieved long-term memory + recall snippets" />
          <Row label="Overhead" color="text-fg-muted"  used={overheadUsed} budget={overheadUsed}   hint="System prompt + per-message scaffolding" />
          {cacheActive && (
            <span
              className="col-span-2 text-violet-500"
              title={[
                "Prompt cache (ADR-0062). Disjoint from the tiers above.",
                `Read ${cacheRead.toLocaleString()} tokens — billed at 0.1× input rate.`,
                `Wrote ${cacheCreation.toLocaleString()} tokens — billed at 1.25× input rate.`,
                "Reads pay off on subsequent turns; writes are an investment.",
              ].join("\n")}
            >
              <span className="text-violet-500">Cache</span>{" "}
              read {fmtTokens(cacheRead)}
              {cacheCreation > 0 ? ` · created ${fmtTokens(cacheCreation)}` : ""}
            </span>
          )}
          <span
            className="col-span-2 mt-0.5 border-t border-border pt-0.5"
            title={`Output: tokens the model generated in its reply.\nWindow: total context capacity of this model.`}
          >
            Output: {fmtTokens(usage.output_tokens)} · Window: {fmtTokens(cap)}
          </span>
        </div>
      )}
    </div>
  );
}

function Slot({ widthPct, usedPct, fill, empty, overflow, title }: { widthPct: number; usedPct: number; fill: string; empty: string; overflow: boolean; title?: string }) {
  if (widthPct <= 0) return null;
  const filledOfSlot = Math.min(100, Math.max(0, usedPct));
  return (
    <div className={`relative h-full ${empty}`} style={{ width: `${widthPct}%` }} title={title}>
      <div
        className={`absolute inset-y-0 left-0 ${overflow ? "bg-rose-500/80" : fill}`}
        style={{ width: `${filledOfSlot}%` }}
      />
    </div>
  );
}

function Row({ label, color, used, budget, hint }: { label: string; color: string; used: number; budget: number; hint?: string }) {
  const pct = budget > 0 ? Math.min(999, Math.round((used / budget) * 100)) : 0;
  return (
    <span title={hint}>
      <span className={color}>{label}</span> {fmtTokens(used)}
      <span className="text-fg-faint/70"> / {fmtTokens(budget)} ({pct}%)</span>
    </span>
  );
}
