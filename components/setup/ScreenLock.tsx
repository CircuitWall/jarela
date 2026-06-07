"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/ui/Logo";

// Screen-lock overlay (presence check). Shown when the server reports
// `screen_locked: true` after an idle timeout. Distinct from
// UnlockScreen — this does NOT touch the in-memory master key, just
// verifies the human at the keyboard knows the PIN. Background work
// (agents, scheduler, bridges) keeps running underneath.

const PIN_LENGTH = 6;

export function ScreenLock({ onUnlock }: { onUnlock: () => void }) {
  const [digits, setDigits] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryAfterSec, setRetryAfterSec] = useState(0);
  const submittingRef = useRef(false);

  const submit = useCallback(async (pin: string) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/security/verify-pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        onUnlock();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        retry_after_ms?: number;
      };
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
  }, [onUnlock]);

  const append = useCallback((d: string) => {
    if (submitting || retryAfterSec > 0) return;
    setError(null);
    setDigits((cur) => (cur.length >= PIN_LENGTH ? cur : cur + d));
  }, [submitting, retryAfterSec]);

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
      className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-6 bg-surface text-fg"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <Logo className="h-16 w-auto" />
      <div className="w-full max-w-xs p-6">
        <h1 className="mb-1 text-center text-lg font-semibold text-fg">
          Locked
        </h1>
        <p className="mb-6 text-center text-xs text-fg-faint">
          Enter your 6-digit PIN to resume.
        </p>

        <div className="mb-6 flex justify-center gap-3" aria-label="PIN entry progress">
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <span
              key={i}
              className={`h-3 w-3 rounded-full transition-colors ${
                i < digits.length
                  ? error
                    ? "bg-red-500"
                    : "bg-fg"
                  : "bg-surface-3"
              }`}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <PinKey key={d} digit={d} onPress={() => append(d)} disabled={submitting || retryAfterSec > 0} />
          ))}
          <div />
          <PinKey digit="0" onPress={() => append("0")} disabled={submitting || retryAfterSec > 0} />
          <PinKey digit="←" onPress={backspace} disabled={submitting || digits.length === 0} ariaLabel="Backspace" />
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
            : error ?? (submitting ? "Verifying…" : "\u00A0")}
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
