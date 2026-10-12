// Static imports keep providers visible to Next's server bundler. Registration
// uses each module's provider name rather than a second name-to-provider map.
import { anthropicProvider } from "./anthropic";
import { deepseekProvider } from "./deepseek";
import { geminiProvider } from "./gemini";
import { githubCopilotProvider } from "./github-copilot";
import { langchainProvider } from "./langchain";
import { mockProvider } from "./mock";
import { openaiProvider } from "./openai";
import type { ModelProvider } from "./types";
import { registerBuiltinProvider } from "./registry";

const PROVIDER_MODULES: readonly (ModelProvider | undefined)[] = [
  openaiProvider,
  anthropicProvider,
  githubCopilotProvider,
  deepseekProvider,
  geminiProvider,
  langchainProvider,
  mockProvider,
];

for (const provider of PROVIDER_MODULES) {
  if (provider) registerBuiltinProvider(provider);
}