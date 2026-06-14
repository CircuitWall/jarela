// Curated catalog of LangChain JS tool packages we know how to surface in
// the Install panel. Static metadata only — no network calls, no npm
// queries. Lets the user pick from a list instead of hunting npm.
//
// Sources:
//   - https://docs.langchain.com/oss/javascript/integrations/tools/
//   - https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools
//
// Keep entries to packages whose publishers are already trusted
// (`@langchain/`, `langchain`) so picking one installs without an extra
// approval round-trip.

import type { BuiltinCategory } from "./registry";

export interface LangChainCatalogEntry {
  /** Stable id for React keys + analytics. Lowercase kebab-case. */
  id: string;
  /** Human label shown in the dropdown. */
  label: string;
  /** npm package spec passed to `npm install`. May include a subpath. */
  npmPackage: string;
  /** Subpath import used in the manifest's `package` field, when different from `npmPackage`. */
  manifestPackage?: string;
  /** Exported class name for the manifest. */
  exportName: string;
  /** One-line summary. */
  description: string;
  /** Best-fit built-in category for the generated manifest. */
  category: BuiltinCategory;
  /** Default capability hint; loader still re-derives by verb when omitted. */
  capability?: "read" | "write" | "execute";
  /** Env vars the tool needs at runtime. Pre-filled in the manifest form. */
  requiredEnv?: string[];
  /** Upstream docs link, surfaced as a "Learn more" affordance. */
  docsUrl?: string;
}

