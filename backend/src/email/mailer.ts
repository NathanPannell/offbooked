import type { Config } from "../config.ts";
import type { Log } from "../log.ts";

export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface Mailer {
  readonly driver: "log" | "resend";
  send(email: Email): Promise<void>;
}

export class LogMailer implements Mailer {
  readonly driver = "log" as const;
  readonly sent: Email[] = [];
  private log: Log;

  constructor(log: Log) {
    this.log = log;
  }

  async send(email: Email): Promise<void> {
    this.sent.push(email);
    this.log.info({ to: email.to, subject: email.subject, text: email.text }, "email (log driver, not sent)");
  }
}

export class ResendMailer implements Mailer {
  readonly driver = "resend" as const;
  private apiKey: string;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(email: Email): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, html: email.html, text: email.text, headers: email.headers }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Resend responded ${res.status}: ${detail}`);
    }
  }
}

export function createMailer(config: Config, log: Log): Mailer {
  if (config.email.driver === "resend" && config.email.resendApiKey) return new ResendMailer(config.email.resendApiKey, config.email.from);
  return new LogMailer(log);
}
