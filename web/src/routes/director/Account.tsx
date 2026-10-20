import { LogOut } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { errorMessage, session } from "../../api/client";
import { auth } from "../../api/director";
import { Avatar } from "../../components/Avatar";
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

  return (
    <main className="page page-narrow account-page">
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
    </main>
  );
}
