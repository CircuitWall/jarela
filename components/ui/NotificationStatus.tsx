"use client";
import { Bell, BellOff, BellRing, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getAppName, getAppIcons } from "@/lib/env/app-config";

// Browsers (Chrome, Safari) require a user gesture for Notification.requestPermission().
// Calling it from an SSE event handler — like we did originally — silently fails on
// many setups. This banner gives the user a single click to grant permission, with a
// confirmation notification so they can verify the wiring works end-to-end.

type Status = "unsupported" | "default" | "granted" | "denied";

function readStatus(): Status {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as Status;
}

const DISMISS_KEY = "jarela:notif-banner-dismissed";

export function NotificationStatus() {
  const [status, setStatus] = useState<Status>("default");
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setStatus(readStatus());
    let wasDismissed = false;
    try { wasDismissed = window.localStorage.getItem(DISMISS_KEY) === "1"; } catch { /* storage may be unavailable */ }
    setDismissed(wasDismissed);

    // Re-check on focus — the user may have toggled it in browser settings.
    const onFocus = () => setStatus(readStatus());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  async function enable() {
    if (typeof Notification === "undefined") return;
    try {
      const result = await Notification.requestPermission();
      setStatus(result as Status);
      if (result === "granted") {
        // Fire a confirmation so the user sees notifications actually work,
        // and so the OS notification center is "primed" — some macOS setups
        // hide the very first notification until the system center registers
        // the source.
        new Notification(`${getAppName()} notifications enabled`, {
          body: "You'll see a ping when an agent finishes a turn while you're away.",
          icon: getAppIcons().icon192,
          tag: "jarela-enable",
        });
      }
    } catch (err) {
      console.warn("[notifications] permission request failed:", err);
    }
  }

  function dismiss() {
    setDismissed(true);
    try { window.localStorage.setItem(DISMISS_KEY, "1"); } catch { /* storage may be unavailable */ }
  }

  // Hide the banner when granted or dismissed.
  if (status === "unsupported") return null;
  if (status === "granted") {
    return null; // suppress entirely once granted; access via the gear settings if needed
  }
  if (dismissed) return null;

  const bannerTone = status === "denied"
    ? "border-rose-500/30 bg-rose-500/10"
    : "border-amber-500/30 bg-amber-500/10";

  return (
    <div className="absolute top-9 left-0 right-0 z-30 mx-auto max-w-xl px-4 mt-2 pointer-events-none">
      <div role="status" className={`pointer-events-auto rounded-lg border ${bannerTone} backdrop-blur px-3 py-2 flex flex-wrap items-center gap-x-2 gap-y-1 shadow-lg`}>
        {status === "denied"
          ? <BellOff size={14} className="text-rose-700 dark:text-rose-400 shrink-0" />
          : <Bell size={14} className="text-amber-700 dark:text-amber-400 shrink-0" />}
        <p className="min-w-0 flex-1 basis-full text-xs text-fg sm:basis-auto">
          {status === "denied"
            ? "System notifications are blocked. In-app alerts still work; change this in browser site settings."
            : "Enable system alerts for when Jarela isn't focused."}
        </p>
        {status === "default" && (
          <button
            type="button"
            onClick={enable}
            className="control-tap inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-amber-700 hover:bg-amber-800 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <BellRing size={11} /> Enable
          </button>
        )}
        <button type="button" onClick={dismiss} className="control-tap p-1 text-fg-subtle hover:text-fg" title="Dismiss" aria-label="Dismiss notification prompt">
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

