import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const githubCopilotCliManifest: IntegrationManifest = {
  id: "github-copilot-cli",
  name: "GitHub Copilot (agent runtime)",
  summary:
    "Lets the agent delegate a coding task to the GitHub Copilot agent runtime through the Copilot SDK, using your existing Copilot CLI sign-in or a fine-grained GitHub token.",
  category: "infrastructure",
  dependencies: [
    {
      kind: "node-runtime",
      id: "node",
      version: "^24.15.0 || >=26.0.0",
      hint: "Upgrade Node.js to 24.15.0+ (24.x) or 26+ — the Copilot SDK runtime requires it.",
      docs_url: "https://nodejs.org/en/download",
    },
  ],
  prerequisites: [
    {
      check: "credentials",
      detail: "A GitHub Copilot subscription. Authentication reuses the GitHub integration token, which needs the Copilot Requests permission when it is used for this integration, or the Copilot CLI sign-in from `copilot login`.",
      docs_url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    },
    {
      check: "env",
      detail: "Node.js ^20.19 or >=22.12. The Copilot SDK ships the runtime in a platform package, so no separate CLI install is required.",
      docs_url: "https://www.npmjs.com/package/@microsoft/copilot-sdk",
    },
  ],
  steps: [
    {
      id: "sign-in-copilot",
      title: "Connect a GitHub credential",
      description:
        "The delegate reuses the GitHub integration token, so the same credential that serves the github_* tools authenticates Copilot; add the Copilot Requests permission to the fine-grained token. Alternatively run `copilot login` once and leave the GitHub token unset. Classic personal access tokens are not supported.",
      docs_url: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#copilot-login-options",
    },
    {
      id: "enable-copilot-delegate",
      title: "Enable delegation",
      description:
        "Propose enabling the integration. Optionally set a default model and timeout. Copilot runs inherit the CLI's own instructions, skills, MCP servers and plugins, and every permission request it raises is approved once and recorded in the transcript.",
      proposes: "enable_integration",
    },
  ],
  troubleshooting: [
    {
      when: "Copilot runtime failed to start",
      say: "Confirm the Copilot subscription is active and that either `copilot login` succeeded or a valid fine-grained token with the Copilot Requests permission is saved. Set a runtime path only when you want to replace the bundled runtime.",
    },
    {
      when: "copilot_delegate returns SAFETY_BLOCKED",
      say: "copilot_delegate refuses to run under JARELA_TOOL_SAFETY=safe, since the delegated agent can edit files and run commands. Raise the tier to 'mostly_safe' (the default) or 'bypass'.",
    },
    {
      when: "The delegated turn reports a timeout",
      say: "Raise the timeout in seconds, or split the task. A timeout aborts the Copilot turn; partial edits may already be on disk, so inspect the git diff before retrying.",
    },
  ],
};
