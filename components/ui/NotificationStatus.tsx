"use client";
import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { getAppName, getAppIcons } from "@/lib/env/app-config";

// Browsers (Chrome, Safari) require a user gesture for Notification.requestPermission().
// Keep the permission action in the existing navigation Preferences section rather
// than overlaying app content with a banner.

type Status = "unsupported" | "default" | "granted" | "denied";

function readStatus(): Status {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as Status;
}

export function NotificationStatus() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    setStatus(readStatus());

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

  // Hide the action after permission is granted; denied permissions must be
  // changed in browser settings and cannot be requested again from the page.
  if (!status || status === "unsupported") return null;
  if (status === "granted") return null;

  const content = status === "denied"
    ? {
      icon: <BellOff size={17} aria-hidden="true" />,
      title: "System alerts are blocked",
      description: "Allow notifications in browser site settings.",
    }
    : {
      icon: <Bell size={17} aria-hidden="true" />,
      title: "Enable system alerts",
      description: "Get alerts when Jarela isn't focused.",
    };

  const className = "control-tap flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left text-fg-muted";
  const text = (
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium">{content.title}</span>
      <span className="block text-xs leading-relaxed text-fg-faint break-words">{content.description}</span>
    </span>
  );

  if (status === "denied") {
    return (
      <div role="status" className={className}>
        <span className="shrink-0 text-fg-faint" aria-hidden="true">{content.icon}</span>
        {text}
      </div>
    );
  }

  return (
    <button type="button" onClick={enable} className={`${className} hover:bg-surface-3/60 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent`}>
      <span className="shrink-0 text-fg-faint" aria-hidden="true">{content.icon}</span>
      {text}
    </button>
  );
}
