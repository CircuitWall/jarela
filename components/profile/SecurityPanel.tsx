"use client";

import { useEffect, useState } from "react";
import { Lock, Shield } from "lucide-react";

// SecurityPanel — UI for enabling, changing, or disabling the at-rest
// PIN (ADR-0063). Talks to /api/v1/security/{state,pin}. The unlock
// route is exercised by the splash screen, not here.

type State = {
  state: "locked" | "unlocked" | null;
  source: "keychain" | "keyfile" | "pin-wrapped-keyfile" | null;
  pin_enabled: boolean;
};

type Mode = "idle" | "enable" | "change" | "disable";

export function SecurityPanel() {
  const [state, setState] = useState<State | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    try {
      const res = await fetch("/api/v1/security/state");
      if (res.ok) setState(await res.json());
    } catch { /* ignore */ }
  }

  function reset() {
    setMode("idle");
    setCurrentPin("");
    setNewPin("");
    setConfirmPin("");
    setError(null);
  }

  async function submit() {
    setError(null);
    setOkMsg(null);

    if (mode === "enable" || mode === "change") {
      if (!/^\d{6}$/.test(newPin)) {
        setError("PIN must be exactly 6 digits.");
        return;
      }
      if (newPin !== confirmPin) {
        setError("PIN entries don't match.");
        return;
      }
    }
    if ((mode === "change" || mode === "disable") && !/^\d{6}$/.test(currentPin)) {
      setError("Current PIN must be exactly 6 digits.");
      return;
    }

    const body: Record<string, string> = { action: mode };
    if (mode === "enable") body.newPin = newPin;
    if (mode === "change") { body.currentPin = currentPin; body.newPin = newPin; }
    if (mode === "disable") body.currentPin = currentPin;

    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/security/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const successMsg = mode === "enable"
          ? "PIN enabled. You'll be asked for it on next launch."
          : mode === "change"
            ? "PIN changed."
            : "PIN disabled.";
        setOkMsg(successMsg);
        reset();
        await refresh();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 401) setError("Current PIN is incorrect.");
        else if (res.status === 429) setError("Too many attempts. Try again later.");
        else setError(data.error ?? `Error (${res.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!state) {
    return (
      <div className="rounded-xl border border-border bg-surface-2/70 p-4 text-sm text-fg-muted">
        Loading security state…
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-surface-2/70 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Shield size={14} className="text-accent" />
        <h3 className="text-sm font-semibold text-fg">At-rest PIN</h3>
      </div>
      <p className="text-xs text-fg-muted mb-3">
        {state.pin_enabled
          ? "A 6-digit PIN is required to unlock encrypted data on every launch."
          : "Your data is encrypted at rest with a key from the OS keychain or a local keyfile. Add a 6-digit PIN to require unlock on every launch."}
      </p>

      {okMsg && (
        <p className="text-xs text-emerald-500 mb-2" role="status">{okMsg}</p>
      )}

      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          {!state.pin_enabled && (
            <button
              type="button"
              onClick={() => { reset(); setMode("enable"); setOkMsg(null); }}
              className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg flex items-center gap-1.5"
            >
              <Lock size={12} /> Enable PIN
            </button>
          )}
          {state.pin_enabled && (
            <>
              <button
                type="button"
                onClick={() => { reset(); setMode("change"); setOkMsg(null); }}
                className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg"
              >
                Change PIN
              </button>
              <button
                type="button"
                onClick={() => { reset(); setMode("disable"); setOkMsg(null); }}
                className="text-xs px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-400"
              >
                Disable PIN
              </button>
            </>
          )}
        </div>
      )}

      {mode !== "idle" && (
        <div className="space-y-2">
          {(mode === "change" || mode === "disable") && (
            <PinInput label="Current PIN" value={currentPin} onChange={setCurrentPin} disabled={submitting} />
          )}
          {(mode === "enable" || mode === "change") && (
            <>
              <PinInput label="New PIN" value={newPin} onChange={setNewPin} disabled={submitting} />
              <PinInput label="Confirm new PIN" value={confirmPin} onChange={setConfirmPin} disabled={submitting} />
            </>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="text-xs px-3 py-1.5 rounded-lg bg-accent text-bg hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={submitting}
              className="text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-3 hover:bg-surface-2 text-fg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PinInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-fg-muted mb-1">{label}</span>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        disabled={disabled}
        className="w-32 px-2 py-1.5 rounded-lg border border-border bg-surface-3 text-fg text-sm tracking-[0.4em] font-mono"
      />
    </label>
  );
}
