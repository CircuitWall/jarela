const functions = require('@google-cloud/functions-framework');

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

functions.http('tokenProxy', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '3600');
    return res.status(204).send('');
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const clientId = process.env.JARELA_GMAIL_CLIENT_ID;
  const clientSecret = process.env.JARELA_GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('proxy misconfigured: missing JARELA_GMAIL_CLIENT_ID or _SECRET');
    return res.status(500).json({ error: 'proxy_misconfigured' });
  }

  // Inbound body is parsed by functions-framework when Content-Type is
  // application/x-www-form-urlencoded. Strip any inbound credentials --
  // they MUST come from the proxy's env, never trusted from the client.
  const params = new URLSearchParams();
  const body = req.body ?? {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'client_id' || k === 'client_secret') continue;
    if (typeof v === 'string') params.set(k, v);
  }
  params.set('client_id', clientId);
  params.set('client_secret', clientSecret);

  try {
    const upstream = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await upstream.text();
    return res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') ?? 'application/json')
      .send(text);
  } catch (err) {
    console.error('upstream failure', err?.message ?? err);
    return res.status(502).json({ error: 'upstream_failure' });
  }
});
