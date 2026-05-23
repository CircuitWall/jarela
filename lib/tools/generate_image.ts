// generate_image: produce an image from a text prompt using Google's Gemini
// image-generation models (a.k.a. "nano banana") via the Generative Language
// REST API. Falls back to Imagen if the user picks one of those model ids.
//
// API key resolution: integrations store ("google" → api_key) →
// GEMINI_API_KEY env → GOOGLE_API_KEY env. The Integrations panel is the
// recommended way to set this.
//
// Output: PNG bytes written to ~/.jarela/files/<uuid>.png. The tool returns
// a relative URL the chat renderer can embed via markdown `![alt](url)`.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { writeBinaryFile } from "@/lib/files";
import { getConfig } from "@/lib/env/config";
import { registerTools } from "./registry";

const DEFAULT_MODEL = "gemini-2.5-flash-image";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(new Error(`timeout after ${ms}ms`)), ms).unref?.();
  return c.signal;
}

function resolveApiKey(): string | null {
  const raw = getIntegrationRaw("google");
  const fromStore = raw?.api_key?.trim();
  if (fromStore) return fromStore;
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim() || null;
}

interface InlineData {
  mimeType?: string;
  mime_type?: string;
  data?: string;
}
interface GeminiPart {
  text?: string;
  inlineData?: InlineData;
  inline_data?: InlineData;
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  error?: { message?: string };
}

interface ImagenPrediction {
  bytesBase64Encoded?: string;
  mimeType?: string;
}
interface ImagenResponse {
  predictions?: ImagenPrediction[];
  error?: { message?: string };
}

async function callGemini(model: string, prompt: string, apiKey: string): Promise<{ data: Buffer; mime: string }> {
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutSignal(getConfig().imageTimeoutMs),
    });
  } catch (err) {
    throw new Error(`Gemini request failed: ${describeError(err)}`);
  }
  const json = (await res.json()) as GeminiResponse;
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${json.error?.message ?? "request failed"}`);
  }
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = p.inlineData ?? p.inline_data;
    const data = inline?.data;
    const mime = inline?.mimeType ?? inline?.mime_type ?? "image/png";
    if (data) return { data: Buffer.from(data, "base64"), mime };
  }
  const text = parts.map((p) => p.text).filter(Boolean).join(" ").trim();
  throw new Error(text ? `Gemini returned no image: ${text}` : "Gemini returned no image");
}

async function callImagen(model: string, prompt: string, apiKey: string, n: number, aspect: string): Promise<Array<{ data: Buffer; mime: string }>> {
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:predict?key=${encodeURIComponent(apiKey)}`;
  const body = {
    instances: [{ prompt }],
    parameters: { sampleCount: Math.max(1, Math.min(4, n)), aspectRatio: aspect },
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutSignal(getConfig().imageTimeoutMs),
    });
  } catch (err) {
    throw new Error(`Imagen request failed: ${describeError(err)}`);
  }
  const json = (await res.json()) as ImagenResponse;
  if (!res.ok) {
    throw new Error(`Imagen ${res.status}: ${json.error?.message ?? "request failed"}`);
  }
  const preds = json.predictions ?? [];
  const out: Array<{ data: Buffer; mime: string }> = [];
  for (const p of preds) {
    if (p.bytesBase64Encoded) {
      out.push({ data: Buffer.from(p.bytesBase64Encoded, "base64"), mime: p.mimeType ?? "image/png" });
    }
  }
  if (out.length === 0) throw new Error("Imagen returned no image");
  return out;
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${err.message}: ${cause.message} (${code})` : `${err.message}: ${cause.message}`;
  }
  return err.message;
}

function extForMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "png";
}

export const generateImageTool = tool(
  async ({ prompt, model, count, aspect_ratio }) => {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error("prompt is required and must be non-empty");

    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw new Error(
        'Google API key not configured. Open the Integrations panel and set "Google AI (Gemini + Imagen)", or set GEMINI_API_KEY in the environment.',
      );
    }

    const m = (model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const aspect = aspect_ratio ?? "1:1";
    const n = count ?? 1;

    const images = m.startsWith("imagen")
      ? await callImagen(m, trimmed, apiKey, n, aspect)
      : [await callGemini(m, trimmed, apiKey)];

    const saved = images.map((img) => {
      const name = `img-${randomUUID()}.${extForMime(img.mime)}`;
      writeBinaryFile(name, img.data);
      const url = `/api/v1/files/${name}`;
      return { url, mime: img.mime, bytes: img.data.length };
    });

    return JSON.stringify({
      model: m,
      prompt: trimmed,
      images: saved,
      markdown: saved.map((s, i) => `![${trimmed.slice(0, 80)}${images.length > 1 ? ` (${i + 1})` : ""}](${s.url})`).join("\n\n"),
      hint: "Embed images in your reply using the `markdown` field verbatim, or build your own `![alt](url)` from `images[].url`.",
    });
  },
  {
    name: "generate_image",
    description:
      "Generate one or more images from a text prompt using Google's Gemini image models (default: gemini-2.5-flash-image) or Imagen. Returns local URLs the assistant should embed in its reply via markdown `![alt](url)`. Requires the Google integration (api_key) to be configured.",
    schema: z.object({
      prompt: z.string().describe("Detailed description of the image to generate."),
      model: z
        .string()
        .optional()
        .describe(
          "Optional Google model id. Defaults to `gemini-2.5-flash-image`. Use an `imagen-*` model (e.g. `imagen-3.0-generate-002`) for higher-fidelity stills.",
        ),
      count: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe("Number of images to generate. Only honored by Imagen models; Gemini models always return 1."),
      aspect_ratio: z
        .enum(["1:1", "3:4", "4:3", "9:16", "16:9"])
        .optional()
        .describe("Aspect ratio. Only honored by Imagen models; ignored by Gemini image models."),
    }),
  },
);

registerTools("Images", [generateImageTool]);
