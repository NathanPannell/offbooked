import { readStorage, removeStorage, writeStorage } from "../lib/storage";

export const API_URL = (
  import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "https://api.offbooked.com" : "http://localhost:8080")
).replace(/\/+$/, "");

const SESSION_KEY = "offbooked.session";
export const UNAUTHORIZED_EVENT = "offbooked:unauthorized";

export const session = {
  get: () => readStorage(SESSION_KEY),
  set: (token: string) => writeStorage(SESSION_KEY, token),
  clear: () => removeStorage(SESSION_KEY),
};

export type Auth = { kind: "none" } | { kind: "director" } | { kind: "invite"; token: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown> | null;

  constructor(status: number, code: string, message: string, body: Record<string, unknown> | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** Network failures, timeouts, rate limits and 5xx are worth retrying. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

interface RequestOptions {
  method?: string;
  auth: Auth;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function authHeader(auth: Auth): string | null {
  if (auth.kind === "invite") return `Invite ${auth.token}`;
  if (auth.kind === "director") {
    const token = session.get();
    return token ? `Bearer ${token}` : null;
  }
  return null;
}

/** Headers for a director request made outside `request`, such as pdf.js loading the original script. */
export function directorHeaders(): Record<string, string> {
  const authorization = authHeader({ kind: "director" });
  return authorization ? { Authorization: authorization } : {};
}

export async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  const authorization = authHeader(options.auth);
  if (authorization) headers.Authorization = authorization;
  let body = options.body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}/api${path}`, {
      method: options.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: options.signal,
      // Actor routes share URLs and differ only by the Authorization header, so never reuse a cached response.
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", "Can't reach Offbooked. Check your connection.", null);
  }

  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = (data?.error ?? {}) as { code?: string; message?: string };
    if (response.status === 401 && options.auth.kind === "director") {
      session.clear();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(
      response.status,
      error.code ?? "http_" + response.status,
      error.message ?? defaultMessage(response.status),
      data,
    );
  }
  return data as T;
}

function defaultMessage(status: number): string {
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500) return "Something went wrong on our side. Try again in a moment.";
  return "That didn't work.";
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
