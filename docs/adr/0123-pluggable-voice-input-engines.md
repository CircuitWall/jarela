# ADR-0123: Pluggable voice input engines (browser, Whisper tiny, Gemini)

Status: **Accepted**

Date: 2026-11-21

> **Amended (UX):** capture is hands-free — a short silence pauses the
> capture, and a longer silence ends and sends the turn. Reply TTS follows the
> selected engine: Gemini input uses Gemini TTS; browser and Whisper input use
> the device's built-in voices. Voice-originated turns are tagged with
> `voice_input` metadata so the system prompt shapes the reply for listening
> (prose over tables/code). A spoken reply keeps the conversation going: when
> the auto-spoken reply ends — or the user presses Stop to interrupt it —
> capture reopens, and 5 s of leading silence ends the loop. Only the
> auto-speak path joins the loop; the manual Play button never opens the
> microphone. Reading starts with the first complete sentence of a streaming
> reply rather than after the last token. Whisper remains recognition-only.
> Barge-in and speech-to-speech stay out of scope.

Related: [ADR-0017](./0017-voice-via-gemini.md) (voice via Gemini — input path
amended here), [ADR-0101](./0101-on-demand-local-embedding-model.md)
(hash-pinned on-demand model assets), [ADR-0121](./0121-optional-tool-and-integration-dependencies.md)
/ [ADR-0122](./0122-on-demand-heavy-runtimes.md) (on-demand runtime packages).

## Context

ADR-0017 wired voice input to Gemini: the browser recorded a clip, posted it to
`/api/v1/voice/transcribe`, and a multimodal Gemini model returned text. That
kept one vendor and one key, but it made dictation impossible without the
Google integration — the single most common reason voice looked broken. It
also forced every user's audio through a third party even when a free local or
browser engine would do.

Three engines are now worth supporting, with different trade-offs:

| Engine | Key required | Cost | Quality on technical speech | Offline | Partial text |
| --- | --- | --- | --- | --- | --- |
| Browser `SpeechRecognition` | none | $0 (Chromium/Safari only) | weakest (no vocabulary bias) | no | yes |
| Whisper tiny (local ONNX) | none | $0 | middling, much better than "none" | yes | no |
| Gemini multimodal | Google key | ~$0.005/min | best (contextual, vocabulary bias) | no | no |

Leaving Gemini as the only option also baked an engine-specific assumption
(`voice_stt_model`) into the config surface, so an agent could not express
"record locally" at all.

## Decision

1. **Per-agent engine column.** `agent_configs.voice_stt_engine` holds
   `'gemini' | 'browser' | 'whisper'` and defaults to `'gemini'`, so upgrading
   is a no-op for every existing agent. Unknown values normalize to `gemini`
   rather than failing the write.
2. **One client abstraction.** `lib/voice/stt/` exposes `SttSession`
   (`stop()` → final transcript, plus optional `onPartial`) with a browser
   implementation and a server-backed helper. `useVoiceRecording` no longer
   knows about MediaRecorder, fetch, or any vendor.
3. **One endpoint, dispatched by engine.** `POST /api/v1/voice/transcribe`
   accepts `engine` and falls back to the agent's stored engine when the field
   is absent, so older clients keep working. `browser` is rejected: the Web
   Speech API runs in the page and never sends audio to Jarela.
4. **Whisper inputs are PCM WAV.** The server ships no ffmpeg or opus decoder,
   so the browser decodes its own recording to 16 kHz mono PCM16 WAV before
   upload. The route accepts only `audio/wav` for that engine and rejects
   everything else with 415 instead of guessing.
5. **Whisper runs on the existing on-demand stack.** `@huggingface/transformers`
   is resolved at call time (ADR-0122); the model (`Xenova/whisper-tiny`,
   quantized ONNX, ~45 MB) is pinned by repository, revision, size and hash and
   installed through the same staged, verified downloader as the embedding
   model (ADR-0101). The shared downloader now lives in `lib/assets/`.
   `GET/POST /api/v1/voice/whisper` reports readiness and starts the download;
   a transcription request while the model is missing returns 409 with the
   status instead of holding the socket open.
6. **Gemini stays.** TTS is untouched, and Gemini remains the best input engine
   for technical vocabulary — it is now a choice rather than a prerequisite.

## Consequences

* Dictation works with no keys at all (browser), or fully offline after a
  one-time ~45 MB download (Whisper).
* Whisper tiny is the *floor*, not the ceiling: expect it to mis-hear
  identifiers and file names that Gemini gets right. The editor copy says so.
* The Whisper engine needs a second install step (runtime package + model
  download). Both report actionable states rather than failing silently.
* Interruption semantics are unchanged: all three engines are half-duplex
  (record → pause/auto-end → transcribe). Barge-in and speech-to-speech remain
  out of scope — they would cost the text-in-the-middle architecture that
  tools, memory and checkpoints depend on (see the streaming-TTS follow-up).
* New external dependency: `huggingface.co` for the one-time model download.
  It is opt-in (only when the Whisper engine is used) and hash-verified.

## Alternatives considered

* **`whisper.cpp` native addon** — faster inference, but a per-platform binary
  and a second install mechanism. Rejected: transformers.js is already an
  on-demand runtime in this repo.
* **Let transformers.js fetch from the Hub at first use** — less code, but
  unpinned and unverified, contradicting ADR-0101's asset model.
* **Browser-only** — free and simplest, but Firefox has no Web Speech API and
  quality on code vocabulary is poor, with no local fallback.
* **Speech-to-speech (Gemini Live / OpenAI Realtime)** — best feel, but an
  order of magnitude more expensive and it removes the text transcript that
  every tool call, memory write and checkpoint depends on.

## Browser support requirement

Dictation and read-aloud must work in Chromium-based browsers and in Safari —
desktop and iOS/iPadOS, including the Home Screen PWA. Every engine in this ADR
is a *client* browser API or a server call, so platform quirks are part of the
contract rather than an implementation detail. The quirks that have already
broken this (iOS user-gesture arming, asynchronous voice lists, utterance
garbage collection, `cancel()` semantics, a wedged `speaking` state, and the
one-reader-per-turn rule) and the acceptance checks that guard them are
recorded in
[docs/VOICE_BROWSER_SUPPORT.md](../VOICE_BROWSER_SUPPORT.md).
