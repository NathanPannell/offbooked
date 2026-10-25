import type { Sql } from "./db.ts";
import { HttpError } from "./errors.ts";
import type { Log } from "./log.ts";

export interface Limit {
  limit: number;
  windowSeconds: number;
}

export const LIMITS = {
  signInEmail: { limit: 5, windowSeconds: 900 },
  signInIp: { limit: 30, windowSeconds: 900 },
  verifyIp: { limit: 30, windowSeconds: 900 },
  inviteActor: { limit: 600, windowSeconds: 600 },
  inviteIp: { limit: 900, windowSeconds: 600 },
  takeUpload: { limit: 120, windowSeconds: 600 },
  scriptParse: { limit: 10, windowSeconds: 3600 },
  completionEmail: { limit: 60, windowSeconds: 86_400 },
  verifySend: { limit: 5, windowSeconds: 3600 }, // verification emails per cast member
  verifyTo: { limit: 5, windowSeconds: 86_400 }, // verification emails per address
  verifyProduction: { limit: 20, windowSeconds: 3600 }, // verification emails per production
  verifySendIp: { limit: 10, windowSeconds: 3600 }, // verification emails asked for per IP
  verifyOpen: { limit: 30, windowSeconds: 900 }, // verification pages opened or confirmed per IP
  betaCodeUser: { limit: 10, windowSeconds: 3600 }, // beta access code tries per account
  betaCodeIp: { limit: 30, windowSeconds: 3600 }, // beta access code tries per IP
} satisfies Record<string, Limit>;

// Fixed window counter. Returns false once the window's count passes the limit.
export async function consume(sql: Sql, key: string, { limit, windowSeconds }: Limit): Promise<boolean> {
  const [row] = await sql<{ count: number }[]>`
    insert into rate_limits (key, window_start, count)
    values (${key}, to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}), 1)
    on conflict (key, window_start) do update set count = rate_limits.count + 1
    returning count`;
  return row!.count <= limit;
}

// Old windows are pruned at most hourly and only alongside a request, never on a timer, so an
// idle server sends no queries and Neon can scale the database to zero.
const PRUNE_EVERY_MS = 3_600_000;
let lastPrune = 0;

export async function enforce(sql: Sql, log: Log, key: string, limit: Limit, message = "Too many requests. Try again in a few minutes."): Promise<void> {
  if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = Date.now();
    pruneRateLimits(sql).catch((err) => log.error({ err }, "rate limit prune failed"));
  }
  if (await consume(sql, key, limit)) return;
  log.warn({ key }, "rate limit exceeded");
  throw new HttpError(429, "rate_limited", message, undefined, { "Retry-After": String(secondsLeft(limit.windowSeconds)) });
}

// Seconds until the current fixed window ends, when the count starts again (at least 1).
export function secondsLeft(windowSeconds: number, nowMs = Date.now()): number {
  const now = nowMs / 1000;
  return Math.max(1, Math.ceil(Math.floor(now / windowSeconds) * windowSeconds + windowSeconds - now));
}

export async function pruneRateLimits(sql: Sql): Promise<void> {
  await sql`delete from rate_limits where window_start < now() - interval '2 days'`;
}
