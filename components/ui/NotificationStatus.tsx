"use client";
import { Bell, BellOff, BellRing, X } from "lucide-react";
import { useEffect, useState } from "react";
import { pushToast } from "@/lib/ui/toasts";
import { getAppName, getAppIcons } from "@/lib/env/app-config";

// Browsers (Chrome, Safari) require a user gesture for Notification.requestPermission().
// Calling it from an SSE event handler — like we did originally — silently fails on
// many setups. This banner gives the user a single click to grant permission, with a
// "test" action so they can verify the wiring works end-to-end.

type Status = "unsupported" | "default" | "granted" | "denied";

function readStatus(): Status {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as Status;
}

const DISMISS_KEY = "jarela:notif-banner-dismissed";

export function NotificationStatus() {
  const [status, setStatus] = useState<Status>("default");
  const [dismissed, setDismissed] = useState(true);
  const [testFired, setTestFired] = useState(false);

  useEffect(() => {
    setStatus(readStatus());
    setDismissed(typeof localStorage !== "undefined" && localStorage.getItem(DISMISS_KEY) === "1");

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

  function testFire() {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification(`${getAppName()} test`, {
      body: "If you see this, notifications are wired correctly.",
      icon: getAppIcons().icon192,
      tag: "jarela-test",
    });
    setTestFired(true);
    setTimeout(() => setTestFired(false), 2000);
  }

  function dismiss() {
    setDismissed(true);
    localStorage.setItem(DISMISS_KEY, "1");
  }

  // Hide the banner when granted (just show a tiny test affordance) or when user dismissed.
  if (status === "unsupported") return null;
  if (status === "granted") {
    // Persistent tiny "test" link in the corner so the user can confirm anytime.
    return null; // suppress entirely once granted; access via the gear settings if needed
  }
  if (dismissed) return null;

  return (
    <div className="absolute top-9 left-0 right-0 z-30 mx-auto max-w-2xl px-4 mt-2 pointer-events-none">
      <div className="pointer-events-auto rounded-lg border border-amber-700/60 bg-amber-950/40 backdrop-blur px-3 py-2 flex items-center gap-2 shadow-lg">
        {status === "denied"
          ? <BellOff size={14} className="text-rose-700 dark:text-rose-400 shrink-0" />
          : <Bell size={14} className="text-amber-700 dark:text-amber-400 shrink-0" />}
        <p className="text-xs text-fg mr-auto">
          {status === "denied"
            ? "OS notifications are blocked. In-app pop-ups still work; for system-level alerts when Jarela isn't focused, allow Notifications via the lock icon in the URL bar."
            : "Enable OS notifications to also get pinged when Jarela isn't focused (in-app pop-ups already work)."}
        </p>
        {status === "default" && (
          <button
            onClick={enable}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-amber-600 hover:bg-amber-500 text-white"
          >
            <BellRing size={11} /> Enable
          </button>
        )}
        {testFired && (
          <span className="text-[10px] text-emerald-700 dark:text-emerald-400">test sent</span>
        )}
        <button onClick={dismiss} className="p-1 text-fg-subtle hover:text-fg" title="Dismiss">
          <X size={12} />
        </button>
      </div>
    </div>
  );
}


