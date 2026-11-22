# Voice support: Chromium-based browsers and Safari

**Requirement.** Voice input (dictation) and voice output (read-aloud) must work
in Chromium-based browsers and in Safari, on desktop and on iOS/iPadOS,
including the Home Screen PWA. This is a product requirement, not a
best-effort: a browser listed as supported here must pass the acceptance
checks at the bottom of this page.

## Supported browsers

| Browser | Dictation | Read-aloud | Notes |
| --- | --- | --- | --- |
| Chrome, Edge, Brave, Arc, Vivaldi (desktop) | `SpeechRecognition` | `speechSynthesis` | reference implementation |
| Chrome (Android) | `SpeechRecognition` | `speechSynthesis` | gesture rule applies as on iOS in some builds |
| Safari (macOS) | `webkitSpeechRecognition` | `speechSynthesis` | no `continuous` support; one utterance per session |
| Safari (iOS / iPadOS, incl. PWA) | `webkitSpeechRecognition` | `speechSynthesis` | **user-gesture rule, see below** |
| VS Code / Electron integrated browser | `SpeechRecognition` | `speechSynthesis` | voices often empty; device default is used |
| Firefox | not supported | Gemini TTS only | no Web Speech recognition; read-aloud must not silently fail |

Voice engines (`agent_configs.voice_stt_engine`, ADR-0123) map to backends:

| Engine | Dictation | Read-aloud |
| --- | --- | --- |
| `browser` | Web Speech recognition in the page | device voices (`speechSynthesis`) |
| `whisper` | Whisper tiny on the server | device voices (`speechSynthesis`) |
| `gemini` | Gemini transcription (server) | Gemini TTS (audio element) |

## Platform quirks and the required mitigation

Each item below has already caused a shipped defect; the mitigation is the
current contract, and removing it re-introduces the bug.

1. **iOS Safari requires a `speak()` inside a user gesture to arm synthesis.**
   Until the page has done that once, every later `speak()` from a timer or a
   stream callback is dropped — even a blank utterance is enough to arm it.
   *Mitigation:* `unlockBrowserSpeech()` runs from the mic press
   (`InputBar.startRecording`), which is the one gesture the voice flow gets.
   Source: [SO 61658740](https://stackoverflow.com/questions/61658740/speechsynthesis-not-working-on-mobile-safari-even-though-its-supported).
2. **Voices load asynchronously.** `getVoices()` is empty until
   `voiceschanged` on Chromium and can stay empty longer on iOS.
   *Mitigation:* the picker refreshes on `voiceschanged`
   (`VoiceFields`), and `resolveBrowserVoice()` returns `null` for a voice that
   is not installed yet, so playback falls back to the device default instead of
   failing. Source:
   [SO 21513706](https://stackoverflow.com/questions/21513706/getting-the-list-of-voices-in-speechsynthesis-web-speech-api).
3. **An utterance can be garbage-collected before it plays and then never
   speak.** *Mitigation:* the session returned by `speakWithBrowser()` keeps the
   utterance referenced until `end`/`error`/`cancel`. Source:
   [SO 23483990](https://stackoverflow.com/questions/23483990/speechsynthesis-api-onend-callback-not-working)
   (cites Chromium issue 509488).
4. **`cancel()` empties the whole queue and stops immediately**, and a
   `speak()` issued right after a `cancel()` can be dropped.
   *Mitigation:* sequential slices speak one at a time with `replace: false`;
   only a manual Play replaces a clip that is already speaking. Source:
   [MDN `cancel()`](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/cancel).
5. **`speechSynthesis.speaking` can be stale or wedged** (true while nothing is
   audible). A start watchdog must not treat it as proof of playback, or the
   queue waits for an `end` that never arrives.
   *Mitigation:* only a real `start` event counts as playback; the watchdog
   reports a visible failure instead of assuming success.
6. **Exactly one reader may own a turn.** The streaming reader claims the turn
   when it dispatches its first clip (`onDispatch` →
   `markLiveSpeechSpoken()`), not when the browser fires `start` — Chromium
   fires that event roughly 100 ms after `speak()`, and a short reply finalizes
   inside that window. Observed failure: the whole-message reader then started
   with `replace: true`, cancelled the live clip and read the reply again from
   the top.
7. **iOS suspends synthesis when the page is backgrounded or the screen
   locks.** Treat a suspended session as the end of the turn; do not assume the
   queue resumes when the user returns.

## Acceptance checks

Run these in each supported browser after any change to `lib/voice/**` or the
chat voice wiring:

1. Voice turn: the reply is read while it is still streaming — the first
   sentence starts before the reply finishes.
2. No sentence is spoken twice and none is cut off mid-way.
3. Manual **Play voice** on a finished message reads the whole message once.
4. **Stop** silences immediately and clears the queue; nothing resumes and
   nothing restarts when the text keeps arriving.
5. A typed turn makes no sound (auto-speak is opt-in per turn via
   `voice_auto_speak`, armed only by voice submissions).
6. `whisper`/`gemini` dictation still reads replies with the device voices.
7. iPhone: the same checks pass after a mic tap, with the app added to the Home
   Screen, and again after locking/unlocking the phone.
8. Firefox: dictation reports a clear message and read-aloud either uses Gemini
   or fails with a visible error — never silence.
