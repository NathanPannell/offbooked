import { hmac, isUuid, safeEqual } from "./crypto.ts";

// Derived, never stored: base64url(actorId bytes) "." tokenVersion "." HMAC(actorId:tokenVersion)[0..22].
export function inviteToken(secret: string, actorId: string, tokenVersion: number): string {
  const id = Buffer.from(actorId.replace(/-/g, ""), "hex").toString("base64url");
  return `${id}.${tokenVersion}.${signature(secret, actorId, tokenVersion)}`;
}

export function parseInviteToken(secret: string, token: string): { actorId: string; tokenVersion: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [idPart, versionPart, sig] = parts as [string, string, string];
  if (!/^\d{1,9}$/.test(versionPart)) return null;
  const hex = Buffer.from(idPart, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  const actorId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const tokenVersion = Number(versionPart);
  if (!isUuid(actorId) || !safeEqual(sig, signature(secret, actorId, tokenVersion))) return null;
  return { actorId, tokenVersion };
}

export function inviteUrl(appUrl: string, secret: string, actorId: string, tokenVersion: number): string {
  return `${appUrl}/i/${inviteToken(secret, actorId, tokenVersion)}`;
}

const DAY_MS = 86_400_000;

// Valid through the end of performanceDate + 14 days, or 120 days after the actor was added.
export function inviteExpiresAt(performanceDate: string | null, actorCreatedAt: Date): Date {
  if (performanceDate) return new Date(Date.parse(`${performanceDate}T00:00:00Z`) + 15 * DAY_MS);
  return new Date(actorCreatedAt.getTime() + 120 * DAY_MS);
}

function signature(secret: string, actorId: string, tokenVersion: number): string {
  return hmac(secret, `${actorId.toLowerCase()}:${tokenVersion}`).slice(0, 22);
}
