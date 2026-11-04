/** Shared high-confidence markers. Callers decide whether line suppressions apply. */
export const SECRET_PATTERNS = [
  { name: "OpenAI / DeepSeek-style key", re: /\bsk-[a-zA-Z0-9_-]{20,}\b/ },
  { name: "GitHub PAT (classic)", re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub user-to-server token", re: /\bghu_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub server-to-server token", re: /\bghs_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub refresh token", re: /\bghr_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub OAuth client secret", re: /\bgho_[A-Za-z0-9]{30,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "Google OAuth client secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Google service-account/refresh", re: /\bAQ\.Ab8RN6[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic API key", re: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Stripe live key", re: /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/ },
];
