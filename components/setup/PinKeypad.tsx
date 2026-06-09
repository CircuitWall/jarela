"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/ui/Logo";

// Shared 6-digit PIN keypad used by both the decrypt splash (master key
// locked at boot) and the screen-lock overlay (idle timer fired). The
// only differences between the two states are (a) the endpoint hit
// (b) the copy on screen and (c) what happens after success. Everything
// else — keypad layout, dot strip, rate-limit handling, keyboard
// support, error mapping — is identical, so the two were collapsed into
// one component to avoid drift.

const PIN_LENGTH = 6;

export type PinKeypadMode = "decrypt" | "unlock";

interface PinKeypadProps {
  mode: PinKeypadMode;
  onSuccess: () => void;
}

interface ModeConfig {
  endpoint: string;
  title: string;
  subtitle: string;
  busyLabel: string;
}

const MODES: Record<PinKeypadMode, ModeConfig> = {
  decrypt: {
    endpoint: "/api/v1/security/unlock",
    title: "Decrypt Jarela",
    subtitle: "Enter your 6-digit PIN to decrypt your data.",
    busyLabel: "Decrypting\u2026",
  },
  unlock: {
    endpoint: "/api/v1/security/verify-pin",
    title: "Welcome back",
    subtitle: "Enter your 6-digit PIN to unlock.",
    busyLabel: "Unlocking\u2026",
  },
};

export function PinKeypad({ mode, onSuccess }: PinKeypadProps) {
  const cfg = MODES[mode];
  const [digits, setDigits] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryAfterSec, setRetryAfterSec] = useState(0);
  // Hard guard against parallel submits. setState updaters can run more
  // than once (dev StrictMode, concurrent rendering), so if `submit`
  // were called from inside `setDigits` we'd POST twice and the second
  // request would race the first into `unlockMasterKey()` after state
  // already flipped to unlocked — the route would 500.
  const submittingRef = useRef(false);

  const submit = useCallback(
    async (pin: string) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch(cfg.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        if (res.ok) {
          onSuccess();
          return;
        }
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          retry_after_ms?: number;
        };
        // Goal-state convergence: both endpoints can return 409 when the
        // server already reached the target state (decrypt → master key
        // already unlocked; unlock → screen not locked). Treat as success
        // rather than surfacing a confusing error.
        if (res.status === 409 && (body.error === "not-locked" || body.error === "no-pin")) {
          onSuccess();
          return;
        }
        if (res.status === 429 && typeof body.retry_after_ms === "number") {
          setRetryAfterSec(Math.ceil(body.retry_after_ms / 1000));
          setError("Too many attempts. Try again later.");
        } else if (res.status === 401) {
          setError("Wrong PIN. Try again.");
        } else if (res.status === 400) {
          setError("Invalid PIN format.");
        } else {
          setError(body.error ?? `Error (${res.status})`);
        }
        setDigits("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setDigits("");
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [cfg.endpoint, onSuccess],
  );

  const append = useCallback(
    (d: string) => {
      if (submitting || retryAfterSec > 0) return;
      setError(null);
      setDigits((cur) => (cur.length >= PIN_LENGTH ? cur : cur + d));
    },
    [submitting, retryAfterSec],
  );

  // Auto-submit once the buffer hits 6 digits.
  useEffect(() => {
    if (digits.length === PIN_LENGTH && !submittingRef.current) {
      void submit(digits);
    }
  }, [digits, submit]);

  const backspace = useCallback(() => {
    if (submitting) return;
    setError(null);
    setDigits((cur) => cur.slice(0, -1));
  }, [submitting]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        append(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        backspace();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [append, backspace]);

  useEffect(() => {
    if (retryAfterSec <= 0) return;
    const t = setInterval(() => {
      setRetryAfterSec((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, [retryAfterSec]);

  return (
    <div
      className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-6 bg-surface text-fg animate-in fade-in duration-200"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
      data-pin-mode={mode}
    >
      <Logo className="h-16 w-auto" />
      <div className="w-full max-w-xs p-6">
        <h1 className="mb-1 text-center text-lg font-semibold text-fg">{cfg.title}</h1>
        <p className="mb-6 text-center text-xs text-fg-faint">{cfg.subtitle}</p>

        <div className="mb-6 flex justify-center gap-3" aria-label="PIN entry progress">
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <span
              key={i}
              className={`h-3 w-3 rounded-full transition-colors ${
                i < digits.length ? (error ? "bg-red-500" : "bg-fg") : "bg-surface-3"
              }`}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <PinKey
              key={d}
              digit={d}
              onPress={() => append(d)}
              disabled={submitting || retryAfterSec > 0}
            />
          ))}
          <div />
          <PinKey
            digit="0"
            onPress={() => append("0")}
            disabled={submitting || retryAfterSec > 0}
          />
          <PinKey
            digit="\u2190"
            onPress={backspace}
            disabled={submitting || digits.length === 0}
            ariaLabel="Backspace"
          />
        </div>

        <p
          className={`mt-4 min-h-[1.5rem] text-center text-xs ${
            error ? "text-red-400" : "text-fg-faint"
          }`}
          role="status"
          aria-live="polite"
        >
          {retryAfterSec > 0
            ? `Try again in ${retryAfterSec}s`
            : error ?? (submitting ? cfg.busyLabel : "\u00A0")}
        </p>
      </div>
    </div>
  );
}

function PinKey({
  digit,
  onPress,
  disabled,
  ariaLabel,
}: {
  digit: string;
  onPress: () => void;
  disabled: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-label={ariaLabel ?? digit}
      className="h-14 rounded-xl bg-surface-3 text-xl font-medium text-fg transition-colors hover:bg-surface-3/70 active:bg-surface-3/50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {digit}
    </button>
  );
}
