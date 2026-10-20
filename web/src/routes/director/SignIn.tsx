import { MailCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router";
import { errorMessage, session } from "../../api/client";
import { auth } from "../../api/director";
import { Brand } from "../../components/Brand";
import { safeNext } from "../../lib/names";

export default function SignIn() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  if (session.get()) return <Navigate to={next ?? "/app"} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState("sending");
    setError(null);
    try {
      const result = await auth.request(email.trim(), next);
      setDevLink(result?.devLink ?? null);
      setState("sent");
    } catch (err) {
      setError(errorMessage(err));
      setState("idle");
    }
  };

  return (
    <main className="page page-narrow center-page">
      <Brand />
      {state === "sent" ? (
        <div className="raised message-card stack" aria-live="polite">
          <MailCheck size={32} className="accent-icon" aria-hidden="true" />
          <h1 className="display">Check your email</h1>
          <p>
            We sent a sign-in link to <strong>{email}</strong>. It works once and expires in 15 minutes.
          </p>
          {devLink && (
            <a className="btn btn-primary" href={devLink}>
              Use dev sign-in link
            </a>
          )}
          <button type="button" className="link-btn" onClick={() => setState("idle")}>
            Use a different email
          </button>
        </div>
      ) : (
        <form className="raised message-card stack" onSubmit={submit}>
          <div className="stack" style={{ gap: 6 }}>
            <h1 className="display">Welcome in</h1>
            <p className="muted">
              No password. We'll email you a link.
            </p>
          </div>
          <label className="field">
            <span>Email</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourtheatre.org"
            />
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary btn-lg" disabled={state === "sending" || !email.trim()}>
            {state === "sending" ? "Sending…" : "Email me a sign-in link"}
          </button>
          <p className="small muted">Joining a cast? You don't need to sign in. Use the link you were sent.</p>
        </form>
      )}
    </main>
  );
}
