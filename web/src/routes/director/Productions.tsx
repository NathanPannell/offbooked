import { ArrowRight, Plus } from "lucide-react";
import { Link, Navigate } from "react-router";
import { errorMessage } from "../../api/client";
import { productions } from "../../api/director";
import type { Production } from "../../api/types";
import { Loading } from "../../components/Loading";
import { useResource } from "../../lib/useResource";
import { nextStep } from "./nextStep";

export default function Productions() {
  const list = useResource(() => productions.list().then((r) => r.productions), "productions");

  return (
    <main className="page">
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
        // Nothing to list yet: go straight to setting one up.
        <Navigate to="/app/new" replace />
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
