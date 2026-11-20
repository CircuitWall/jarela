/**
 * Minimal semver range evaluation for `node-runtime` dependencies.
 *
 * Jarela declares engine ranges (e.g. `^24.15.0 || >=26.0.0`), so this covers
 * the subset npm uses for `engines`: `||` alternatives, whitespace-separated
 * comparators, `^`, `~`, `>=`, `>`, `<=`, `<`, `=`, partial versions and
 * `x`/`X`/`*` wildcards. Prerelease/build suffixes are ignored — engine checks
 * only care about the numeric core.
 *
 * Deliberately not a general semver implementation: no prerelease ordering and
 * no `~>`/hyphen ranges. An unparseable range is reported as invalid so the
 * probe can return `unverified` instead of silently claiming "missing".
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

type Operator = ">=" | ">" | "<=" | "<" | "=";

export interface Comparator {
  op: Operator;
  version: ParsedVersion;
}

export type ParsedRange = Comparator[][];

const WILDCARD = /^[xX*]$/;

export function parseVersion(input: string): ParsedVersion | null {
  const parts = coreParts(input);
  if (!parts || parts.length === 0 || parts.length > 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  return version(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0);
}

export function formatVersion(v: ParsedVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Parse a range into alternatives (OR) of comparator groups (AND).
 * Returns null when the range is not understood.
 */
export function parseRange(range: string): ParsedRange | null {
  const alternatives = range.split("||");
  if (alternatives.length === 0) return null;
  const parsed: ParsedRange = [];
  for (const alternative of alternatives) {
    const trimmed = alternative.trim();
    if (trimmed === "") continue;
    const group: Comparator[] = [];
    for (const token of trimmed.split(/\s+/)) {
      const expanded = expandToken(token);
      if (expanded === null) return null;
      group.push(...expanded);
    }
    parsed.push(group);
  }
  return parsed.length > 0 ? parsed : null;
}

/** True when `version` satisfies `range`; false for invalid ranges. */
export function satisfiesRange(version: string, range: string): boolean {
  const target = parseVersion(version);
  const parsed = parseRange(range);
  if (!target || !parsed) return false;
  return parsed.some((group) => group.every((c) => matches(target, c)));
}

function matches(version: ParsedVersion, comparator: Comparator): boolean {
  const cmp = compareVersions(version, comparator.version);
  switch (comparator.op) {
    case ">=": return cmp >= 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case "<": return cmp < 0;
    case "=": return cmp === 0;
  }
}

function coreParts(input: string): string[] | null {
  const core = input.trim().replace(/^v/i, "").split(/[-+]/)[0];
  if (!core) return null;
  return core.split(".");
}

function version(major: number, minor: number, patch: number): ParsedVersion {
  return { major, minor, patch };
}

/** Concrete prefix of a partial version; `null` entries are wildcards. */
function partialOf(input: string): Array<number | null> | null {
  const parts = coreParts(input);
  if (!parts || parts.length === 0 || parts.length > 3) return null;
  const nums: Array<number | null> = [];
  for (const part of parts) {
    if (WILDCARD.test(part)) {
      nums.push(null);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  return nums;
}

function concreteCount(nums: Array<number | null>): number {
  let count = 0;
  for (const n of nums) {
    if (n === null) break;
    count += 1;
  }
  return count;
}

/** Lowest version covered by a partial version (`24.15` → 24.15.0). */
function lowest(nums: Array<number | null>): ParsedVersion {
  return version(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0);
}

/** Exclusive upper bound for the band a partial version denotes. */
function bandUpper(nums: Array<number | null>): ParsedVersion {
  const count = concreteCount(nums);
  if (count === 0) return version(Infinity, Infinity, Infinity);
  if (count === 1) return version((nums[0] ?? 0) + 1, 0, 0);
  return version(nums[0] ?? 0, (nums[1] ?? 0) + 1, 0);
}

function caretUpper(nums: Array<number | null>): ParsedVersion {
  const count = concreteCount(nums);
  if (count === 0) return version(Infinity, Infinity, Infinity);
  const major = nums[0] ?? 0;
  const minor = nums[1] ?? 0;
  if (major > 0 || count === 1) return version(major + 1, 0, 0);
  if (minor > 0 || count === 2) return version(0, minor + 1, 0);
  return version(0, 0, (nums[2] ?? 0) + 1);
}

function tildeUpper(nums: Array<number | null>): ParsedVersion {
  const count = concreteCount(nums);
  if (count === 0) return version(Infinity, Infinity, Infinity);
  if (count === 1) return version((nums[0] ?? 0) + 1, 0, 0);
  return version(nums[0] ?? 0, (nums[1] ?? 0) + 1, 0);
}

function expandToken(token: string): Comparator[] | null {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (!match) return null;
  const op = match[1] ?? "";
  const partial = partialOf(match[2] ?? "");
  if (!partial) return null;

  const count = concreteCount(partial);
  const low = lowest(partial);
  const isExact = count === 3;

  switch (op) {
    case "":
    case "=":
      if (isExact) return [{ op: "=", version: low }];
      return [{ op: ">=", version: low }, { op: "<", version: bandUpper(partial) }];
    case "^":
      return [{ op: ">=", version: low }, { op: "<", version: caretUpper(partial) }];
    case "~":
      return [{ op: ">=", version: low }, { op: "<", version: tildeUpper(partial) }];
    case ">=":
      return [{ op: ">=", version: low }];
    case ">":
      // npm couples `>` with partial versions: `>24.15` means `>=24.16.0`.
      return isExact ? [{ op: ">", version: low }] : [{ op: ">=", version: bandUpper(partial) }];
    case "<":
      return [{ op: "<", version: low }];
    case "<=":
      // `<=24.15` means `<24.16.0`.
      return isExact ? [{ op: "<=", version: low }] : [{ op: "<", version: bandUpper(partial) }];
    default:
      return null;
  }
}
