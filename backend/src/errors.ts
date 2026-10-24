export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown> | undefined;
  /** Response headers to send with the error, e.g. Retry-After on a 429. */
  headers: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

export const notFound = (what = "Not found") => new HttpError(404, "not_found", what);
export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const unauthorized = (message = "Sign in again.") => new HttpError(401, "unauthorized", message);
// A cast or join link to a production whose director deleted their account. Unlike a wrapped show
// (invite_expired), it names neither the show nor the director: both went with the account.
export const productionDeleted = () => new HttpError(410, "production_deleted", "This show was taken down by its director, so this link no longer works.");
