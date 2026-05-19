import type { IntegrationManifest } from "@/lib/integrations/manifest";

export const googleManifest: IntegrationManifest = {
  id: "google",
  name: "Google AI (Gemini + Imagen)",
  summary:
    "Powers the generate_image tool via Google's Gemini and Imagen models. " +
    "Independent from the Gmail integration — this is just an API key, no OAuth.",
  category: "llm",
  prerequisites: [
    {
      check: "credentials",
      detail:
        "A Google AI Studio API key. Free tier is sufficient for most use; " +
        "Imagen requires a paid project.",
      docs_url: "https://aistudio.google.com/apikey",
    },
  ],
  steps: [
    {
      id: "get-api-key",
      title: "Create an API key in Google AI Studio",
      description:
        "Open aistudio.google.com/apikey, sign in, click Create API key, " +
        "and copy the value (starts with AIza). Keep the tab open until it's saved in Jarela.",
      docs_url: "https://aistudio.google.com/apikey",
    },
    {
      id: "save-key",
      title: "Save the key in Jarela",
      description:
        "Propose enabling the integration. The user will paste the API key into " +
        "a secure field; it's stored encrypted at rest and never sent to the model in plaintext.",
      proposes: "enable_integration",
    },
  ],
  troubleshooting: [
    {
      when: "generate_image returns 'API key not valid'",
      say:
        "The Google AI key is wrong or revoked. Ask the user to regenerate it at " +
        "aistudio.google.com/apikey and re-save in the Integrations panel.",
    },
    {
      when: "generate_image returns 'Imagen requires a paid plan'",
      say:
        "The free Gemini key doesn't include Imagen. Ask the user to enable billing on the " +
        "Google Cloud project linked to the AI Studio key, or pick a Gemini-only image variant.",
    },
  ],
};
