import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, errorMessage } from "../../api/client";
import { productions, script as scriptApi } from "../../api/director";
import type { ParseProgress } from "../../api/types";
import { InfoTip } from "../../components/InfoTip";
import { useInterval, useResource } from "../../lib/useResource";
import { BetaGate } from "./BetaGate";
import { useDirector } from "./DirectorLayout";
import { ParseProgressView } from "./ParseProgressView";
import { ScriptDropZone } from "./ScriptDropZone";
import { localToday, performanceDatesProblem, sendSetup, type SetupApi } from "./setup";

const setupApi: SetupApi = {
  create: (input) => productions.create(input),
  update: (id, input) => productions.update(id, input),
  upload: (id, file) => scriptApi.uploadFile(id, file),
};

/** `sending` creates the production and uploads the file; `reading` polls until the script is read. */
type Phase = "form" | "sending" | "reading" | "failed";
type Errors = { title?: string; dates?: string; file?: string; form?: string };

/** Setting up a play needs beta access; an account without it is asked for the code first. */
export default function NewProduction() {
  const { user, setUser } = useDirector();
  return user.betaAccess ? <SetUpProduction /> : <BetaGate onGranted={setUser} />;
}

/**
 * Setting up a play is one screen: the title, the performance dates and the script. Sending it
 * creates the production, uploads the file and reads it right here; once it's read, the director
 * lands on their script.
 */
