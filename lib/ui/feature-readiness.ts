import type { IntegrationStatus, ModelConfig } from "@/api/types";
import { modelCapabilities, type ModelCapabilities } from "@/lib/providers/capabilities";

function providerLikelySupportsEmbeddings(provider: string): boolean {
  return new Set(["openai", "gemini", "github-copilot", "mock"]).has(provider.toLowerCase());
}

function isIntegrationConfigured(statuses: IntegrationStatus[], name: string): boolean {
  return statuses.some((status) => status.name === name && status.configured);
}

export interface FeatureReadiness {
  selectedModelCaps: ModelCapabilities | null;
  hasGoogleIntegration: boolean;
  hasGeminiModel: boolean;
  hasEmbeddingsModel: boolean;
  voiceReady: boolean;
  documentsReady: boolean;
}

export function computeFeatureReadiness({
  models,
  integrations,
  selectedProvider,
  selectedModelId,
}: {
  models: ModelConfig[];
  integrations?: IntegrationStatus[];
  selectedProvider?: string;
  selectedModelId?: string;
}): FeatureReadiness {
  const selectedModelCaps = selectedProvider && selectedModelId
    ? modelCapabilities(selectedProvider, selectedModelId)
    : null;

  const hasGoogleIntegration = isIntegrationConfigured(integrations ?? [], "google");
  const hasGeminiModel = models.some((model) => model.provider === "gemini") || selectedProvider === "gemini";
  const hasEmbeddingsModel = models.some((model) => providerLikelySupportsEmbeddings(model.provider))
    || !!selectedProvider && providerLikelySupportsEmbeddings(selectedProvider);

  return {
    selectedModelCaps,
    hasGoogleIntegration,
    hasGeminiModel,
    hasEmbeddingsModel,
    voiceReady: hasGoogleIntegration && hasGeminiModel,
    documentsReady: hasEmbeddingsModel,
  };
}
