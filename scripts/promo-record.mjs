// Promo recorder for Jarela.
//
// Drives the user's REAL local install (default http://localhost:4312) in
// a 9:16 vertical viewport (540x960 by default) and records a webm video
// of: simulated PIN tap intro -> agent picker -> human-paced chat turn
// -> tour of every side panel. Everything renders in dark theme.
//
// Usage:
//   1. Make sure Jarela is running (npm run dev / installed task).
//   2. First run only: a headed browser opens; if your install is locked
//      or behind any one-time gate, unlock it manually. The script then
//      saves the auth cookies to `promo/.storage.json` and reuses them.
//   3. Re-run any time:
//        node scripts/promo-record.mjs
//
// Env overrides:
//   JARELA_PROMO_URL    base URL (default http://localhost:4312)
//   JARELA_PROMO_W      viewport width   (default 432)
//   JARELA_PROMO_H      viewport height  (default 1296)
//   JARELA_PROMO_OUT    output dir       (default ./promo)
//   JARELA_PROMO_MSG    chat message to send during scene 4
//   JARELA_PROMO_SKIP_CHAT=1   skip sending a real chat turn (use when
//                              you don't want the message persisted)
//
// Output:
//   promo/jarela-promo-<timestamp>.webm
//   promo/jarela-promo-latest.webm  (symlink/copy of the newest run)

