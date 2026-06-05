/**
 * @public — `POST /api/v1/page-capture` (with CORS `OPTIONS` preflight)
 *
 * Browser-extension upload endpoint: receives the active page's URL,
 * title, and selected/full text and routes it into the active thread.
 * See `docs/api.md`.
 */

import { handlePageCapture, handlePageCaptureOptions } from "@/lib/api/page-capture";

export const POST = handlePageCapture;
export const OPTIONS = handlePageCaptureOptions;
