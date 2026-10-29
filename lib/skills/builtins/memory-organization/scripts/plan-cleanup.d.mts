export function planMemoryCleanup(input: unknown):
  | { ok: false; error: string; issues: Array<{ path: string; message: string }> }
  | { ok: true; expired_keys: string[]; duplicate_groups: string[][]; checks: string[]; limitation: string };