// Ordered for the dropdown: most generally useful first, then alpha.
export const LANGCHAIN_CATALOG: readonly LangChainCatalogEntry[] = [
  {
    id: "tavily-search",
    label: "Tavily Search",
    npmPackage: "@langchain/tavily",
    exportName: "TavilySearch",
    description: "AI-grade web search optimised for LLM agents.",
    category: "Web",
    capability: "read",
    requiredEnv: ["TAVILY_API_KEY"],
    docsUrl: "https://docs.langchain.com/oss/integrations/tools/tavily_search",
  },
  {
    id: "exa-search",
    label: "Exa Search",
    npmPackage: "@langchain/exa",
    exportName: "ExaSearchResults",
    description: "Neural search with semantic ranking and content extraction.",
    category: "Web",
    capability: "read",
    requiredEnv: ["EXASEARCH_API_KEY"],
    docsUrl: "https://docs.langchain.com/oss/integrations/tools/exa_search",
  },
  {
    id: "google-gemini-tools",
    label: "Google (Gemini Native Tools)",
    npmPackage: "@langchain/google-genai",
    exportName: "GoogleSearchRetrievalTool",
    description: "Gemini-native grounding tools (Google Search retrieval).",
    category: "Web",
    capability: "read",
    requiredEnv: ["GOOGLE_API_KEY"],
    docsUrl: "https://docs.langchain.com/oss/integrations/tools/google",
  },
  {
    id: "duckduckgo-search",
    label: "DuckDuckGo Search",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/duckduckgo_search",
    exportName: "DuckDuckGoSearch",
    description: "Privacy-friendly web search, no API key required.",
    category: "Web",
    capability: "read",
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/duckduckgo_search.ts",
  },
  {
    id: "brave-search",
    label: "Brave Search",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/brave_search",
    exportName: "BraveSearch",
    description: "Independent web index from Brave.",
    category: "Web",
    capability: "read",
    requiredEnv: ["BRAVE_SEARCH_API_KEY"],
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/brave_search.ts",
  },
  {
    id: "serpapi",
    label: "SerpAPI",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/serpapi",
    exportName: "SerpAPI",
    description: "General-purpose SERP scraper (Google + many engines).",
    category: "Web",
    capability: "read",
    requiredEnv: ["SERPAPI_API_KEY"],
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/serpapi.ts",
  },
  {
    id: "serper",
    label: "Serper.dev",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/serper",
    exportName: "Serper",
    description: "Fast Google SERP API with generous free tier.",
    category: "Web",
    capability: "read",
    requiredEnv: ["SERPER_API_KEY"],
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/serper.ts",
  },
  {
    id: "searchapi",
    label: "SearchApi.io",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/searchapi",
    exportName: "SearchApi",
    description: "Multi-engine SERP API (Google, Bing, YouTube, etc.).",
    category: "Web",
    capability: "read",
    requiredEnv: ["SEARCHAPI_API_KEY"],
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/searchapi.ts",
  },
  {
    id: "google-custom-search",
    label: "Google Custom Search",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/google_custom_search",
    exportName: "GoogleCustomSearch",
    description: "Google Programmable Search Engine results.",
    category: "Web",
    capability: "read",
    requiredEnv: ["GOOGLE_CSE_ID", "GOOGLE_API_KEY"],
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/google_custom_search.ts",
  },
  {
    id: "searxng-search",
    label: "SearxNG Search",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/searxng_search",
    exportName: "SearxngSearch",
    description: "Self-hosted metasearch engine.",
    category: "Web",
    capability: "read",
    requiredEnv: ["SEARXNG_API_BASE"],
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/searxng_search.ts",
  },
  {
    id: "wikipedia",
    label: "Wikipedia",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/wikipedia_query_run",
    exportName: "WikipediaQueryRun",
    description: "Query Wikipedia article summaries.",
    category: "Web",
    capability: "read",
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/wikipedia_query_run.ts",
  },
  {
    id: "stackexchange",
    label: "Stack Exchange",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/stackexchange",
    exportName: "StackExchangeAPI",
    description: "Search Stack Overflow / Stack Exchange Q&A.",
    category: "Web",
    capability: "read",
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/stackexchange.ts",
  },
  {
    id: "wolfram-alpha",
    label: "Wolfram Alpha",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/wolframalpha",
    exportName: "WolframAlphaTool",
    description: "Computational knowledge engine (math, units, facts).",
    category: "Web",
    capability: "read",
    requiredEnv: ["WOLFRAM_ALPHA_APPID"],
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/wolframalpha.ts",
  },
  {
    id: "calculator",
    label: "Calculator",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/calculator",
    exportName: "Calculator",
    description: "Math expression evaluator (mathjs).",
    category: "Agent",
    capability: "execute",
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/calculator.ts",
  },
  {
    id: "web-browser",
    label: "Web Browser",
    npmPackage: "langchain",
    manifestPackage: "langchain/tools/webbrowser",
    exportName: "WebBrowser",
    description: "Fetch + summarise a URL using an embedding model.",
    category: "Web",
    capability: "read",
    docsUrl: "https://docs.langchain.com/oss/integrations/tools/webbrowser",
  },
  {
    id: "dalle",
    label: "DALL·E Image Generator",
    npmPackage: "@langchain/openai",
    exportName: "DallEAPIWrapper",
    description: "Generate images via the OpenAI DALL·E API.",
    category: "Images",
    capability: "write",
    requiredEnv: ["OPENAI_API_KEY"],
    docsUrl: "https://docs.langchain.com/oss/integrations/tools/dalle",
  },
  {
    id: "aws-lambda",
    label: "AWS Lambda",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/aws_lambda",
    exportName: "AWSLambda",
    description: "Invoke an AWS Lambda function as a tool.",
    category: "Shell",
    capability: "execute",
    requiredEnv: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
    docsUrl: "https://docs.langchain.com/oss/integrations/tools/lambda_agent",
  },
  {
    id: "discord",
    label: "Discord",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/discord",
    exportName: "DiscordSendMessagesTool",
    description: "Send messages to Discord channels.",
    category: "Agent",
    capability: "write",
    requiredEnv: ["DISCORD_BOT_TOKEN"],
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/discord.ts",
  },
  {
    id: "ifttt",
    label: "IFTTT Webhooks",
    npmPackage: "@langchain/community",
    manifestPackage: "@langchain/community/tools/ifttt",
    exportName: "IFTTTWebhook",
    description: "Trigger IFTTT applets via webhook.",
    category: "Agent",
    capability: "execute",
    requiredEnv: ["IFTTT_WEBHOOK_KEY"],
    docsUrl: "https://github.com/langchain-ai/langchainjs-community/tree/main/libs/community/src/tools/ifttt.ts",
  },
];

export function getLangChainCatalog(): readonly LangChainCatalogEntry[] {
  return LANGCHAIN_CATALOG;
}
