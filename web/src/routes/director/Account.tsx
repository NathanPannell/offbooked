import { ArrowLeft, LogOut, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { errorMessage, session } from "../../api/client";
import { auth } from "../../api/director";
import { Avatar } from "../../components/Avatar";
import { Dialog } from "../../components/Dialog";
import { castFacingName } from "../../lib/names";
import { useDirector } from "./DirectorLayout";

export default function Account() {
  const { user, setUser } = useDirector();
  const navigate = useNavigate();
  const [name, setName] = useState(user.name ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const shown = castFacingName(name, user.email);
  const changed = name.trim() !== (user.name ?? "").trim();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setState("saving");
    setError(null);
    try {
      setUser((await auth.updateMe(name.trim())).user);
      setState("saved");
    } catch (err) {
      setError(errorMessage(err));
      setState("idle");
    }
  };

  const signOut = async () => {
    await auth.logout().catch(() => {});
    session.clear();
    navigate("/", { replace: true });
  };

  const deleteAccount = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await auth.deleteAccount();
      session.clear();
      navigate("/", { replace: true });
    } catch (err) {
      setDeleteError(errorMessage(err));
      setDeleting(false);
    }
  };

  return (
    <main className="page page-narrow account-page">
      <Link className="back-link" to="/app">
        <ArrowLeft size={16} aria-hidden="true" /> Productions
      </Link>
      <div className="account-head">
        <Avatar name={castFacingName(user.name, user.email)} size={56} />
        <h1 className="display">Your account</h1>
      </div>

      <form className="raised message-card stack" onSubmit={save}>
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" value={user.email} readOnly aria-readonly="true" />
        </label>
        <label className="field">
          <span>Your name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setState("idle");
            }}
            placeholder={user.email}
            autoComplete="name"
            maxLength={80}
          />
          <span className="field-hint">Your cast sees “{shown} invited you”. They never see your email.</span>
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="row account-actions">
          <button className="btn btn-primary" disabled={state === "saving" || !changed}>
            {state === "saving" ? "Saving…" : "Save"}
          </button>
          <span className="small muted" aria-live="polite">
            {state === "saved" ? "Saved" : ""}
          </span>
        </div>
      </form>

      <button type="button" className="btn btn-secondary account-signout" onClick={signOut}>
        <LogOut size={18} aria-hidden="true" /> Sign out
      </button>

      <button type="button" className="link-btn account-delete" onClick={() => setConfirmDelete(true)}>
        <Trash2 size={16} aria-hidden="true" /> Delete my account
      </button>

      <Dialog open={confirmDelete} onClose={() => !deleting && setConfirmDelete(false)} title="Delete your account?" variant="confirm">
        <div className="stack">
          <p>
            Every production you set up goes now, for good: its script, every recording your cast and you made, and your cast&rsquo;s names and emails. Their
            links stop working. This can&rsquo;t be undone.
          </p>
          {deleteError && (
            <p className="field-error" role="alert">
              {deleteError}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-danger" onClick={() => void deleteAccount()} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete everything"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)} disabled={deleting} autoFocus>
              Keep my account
            </button>
          </div>
        </div>
      </Dialog>
    </main>
  );
}