function SetUpProduction() {
  const navigate = useNavigate();
  const [today] = useState(localToday);
  const [title, setTitle] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [phase, setPhase] = useState<Phase>("form");
  const [productionId, setProductionId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const polling = useRef(false);
  // A director with no productions yet has nowhere to cancel back to.
  const existing = useResource(() => productions.list().then((r) => r.productions.length), "new-production:count");

  useInterval(
    () => {
      if (!productionId || polling.current) return;
      polling.current = true;
      scriptApi
        .get(productionId)
        .then((s) => {
          if (s.status === "ready") navigate(`/app/p/${productionId}?tab=script`, { replace: true });
          else if (s.status === "failed" || s.status === "none") {
            setFailure(s.error || "Something in the file stopped us finding the lines.");
            setPhase("failed");
          } else setProgress(s.progress ?? null);
        })
        .catch(() => {
          // A missed poll is fine; the next one tries again.
        })
        .finally(() => {
          polling.current = false;
        });
    },
    1500,
    phase === "reading" && !!productionId,
  );

  // The form goes away while the script is read, so move focus to the heading that replaces it.
  const screen = phase === "sending" || phase === "reading" ? "progress" : phase;
  useEffect(() => {
    if (screen !== "form") document.getElementById("parse-title")?.focus();
  }, [screen]);

  const clearDatesIfValid = (starts: string, ends: string) => {
    if (!performanceDatesProblem(starts, ends, today)) setErrors((er) => (er.dates ? { ...er, dates: undefined } : er));
  };

  const start = async (script: File) => {
    setErrors({});
    setFailure(null);
    setProgress(null);
    setPhase("sending");
    try {
      await sendSetup(setupApi, { title, performanceStartsOn: startsOn, performanceEndsOn: endsOn, file: script }, productionId, setProductionId);
      setPhase("reading");
    } catch (err) {
      // The server is already reading this production's script (an earlier upload whose answer got
      // lost on the way back): wait for that read instead.
      if (err instanceof ApiError && err.code === "parse_in_progress") return setPhase("reading");
      setPhase("form");
      setErrors({
        form:
          err instanceof ApiError && err.code === "has_recordings"
            ? "This production already has recordings, so its script can't be replaced."
            : `We couldn't send the script. ${errorMessage(err)}`,
      });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    if (!title.trim()) next.title = "Give the production a title.";
    const dates = performanceDatesProblem(startsOn, endsOn, today);
    if (dates) next.dates = dates;
    if (!file) next.file = "Add the script as a PDF or Word file.";
    setErrors(next);
    if (next.title || next.dates || next.file) {
      const first = next.title ? "np-title" : next.dates ? (startsOn ? "np-ends" : "np-starts") : "np-file-error";
      // After React shows the messages.
      requestAnimationFrame(() => document.getElementById(first)?.focus());
      return;
    }
    void start(file!);
  };

  if (phase === "sending" || phase === "reading") {
    return (
      <main className="page page-narrow new-production">
        <ParseProgressView progress={progress} fileName={file?.name} eyebrow={title.trim()} headingLevel={1} />
      </main>
    );
  }

  if (phase === "failed") {
    return (
      <main className="page page-narrow new-production">
        <section className="raised form-card stack" aria-labelledby="parse-title">
          <div className="stack" style={{ gap: 6 }}>
            <p className="eyebrow">{title.trim()}</p>
            <h1 id="parse-title" className="display" tabIndex={-1}>
              We couldn't read {file?.name ?? "that script"}
            </h1>
          </div>
          <div className="notice notice-error" role="alert">
            <div>{failure} Try another file: a PDF exported from Word or Google Docs, or the .docx itself, usually reads best.</div>
          </div>
          <ScriptDropZone
            buttonLabel="Try another file"
            onFile={(f) => {
              setFile(f);
              void start(f);
            }}
            onProblem={(message) => setErrors({ file: message })}
          />
          {errors.file && (
            <p className="field-error" role="alert">
              {errors.file}
            </p>
          )}
          <button
            type="button"
            className="quiet-link"
            style={{ alignSelf: "flex-start" }}
            onClick={() => {
              // The file that failed to read goes too, so it isn't sent again by mistake.
              setFile(null);
              setPhase("form");
            }}
          >
            <RotateCcw size={14} aria-hidden="true" /> Change the title or dates
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="page page-narrow new-production">
      <form className="raised form-card stack" onSubmit={submit} noValidate>
        <div className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">New production</p>
          <h1 className="display">What are you putting on?</h1>
        </div>

        <label className="field">
          <span>Title</span>
          <input
            id="np-title"
            className="input input-lg"
            required
            autoFocus
            maxLength={200}
            value={title}
            aria-invalid={!!errors.title || undefined}
            aria-describedby={errors.title ? "np-title-error" : undefined}
            onChange={(e) => {
              setTitle(e.target.value);
              // An error goes as soon as its field is right, not on the next submit.
              if (e.target.value.trim()) setErrors((er) => (er.title ? { ...er, title: undefined } : er));
            }}
            placeholder="e.g. Hamlet, or Our Town (spring)"
          />
          {errors.title && (
            <span id="np-title-error" className="field-error" role="alert">
              {errors.title}
            </span>
          )}
        </label>

        <fieldset className="field date-range">
          <legend className="field-label date-range-legend">
            Performance dates
            <InfoTip label="About performance dates">We delete the script and every recording 7 days after the final performance.</InfoTip>
          </legend>
          <div className="date-range-inputs">
            <label className="date-range-field">
              <span className="small muted">First performance</span>
              <input
                id="np-starts"
                className="input"
                type="date"
                required
                value={startsOn}
                aria-invalid={(!!errors.dates && !startsOn) || undefined}
                aria-describedby={errors.dates ? "np-dates-error" : undefined}
                onChange={(e) => {
                  const value = e.target.value;
                  setStartsOn(value);
                  // Keep the range whole: a final performance before the new first one moves with it.
                  const end = value && (!endsOn || endsOn < value) ? (value < today ? today : value) : endsOn;
                  if (end !== endsOn) setEndsOn(end);
                  clearDatesIfValid(value, end);
                }}
              />
            </label>
            <span className="date-range-dash" aria-hidden="true">
              –
            </span>
            <label className="date-range-field">
              <span className="small muted">Final performance</span>
              <input
                id="np-ends"
                className="input"
                type="date"
                required
                min={startsOn && startsOn > today ? startsOn : today}
                value={endsOn}
                aria-invalid={(!!errors.dates && !!startsOn) || undefined}
                aria-describedby={errors.dates ? "np-dates-error" : undefined}
                onChange={(e) => {
                  setEndsOn(e.target.value);
                  clearDatesIfValid(startsOn, e.target.value);
                }}
              />
            </label>
          </div>
          {errors.dates && (
            <span id="np-dates-error" className="field-error" role="alert">
              {errors.dates}
            </span>
          )}
        </fieldset>

        <div className="field" role="group" aria-labelledby="np-file-label">
          <span id="np-file-label">Script</span>
          <ScriptDropZone
            chosen={file}
            invalid={!!errors.file}
            describedBy={errors.file ? "np-file-error" : undefined}
            onFile={(f) => {
              setFile(f);
              setErrors((e) => ({ ...e, file: undefined }));
            }}
            onProblem={(message) => setErrors((e) => ({ ...e, file: message }))}
          />
          {errors.file && (
            <span id="np-file-error" className="field-error" role="alert" tabIndex={-1}>
              {errors.file}
            </span>
          )}
        </div>

        {errors.form && (
          <p className="field-error" role="alert">
            {errors.form}
          </p>
        )}
        <div className="row">
          <button className="btn btn-primary btn-lg">Read the script</button>
          {!!existing.data && (
            <Link className="btn btn-ghost" to="/app">
              Cancel
            </Link>
          )}
        </div>
      </form>
    </main>
  );
}
