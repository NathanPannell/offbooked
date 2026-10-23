import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { session } from "../api/client";
import { Brand } from "../components/Brand";
import { appPathFromUrl } from "./links";

/**
 * The app's front screen, in place of the website's landing page: most people arrive through a
 * cast link, which opens its page directly; this is for opening one by hand (pasted from a message)
 * and for directors.
 */
export default function NativeHome() {
  const navigate = useNavigate();
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const signedIn = !!session.get();

  const open = (e: FormEvent) => {
    e.preventDefault();
    const path = appPathFromUrl(link.trim());
    if (!path) {
      setError("That isn't an Offbooked link. It starts with https://offbooked.com/join/.");
      return;
    }
    void navigate(path);
  };

  return (
    <main className="page page-narrow center-page">
      <Brand />
      <form className="raised message-card stack" onSubmit={open}>
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="display">Get off book together</h1>
          <p className="muted">Open the cast link from your director to record your lines and listen through the play.</p>
        </div>
        <label className="field">
          <span>Cast link</span>
          <input
            className="input"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setError(null);
            }}
            placeholder="https://offbooked.com/join/…"
          />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-lg" disabled={!link.trim()}>
          Open my cast link
        </button>
        <p className="small muted">
          Setting up a play? <Link to={signedIn ? "/app" : "/signin"}>{signedIn ? "Your productions" : "Sign in"}</Link>
        </p>
      </form>
    </main>
  );
}
