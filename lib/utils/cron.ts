// Minimal best-effort humanizer for 5-field cron expressions
// (`minute hour day-of-month month day-of-week`). Returns null when the
// expression is too exotic to summarize accurately so the UI falls back
// to the raw expression instead of misleading text.

export function humanizeCron(expr: string): string | null {
  if (!expr) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;

  const time = formatTime(minute, hour);
  if (!time) return null;

  // every minute / every N minutes
  if (hour === "*" && dom === "*" && month === "*" && dow === "*") {
    if (minute === "*") return "every minute";
    const step = parseStep(minute);
    if (step) return `every ${step} minutes`;
  }

  // hourly at HH:MM
  if (hour === "*" && dom === "*" && month === "*" && dow === "*" && /^\d+$/.test(minute)) {
    return `hourly at :${pad(minute)}`;
  }

  // every N hours
  if (dom === "*" && month === "*" && dow === "*" && /^\d+$/.test(minute)) {
    const step = parseStep(hour);
    if (step) return `every ${step} hours at :${pad(minute)}`;
  }

  // weekday(s) at HH:MM
  if (dom === "*" && month === "*" && dow !== "*") {
    const days = formatDow(dow);
    if (days) return `${days} at ${time}`;
  }

  // monthly on day N at HH:MM
  if (month === "*" && dow === "*" && /^\d+$/.test(dom)) {
    return `monthly on day ${dom} at ${time}`;
  }

  // daily at HH:MM
  if (dom === "*" && month === "*" && dow === "*") {
    return `daily at ${time}`;
  }

  return null;
}

function formatTime(minute: string, hour: string): string | null {
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

function pad(n: string): string {
  return n.length >= 2 ? n : `0${n}`;
}

function parseStep(field: string): number | null {
  const m = /^\*\/(\d+)$/.exec(field);
  return m ? Number(m[1]) : null;
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDow(field: string): string | null {
  if (field === "1-5") return "weekdays";
  if (field === "0,6" || field === "6,0") return "weekends";
  if (/^\d$/.test(field)) {
    const n = Number(field);
    if (n >= 0 && n <= 6) return DOW_NAMES[n];
  }
  if (/^\d(,\d)+$/.test(field)) {
    const ns = field.split(",").map(Number).filter((n) => n >= 0 && n <= 6);
    if (ns.length) return ns.map((n) => DOW_NAMES[n]).join("/");
  }
  return null;
}
