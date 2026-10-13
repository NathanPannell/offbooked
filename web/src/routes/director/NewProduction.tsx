import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { errorMessage } from "../../api/client";
import { productions } from "../../api/director";

export default function NewProduction() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { production } = await productions.create({ title: title.trim(), performanceDate: date || null });
      navigate(`/app/p/${production.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main className="page page-narrow">
      <form className="card stack" onSubmit={submit}>
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">New production</p>
          <h1 className="display">What are you putting on?</h1>
        </div>
        <label className="field">
          <span>Title</span>
          <input className="input input-lg" required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Hamlet" />
        </label>
        <label className="field">
          <span>Performance date (optional)</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <span className="field-hint">Actor links stay valid until two weeks after this date.</span>
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button className="btn btn-primary btn-lg" disabled={busy || !title.trim()}>
            {busy ? "Creating…" : "Next: add the script"}
          </button>
          <Link className="btn btn-ghost" to="/app">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
