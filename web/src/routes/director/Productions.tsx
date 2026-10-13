import { CalendarDays, Plus, Theater } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { errorMessage } from "../../api/client";
import { auth, productions } from "../../api/director";
import type { Production } from "../../api/types";
import { Loading } from "../../components/Loading";
import { ProgressBar } from "../../components/ProgressBar";
import { formatDate, plural } from "../../lib/format";
import { useResource } from "../../lib/useResource";
import { useDirector } from "./DirectorLayout";

export default function Productions() {
  const { user } = useDirector();
  const list = useResource(() => productions.list().then((r) => r.productions), "productions");

  return (
    <main className="page">
      {!user.name && <NamePrompt />}
      <div className="spread page-head">
        <h1 className="display">Your productions</h1>
        <Link className="btn btn-primary" to="/app/new">
          <Plus size={20} aria-hidden="true" /> New production
        </Link>
      </div>
      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <div className="notice notice-error" role="alert">
          {errorMessage(list.error)}{" "}
          <button className="link-btn" onClick={() => void list.reload()}>
            Try again
          </button>
        </div>
      ) : list.data!.length === 0 ? (
        <div className="empty card">
          <Theater size={40} aria-hidden="true" />
          <h2>No productions yet</h2>
          <p>Create one, add your script, and share a link with each actor.</p>
          <Link className="btn btn-primary" to="/app/new">
            Start your first production
          </Link>
        </div>
      ) : (
        <ul className="production-grid">
          {list.data!.map((p) => (
            <li key={p.id}>
              <ProductionCard production={p} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const SCRIPT_STATUS: Record<Production["scriptStatus"], string> = {
  none: "Add a script",
  parsing: "Reading script…",
  ready: "Script ready",
  failed: "Script needs attention",
};

function ProductionCard({ production: p }: { production: Production }) {
  const { linesRecorded, linesTotal, actorsTotal, actorsDone } = p.progress;
  return (
    <Link className="card production-card" to={`/app/p/${p.id}`}>
      <h2 className="display">{p.title}</h2>
      <p className="small muted row" style={{ gap: 6 }}>
        {p.performanceDate && (
          <>
            <CalendarDays size={15} aria-hidden="true" /> {formatDate(p.performanceDate)} ·{" "}
          </>
        )}
        {SCRIPT_STATUS[p.scriptStatus]}
      </p>
      {p.scriptStatus === "ready" && linesTotal > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <ProgressBar value={linesRecorded} max={linesTotal} label="Lines recorded" />
          <p className="small muted">
            {linesRecorded} of {plural(linesTotal, "line")} recorded · {actorsDone}/{actorsTotal} actors done
          </p>
        </div>
      )}
    </Link>
  );
}

function NamePrompt() {
  const { setUser } = useDirector();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setUser((await auth.updateMe(name.trim())).user);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <form className="card name-prompt" onSubmit={save}>
      <label className="field grow">
        <span>What should your cast call you?</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" autoComplete="given-name" />
        <span className="field-hint">Shown on invites: “Sam invited you”.</span>
      </label>
      <button className="btn btn-primary" disabled={!name.trim()}>
        Save
      </button>
      {error && <p className="field-error">{error}</p>}
    </form>
  );
}
