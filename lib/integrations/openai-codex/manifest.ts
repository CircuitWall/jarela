import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const openaiCodexManifest: IntegrationManifest = {
  id: "openai-codex",
  name: "OpenAI Codex (ChatGPT)",
  summary:
    "Lets the agent delegate a coding task to the locally installed Codex CLI, using your existing ChatGPT sign-in or an OpenAI API key for trusted automation.",
  category: "infrastructure",
  prerequisites: [
    {
      check: "credentials",
      detail: "A ChatGPT account with Codex access, or an OpenAI Platform API key for usage-based automation.",
      docs_url: "https://learn.chatgpt.com/docs/auth",
    },
    {
      check: "env",
      detail: "Codex CLI installed locally. Run `npm install -g @openai/codex`, then run `codex login` to complete browser sign-in with ChatGPT.",
      docs_url: "https://learn.chatgpt.com/docs/codex/cli",
    },
  ],
  steps: [
    {
      id: "install-codex",
      title: "Install and sign in to Codex",
      description:
        "Install the Codex CLI with `npm install -g @openai/codex`. In a terminal, run `codex login` and complete the browser sign-in with ChatGPT. The CLI reuses that local login when Jarela calls it.",
      docs_url: "https://learn.chatgpt.com/docs/codex/cli",
    },
    {
      id: "configure-codex",
      title: "Configure Codex in Jarela",
      description:
        "Propose enabling the integration and enter `codex` as the CLI command. A saved API key is optional and is intended only for trusted automated runs; leave it blank to use the Codex CLI's ChatGPT sign-in.",
      proposes: "enable_integration",
    },
  ],
  troubleshooting: [
    {
      when: "codex CLI not found",
      say: "Install it with `npm install -g @openai/codex`, or set its executable path in Settings -> Credentials -> OpenAI Codex (ChatGPT).",
    },
    {
      when: "Codex reports that authentication is required",
      say: "Run `codex login` in a terminal to sign in with ChatGPT. Alternatively, save a valid OpenAI API key for this integration; API-key use is billed at standard Platform API rates.",
    },
    {
      when: "the delegated task cannot edit files",
      say: "Jarela starts Codex in a read-only sandbox by default. Set allow_unsafe to true only for a task you trust to grant workspace-write access.",
    },
  ],
};