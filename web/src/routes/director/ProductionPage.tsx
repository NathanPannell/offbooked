import { Archive, ArrowLeft, Check } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { errorMessage } from "../../api/client";
import { productions } from "../../api/director";
import type { Production } from "../../api/types";
import { Loading } from "../../components/Loading";
import { useToast } from "../../components/Toast";
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
        <ProductionTitle production={p} onSaved={(updated) => production.setData(updated)} />
      </div>

      {/* Pinned to the top while scrolling, with each page’s own row pinned just under it. */}
      <div className="steps-bar">
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
      </div>

      <section className="step-panel" aria-label={STEPS.find((s) => s.id === tab)!.label}>
        {tab === "script" && (
          <ScriptTab production={p} onChanged={() => void production.reload()} onDone={() => selectTab("cast")} />
        )}
        {tab === "cast" && <CastTab production={p} onOpenScript={() => selectTab("script")} onOpenPlay={() => selectTab("play")} />}
        {tab === "play" && <RunThroughTab production={p} />}
      </section>

    </main>
  );
}

/**
 * The title edits where it stands, like a script line: click it, type, Enter or click away saves,
 * Escape cancels. Archive sits beside it and asks once, in place.
 */
function ProductionTitle({ production, onSaved }: { production: Production; onSaved: (p: Production) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (draft !== null && document.activeElement !== field.current) {
      field.current?.focus();
      field.current?.select();
    }
  }, [draft]);

  const save = async () => {
    if (draft === null) return;
    const title = draft.trim();
    setDraft(null);
    if (!title || title === production.title) return;
    try {
      const { production: updated } = await productions.update(production.id, { title });
      setError(null);
      onSaved(updated);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(null);
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
    <>
      <div className="production-title">
        {draft === null ? (
          <h1 className="display">
            <button type="button" className="title-edit" onClick={() => setDraft(production.title)} title="Rename">
              {production.title}
            </button>
          </h1>
        ) : (
          <input
            ref={field}
            className="display title-input"
            aria-label="Production title"
            value={draft}
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={() => void save()}
          />
        )}
        <button
          type="button"
          className="icon-btn"
          onClick={() => setConfirmArchive((c) => !c)}
          aria-expanded={confirmArchive}
          aria-label="Archive production"
          title="Archive production"
        >
          <Archive size={18} />
        </button>
      </div>
      {confirmArchive && (
        <div className="archive-confirm" role="group" aria-label="Archive this production">
          <p className="small">Archiving hides this production and turns off the cast link. Recordings are kept.</p>
          <button type="button" className="btn btn-danger btn-sm" onClick={archive}>
            Archive
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmArchive(false)}>
            Keep it
          </button>
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
    </>
  );
}
