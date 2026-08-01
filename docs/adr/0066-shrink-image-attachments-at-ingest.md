# ADR-0066: Shrink image attachments at ingest

- Status: Accepted
- Date: 2026-08-02

## Context

ADR-0065 moved image payloads out of `messages.content` and onto disk
under `<dataDir>/files/<sha256>.<ext>`, keyed by their content hash.
That fixed the pathological growth of `messages` and `checkpoints.db`,
but it did nothing about the **size of an individual image** on the
wire.

Vision providers we speak to today all downsample to their own fixed
grids: Anthropic caps around 1568×1568, OpenAI at 2048×2048, Gemini
at 3072×3072. A 4032×3024 iPhone photo — the median WhatsApp bridge
attachment — is ~3 MB of JPEG that the model resamples down to those
grids anyway. Shipping the original costs:

- Upload latency on every provider round-trip.
- Image tokens (both Anthropic and OpenAI bill per pixel/tile).
- Disk footprint on every ref (the ADR-0065 refs still sit on disk).

There is also a correctness component. Providers don't uniformly
accept HEIC/HEIF/BMP/TIFF; the iOS photo picker returns HEIC by
default. A user-facing "image failed to send" from Gemini after five
retries is a real complaint we do not want to keep debugging.

## Decision

Add `shrinkImage(buf, mediaType, opts?)` in `lib/attachments/shrink.ts`
and run every image through it inside `spillImagePart` before hashing
and writing. So what lands on disk is *already* the transcoded /
resized version — refs stay content-addressed by the shrunk bytes.

Defaults:

- **Longest edge**: 1600 px. Below every provider's downsample grid;
  comfortably above their per-tile boundaries; a good compromise for
  screenshots and photos alike.
- **JPEG quality**: 85 with `mozjpeg` on. Best-in-class encoder for
  photographic content at that quality level.
- **Passthrough floor**: 64 KB. Below that the encoder round-trip
  costs more than it saves.
- **Alpha preservation**: PNGs with `hasAlpha=true` stay as PNG (JPEG
  would flatten transparency to black). Everything else lands as JPEG.
- **Forced transcode**: HEIC, HEIF, BMP, TIFF → JPEG regardless of
  size. These formats are the source of most provider-reject errors.
- **SVG / GIF**: passthrough, always. Vector graphics can't be
  meaningfully resized in raster; still-frame re-encoding a GIF would
  drop animation.

The pipeline also:

- Calls `sharp().rotate()` to apply the EXIF Orientation tag before
  stripping metadata. Users routinely paste photos taken sideways.
- Skips writing when the re-encoded buffer would be **larger** than
  the original (defensive: mozjpeg on an already-optimised sub-64 KB
  JPEG can occasionally grow the file).
- Falls back to passthrough on any decode or encode error — losing an
  attachment is a worse failure mode than shipping the original.

Sharp is loaded via dynamic `import("sharp")` so installs that never
see an image ingest don't pay the native-binary load cost. `sharp` was
already a declared dep + externalised in `next.config.ts`, so the
build treatment doesn't change.

## Consequences

**Size.** A 4032×3024 iPhone JPEG (~3.2 MB) shrinks to 1600×1200 at
q85 mozjpeg — measured ~180–260 KB on typical content. That's a
12–17× win on disk, on the outbound provider request, and in
image-token cost.

**Provider compatibility.** HEIC / HEIF / BMP / TIFF ingest no longer
depends on the provider's tolerance for those formats. Refs land as
JPEG and every provider accepts JPEG.

**Ref stability.** Refs are keyed by the hash of the **shrunk** bytes.
An identical original image ingested twice still dedups (same shrink
output → same hash). But two ingests of the *same* original with
different `ShrinkOpts` will produce different files. In practice we
never vary the opts today, so it's a theoretical concern.

**EXIF stripping.** We drop EXIF as a side effect of the re-encode.
Location and camera metadata that would previously ride along an
inline base64 blob no longer reach the model. If a workflow ever
needs the EXIF, the caller can bypass shrink with an explicit opt.

**Legacy files.** ADR-0065's boot migration spilled inline images to
disk **without** shrinking them (it runs inside a sync migration path
and sharp is async). Existing on-disk blobs stay at their original
size. A future maintenance task can re-hash them post-shrink; there's
no runtime pressure since the messages rows are already small.

**Test surface.** New unit tests in `lib/attachments/shrink.test.ts`
exercise: tiny-passthrough, resize, alpha preservation, SVG/GIF
passthrough, and graceful passthrough on invalid input.

## Alternatives considered

- **Client-side shrink before upload.** Doesn't cover WhatsApp bridge
  or page-capture. The client-upgrade PR can add it later as a
  latency win; the ingest funnel remains the source of truth.
- **Provider-specific shrink** (WebP for Gemini, JPEG for Anthropic).
  Refs are shared across providers — a per-provider format would break
  dedup. The one-format-fits-all choice trades a few percent of size
  for correctness and simplicity.
- **Skip shrink on user preference.** Deferred until anyone asks. The
  passthrough floor and passthrough-on-failure paths already handle
  the "leave my picture alone" cases that matter.

## References

- `lib/attachments/shrink.ts` — the helper.
- `lib/attachments/spill.ts` — calls `shrinkImage` inside `spillImagePart`.
- `lib/attachments/shrink.test.ts` — six unit tests.
- ADR-0065 — the ref refactor this layers on top of.
