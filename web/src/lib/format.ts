export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "FIRST WITCH" → "First Witch". Names already in mixed case are left as written. */
export const titleCase = (name: string): string =>
  name === name.toUpperCase() ? name.toLowerCase().replace(/(^|[\s\-'’.(])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase()) : name;

/** "HAMLET", "HAMLET & GHOST", "HAMLET, GHOST & PLAYER". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "Never";
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return plural(days, "day") + " ago";
  return formatDate(iso);
}

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  // Date-only strings are calendar dates, not instants: don't shift them by time zone.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** A stable hue per character so names are easy to scan. */
export function characterHue(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % 360;
}
