"use client";
// Code-aware chat error banner. Renders one of:
//   - retry-able codes (network_error, http_5xx, http_429, rate_limit) →
//     "Retry" button alongside Copy / Dismiss
//   - auth/billing/model_not_found → "Open Settings" link to the right page
//   - tool_timeout / stream_deadline → narrow-input hint, no retry
//   - generic / unknown → message + Copy + Dismiss
//
// The previous renderer was a `<pre>` dump of the raw message in a red
// box. Users got "Couldn't load X" with no recovery path; sticky toasts
// piled up across long sessions. This card consumes the error vocabulary
// from ADR-0049 / 0050 / 0051 and surfaces actionable affordances per
// code.
//
// See ADR-0054.

import Link from "next/link";

interface Props {
  message: string;
  code: string;
  /**
   * If provided, the card renders a "Retry" button that calls this. Bound
   * by the parent only when there's a current input to retry; without one
   * the user has to retype.
   */
  onRetry?: () => void;
  /**
   * If provided AND the recipe is reconnectable, the card renders a
   * "Reconnect" button that calls this. Used for stream-drop recovery —
   * the run is still on the server, we just need to re-subscribe via the
   * replay buffer.
   */
  onReconnect?: () => void;
  /** Optional dismiss handler. When omitted the card stays until the next run. */
  onDismiss?: () => void;
}

interface Recipe {
  /** Headline shown bolder than the body. */
  title: string;
  /** Optional second line above the body — usually a recovery hint. */
  hint?: string;
  /** True when the agent's playbook + this UI agree on retry being safe. */
  retryable: boolean;
  /**
   * True when the issue is recoverable by re-subscribing to a server-side
   * run that's still in flight (stream drop, not a hard failure). The card
   * renders a "Reconnect" button when the parent passes onReconnect.
   */
  reconnectable?: boolean;
  /** Tone — "error" renders rose/red, "warning" renders amber. Defaults to "error". */
  tone?: "error" | "warning";
  /** Settings page to link to when the user needs to fix config. */
  settingsHref?: string;
  /** Label for the settings link, when present. */
  settingsLabel?: string;
}

// Map of known codes to the recipe the UI renders. Codes not in this map
// fall through to the generic recipe below — the card still renders, just
// without code-specific affordances.
const CODE_RECIPES: Record<string, Recipe> = {
  // Provider transients (ADR-0051)
  network_error: {
    title: "Network failure",
    hint: "Reaching the provider failed. The agent retried once automatically; you can try again.",
    retryable: true,
  },
  rate_limit: {
    title: "Rate-limited by the provider",
    hint: "The agent retried once after the suggested wait. If you keep hitting this, switch to a different model config.",
    retryable: true,
  },
  auth_error: {
    title: "Provider rejected the API key",
    hint: "The API key is invalid, missing, or expired. For OAuth integrations (Gmail, Outlook), reconnect the integration.",
    retryable: false,
    settingsHref: "/?settings=models",
    settingsLabel: "Open model settings",
  },
  billing_error: {
    title: "Billing or quota issue",
    hint: "The provider returned a billing/quota error. Check your provider account or switch to a different model config.",
    retryable: false,
    settingsHref: "/?settings=models",
    settingsLabel: "Open model settings",
  },
  model_not_found: {
    title: "Model unavailable",
    hint: "The configured model isn't available. Pick a different model_id in Settings.",
    retryable: false,
    settingsHref: "/?settings=models",
    settingsLabel: "Open model settings",
  },

  // Run-level (lib/agents/llm.ts + lib/agents/run-registry.ts)
  aborted: {
    title: "Run interrupted",
    retryable: false,
  },
  stream_deadline: {
    title: "Run exceeded wall-clock limit",
    hint: "Try breaking the task into smaller steps. If the task is legitimately long, raise JARELA_LLM_STREAM_MAX_MS in the env.",
    retryable: false,
  },
  recursion_limit: {
    title: "Agent took too many tool steps",
    hint: "The agent looped or chased a deep multi-step task. Simplify the prompt, or raise JARELA_RECURSION_LIMIT for genuinely deep tasks.",
    retryable: false,
  },
  context_length_exceeded: {
    title: "Context window exceeded",
    hint: "Trim history (lower history_limit / history_window_hours), pin a smaller context_window_tokens on the model config, or start a new thread.",
    retryable: false,
  },
  empty_response: {
    title: "Provider returned an empty response",
    hint: "Often a content filter or a low max_tokens for a reasoning model. Check the model config and retry.",
    retryable: true,
  },
  max_tokens_exhausted: {
    title: "max_tokens exhausted",
    hint: "Raise max_tokens in the model config and retry.",
    retryable: false,
    settingsHref: "/?settings=models",
    settingsLabel: "Open model settings",
  },
  max_tokens_truncated: {
    title: "Response truncated",
    hint: "The model hit its max_tokens limit before finishing. Raise max_tokens (Anthropic defaults to 4096) and ask the agent to continue.",
    retryable: false,
    settingsHref: "/?settings=models",
    settingsLabel: "Open model settings",
  },

  // Streaming / parsing (PR-5)
  stream_parse_failures: {
    title: "Provider stream became unparseable",
    hint: "The upstream emitted malformed events. Often clears on retry; if persistent, check the provider's status page.",
    retryable: true,
  },

  // Client-level (PR-E)
  client_error: {
    title: "Client request failed",
    retryable: true,
  },
  // Stream drop after the server already accepted the run (PR-λ). The
  // agent is still running server-side; messages were just refetched so
  // any committed result is visible. Reconnect re-subscribes via the
  // server's replay buffer.
  stream_dropped: {
    title: "Stream connection dropped",
    hint: "Refetched the latest messages — the agent may still be running. Reconnect to resume the live view.",
    retryable: false,
    reconnectable: true,
    tone: "warning",
  },
  no_model: {
    title: "No model configured",
    hint: "Add a model in the Models panel to start chatting.",
    retryable: false,
    settingsHref: "/?settings=models",
    settingsLabel: "Open model settings",
  },
};

