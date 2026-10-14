import { ArrowLeft, Check, Pencil } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { errorMessage } from "../../api/client";
import { productions } from "../../api/director";
import type { Production } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { Loading } from "../../components/Loading";
import { useToast } from "../../components/Toast";
import { formatDate } from "../../lib/format";
import { useResource } from "../../lib/useResource";
import { CastTab } from "./CastTab";
import { nextStep, type StepTab } from "./nextStep";
import { RunThroughTab } from "./RunThroughTab";
import { ScriptTab } from "./ScriptTab";

const STEPS: { id: StepTab; label: string }[] = [
  { id: "script", label: "Script" },
  { id: "cast", label: "Cast" },
  { id: "play", label: "Run-through" },
];

export default function ProductionPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const production = useResource(() => productions.get(id).then((r) => r.production), id);
  const [editing, setEditing] = useState(false);

  if (production.loading) return <Loading />;
  if (production.error || !production.data) {
    return (
      <main className="page">
        <div className="notice notice-error" role="alert">
          {errorMessage(production.error)} <Link to="/app">Back to productions</Link>
        </div>
      </main>
    );
  }

  const p = production.data;
  const requested = params.get("tab");
  const tab: StepTab = requested === "script" || requested === "cast" || requested === "play" ? requested : nextStep(p).tab;
  const selectTab = (next: StepTab) => {
    setParams({ tab: next }, { replace: true });
    window.scrollTo({ top: 0 });
  };
  const done: Record<StepTab, boolean> = {
    script: p.scriptStatus === "ready",
    cast: p.progress.linesTotal > 0 && p.progress.linesRecorded >= p.progress.linesTotal,
    play: false,
  };

  return (
    <main className={`page production-page tab-${tab}`}>
      <div className="production-head">
        <Link className="back-link" to="/app" aria-label="All productions">
          <ArrowLeft size={16} aria-hidden="true" /> Productions
        </Link>
        <div className="production-title">
          <h1 className="display">{p.title}</h1>
          <button type="button" className="icon-btn" onClick={() => setEditing(true)} aria-label="Edit production" title="Edit production">
            <Pencil size={17} />
          </button>
        </div>
        {p.performanceDate && <p className="small muted">Opens {formatDate(p.performanceDate)}</p>}
      </div>

      <nav className="steps" aria-label="Production steps">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className="step"
            aria-current={tab === s.id ? "page" : undefined}
            onClick={() => selectTab(s.id)}
          >
            <span className={`step-dot ${done[s.id] ? "is-done" : ""}`} aria-hidden="true">
              {done[s.id] ? <Check size={13} strokeWidth={3} /> : i + 1}
            </span>
            {s.label}
          </button>
        ))}
      </nav>

      <section className="step-panel" aria-label={STEPS.find((s) => s.id === tab)!.label}>
        {tab === "script" && (
          <ScriptTab production={p} onChanged={() => void production.reload()} onDone={() => selectTab("cast")} />
        )}
        {tab === "cast" && <CastTab production={p} onOpenScript={() => selectTab("script")} onOpenPlay={() => selectTab("play")} />}
        {tab === "play" && <RunThroughTab production={p} />}
      </section>

      <EditProduction
        open={editing}
        production={p}
        onClose={() => setEditing(false)}
        onSaved={(updated) => {
          production.setData(updated);
          setEditing(false);
        }}
      />
    </main>
  );
}

function EditProduction({
  open,
  production,
  onClose,
  onSaved,
}: {
  open: boolean;
  production: Production;
  onClose: () => void;
  onSaved: (p: Production) => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [title, setTitle] = useState(production.title);
  const [date, setDate] = useState(production.performanceDate?.slice(0, 10) ?? "");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { production: updated } = await productions.update(production.id, {
        title: title.trim(),
        performanceDate: date || null,
      });
      onSaved(updated);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const archive = async () => {
    try {
      await productions.archive(production.id);
      toast(`${production.title} archived`);
      navigate("/app", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Edit production">
      <form className="stack" onSubmit={save}>
        <label className="field">
          <span>Title</span>
          <input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Performance date</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <span className="field-hint">Cast links keep working until two weeks after this date.</span>
        </label>
        {error && <p className="field-error">{error}</p>}
        <button className="btn btn-primary" disabled={!title.trim()}>
          Save
        </button>
        <hr className="divider" />
        {confirmArchive ? (
          <div className="stack" style={{ "--gap": "10px" } as React.CSSProperties}>
            <p className="small">Archiving hides this production and turns off every cast link. Recordings are kept.</p>
            <div className="row">
              <button type="button" className="btn btn-danger btn-sm" onClick={archive}>
                Archive production
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmArchive(false)}>
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="quiet-link" style={{ alignSelf: "flex-start" }} onClick={() => setConfirmArchive(true)}>
            Archive this production…
          </button>
        )}
      </form>
    </Dialog>
  );
}
