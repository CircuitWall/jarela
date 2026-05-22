---
status: accepted
date: 2026-05-22
deciders: andwu
consulted:
informed:
---

# Add voice (STT + TTS) using Gemini, gated by per-agent config

## Context and Problem Statement

We want two voice features in the chat surface:

1. **Push-to-talk input** — the user holds a button, the browser records
   audio, and the app transcribes it before sending the text to the agent.
2. **Spoken replies** — agents can call a `generate_voice` tool to produce
   an audio clip for a phrase ("read this paragraph back to me", multi-
   speaker scenes), and the chat renderer plays it inline.

Both features ship audio bytes through *some* third party. The decision is
which third party, where the bytes flow, and how the agent's tool surface
exposes the capability without leaking voice/model selection into prompts
the user has no visibility into.

CLAUDE.md decision triggers force this to be an ADR: voice adds a new
external dependency direction (audio in/out, not just LLM text) and a new
tool category that the safety policy needs to acknowledge.

## Decision Drivers

* **Local-first invariant** — no new daemon, no telemetry, audio must
  flow only between the user's browser, the local Next.js process, and a
  vendor API the user has explicitly configured. Same threat model as the
  existing LLM providers.
* **Vendor minimization** — every additional vendor multiplies the
  configure / rotate / break surface. Reusing an already-configured
  provider beats adding a fifth.
* **No surprise billing** — voice models often have separate quotas /
  pricing tiers. A user who has only typed an Anthropic key shouldn't
  have voice silently fail; it should be off until they opt in.
* **Per-agent personality** — the user picks the voice (e.g. "Kore",
  "Puck") in the AgentEditor, not the agent at tool-call time. Agents
  routinely make poor preference calls; voice/model should not be in
  their schema.
* **Streaming UI parity** — voice playback should feel like text in chat:
  rendered inline, replayable, link-shareable, no modal.

## Considered Options

* **OpenAI Whisper (STT) + OpenAI tts-1 (TTS)** — same vendor, mature.
  Adds a hard dependency on having an OpenAI key, even for users who run
  Anthropic-only.
* **ElevenLabs (TTS) + Whisper (STT)** — premium TTS quality. Adds a new
  vendor, new key rotation surface, and ElevenLabs has stricter
  per-character billing than the LLM providers.
* **Google GenAI (Gemini) — `models/*-preview-tts` for TTS, multimodal
  Gemini for STT** — reuses the existing `google` integration that the
  `generate_image` tool already requires. One key, one rotation surface,
  one quota. Native REST endpoints for both directions.
* **Browser-native Web Speech API** — zero vendor cost, but quality is
  poor on Chromium-without-internet, broken on Safari, and TTS voices
  vary unpredictably across OS versions. Doesn't satisfy multi-speaker
  scenes.

## Decision Outcome

Chosen option: **Google GenAI (Gemini)**, because it is the only option
that adds zero new vendors for users who already configured the `google`
integration for image generation, and it covers both directions (STT + TTS)
with the same API key.

The voice surface is gated three ways to satisfy the local-first and
no-surprise-billing drivers:

1. **Per-agent toggle** — `voice_enabled` on `agent_configs`. Off by default.
2. **Per-agent voice + STT model fields** — `voice_model`, `voice_name`,
   `voice_stt_model` are picked by the user in the AgentEditor.
   `generate_voice` reads them via `resolveAgentVoice(config)` and does
   *not* expose them in the tool schema.
3. **Hard fail with a guidance message** if the Google API key is missing.

Implementation lives in [lib/voice/gemini.ts](../../lib/voice/gemini.ts)
(API client) and [lib/tools/generate_voice.ts](../../lib/tools/generate_voice.ts)
(tool surface). Audio clips land in `~/.jarela/files/voice-<uuid>.wav`
and are served by `GET /api/v1/files/[name]`, the same path used by
`generate_image`.

### Consequences

* Good, because users with the Google integration already configured get
  voice for free — no new key, no new rotation surface.
* Good, because the agent cannot accidentally pick a different voice or
  model: those are user preferences, not agent decisions.
* Good, because the file pipeline (`lib/files` → `/api/v1/files/`) already
  exists for `generate_image`, so the chat renderer's inline-media path
  is reused.
* Bad, because users on Anthropic-only setups have to add a Google API
  key to get voice — that's a 30-second config step, but it's a step.
* Bad, because Gemini's TTS uses preview models (`*-preview-tts`) whose
  contract may change. Mitigated by the per-agent model field — if the
  default breaks we can change it without an app update.
* Neutral, because we add a new outbound dependency direction (audio
  bytes leave the host), but only to a vendor the user already trusts
  for text inference. Same proxy / TLS path as the LLM call.

## Pros and Cons of the Options

### OpenAI (Whisper + tts-1)

* Good, because mature APIs with reliable contracts.
* Bad, because requires an OpenAI key for voice even when the user has no
  reason to send text to OpenAI.

### ElevenLabs + Whisper

* Good, because TTS quality is currently the best on the market.
* Bad, because adds a *third* vendor relationship (LLM + TTS + STT) and
  an aggressive per-character billing model that surprises users.

### Google GenAI (chosen)

* Good, because reuses the `google` integration we already require for
  `generate_image`.
* Good, because one key for STT + TTS + LLM + image generation.
* Bad, because preview-tagged TTS endpoints carry contract risk.

### Browser Web Speech API

* Good, because zero vendor cost and works offline on supported browsers.
* Bad, because cross-browser quality / availability is inconsistent and
  multi-speaker dialogue is not supported.

## More Information

* [lib/voice/gemini.ts](../../lib/voice/gemini.ts) — REST client for both
  directions.
* [lib/tools/generate_voice.ts](../../lib/tools/generate_voice.ts) — tool
  schema and per-agent voice resolution.
* [ARCHITECTURE.md](../ARCHITECTURE.md) — Voice container in the
  C4-Container diagram and the Gemini STT/TTS row in External Dependencies.
* Related: [ADR-0010 — Agent-led integration setup](./0010-agent-led-setup-and-integration-manifests.md)
  (the `google` integration manifest the voice surface depends on).
