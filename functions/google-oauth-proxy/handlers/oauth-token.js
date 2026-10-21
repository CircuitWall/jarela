const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

async function handleOAuthToken(req, res) {
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

  // Credentials always come from the service environment, never request data.
  const params = new URLSearchParams();
  const body = req.body ?? {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'client_id' || key === 'client_secret') continue;
    if (typeof value === 'string') params.set(key, value);
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
  } catch (error) {
    console.error('upstream failure', error?.message ?? error);
    return res.status(502).json({ error: 'upstream_failure' });
  }
}

module.exports = { handleOAuthToken };
