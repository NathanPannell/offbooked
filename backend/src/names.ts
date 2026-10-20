// What the cast calls the director. The cast never sees an email address: until the director sets a
// name, they get the part of the email before the @, capitalised ("sam.ortiz+shows@…" is "Sam Ortiz").
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

// Where to land after signing in. Only paths inside the director app, so a sign-in link can never
// send someone to another site ("//evil.test", "https://…", "/\evil.test").
export function safeNext(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  return /^\/app(?:[/?#][^\s\\]*)?$/.test(value) && !value.includes("//") ? value : null;
}
