import type { Metadata, Viewport } from "next";
import { AppProvider } from "@/contexts/AppContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ServiceWorkerRegistration } from "@/components/ui/ServiceWorkerRegistration";
import { getAppName, getAppDescription } from "@/lib/env/app-config";
import "./globals.css";

export const metadata: Metadata = {
  title: getAppName(),
  description: getAppDescription(),
  manifest: "/manifest.json",
  icons: {
    // SVG favicon is theme-aware (prefers-color-scheme inside the SVG),
    // so it flips between navy J (light UI) and sky J (dark UI) without
    // shipping two payloads. PNG/ICO fall through for older browsers.
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    // iOS reads ONE apple-touch-icon and ignores prefers-color-scheme,
    // so we hand it the dark navy variant (reads on any wallpaper). The
    // light-bg companion is shipped at /apple-touch-icon-light.png for
    // anyone who wants to opt in via a custom <link> tag.
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  // iOS standalone-mode PWA chrome. Safari ignores the manifest's
  // `theme_color` once the app is installed to the home screen and only
  // honors these Apple-specific tags. `black-translucent` is the only
  // value that produces an arbitrary status-bar color: the bar overlays
  // the page and whatever paints under it (the AppShell top bar, which
  // already pads itself with env(safe-area-inset-top) via --app-safe-top)
  // becomes the visible status-bar background. So the top bar's surface
  // color follows the active light/dark theme automatically.
  appleWebApp: {
    capable: true,
    title: getAppName(),
    statusBarStyle: "black-translucent",
  },
};

// Next 15+ requires themeColor (and color-scheme, viewport, etc.) to live in
// the viewport export, not metadata. The /_not-found warning came from Next
// inheriting this same layout — moving it here fixes both routes at once.
// Match the installed-PWA window chrome (desktop title bar, mobile address
// bar, splash) to the active surface color. Two entries let the OS pick
// based on prefers-color-scheme; the runtime ThemeContext / pre-paint
// script overrides this single <meta name="theme-color"> tag when the
// user picks an explicit light/dark mode.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  // Chromium-only: shrink the layout viewport when the OS keyboard
  // appears, so `100dvh` automatically sits above the keyboard. Safari
  // doesn't implement this key (it logs a benign console warning, see
  // tests/e2e/smoke.spec.ts allow-list) and instead `dvh` itself already
  // tracks the keyboard on iOS 16.4+ PWA, so no extra JS is needed.
  interactiveWidget: "resizes-content",
};

// Pre-paint script: reads the persisted theme and sets `data-theme` on
// <html> before the first paint, so light-mode users don't flash dark on
// every page load. Inlined via dangerouslySetInnerHTML — the canonical
// App Router pattern. (Earlier attempt routed this through next/script,
// but under Next 16 + React 19.2 that import resolves to a Promise in
// some module-resolution paths, tripping "Element type is invalid".)
// Falls back to "system", which then defers to prefers-color-scheme.
const themeBootstrap = `(() => {
  var LIGHT = "#ffffff", DARK = "#09090b";
  function resolve(t) {
    if (t === "light") return LIGHT;
    if (t === "dark") return DARK;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? DARK : LIGHT;
    } catch (e) { return DARK; }
  }
  try {
    var t = localStorage.getItem("jarela-theme");
    if (t !== "light" && t !== "dark" && t !== "system") t = "system";
    document.documentElement.setAttribute("data-theme", t);
    // Collapse any media-scoped theme-color metas Next emits to a single tag
    // so the PWA window chrome matches the user's explicit choice (not just
    // prefers-color-scheme). ThemeContext keeps this in sync on change.
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 1; i < metas.length; i++) metas[i].parentNode.removeChild(metas[i]);
    var meta = metas[0];
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.removeAttribute("media");
    meta.setAttribute("content", resolve(t));
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "system");
  }
})();`;

