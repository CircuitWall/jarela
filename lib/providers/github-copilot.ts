import { makeOpenAICompatProvider } from "./openai";

// GitHub Copilot Chat API is OpenAI-compatible with specific required headers
export const githubCopilotProvider = makeOpenAICompatProvider(
  "github-copilot",
  "https://api.githubcopilot.com",
  {
    "Editor-Version": "vscode/1.85.0",
    "Copilot-Integration-Id": "vscode-chat",
    "openai-intent": "conversation-ai",
  },
);
