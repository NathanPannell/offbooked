// Mirrors backend/src/names.ts: what the cast calls the director until they set a name, the part of
// their email before the @, capitalised. The cast never sees the address itself.
export function castFacingName(name: string | null | undefined, email: string): string {
  const given = name?.trim();
  if (given && !given.includes("@")) return given;
  const local = (given || email).split("@")[0]!.split("+")[0]!;
  const words = local
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1));
  return words.join(" ") || "Your director";
}

// Where to go after signing in: only a path inside the director app, so `?next=` can't send anyone
// to another site.
export function safeNext(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  return /^\/app(?:[/?#][^\s\\]*)?$/.test(value) && !value.includes("//") ? value : null;
}
