import { useState, type FormEvent } from "react";
import { errorMessage } from "../../api/client";
import { Avatar } from "../../components/Avatar";
import { Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toast";

/**
 * The cast member's initials at the top right, like the director's: it opens their name (fixable
 * any time) and an optional email. With an email their name stays on their recordings after the
 * show, and they hear when the cast is complete.
 */
export function CastProfile({
  name,
  hasEmail,
  onRename,
  onEmail,
}: {
  name: string;
  hasEmail: boolean;
  onRename: (name: string) => Promise<void>;
  onEmail: (email: string) => Promise<void>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = () => {
    setDraftName(name);
    setEmail("");
    setError(null);
    setOpen(true);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const nextName = draftName.trim();
    const nextEmail = email.trim();
    if (!nextName) return setError("Add your name.");
    setBusy(true);
    setError(null);
    try {
      if (nextName !== name) await onRename(nextName);
      if (nextEmail) await onEmail(nextEmail);
      setOpen(false);
      toast("Saved");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="account-btn" onClick={show} aria-label={`You: ${name}`} title="Your name and email">
        <Avatar name={name} size={36} />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="You">
        <form className="stack" onSubmit={save}>
          <label className="field">
            <span>Your name</span>
            <input className="input" value={draftName} onChange={(e) => setDraftName(e.target.value)} autoComplete="given-name" maxLength={60} required />
          </label>
          <label className="field">
            <span>Email (optional)</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder={hasEmail ? "Saved. Type a new one to change it" : "you@example.com"}
            />
            <span className="field-hint">Keeps your name on your recordings after the show, and we'll tell you when the cast is complete.</span>
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      </Dialog>
    </>
  );
}
