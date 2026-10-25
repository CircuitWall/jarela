import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const deepseekWebManifest: IntegrationManifest = {
  id: "deepseek-web",
  name: "DeepSeek Search & Fetch",
  summary:
    "Optional backend for Jarela's web_search and web_fetch tools. This is separate from DeepSeek model capability " +
    "badges and is not enabled by configuring a DeepSeek chat-model credential.",
  category: "other",
  prerequisites: [
    {
      check: "credentials",
      detail:
        "A DeepSeek API key. Jarela sends web queries and URLs to DeepSeek only after this separate integration is configured. " +
        "DeepSeek documents Search and Fetch at $0.75 per 1,000 successful requests for each API; empty searches and failed " +
        "requests are not billed. Prices and terms can change.",
      docs_url: "https://api-docs.deepseek.com/guides/search",
    },
  ],
  steps: [
    {
      id: "review-search-fetch",
      title: "Review DeepSeek Search & Fetch",
      description:
        "Read DeepSeek's Search & Fetch documentation and pricing. These are separate APIs from DeepSeek chat completions.",
      docs_url: "https://api-docs.deepseek.com/guides/search",
    },
    {
      id: "create-api-key",
      title: "Get a DeepSeek API key",
      description:
        "Create or reuse a DeepSeek API key from the platform. You may use the same key as the chat-model integration, but it must be saved separately here to opt web tools in.",
      docs_url: "https://platform.deepseek.com/api_keys",
    },
    {
      id: "save-api-key",
      title: "Enable DeepSeek for Jarela web tools",
      description:
        "Save the key in Settings → Credentials → DeepSeek Search & Fetch. It is stored encrypted at rest. Setup does not make a search request; once configured, web_search and eligible public text-mode web_fetch requests use DeepSeek. HTML requests, Allowed sites, and private-fetch overrides keep direct fetch. Removing this credential restores the existing backends.",
      proposes: "enable_integration",
    },
    {
      id: "verify-web-tools",
      title: "Verify search and fetch after opting in",
      description:
        "With the user's approval for potentially billed requests, run web_search with a public test query and verify provider='deepseek', " +
        "no error, and source URLs in the results. Then run web_fetch on a returned public URL and verify fetcher='deepseek', " +
        "content_type='text/markdown', and non-empty content. Credential presence alone does not verify API access. " +
        "There is deliberately no automatic paid search probe.",
    },
  ],
  troubleshooting: [
    {
      when: "DeepSeek Search or Fetch returns HTTP 402",
      say: "The DeepSeek API account has insufficient balance. Check the DeepSeek platform billing page.",
    },
    {
      when: "DeepSeek Search or Fetch returns HTTP 429",
      say:
        "The account-level Search or Fetch request limit was exceeded. Wait before retrying; Fetch also has per-domain limits.",
    },
    {
      when: "DeepSeek Fetch returns HTTP 403 or 404",
      say:
        "DeepSeek rejected the URL under its security policy or could not retrieve usable page content. Verify that the URL is publicly reachable and supports extraction.",
    },
  ],
};
