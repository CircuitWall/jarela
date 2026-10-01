// view_attachment: on-demand re-read for an image/file attachment ref that
// has aged out of the live context window.
//
// ADR-0090: `toBaseMessages` (lib/agents/llm.ts) only reads an `image_ref`/
// `file_ref` back off disk for the newest turn — every earlier occurrence
// collapses to a `[image attachment: ...]` / `[file attachment: ...]`
// placeholder that still carries the ref's `name` and `media_type`. This
// tool is how the model acts on "call view_attachment(...)" in that
// placeholder.
//
// Files: returns the actual text content again (same decode path as the
// newest-turn readout in llm.ts). Images: no provider adapter in this
// codebase can carry a vision block in a tool result — every `tool`-role
// message is coerced to a string before it reaches the provider (see
// lib/providers/{anthropic,openai,gemini}.ts and lib/providers/langchain.ts)
// — so this can only hand back the file's URL, not its pixels. The response
// says so explicitly rather than letting the model assume it can "see" the
// image again.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";
import { readFileRef } from "@/lib/attachments/spill";
import { isSafeFileName } from "@/lib/files";
import { getConfig } from "@/lib/env/config";

function isTextMediaType(media_type: string): boolean {
  return media_type.startsWith("text/") || media_type === "application/json";
}

function clip(text: string, max: number): { value: string; truncated: boolean } {
  if (text.length <= max) return { value: text, truncated: false };
  return { value: text.slice(0, max), truncated: true };
}

export const viewAttachmentTool = tool(
  async ({ name, media_type }) => {
    if (!isSafeFileName(name)) {
      return JSON.stringify({ ok: false, error: `unsafe attachment name: ${name}` });
    }
    if (media_type.startsWith("image/")) {
      return JSON.stringify({
        ok: true,
        kind: "image",
        url: `/api/v1/files/${name}`,
        media_type,
        note: "This only returns the URL — you do not regain visual access to the image's pixels through this tool. Share the URL with the user (e.g. markdown `![alt](url)`) rather than claiming to have looked at it again.",
      });
    }
    try {
      const buf = await readFileRef({ name });
      if (!isTextMediaType(media_type)) {
        return JSON.stringify({
          ok: true,
          kind: "file",
          url: `/api/v1/files/${name}`,
          media_type,
          note: "Binary file — not text-renderable here. Use the URL to point the user at it.",
        });
      }
      const clipped = clip(buf.toString("utf8"), getConfig().filesMaxReadBytes);
      return JSON.stringify({ ok: true, kind: "file", content: clipped.value, truncated: clipped.truncated });
    } catch (err) {
      return JSON.stringify({ ok: false, error: (err as Error).message });
    }
  },
  {
    name: "view_attachment",
    description:
      "Re-surface an image or file attachment that aged out of the live context — use it when a `[image attachment: ...]` / `[file attachment: ...]` placeholder tells you to call it with that placeholder's exact `name` and `media_type`. For files it returns the actual text content again. For images it only returns the URL — this codebase cannot replay image pixels back into a tool result, so calling it does not restore your view of the image.",
    schema: z.object({
      name: z.string().describe("The ref name from the placeholder text, e.g. `3af2e1....png` or `9c01b2....pdf`."),
      media_type: z.string().describe("The media type from the placeholder text, e.g. `image/png` or `text/plain`."),
    }),
  },
);

registerLangChainPackage({ category: "Files", tools: { read: [viewAttachmentTool] } });
