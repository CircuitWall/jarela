// Picking one of the device's built-in voices for spoken replies.
//
// `speechSynthesis.getVoices()` is populated asynchronously (Chrome/Edge fill
// it after the `voiceschanged` event), and the set differs per machine. The
// stored value is therefore a portable key — the voice's `voiceURI` when the
// engine provides one, otherwise its display name — and a machine that does
// not have it falls back to the device default instead of failing to speak.
export interface BrowserVoiceOption {
  key: string;
  label: string;
  lang: string;
  local: boolean;
}

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  const api = window.speechSynthesis;
  return api && typeof api.getVoices === "function" ? api : null;
}

export function browserVoiceKey(voice: SpeechSynthesisVoice): string {
  const uri = (voice.voiceURI ?? "").trim();
  return uri || (voice.name ?? "").trim();
}

/** Every voice this device can speak with, sorted for a stable picker. */
export function listBrowserVoices(): BrowserVoiceOption[] {
  const api = synth();
  if (!api) return [];
  const seen = new Set<string>();
  const options: BrowserVoiceOption[] = [];
  for (const voice of api.getVoices()) {
    const key = browserVoiceKey(voice);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push({
      key,
      label: voice.lang ? `${voice.name} — ${voice.lang}` : voice.name,
      lang: voice.lang ?? "",
      local: voice.localService !== false,
    });
  }
  return options.sort((a, b) => a.lang.localeCompare(b.lang) || a.label.localeCompare(b.label));
}

/**
 * The voice object for a stored key, or null when the key is empty (device
 * default) or that voice is not installed on this machine.
 */
export function resolveBrowserVoice(key: string | null | undefined): SpeechSynthesisVoice | null {
  const wanted = (key ?? "").trim();
  if (!wanted) return null;
  const api = synth();
  if (!api) return null;
  const voices = api.getVoices();
  return voices.find((voice) => voice.voiceURI === wanted)
    ?? voices.find((voice) => voice.name === wanted)
    ?? voices.find((voice) => browserVoiceKey(voice) === wanted)
    ?? null;
}

/** True when a stored key names a voice this device does not have. */
export function isBrowserVoiceMissing(key: string | null | undefined): boolean {
  const wanted = (key ?? "").trim();
  if (!wanted) return false;
  const api = synth();
  if (!api || api.getVoices().length === 0) return false;
  return resolveBrowserVoice(wanted) === null;
}
