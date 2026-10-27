import { request, type Auth } from "./client";

// The admin area's API (backend/src/routes/admin.ts). Only accounts in the server's ADMIN_EMAILS
// get answers; everyone else gets 404. Every call is made when a panel opens: nothing polls.

const director: Auth = { kind: "director" };

/** A person across productions: `e:<email>`, `u:<account id>` (deleted account) or `a:<cast row id>`. */
export type PersonKey = string;

export interface AdminProduction {
  id: string;
  title: string;
  createdAt: string;
  archived: boolean;
  contentDeleted: boolean;
  scriptStatus: string;
  performanceEndsOn: string | null;
  owner: { id: string; email: string | null; name: string | null; key: PersonKey };
  linesTotal: number;
  /** Dialogue lines with at least one take that hasn't been deleted. */
  linesRecorded: number;
  takes: number;
  /** Everyone who joined the cast, listeners included. */
  castMembers: number;
  lastActivity: string;
}

export interface Creator {
  key: PersonKey;
  email: string | null;
  name: string | null;
  signedUpAt: string;
  deletedAt: string | null;
  plan: { name: string; betaAccessAt: string | null };
  productions: number;
  activeProductions: number;
  castMembers: number;
  linesRecorded: number;
  takes: number;
  lastSignInAt: string | null;
  lastActivity: string;
}

export interface Recorder {
  key: PersonKey;
  name: string | null;
  email: string | null;
  kind: "director" | "cast";
  takes: number;
  linesRecorded: number;
  firstRecordingAt: string;
  lastRecordingAt: string;
  lastSeenAt: string;
  productions: { id: string; title: string; role: "owner" | "cast" }[];
}

export interface TraceEvent {
  at: string;
  kind: string;
  text: string;
  production: { id: string; title: string } | null;
}

export interface PersonTrace {
  key: PersonKey;
  name: string | null;
  emails: string[];
  accounts: { id: string; email: string | null; signedUpAt: string; deletedAt: string | null }[];
  castRows: { id: string; name: string; production: { id: string; title: string }; joinedAt: string; lastActiveAt: string | null }[];
  events: TraceEvent[];
}

export interface AuditEntry {
  id: string;
  at: string;
  action: "view_production" | "view_person";
  admin: string;
  production: { id: string; title: string } | null;
  subject: string | null;
}

/** The productions list stops here (ADMIN_LIST_LIMIT in backend/src/admin/productions.ts). */
export const ADMIN_LIST_LIMIT = 500;

export const admin = {
  productions: (q?: string) =>
    request<{ productions: AdminProduction[] }>(`/admin/productions${q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`, { auth: director }),
  creators: () => request<{ creators: Creator[] }>("/admin/creators", { auth: director }),
  recorders: () => request<{ recorders: Recorder[] }>("/admin/recorders", { auth: director }),
  person: (key: PersonKey) => request<{ person: PersonTrace }>(`/admin/people/${encodeURIComponent(key)}`, { auth: director }),
  audit: () => request<{ entries: AuditEntry[] }>("/admin/audit", { auth: director }),
};

/** The trace page for a person. */
export const personPath = (key: PersonKey) => `/app/admin/people/${encodeURIComponent(key)}`;
