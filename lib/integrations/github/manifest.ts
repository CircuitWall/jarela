import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const githubManifest: IntegrationManifest = {
  id: "github",
  name: "GitHub",
  summary:
    "Lets the agent search, read, create, comment on, open/merge, and review GitHub issues " +
    "and pull requests, list branches, read repo files, and search code via the REST API. " +
    "Authenticates with a Personal Access Token.",
  category: "issue-tracker",
  prerequisites: [
    {
      check: "credentials",
      detail:
        "A GitHub account with access to the repos you want the agent to read or write. " +
        "For org repos, the org must allow PAT access (Settings → Third-party Access → Personal access tokens).",
    },
    {
      check: "credentials",
      detail:
        "A Personal Access Token (classic or fine-grained) created at github.com/settings/tokens. " +
        "Classic tokens need `repo` (or `public_repo` for public-only). Fine-grained tokens need " +
        "Contents: read, Issues: read/write, and Pull requests: read/write on the selected repositories. " +
        "`read:org` is only needed for organization-specific operations such as team reviewer lookup.",
      docs_url: "https://docs.github.com/en/rest/overview/permissions-required-for-fine-grained-personal-access-tokens",
    },
  ],
  steps: [
    {
      id: "create-pat",
      title: "Create a GitHub Personal Access Token",
      description:
        "Open github.com/settings/tokens → Generate new token. For classic tokens, tick `repo` (or " +
        "`public_repo` for public repos only); add `read:org` only if you need organization team reviewer " +
        "lookup. For fine-grained tokens, pick the repos and grant Contents: Read-only, Issues: Read+Write, " +
        "and Pull requests: Read+Write. Copy the token immediately — GitHub only " +
        "shows it once.",
      docs_url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    },
    {
      id: "save-credentials",
      title: "Save the token in Jarela",
      description:
        "Propose enabling the integration. The user will be asked for the token; it is stored encrypted at rest.",
      proposes: "enable_integration",
    },
  ],
  troubleshooting: [
    {
      when: "tool returns 401 Unauthorized",
      say:
        "The token is wrong, expired, or was revoked. Ask the user to regenerate it at " +
        "github.com/settings/tokens and re-enter it in the Integrations panel.",
    },
    {
      when: "tool returns 403 with rate-limit message",
      say:
        "GitHub rate-limited this token. Wait until the reset window indicated in the response, or ask the " +
        "user to switch to a token with higher limits (authenticated requests get 5000/hr).",
    },
    {
      when: "tool returns 403 'Resource not accessible by personal access token'",
      say:
        "Fine-grained tokens are scoped to specific repos AND specific permissions. Either widen the token's " +
        "repo selection, grant the missing permission (Issues / Pull requests: Read+Write), or fall back to a " +
        "classic token with the `repo` scope.",
    },
    {
      when: "tool returns 404 on a repo the user can see in the browser",
      say:
        "The token can't see the repo. For org-owned private repos, the org must allow PAT access " +
        "(org Settings → Third-party Access). Ask the user to verify the org's PAT policy.",
    },
  ],
};
