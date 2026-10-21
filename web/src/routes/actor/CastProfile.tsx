import { Check } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../../api/client";
import type { EmailState } from "../../api/types";
import { Avatar } from "../../components/Avatar";
import { Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toast";

/**
 * The cast member's initials at the top right, like the director's: it opens their name (fixable
 * any time) and an optional email. An email counts once its link is opened: then their name stays
 * on their recordings after the show, and they hear when the play is ready. The open state lives
 * with the screen, so the wrapped screen's email prompt opens the same dialog.
 */
export function CastProfile({
  name,
  hasEmail,
  pendingEmail,
  open,
  onOpenChange,
  onRename,
  onEmail,
}: {
  name: string;
  hasEmail: boolean;
  pendingEmail: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (name: string) => Promise<void>;
  /** Sends the verification link (again, without an address). */
  onEmail: (email?: string) => Promise<EmailState>;
}) {
  return (
    <>
      <button type="button" className="account-btn" onClick={() => onOpenChange(true)} aria-label={`You: ${name}`} title="Your name and email">
        <Avatar name={name} size={36} />
      </button>
      <Dialog open={open} onClose={() => onOpenChange(false)} title="You">
        {open && (
          <ProfileForm name={name} hasEmail={hasEmail} pendingEmail={pendingEmail} onRename={onRename} onEmail={onEmail} onDone={() => onOpenChange(false)} />
        )}
      </Dialog>
    </>
  );
}

/** Mounted each time the dialog opens, so it starts from what's saved. */
function ProfileForm({
  name,
  hasEmail,
  pendingEmail,
  onRename,
  onEmail,
  onDone,
}: {
  name: string;
  hasEmail: boolean;
  pendingEmail: boolean;
  onRename: (name: string) => Promise<void>;
  onEmail: (email?: string) => Promise<EmailState>;
  onDone: () => void;
}) {
  const toast = useToast();
  const [draftName, setDraftName] = useState(name);
  const [email, setEmail] = useState("");
  const [changing, setChanging] = useState(!hasEmail && !pendingEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const nextName = draftName.trim();
    const nextEmail = changing ? email.trim() : "";
    if (!nextName) return setError("Add your name.");
    setBusy(true);
    setError(null);
    try {
      if (nextName !== name) await onRename(nextName);
      const state = nextEmail ? await onEmail(nextEmail) : null;
      onDone();
      toast(!state ? "Saved" : state.sent ? "Check your inbox for a link" : "Already verified");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      const state = await onEmail();
      toast(state.sent ? "Sent again. Check your inbox" : state.hasEmail ? "Already verified" : "Add your email first");
      if (!state.sent && !state.hasEmail) setChanging(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={save}>
      <label className="field">
        <span>Your name</span>
        <input className="input" value={draftName} onChange={(e) => setDraftName(e.target.value)} autoComplete="given-name" maxLength={60} required />
      </label>
      {changing ? (
        <label className="field">
          <span>Email (optional)</span>
          <input
            className="input"
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
          />
          <span className="field-hint">We'll send a link to confirm it, then tell you when the play is ready.</span>
        </label>
      ) : (
        <div className="field">
          <span>Email</span>
          <p className="profile-email" role="status">
            {pendingEmail ? (
              <span className="grow">Check your inbox for a link.</span>
            ) : (
              <span className="grow profile-email-verified">
                <Check size={16} aria-hidden="true" /> Verified
              </span>
            )}
            {pendingEmail && (
              <button type="button" className="link-btn" disabled={busy} onClick={() => void resend()}>
                Send it again
              </button>
            )}
            <button type="button" className="link-btn" onClick={() => setChanging(true)}>
              Change
            </button>
          </p>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
