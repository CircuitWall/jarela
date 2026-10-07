import type { ContentPart } from "@/lib/tools/runtime/types";

export interface FileReferenceMetadata {
  type: "file_reference";
  storage: "jarela" | "filesystem";
  ref: string;
  filename: string;
  media_type: string;
  size: number | null;
  sha256: string | null;
}

export interface AttachmentHandlingMetadata {
  version: 1;
  interpretation_message_id: string;
  references: FileReferenceMetadata[];
}

export function fileReferenceFromContentPart(part: ContentPart): FileReferenceMetadata | null {
  if (part.type !== "file_ref" && part.type !== "image_ref") return null;
  return {
    type: "file_reference",
    storage: "jarela",
    ref: part.name,
    filename: part.type === "file_ref" ? part.filename : part.filename ?? part.name,
    media_type: part.media_type,
    size: typeof part.size === "number" ? part.size : null,
    sha256: typeof part.sha256 === "string" ? part.sha256 : null,
  };
}

export function isFileReferenceMetadata(value: unknown): value is FileReferenceMetadata {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<FileReferenceMetadata>;
  return ref.type === "file_reference"
    && (ref.storage === "jarela" || ref.storage === "filesystem")
    && typeof ref.ref === "string"
    && typeof ref.filename === "string"
    && typeof ref.media_type === "string"
    && (ref.size === null || typeof ref.size === "number")
    && (ref.sha256 === null || typeof ref.sha256 === "string");
}

export function formatAttachmentHandlingContext(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const handling = value as Partial<AttachmentHandlingMetadata>;
  if (!Array.isArray(handling.references)) return "";
  const references = handling.references.filter(isFileReferenceMetadata);
  if (references.length === 0) return "";
  const lines = references.map((ref) => {
    const identity = ref.sha256 ? `sha256=${ref.sha256}` : `ref=${ref.ref}`;
    const locator = ref.storage === "filesystem" ? `path=${ref.ref}` : `Jarela ref=${ref.ref}`;
    const size = typeof ref.size === "number" ? `${ref.size} bytes` : "size unknown";
    return `- ${ref.filename} (${ref.media_type}, ${size}, ${identity}; ${locator})`;
  });
  return `\n\n[File references handled in this assistant turn]\n${lines.join("\n")}`;
}