import { chromium } from "@playwright/test";
import { mkdir, copyFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const BASE_URL = process.env.JARELA_PROMO_URL ?? "http://localhost:4312";
// Default to a 9:16 vertical frame (matches TikTok / Reels / Shorts).
// 540x960 gives a crisp PWA-portrait look at deviceScaleFactor 2.
const VIEW_W = Number(process.env.JARELA_PROMO_W ?? 540);
const VIEW_H = Number(process.env.JARELA_PROMO_H ?? 960);
const OUT_DIR = resolve(process.cwd(), process.env.JARELA_PROMO_OUT ?? "promo");
const STATE_FILE = join(OUT_DIR, ".storage.json");
const CHAT_MSG =
  process.env.JARELA_PROMO_MSG ??
  "Draft me a 3-bullet weekly review of what I shipped, what's stuck, and what I'd ship next \u2014 keep it punchy.";
const SKIP_CHAT = process.env.JARELA_PROMO_SKIP_CHAT === "1";

// PIN digits to *visually* tap in the intro. Not a real PIN — we never
// hit /api/v1/security/unlock. The overlay is a synthetic visual that
// fades out before the real app loads.
const PIN_DEMO = ["7", "2", "9", "1", "4", "0"];

// The TAB_TITLES strings in components/layout/MenuPanel.tsx — buttons in
// the menu carry aria-label={TAB_TITLES[tab]}, so we can drive the tour
// by name without depending on icons or DOM order.
const TOUR_TABS = [
  "Dashboard",
  "Agents",
  "Models",
  "MCP",
  "Tools",
  "Tasks",
  "Memory",
  "Profile",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureDir(d) {
  await mkdir(d, { recursive: true });
}

async function loadStorageState() {
  try {
    await stat(STATE_FILE);
    return STATE_FILE;
  } catch {
    return undefined;
  }
}

async function promptManualUnlock() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log("");
  console.log("=".repeat(60));
  console.log("First-time setup: unlock your install in the browser that");
  console.log("just opened, then come back here and press Enter.");
  console.log("=".repeat(60));
  await rl.question("Press Enter once you see the Jarela home screen... ");
  rl.close();
}

// Inject a Jarela-styled, animated PIN keypad as a full-screen overlay
// over an otherwise blank page. We then "tap" the digits with the mouse
// API so each press is visible in the video, and finally fade it out.
async function recordPinIntro(page) {
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><title>Jarela</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      html, body { margin:0; padding:0; height:100%; background:#09090b; color:#fafafa;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        overflow:hidden;
        transition: background 400ms ease, color 400ms ease, opacity 600ms ease; }
      .wrap { position:fixed; inset:0; display:flex; flex-direction:column;
        align-items:center; justify-content:center; gap:14px; padding:20px 18px; }
      .logo { font-size:24px; font-weight:700; letter-spacing:-0.02em;
        background: linear-gradient(135deg, #818cf8, #c084fc); -webkit-background-clip: text; background-clip:text; color:transparent; }
      h1 { margin:0; font-size:16px; font-weight:600; color:#f1f5f9; }
      p  { margin:0; font-size:11px; color:#94a3b8; }
      .dots { display:flex; gap:12px; margin-top:4px; }
      .dot { width:11px; height:11px; border-radius:50%; background:#27272a;
        transition: background 180ms ease, transform 180ms ease, box-shadow 240ms ease; }
      .dot.on { background:#f1f5f9; transform: scale(1.15); box-shadow:0 0 0 4px rgba(241,245,249,0.10); }
      .keys { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; width:88%; max-width:280px; margin-top:4px; }
      .key { height:52px; border-radius:12px; background:#18181b; border:1px solid #27272a;
        font-size:20px; font-weight:500; color:#fafafa; cursor:pointer;
        display:flex; align-items:center; justify-content:center;
        transition: background 140ms ease, transform 120ms ease, box-shadow 140ms ease; user-select:none; }
      .key.spacer { background:transparent; border:none; }
      .key.tap { background:#6366f1; color:#fff; transform: scale(0.95); box-shadow:0 4px 18px rgba(99,102,241,0.45); }
      .footer { font-size:10px; color:#52525b; margin-top:4px; }
      .fade-out { opacity:0; }
    </style></head><body>
    <div class="wrap" id="wrap">
      <div class="logo">Jarela</div>
      <h1>Unlock Jarela</h1>
      <p>Enter your 6-digit PIN to decrypt your data.</p>
      <div class="dots" id="dots">
        ${Array.from({ length: 6 }).map(() => `<span class="dot"></span>`).join("")}
      </div>
      <div class="keys">
        ${["1","2","3","4","5","6","7","8","9"].map((d) =>
          `<button class="key" data-d="${d}">${d}</button>`,
        ).join("")}
        <button class="key spacer" disabled></button>
        <button class="key" data-d="0">0</button>
        <button class="key" data-d="back">&larr;</button>
      </div>
      <div class="footer">Local-first \u00b7 your data never leaves this machine</div>
    </div></body></html>`,
    { waitUntil: "domcontentloaded" },
  );

  await sleep(700);

  // Tap each digit by clicking the visible button. Brief highlight class
  // animates the press so the recording sees a clear interaction.
  let filled = 0;
  for (const d of PIN_DEMO) {
    const sel = `button.key[data-d="${d}"]`;
    const btn = page.locator(sel);
    await btn.evaluate((el) => el.classList.add("tap"));
    await btn.click({ delay: 60 });
    await sleep(80);
    await btn.evaluate((el) => el.classList.remove("tap"));
    filled += 1;
    await page.evaluate((n) => {
      const dots = document.querySelectorAll("#dots .dot");
      for (let i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i < n);
    }, filled);
    await sleep(280);
  }

  await sleep(550);
  // Fade the splash out, then navigate to the real app.
  await page.evaluate(() => document.body.classList.add("fade-out"));
  await sleep(650);
}

async function dismissBlockingModals(page) {
  // Best-effort dismissals for screen-lock overlays, toast banners, and
  // the side menu if a previous run left it open.
  await page.evaluate(() => {
    document.querySelectorAll("[data-jarela-fill-target]").forEach((n) =>
      n.removeAttribute("data-jarela-fill-target"),
    );
  });
  await page.keyboard.press("Escape").catch(() => {});
}

async function openMenu(page) {
  // The menu button is the rightmost header button with a Menu icon.
  // Its title flips between "Menu" and "<n> new alerts" — match either.
  const menuBtn = page.locator('header button[title*="Menu"], header button[title*="alert"]').last();
  await menuBtn.click();
  await page.waitForSelector('[role="radiogroup"][aria-label="Workspace mode"]', { timeout: 4000 });
  await sleep(350);
}

async function gotoTab(page, label) {
  // Menu must be open before this is called.
  const btn = page.locator(`button[aria-label="${label}"]`).first();
  await btn.waitFor({ state: "visible", timeout: 4000 });
  await btn.click();
  await sleep(900);
}

async function tourPanels(page) {
  for (const label of TOUR_TABS) {
    try {
      await openMenu(page);
      await gotoTab(page, label);
      // Linger on each panel so the camera sees it.
      await sleep(1500);
    } catch (err) {
      console.warn(`[promo] skip tab "${label}":`, err.message);
    }
  }
}

async function pickSecondAgent(page) {
  // Open the agent picker (the header button right next to the logo).
  const picker = page.locator('header button[aria-haspopup="menu"]').first();
  if (!(await picker.count())) return;
  await picker.click();
  try {
    await page.waitForSelector('[role="menu"] [role="menuitemradio"]', { timeout: 2000 });
  } catch {
    // No items — just close and move on.
    await page.keyboard.press("Escape");
    return;
  }
  await sleep(700);
  const items = page.locator('[role="menu"] [role="menuitemradio"]');
  const n = await items.count();
  if (n >= 2) {
    await items.nth(1).hover();
    await sleep(450);
    await items.nth(1).click();
  } else if (n === 1) {
    await items.nth(0).hover();
    await sleep(600);
    await items.nth(0).click();
  } else {
    await page.keyboard.press("Escape");
  }
  await sleep(700);
}

async function humanType(page, locator, text, perCharMs = 70) {
  await locator.focus();
  // Use the page's typewriter delay so each keystroke fires its own input
  // event — important because the chat textarea grows on input.
  await locator.type(text, { delay: perCharMs });
  await sleep(450);
}

async function sendChat(page) {
  const ta = page.locator('textarea[placeholder]').first();
  await ta.waitFor({ state: "visible", timeout: 5000 });
  await humanType(page, ta, CHAT_MSG, 65);
  if (SKIP_CHAT) {
    // Visual only: clear the input without sending.
    await sleep(600);
    await ta.fill("");
    return;
  }
  const send = page.locator('button[aria-label="Send"]').first();
  await send.click();
  // Wait for an assistant bubble to start appearing. The chat UI
  // typically renders messages into a scroll container; rather than
  // pinning to a specific class, we wait for the textarea to clear
  // (parent clears on submit) and then linger for the stream.
  await page.waitForFunction(() => {
    const t = document.querySelector('textarea[placeholder]');
    return t && (t.value === "" || t.value.length === 0);
  }, { timeout: 8000 }).catch(() => {});
  // Let the stream play out for the camera. 9s is enough for a one-line
  // mock reply and short for a real model; tune via JARELA_PROMO_STREAM_MS.
  const streamMs = Number(process.env.JARELA_PROMO_STREAM_MS ?? 9000);
  await sleep(streamMs);
}

async function copyLatest(srcPath, outDir) {
  const latest = join(outDir, "jarela-promo-latest.webm");
  await copyFile(srcPath, latest);
  return latest;
}

async function main() {
  await ensureDir(OUT_DIR);
  const storageState = await loadStorageState();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  console.log(`[promo] base url:  ${BASE_URL}`);
  console.log(`[promo] viewport:  ${VIEW_W}x${VIEW_H}`);
  console.log(`[promo] output:    ${OUT_DIR}`);
  console.log(`[promo] storage:   ${storageState ?? "(none yet — manual unlock once)"}`);

  // Always headed: we want the browser surfaced so the user can see what
  // the recording will look like (and intervene on first-run unlock).
  const browser = await chromium.launch({ headless: false, args: ["--hide-scrollbars"] });

  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: VIEW_W, height: VIEW_H },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    storageState,
    recordVideo: { dir: OUT_DIR, size: { width: VIEW_W, height: VIEW_H } },
    colorScheme: "dark",
  });

  const page = await context.newPage();

  // -------- Scene 1: synthetic PIN intro (no real auth) --------
  await recordPinIntro(page);

  // -------- Scene 2: bridge into the real app --------
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // If the install actually shows the unlock screen on a clean context,
  // pause for a manual unlock so the rest of the tour can run.
  const unlockVisible = await page
    .locator('text=Unlock Jarela')
    .first()
    .isVisible()
    .catch(() => false);
  if (unlockVisible && !storageState) {
    await promptManualUnlock();
  }

  // Force dark theme up-front so the entire recording stays in dark mode.
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    try { localStorage.setItem("jarela-theme", "dark"); } catch { /* */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", "#09090b");
  });

  await page.waitForSelector("header", { timeout: 15000 });
  await dismissBlockingModals(page);
  await sleep(900);

  // -------- Scene 3: agent picker --------
  await pickSecondAgent(page);

  // -------- Scene 4: chat at human speed --------
  // Make sure we're on the chat tab (header logo click reroutes there).
  try {
    await page.locator('header button[aria-haspopup="menu"]').first().click({ trial: false, force: true });
    await page.keyboard.press("Escape");
  } catch { /* ignore */ }
  await sendChat(page);

  // -------- Scene 5: tour every panel --------
  await tourPanels(page);

  // -------- Scene 6: closing pose --------
  // Return to chat to anchor the closing shot, then open the agent
  // picker one last time so the final frame shows the brand.
  try {
    await openMenu(page);
    await gotoTab(page, "Chat");
  } catch { /* */ }
  await sleep(800);
  await pickSecondAgent(page);
  await sleep(600);

  // Persist storage state for future runs (first-run unlock).
  try {
    const state = await context.storageState();
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("[promo] could not save storageState:", err.message);
  }

  // Closing the context flushes the .webm to disk.
  const videoPromise = page.video()?.path();
  await context.close();
  await browser.close();

  const rawPath = await videoPromise;
  if (!rawPath || !existsSync(rawPath)) {
    console.error("[promo] no video file produced");
    process.exitCode = 1;
    return;
  }
  const stamped = join(OUT_DIR, `jarela-promo-${stamp}.webm`);
  await copyFile(rawPath, stamped);
  const latest = await copyLatest(stamped, OUT_DIR);
  console.log("");
  console.log(`[promo] saved: ${stamped}`);
  console.log(`[promo] latest: ${latest}`);
  console.log("");
  console.log("Convert to mp4 (optional, requires ffmpeg):");
  console.log(`  ffmpeg -y -i "${latest}" -c:v libx264 -pix_fmt yuv420p -crf 22 -movflags +faststart "${latest.replace(/\.webm$/, ".mp4")}"`);
}

main().catch((err) => {
  console.error("[promo] fatal:", err);
  process.exit(1);
});
