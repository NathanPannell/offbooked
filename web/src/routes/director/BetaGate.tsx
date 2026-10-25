import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../../api/client";
import { auth } from "../../api/director";
import type { User } from "../../api/types";
import { CONTACT_EMAIL, mailto } from "../../lib/contact";

/**
 * Offbooked is in private beta: an account without access sees this in place of setting up a
 * production. The code is checked by the server (POST /api/me/beta-access) and kept with the account.
 */
export function BetaGate({ onGranted }: { onGranted: (user: User) => void }) {
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const { user } = await auth.enterBetaCode(code);
      onGranted(user);
    } catch (err) {
      setError(errorMessage(err));
      setSending(false);
    }
  };

  return (
    <main className="page page-narrow center-page">
      <form className="raised message-card stack beta-gate" onSubmit={submit}>
        <KeyRound size={30} className="accent-icon" aria-hidden="true" />
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">Private beta</p>
          <h1 className="display">Offbooked is in private beta</h1>
          <p className="muted">
            Email <a href={mailto("Offbooked access code")}>{CONTACT_EMAIL}</a> for an access code. Enter it once and you can set up every production you like.
          </p>
        </div>
        <label className="field">
          <span>Access code</span>
          <input
            className="input"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={200}
            value={code}
            aria-invalid={!!error || undefined}
            aria-describedby={error ? "beta-code-error" : undefined}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {error && (
          <p id="beta-code-error" className="field-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-lg" disabled={sending || !code.trim()}>
          {sending ? "Checking…" : "Unlock Offbooked"}
        </button>
        <p className="small muted">Joining a cast? You don't need a code. Use the link you were sent.</p>
      </form>
    </main>
  );
}
