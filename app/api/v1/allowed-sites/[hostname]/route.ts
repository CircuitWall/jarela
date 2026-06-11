import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  putCookies,
  removeAllowedSite,
  setSsrfBypass,
  type CookieRecord,
} from "@/lib/stores/allowed-sites";

// Per-host operations on the allowed-sites list.
//
//   PUT    — extension pushes the latest cookie set for this host. Returns
//            403 if the host is not on the list (defense in depth — the
//            extension's local cache might be stale).
//   PATCH  — toggle SSRF bypass for this host. UI-only.
//   DELETE — remove the host from the allow-list. Cascade drops cookies.
//
// PUT body shape mirrors chrome.cookies.Cookie so the extension can pass
// the result of chrome.cookies.getAll() through with minimal reshape.

const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  expirationDate: z.number().optional(),
});

const PutInputSchema = z.object({
  cookies: z.array(CookieSchema).max(500),
});

const PatchInputSchema = z.object({
  ssrf_bypass: z.boolean(),
});

interface RouteContext {
  params: Promise<{ hostname: string }>;
}

export async function PUT(req: NextRequest, ctx: RouteContext) {
  const { hostname } = await ctx.params;
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const parsed = PutInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const ok = putCookies(hostname, parsed.data.cookies as CookieRecord[]);
  if (!ok) {
    return NextResponse.json(
      { error: "host is not on the allowed-sites list" },
      { status: 403 },
    );
  }
  return NextResponse.json({ ok: true, count: parsed.data.cookies.length });
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { hostname } = await ctx.params;
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const parsed = PatchInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const ok = setSsrfBypass(hostname, parsed.data.ssrf_bypass);
  if (!ok) return NextResponse.json({ error: "host not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const { hostname } = await ctx.params;
  const removed = removeAllowedSite(hostname);
  return NextResponse.json({ deleted: removed });
}
