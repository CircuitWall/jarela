// GET  /api/v1/voice/whisper — local Whisper engine readiness
// POST /api/v1/voice/whisper — start (or retry) the one-time model download
//
// ADR-0123. The model (~45 MB, hash-pinned) is fetched into the data
// directory on demand; the download runs in the background so the status
// poll never holds a request open.
import { NextResponse } from "next/server";
import { isRuntimePackageInstalled } from "@/lib/dependencies/runtime-package";
import {
  WHISPER_DOWNLOAD_ENV,
  getWhisperModelStatus,
  startWhisperModelDownload,
} from "@/lib/voice/whisper-model";

const RUNTIME_PACKAGE = "@huggingface/transformers";

function statusBody() {
  return {
    engine: "whisper" as const,
    model: getWhisperModelStatus(),
    runtime_installed: isRuntimePackageInstalled(RUNTIME_PACKAGE),
    runtime_package: RUNTIME_PACKAGE,
    download_disabled: process.env[WHISPER_DOWNLOAD_ENV] === "0",
  };
}

export function GET() {
  return NextResponse.json(statusBody(), { headers: { "Cache-Control": "no-store" } });
}

export function POST() {
  if (getWhisperModelStatus().state !== "ready") {
    startWhisperModelDownload({ force: true }).catch(() => {
      // The failure surfaces through the next GET; there is no caller waiting.
    });
  }
  return NextResponse.json(statusBody(), {
    status: 202,
    headers: { "Cache-Control": "no-store" },
  });
}
