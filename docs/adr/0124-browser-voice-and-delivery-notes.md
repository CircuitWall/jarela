# ADR-0124: Per-agent device voice and browser-voice delivery notes

Status: **Accepted**

Date: 2026-11-22

Related: [ADR-0123](./0123-pluggable-voice-input-engines.md) (pluggable voice
engines and reply TTS that follows the engine), [ADR-0017](./0017-voice-via-gemini.md)
(Gemini TTS, its free-form `style` argument).

## Context

ADR-0123 splits reply speech by engine: Gemini input is read by Gemini TTS,
Browser and Whisper input by the operating system's voices through
`speechSynthesis`. The device path had no voice control at all — every reply
used whatever default the browser picked, which is often not the voice the user
wants to listen to for a long answer — and reply-level `[[tone: …]]` notes were
consumed and then thrown away, because `SpeechSynthesisUtterance` has no style
input.

Two constraints shape the fix:

- `speechSynthesis.getVoices()` is populated asynchronously (`voiceschanged`)
  and differs per machine and per browser profile, so a stored voice cannot be
  an index.
- `SpeechSynthesisUtterance` exposes only `voice`, `lang`, `rate`, `pitch` and
  `volume`. Browsers ignore SSML; Chrome and Edge read tag text literally. A
  delivery note therefore cannot be honoured the way Gemini honours it.

## Decision

1. **Store a portable key, resolve it per device.** `agent_configs.voice_browser_voice`
   holds the voice's `voiceURI` when the engine provides one, otherwise its
   display name (`lib/voice/tts/browser-voice.ts`). An empty string means "device
   default" and is the migration default, so upgrades speak exactly as before.
   A key that is not installed on the current machine falls back to the device
   default, and the agent editor says so instead of silently changing voices.
2. **Pick from the live device list.** The agent editor lists
   `getVoices()` (refreshed on `voiceschanged`, sorted by language then name)
   with an explicit "Device default" entry. The value is advisory: a missing
   voice never prevents speech.
3. **Approximate tone notes with a deterministic table.** `browserProsody()`
   maps a small keyword vocabulary — whisper, calm/warm/reassuring,
   serious, excited, slow — to `rate`/`pitch`/`volume`. Unrecognised notes stay
   neutral rather than guessing. Gemini TTS keeps receiving the raw note as
   `style`, which is the only path with real delivery control.
4. **The agent writes words, not knobs.** The hidden `[[tone: …]]` note remains
   the only control surface; there are no numeric directives to learn, echo, or
   leak into the visible message. The voice prompt block names the vocabulary
   the device path actually understands.

## Consequences

- Voice choice is per agent and per device. A profile synced to another machine
  keeps the key but falls back visibly, which is the honest outcome without
  shipping voice fixtures.
- Tone support on the device path is coarse and keyword-bound; a note such as
  "brisk and matter-of-fact" reads neutral. This is stated in the prompt rather
  than presented as full parity with Gemini.
- Both readers — the finished-reply bubble and the streaming sentence queue —
  share the same voice and prosody resolution, so a reply sounds the same
  whether it is read live or replayed.
- Adding a column is a schema change, hence this ADR. The migration is additive
  with a default, so a rollback keeps working against the older code.

## Alternatives considered

- **Numeric directives in the prompt** (`[[tone: rate=0.9]]`): exposes TTS
  internals to the model, invites invalid values, and does not translate to
  Gemini. Rejected.
- **SSML markup**: browsers ignore it, and some engines speak the tags aloud.
  Rejected.
- **Per-message voice selection**: multiplies the settings surface for a
  preference that is stable per agent. Rejected.
