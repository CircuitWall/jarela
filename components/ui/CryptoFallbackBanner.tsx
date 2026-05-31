"use client";

// Persistent warning surfaced when the at-rest encryption master key
// could not be stored in the host OS keychain and fell back to a
// 0600-permissioned keyfile next to the database (ADR-0005). The user
// should know their secrets are no better protected than the DB file
// itself in this mode.

import { useEffect, useState } from "react";
import { ShieldAlert, X } from "lucide-react";

const DISMISS_KEY = "jarela:crypto-fallback-banner-dismissed";

export function CryptoFallbackBanner() {
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(typeof localStorage !== "undefined" && localStorage.getItem(DISMISS_KEY) === "1");
    let cancelled = false;
    fetch("/api/v1/health")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.crypto?.source === "keyfile") setShow(true);
      })
      .catch(() => { /* health endpoint flakiness shouldn't block UI */ });
    return () => { cancelled = true; };
  }, []);

  if (!show || dismissed) return null;

  return (
    <div className="fixed left-0 right-0 z-30 px-3 pt-2 pointer-events-none" style={{ top: "calc(3rem + var(--app-safe-top))" }}>
      <div className="mx-auto max-w-4xl pointer-events-auto flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50/95 px-3 py-2 text-xs text-amber-950 shadow-sm backdrop-blur dark:border-amber-700/50 dark:bg-amber-950/85 dark:text-amber-100">
        <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <span className="font-medium">At-rest encryption is using the keyfile fallback.</span>{" "}
          The master key lives next to the database because the OS keychain
          was unavailable. Protect the data directory like you would the
          secrets it contains.{" "}
          <a
            href="https://github.com/Pcordeironeto/langGUI/blob/main/docs/adr/0005-encrypt-secrets-at-rest.md"
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            Why?
          </a>
        </div>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, "1");
            setDismissed(true);
          }}
          className="shrink-0 rounded p-0.5 hover:bg-amber-200/70 dark:hover:bg-amber-800/40"
          aria-label="Dismiss warning"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
