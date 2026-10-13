import { ArrowLeft, CalendarDays, Pencil } from "lucide-react";
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
import { RunThroughTab } from "./RunThroughTab";
import { ScriptTab } from "./ScriptTab";

type Tab = "script" | "cast" | "play";
const TABS: { id: Tab; label: string }[] = [
  { id: "script", label: "Script" },
  { id: "cast", label: "Cast & progress" },
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
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = requested ?? (p.scriptStatus === "ready" ? "cast" : "script");
  const selectTab = (next: Tab) => setParams({ tab: next }, { replace: true });

  return (
    <main className="page page-wide">
      <Link className="back-link" to="/app">
        <ArrowLeft size={16} aria-hidden="true" /> Productions
      </Link>
      <div className="spread page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="display">{p.title}</h1>
          {p.performanceDate && (
            <p className="small muted row" style={{ gap: 6 }}>
              <CalendarDays size={15} aria-hidden="true" /> Opens {formatDate(p.performanceDate)}
            </p>
          )}
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
          <Pencil size={16} aria-hidden="true" /> Edit
        </button>
      </div>

      <div className="tabs" role="tablist" aria-label="Production">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className="tab"
            onClick={() => selectTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <section className="tab-panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
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
        </label>
        {error && <p className="field-error">{error}</p>}
        <button className="btn btn-primary" disabled={!title.trim()}>
          Save
        </button>
        <hr className="divider" />
        {confirmArchive ? (
          <div className="stack" style={{ gap: 10 }}>
            <p className="small">
              Archiving hides this production and turns off every actor link. Recordings are kept.
            </p>
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
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmArchive(true)}>
            Archive…
          </button>
        )}
      </form>
    </Dialog>
  );
}
