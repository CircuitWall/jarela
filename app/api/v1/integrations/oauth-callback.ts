import { NextResponse } from "next/server";

export function oauthHtmlResponse(message: string, isError: boolean): NextResponse {
  const color = isError ? "#fca5a5" : "#86efac";
  const title = isError ? "Authorization failed" : "Authorization complete";
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { max-width: 32rem; padding: 2rem; border: 1px solid #27272a; border-radius: 0.5rem;
          background: #18181b; }
  h1 { font-size: 1.1rem; margin: 0 0 0.75rem; color: ${color}; }
  p  { margin: 0; line-height: 1.5; font-size: 0.9rem; color: #d4d4d8; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${escapeHtml(message)}</p></div>
<script>setTimeout(()=>{try{window.close()}catch(_){}}, 2000);</script>
</body></html>`;
  return new NextResponse(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
