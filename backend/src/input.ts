import { isUuid } from "./crypto.ts";
import { badRequest, notFound } from "./errors.ts";

// Small request validators. They return clean values or throw a 400 with a readable message.

export type Body = Record<string, unknown>;

export function body(value: unknown): Body {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw badRequest("Expected a JSON object.");
  return value as Body;
}

export function requiredString(b: Body, key: string, max = 200): string {
  const v = b[key];
  if (typeof v !== "string" || !v.trim()) throw badRequest(`${key} is required.`);
  if (v.trim().length > max) throw badRequest(`${key} is too long (max ${max} characters).`);
  return v.trim();
}

// undefined when absent, null when explicitly empty.
export function optionalString(b: Body, key: string, max = 200): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && !v.trim())) return null;
  if (typeof v !== "string") throw badRequest(`${key} must be a string.`);
  if (v.trim().length > max) throw badRequest(`${key} is too long (max ${max} characters).`);
  return v.trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function optionalEmail(b: Body, key: string): string | null | undefined {
  const v = optionalString(b, key, 254);
  if (v && !EMAIL_RE.test(v)) throw badRequest("That email address doesn't look right.");
  return v ? v.toLowerCase() : v;
}

export function requiredEmail(b: Body, key: string): string {
  const v = optionalEmail(b, key);
  if (!v) throw badRequest("Enter an email address.");
  return v;
}

// A real calendar date as YYYY-MM-DD: 2026-02-30 is refused, not rolled over into March.
export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function optionalDate(b: Body, key: string): string | null | undefined {
  const v = optionalString(b, key, 10);
  if (v && !isIsoDate(v)) throw badRequest(`${key} must be a date like 2026-11-20.`);
  return v;
}

export function uuidList(b: Body, key: string, required: boolean): string[] | undefined {
  const v = b[key];
  if (v === undefined && !required) return undefined;
  if (!Array.isArray(v) || !v.every(isUuid)) throw badRequest(`${key} must be a list of ids.`);
  return [...new Set(v as string[])];
}

export function idParam(value: unknown): string {
  if (!isUuid(value)) throw notFound();
  return value.toLowerCase();
}

export function idOf(params: unknown, key = "id"): string {
  return idParam((params as Record<string, unknown>)[key]);
}