const GENERIC_RECIPE: Recipe = {
  title: "Run failed",
  retryable: true,
};

export function ErrorCard({ message, code, onRetry, onReconnect, onDismiss }: Props) {
  const recipe = CODE_RECIPES[code] ?? GENERIC_RECIPE;
  const tone = recipe.tone ?? "error";
  const cls = tone === "warning"
    ? {
        wrap: "bg-amber-900/20 border-amber-700/50 text-amber-700 dark:text-amber-300",
        muted: "text-amber-700/80 dark:text-amber-300/80",
        moreMuted: "text-amber-700/70 dark:text-amber-300/70",
        codeText: "text-amber-700/90 dark:text-amber-300/90",
        outline: "border-amber-700/40 hover:bg-amber-700/10",
        primary: "bg-amber-600/80 text-white hover:bg-amber-600",
      }
    : {
        wrap: "bg-rose-900/30 border-rose-700/60 text-rose-700 dark:text-rose-300",
        muted: "text-rose-700/80 dark:text-rose-300/80",
        moreMuted: "text-rose-700/70 dark:text-rose-300/70",
        codeText: "text-rose-700/90 dark:text-rose-300/90",
        outline: "border-rose-700/40 hover:bg-rose-700/10",
        primary: "bg-rose-600/80 text-white hover:bg-rose-600",
      };

  return (
    <div
      className={`mx-4 mb-2 px-3 py-2 rounded border ${cls.wrap} text-xs`}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="shrink-0 mt-0.5">⚠</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium">{recipe.title}</div>
          {recipe.hint && (
            <div className={`mt-0.5 ${cls.muted}`}>{recipe.hint}</div>
          )}
          <details className="mt-1.5">
            <summary className={`cursor-pointer select-none ${cls.moreMuted} text-[11px] uppercase tracking-wider`}>
              {`details · ${code}`}
            </summary>
            <pre className={`mt-1 whitespace-pre-wrap break-all font-mono text-[11px] ${cls.codeText} max-h-32 overflow-y-auto`}>{message}</pre>
          </details>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 justify-end">
        {recipe.settingsHref && recipe.settingsLabel && (
          <Link
            href={recipe.settingsHref}
            className={`px-2 py-0.5 rounded border ${cls.outline} text-[11px]`}
          >
            {recipe.settingsLabel}
          </Link>
        )}
        <button
          type="button"
          className={`px-2 py-0.5 rounded border ${cls.outline} text-[11px]`}
          onClick={() => {
            if (typeof navigator !== "undefined" && navigator.clipboard) {
              void navigator.clipboard.writeText(`[${code}] ${message}`).catch(() => {});
            }
          }}
          aria-label="Copy error to clipboard"
        >
          Copy
        </button>
        {recipe.reconnectable && onReconnect && (
          <button
            type="button"
            className={`px-2 py-0.5 rounded ${cls.primary} text-[11px]`}
            onClick={onReconnect}
          >
            Reconnect
          </button>
        )}
        {recipe.retryable && onRetry && (
          <button
            type="button"
            className={`px-2 py-0.5 rounded ${cls.primary} text-[11px]`}
            onClick={onRetry}
          >
            Retry
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            className={`px-2 py-0.5 rounded border ${cls.outline} text-[11px]`}
            onClick={onDismiss}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