// iOS Safari standalone-PWA viewport-height shim. On iPhones in
// "Add to Home Screen" mode iOS reports window.innerHeight (and 100dvh
// resolves against it) ~safe-area-inset-top pixels SHORTER than the
// physical screen — about 59px on iPhone, 32px on iPad. That leaves a
// gap below the app that the UA paints with the color-scheme default
// (the white strip the user sees above the home-indicator). dvh, vh,
// position:fixed inset:0, -webkit-fill-available — none of them fill
// the physical screen in standalone PWA mode.
//
// The community-validated fix (boolinator/ios-pwa-bottom-bar-fix.md,
// stackoverflow.com/q/79902310) is a JS shim: read visualViewport.height,
// add safe-area-inset-top back when the gap matches the bug signature,
// and write the corrected pixel value into --actual-vh on <html>.
// CSS then sizes the doc with var(--actual-vh, 100dvh) so non-iOS
// browsers keep using the standard primitive.
//
// Retries at 50/150/300/500/800/1200ms cover iOS's async safe-area
// population on launch. visualViewport.resize, orientationchange, and
// visibilitychange handle keyboard/rotation/app-switch.
const iosViewportBootstrap = `(() => {
  try {
    var isPWA = window.matchMedia('(display-mode: standalone)').matches
             || window.matchMedia('(display-mode: fullscreen)').matches
             || window.navigator.standalone === true;
    if (!isPWA) return;
    var last = 0;
    function safeTopPx() {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--app-safe-top') || '';
      var n = parseFloat(v);
      return isNaN(n) ? 0 : n;
    }
    function isEditableFocused() {
      var ae = document.activeElement;
      if (!ae) return false;
      var tag = ae.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable === true;
    }
    function apply() {
      var vv = window.visualViewport;
      var vh = (vv && vv.height) || window.innerHeight;
      // Keyboard-open detection: when iOS shows the on-screen keyboard,
      // visualViewport.height shrinks but window.innerHeight stays put.
      // Pairing that gap with editable-focus makes it model-agnostic -
      // no need to guess a keyboard height per device (SE ~216, 15 Pro
      // Max ~301, iPad floating ~120). 50px just filters URL-bar jitter.
      var keyboardOpen = isEditableFocused() && (window.innerHeight - vh) > 50;
      var isPortrait = window.innerHeight > window.innerWidth;
      // Skip the chin correction while the keyboard is up - otherwise we
      // inflate --actual-vh beyond the visible viewport and the input bar
      // ends up underneath the keyboard.
      if (!keyboardOpen && isPortrait) {
        var screenH = Math.max(window.screen.height, window.screen.width);
        if (screenH - vh > 15) {
          var top = safeTopPx();
          if (top > 0) vh += top;
        }
      }
      document.documentElement.style.setProperty('--actual-vh', vh + 'px');
      if (last > 0 && Math.abs(vh - last) > 30) {
        setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 50);
      }
      last = vh;
    }
    apply();
    [50, 150, 300, 500, 800, 1200].forEach(function (ms) { setTimeout(apply, ms); });
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', function () {
      setTimeout(apply, 100); setTimeout(apply, 300);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', apply);
      window.visualViewport.addEventListener('scroll', apply);
    }
    // focusin/focusout can lead visualViewport.resize by ~100ms on
    // older iOS - recompute immediately so we don't render a bad frame.
    document.addEventListener('focusin', apply, true);
    document.addEventListener('focusout', apply, true);
    // iOS still scrolls the layout viewport up when the keyboard opens
    // to keep the focused input visible, even with html/body overflow:hidden.
    // Aggressive scroll-reset on focus events counteracts it (piclaw PWA.md
    // pattern, validated on iOS 26.x). Staggered timers cover the lag
    // between focus and iOS's scroll-into-view.
    function snapScroll() {
      if (window.scrollY !== 0 || window.pageYOffset !== 0) {
        window.scrollTo(0, 0);
      }
    }
    document.addEventListener('focusin', function () {
      snapScroll();
      [16, 50, 100, 200, 400].forEach(function (ms) { setTimeout(snapScroll, ms); });
    }, true);
    document.addEventListener('focusout', function () {
      [16, 50, 100, 200].forEach(function (ms) { setTimeout(snapScroll, ms); });
    }, true);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('scroll', snapScroll);
    }
    window.addEventListener('scroll', snapScroll, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { setTimeout(apply, 50); setTimeout(apply, 200); }
    });
  } catch (e) { /* non-fatal: falls back to 100dvh */ }
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="system" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <script dangerouslySetInnerHTML={{ __html: iosViewportBootstrap }} />
      </head>
      <body>
        <ThemeProvider>
          <AppProvider>{children}</AppProvider>
        </ThemeProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
