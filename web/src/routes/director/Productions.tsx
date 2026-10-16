import { ArrowRight, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { errorMessage } from "../../api/client";
import { auth, productions } from "../../api/director";
import type { Production } from "../../api/types";
import { EmptyStage } from "../../components/Illustrations";
import { Loading } from "../../components/Loading";
import { useResource } from "../../lib/useResource";
import { useDirector } from "./DirectorLayout";
import { nextStep } from "./nextStep";

export default function Productions() {
  const { user } = useDirector();
  const list = useResource(() => productions.list().then((r) => r.productions), "productions");

  return (
    <main className="page">
      {!user.name && <NamePrompt />}
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
        <section className="welcome-empty">
          <EmptyStage />
          <p className="eyebrow">Welcome{user.name ? `, ${user.name}` : ""}</p>
          <h1 className="display">Let's get your cast off book.</h1>
          <p className="lede">
            Add your script, share one link with the cast, and everyone records their lines from their phone. You get the whole
            play back as a run-through.
          </p>
          <Link className="btn btn-primary btn-lg" to="/app/new">
            Start a production <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </section>
      ) : (
        <>
          <div className="page-head">
            <h1 className="display">Your productions</h1>
            <Link className="btn btn-secondary btn-sm" to="/app/new">
              <Plus size={16} aria-hidden="true" /> New production
            </Link>
          </div>
          <ul className="production-list">
            {list.data!.map((p) => (
              <li key={p.id}>
                <ProductionCard production={p} />
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function ProductionCard({ production: p }: { production: Production }) {
  const step = nextStep(p);
  const { linesRecorded, linesTotal } = p.progress;
  return (
    <Link className="ticket" to={`/app/p/${p.id}?tab=${step.tab}`}>
      <div className="ticket-main">
        <h2 className="display">{p.title}</h2>
        <p className="small muted">{step.status}</p>
        {p.scriptStatus === "ready" && linesTotal > 0 && <Seats recorded={linesRecorded} total={linesTotal} />}
      </div>
      <span className="ticket-stub">
        <span>{step.action}</span>
        <ArrowRight size={18} aria-hidden="true" />
      </span>
    </Link>
  );
}

/** A row of seats that fill in as the cast records, one per tenth of the lines. */
function Seats({ recorded, total }: { recorded: number; total: number }) {
  const filled = Math.round((recorded / total) * 10);
  const percent = Math.round((recorded / total) * 100);
  return (
    <div className="seats" role="img" aria-label={`${percent}% of lines recorded`}>
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={`seat ${i < filled ? "is-filled" : ""}`} />
      ))}
      <span className="mono nums seats-label">{percent}%</span>
    </div>
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
    <form className="name-prompt" onSubmit={save}>
      <label className="field grow">
        <span>First, what should your cast call you?</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" autoComplete="given-name" />
        <span className="field-hint">Your cast sees “Sam invited you”.</span>
      </label>
      <button className="btn btn-primary" disabled={!name.trim()}>
        Save
      </button>
      {error && <p className="field-error">{error}</p>}
    </form>
  );
}
