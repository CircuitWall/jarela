// Shared pre-flight check for calendar write tools. Runs before any provider
// call so an inverted or zero-length window never creates an event or sends
// invites. Unparseable values are left to the schema/provider to report.
export function eventWindowError(startIso: string | undefined, endIso: string | undefined): string | null {
  if (startIso === undefined || endIso === undefined) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end > start ? null : `end_iso must be after start_iso (got ${startIso} → ${endIso})`;
}
