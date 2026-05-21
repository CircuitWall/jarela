// Client-safe constants for the voice picker UI. Kept in a standalone
// module so client components can import them without dragging server-only
// modules (lib/db, undici, node:child_process) through the import graph.

export const GEMINI_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "Zephyr",      label: "Zephyr · bright" },
  { id: "Puck",        label: "Puck · upbeat" },
  { id: "Charon",      label: "Charon · informative" },
  { id: "Kore",        label: "Kore · firm" },
  { id: "Fenrir",      label: "Fenrir · excitable" },
  { id: "Leda",        label: "Leda · youthful" },
  { id: "Orus",        label: "Orus · firm" },
  { id: "Aoede",       label: "Aoede · breezy" },
  { id: "Callirrhoe",  label: "Callirrhoe · easy-going" },
  { id: "Autonoe",     label: "Autonoe · bright" },
  { id: "Enceladus",   label: "Enceladus · breathy" },
  { id: "Iapetus",     label: "Iapetus · clear" },
  { id: "Umbriel",     label: "Umbriel · easy-going" },
  { id: "Algieba",     label: "Algieba · smooth" },
  { id: "Despina",     label: "Despina · smooth" },
  { id: "Erinome",     label: "Erinome · clear" },
  { id: "Algenib",     label: "Algenib · gravelly" },
  { id: "Rasalgethi",  label: "Rasalgethi · informative" },
  { id: "Laomedeia",   label: "Laomedeia · upbeat" },
  { id: "Achernar",    label: "Achernar · soft" },
  { id: "Alnilam",     label: "Alnilam · firm" },
  { id: "Schedar",     label: "Schedar · even" },
  { id: "Gacrux",      label: "Gacrux · mature" },
  { id: "Pulcherrima", label: "Pulcherrima · forward" },
  { id: "Achird",      label: "Achird · friendly" },
  { id: "Zubenelgenubi", label: "Zubenelgenubi · casual" },
  { id: "Vindemiatrix", label: "Vindemiatrix · gentle" },
  { id: "Sadachbia",   label: "Sadachbia · lively" },
  { id: "Sadaltager",  label: "Sadaltager · knowledgeable" },
  { id: "Sulafat",     label: "Sulafat · warm" },
];

export const GEMINI_TTS_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "gemini-2.5-flash-preview-tts", label: "Flash TTS (fast, cheap)" },
  { id: "gemini-2.5-pro-preview-tts",   label: "Pro TTS (higher quality)" },
];

export const GEMINI_STT_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "gemini-2.5-flash", label: "Flash (fast, multilingual)" },
  { id: "gemini-2.5-pro",   label: "Pro (slower, more accurate)" },
];
