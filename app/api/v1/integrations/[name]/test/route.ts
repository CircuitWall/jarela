import { NextRequest, NextResponse } from "next/server";
import { _resolveAtlassianAuth } from "@/lib/tools/atlassian";
import { _resolveGithubAuth } from "@/lib/tools/github";
import { _resolveGmailAuth } from "@/lib/tools/gmail";
import { _resolveOutlookAuth } from "@/lib/tools/outlook";
import { getMicrosoftAccessToken } from "@/lib/integrations/microsoft-oauth";
import { getIntegrationRaw } from "@/lib/stores/integrations";

type Params = { params: Promise<{ name: string }> };

// POST /api/v1/integrations/{name}/test
// Performs a real API call against the integration to confirm credentials work.
// Surfaces a clear ok/error so the user knows immediately whether their setup
// is good — without having to ask the agent to use the tool.
export async function POST(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  switch (name) {
    case "atlassian": return await testAtlassian();
    case "github":    return await testGithub();
    case "google":    return await testGoogle();
    case "gmail":     return await testGmail();
    case "outlook":   return await testOutlook();
    default:          return NextResponse.json({ error: "unknown integration" }, { status: 404 });
  }
}

async function testAtlassian() {
  const auth = _resolveAtlassianAuth();
  if ("error" in auth) return NextResponse.json({ ok: false, error: auth.error }, { status: 400 });
  try {
    const res = await fetch(`${auth.url}/rest/api/3/myself`, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64"),
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { ok: false, error: `Atlassian ${res.status}: ${body.slice(0, 200)}` },
        { status: 200 },
      );
    }
    const me = (await res.json()) as { displayName?: string; emailAddress?: string; accountId?: string };
    return NextResponse.json({
      ok: true,
      detail: {
        displayName: me.displayName,
        email: me.emailAddress,
        accountId: me.accountId,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: describeError(err) },
      { status: 200 },
    );
  }
}

async function testGithub() {
  const auth = _resolveGithubAuth();
  if ("error" in auth) return NextResponse.json({ ok: false, error: auth.error }, { status: 400 });
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Jarela",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { ok: false, error: `GitHub ${res.status}: ${body.slice(0, 200)}` },
        { status: 200 },
      );
    }
    const me = (await res.json()) as { login?: string; name?: string | null; type?: string };
    return NextResponse.json({
      ok: true,
      detail: { login: me.login, name: me.name ?? null, type: me.type },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: describeError(err) },
      { status: 200 },
    );
  }
}

async function testGoogle() {
  const raw = getIntegrationRaw("google");
  const apiKey = raw?.api_key?.trim();
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "API key not configured" }, { status: 400 });
  }
  try {
    // Cheapest auth check: list available models. No quota cost on free tier.
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { ok: false, error: `Google AI ${res.status}: ${body.slice(0, 200)}` },
        { status: 200 },
      );
    }
    return NextResponse.json({ ok: true, detail: { displayName: "Google AI" } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: describeError(err) },
      { status: 200 },
    );
  }
}

async function testGmail() {
  const auth = _resolveGmailAuth();
  if ("error" in auth) return NextResponse.json({ ok: false, error: auth.error }, { status: 400 });
  try {
    // Exchange refresh token for an access token, then call labels.list as
    // the cheapest end-to-end smoke test.
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: auth.client_id,
        client_secret: auth.client_secret,
        refresh_token: auth.refresh_token,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return NextResponse.json(
        { ok: false, error: `OAuth refresh failed ${tokenRes.status}: ${body.slice(0, 200)}` },
        { status: 200 },
      );
    }
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) {
      return NextResponse.json({ ok: false, error: "OAuth response missing access_token" }, { status: 200 });
    }
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { ok: false, error: `Gmail ${res.status}: ${body.slice(0, 200)}` },
        { status: 200 },
      );
    }
    const data = (await res.json()) as { labels?: Array<{ id: string; name: string }> };
    return NextResponse.json({
      ok: true,
      detail: { labels: data.labels?.length ?? 0 },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: describeError(err) },
      { status: 200 },
    );
  }
}

async function testOutlook() {
  const auth = _resolveOutlookAuth();
  if ("error" in auth) return NextResponse.json({ ok: false, error: auth.error }, { status: 400 });
  try {
    const token = await getMicrosoftAccessToken(auth);
    if (typeof token !== "string") {
      return NextResponse.json({ ok: false, error: token.error }, { status: 200 });
    }
    // /me is the canonical "did this token work?" probe. Returns the
    // signed-in user's displayName + email/UPN.
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { ok: false, error: `Graph ${res.status}: ${body.slice(0, 200)}` },
        { status: 200 },
      );
    }
    const me = (await res.json()) as { displayName?: string; mail?: string; userPrincipalName?: string };
    return NextResponse.json({
      ok: true,
      detail: {
        displayName: me.displayName,
        email: me.mail ?? me.userPrincipalName,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: describeError(err) },
      { status: 200 },
    );
  }
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // undici's fetch wraps the underlying network/TLS/DNS failure in err.cause.
  // The bare "fetch failed" message is useless on its own.
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${err.message}: ${cause.message} (${code})` : `${err.message}: ${cause.message}`;
  }
  return err.message;
}
