export function validatePersonalBriefing(input: unknown):
  | { ok: false; error: string; issues: Array<{ path: string; message: string }> }
  | {
    ok: true;
    briefing: { items: Array<{ text: string; source_ids: string[] }>; unavailable_source_ids: string[] };
    checks: string[];
    limitation: string;
  };
