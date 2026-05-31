// Pure color helpers used by dashboard chart rendering. Kept side-effect free
// so they can be unit-tested in node and reused across visualizations.

export function parseHexColor(value: string): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const hex = value.trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
  const normalized = hex.length === 4
    ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    : hex;
  const raw = normalized.slice(1);
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return [r, g, b];
}

export function shiftHex(value: string, amount: number): string {
  const rgb = parseHexColor(value);
  if (!rgb) return value;
  const t = Math.max(-1, Math.min(1, amount));
  const shiftChannel = (channel: number): number => {
    if (t >= 0) return Math.round(channel + ((255 - channel) * t));
    return Math.round(channel * (1 + t));
  };
  return `rgb(${shiftChannel(rgb[0])}, ${shiftChannel(rgb[1])}, ${shiftChannel(rgb[2])})`;
}

export function withAlpha(value: string, alpha: number): string {
  const rgb = parseHexColor(value);
  const a = Math.max(0, Math.min(1, alpha));
  if (!rgb) return `rgba(34, 197, 94, ${a})`;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}
