export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const notFound = (what = "Not found") => new HttpError(404, "not_found", what);
export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const unauthorized = (message = "Sign in again.") => new HttpError(401, "unauthorized", message);
