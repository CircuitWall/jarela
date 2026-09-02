import { applyBrand } from "./lib/brand.mjs";

applyBrand();

// Offscreen document — sole job is to hold a long-lived port to the
// background service worker so MV3 doesn't terminate it during the
// brief gaps between long-poll iterations.
//
// Chrome enforces a hard 5-minute SW lifetime even with an active
// port. When the SW is recycled the port disconnects; we immediately
// reconnect, which respawns the SW. The result: the polling loop
// resumes within milliseconds of a kill instead of waiting up to 30s
// for the next chrome.alarms revival tick.

const PORT_NAME = "jarela-keepalive";
const RECONNECT_DELAY_MS = 500;

let port = null;

function connect() {
  try {
    port = chrome.runtime.connect({ name: PORT_NAME });
  } catch {
    setTimeout(connect, RECONNECT_DELAY_MS);
    return;
  }
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
}

connect();
