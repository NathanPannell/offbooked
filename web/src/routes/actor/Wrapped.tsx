import { Headphones, ListChecks, Mail, Mic, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { ActorApi } from "../../api/actor";
import { errorMessage } from "../../api/client";
import type { ActorLine, Invite } from "../../api/types";
import { plural, titleCase } from "../../lib/format";
import { VERDICT_CHIP } from "../../components/AccuracyChip";
import { formatVerdictCounts, scoreLabel, verdict, VERDICT_RANK, verdictCounts } from "../../stt/score";
import type { SttState } from "../../stt/session";
import type { UploadItem } from "../../upload/queue";
import { PickUpParts } from "./PickUpParts";
import type { Score } from "./RecordSession";

export function Wrapped({
  token,
  api,
  invite,
  lines,
  scores,
  sttState,
  unsaved,
  pendingScores,
  onRetry,
  onPickedUp,
  partId = null,
  otherParts = [],
  onSwitchPart,
  onReview,
}: {
  token: string;
  api: ActorApi;
  invite: Invite;
  lines: ActorLine[];
  scores: Map<string, Score>;
  sttState: SttState;
  unsaved: UploadItem[];
  pendingScores: number;
  onRetry: (takeId: string) => void;
  onPickedUp: (characters: { id: string; name: string }[]) => void;
  /** With several parts: the one just finished, the others (with lines still to record), and switching. */
  partId?: string | null;
  otherParts?: { id: string; name: string; left: number }[];
  onSwitchPart?: (id: string) => void;
  onReview: (lineId: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [emailState, setEmailState] = useState<"ask" | "sending" | "saved" | "skipped">(invite.hasEmail ? "saved" : "ask");
  const [error, setError] = useState<string | null>(null);

  const saving = unsaved.filter((i) => i.status !== "failed");
  const failed = unsaved.filter((i) => i.status === "failed");
  const results = lines.map((l) => scores.get(l.line.id)?.result).filter((r) => !!r);
  const counts = verdictCounts(results);
  // Not attempted first, then partial, each in script order.
  const toReview = lines
    .map((l) => ({ line: l, score: scores.get(l.line.id) }))
    .filter((x) => x.score && verdict(x.score.result) !== "complete")
    .sort((a, b) => VERDICT_RANK[verdict(a.score!.result)] - VERDICT_RANK[verdict(b.score!.result)]);
  const scoring = pendingScores > 0;
  const partName = partId ? invite.characters.find((c) => c.id === partId)?.name : undefined;
  const nextPart = otherParts.find((p) => p.left > 0);
  const playQuery = partId ? `part=${partId}` : "";
  const showSummary = results.length > 0 || scoring;

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    setEmailState("sending");
    setError(null);
    try {
      await api.contact(email.trim());
      setEmailState("saved");
    } catch (err) {
      setError(errorMessage(err));
      setEmailState("ask");
    }
  };

  if (saving.length > 0 || failed.length > 0) {
    return (
      <main className="wrapped page page-narrow">
        <div className="card stack" aria-live="polite">
          {failed.length > 0 ? (
            <>
              <h1 className="display">Almost there</h1>
              <p>{failed.length === 1 ? "One take" : `${failed.length} takes`} didn't upload. They're safe on this phone.</p>
              <button type="button" className="btn btn-primary" onClick={() => failed.forEach((f) => onRetry(f.takeId))}>
                Try uploading again
              </button>
            </>
          ) : (
            <>
              <div className="spinner" aria-hidden="true" />
              <h1 className="display">Saving your last takes…</h1>
              <p className="muted">{saving.length} to go. Keep this page open for a moment. If you lose signal, they'll upload when you're back.</p>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="wrapped page page-narrow">
      <div className="curtain-call">
        <p className="eyebrow">{invite.production.title}</p>
        <h1 className="wrapped-title">{partName ? `${titleCase(partName)}'s wrapped` : "You're wrapped"}</h1>
        <p className="lede">
          {emailState === "saved"
            ? "We'll let you know when the full run-through is ready."
            : "Every line is in. The run-through fills in as the rest of the cast records."}
        </p>
      </div>

      {nextPart && onSwitchPart && (
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onSwitchPart(nextPart.id)}>
          <Mic size={18} aria-hidden="true" /> Record {titleCase(nextPart.name)} next · {plural(nextPart.left, "line")}
        </button>
      )}

      {emailState === "ask" || emailState === "sending" ? (
        <form className="card stack" onSubmit={submitEmail}>
          <label className="field">
            <span>
              <Mail size={16} aria-hidden="true" /> Want an email when the full run-through is ready?
            </span>
            <input
              className="input"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <span className="field-hint">Just that one email. Nothing else.</span>
          </label>
          {error && <p className="field-error">{error}</p>}
          <div className="row">
            <button className="btn btn-primary" disabled={!email.trim() || emailState === "sending"}>
              Email me
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEmailState("skipped")}>
              No thanks
            </button>
          </div>
        </form>
      ) : null}

      <section className="card stack accuracy-summary" aria-live="polite">
        <h2 className="row" style={{ gap: 8 }}>
          <ListChecks size={20} aria-hidden="true" /> How your lines went
        </h2>
        {!showSummary ? (
          <p className="muted">
            {sttState.status === "unavailable"
              ? "Accuracy check isn't available on this device. Listen back to any line to check it."
              : "No lines checked yet. Listen back to any line to check it."}
          </p>
        ) : (
          <>
            {results.length > 0 && (
              <p className="summary-score">
                <span className="display summary-counts">{formatVerdictCounts(counts)}</span> across {plural(results.length, "line")} checked
              </p>
            )}
            {scoring && (
              <p className="small muted">
                {sttState.status === "ready" ? "Still checking" : "Accuracy check warming up. Then checking"} {pendingScores}{" "}
                {pendingScores === 1 ? "line" : "lines"}…
              </p>
            )}
            {toReview.length > 0 ? (
              <>
                <p className="small">Worth another listen. Tap one to re-record it:</p>
                <ul className="summary-list">
                  {toReview.map(({ line, score }) => (
                    <li key={line.line.id}>
                      <button type="button" className="summary-line" onClick={() => onReview(line.line.id)}>
                        <span className="grow">{line.line.text}</span>
                        <span className={`chip ${VERDICT_CHIP[verdict(score!.result)]}`}>{scoreLabel(score!.result)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              !scoring && results.length > 0 && <p>Every line sounded complete.</p>
            )}
          </>
        )}
      </section>

      <section className="card stack pick-up-card">
        <h2 className="row" style={{ gap: 8 }}>
          <Plus size={20} aria-hidden="true" /> Pick up more lines
        </h2>
        <PickUpParts
          api={api}
          onPicked={onPickedUp}
          intro="Got time for more? These parts are free. Lines nobody has recorded yet play in the computer voice."
        />
      </section>

      <div className="stack wrapped-actions">
        <Link className={`btn ${nextPart ? "btn-secondary" : "btn-primary btn-lg"} btn-block`} to={`/i/${token}/play${playQuery ? `?${playQuery}` : ""}`}>
          <Headphones size={20} aria-hidden="true" /> Listen to what's recorded so far
        </Link>
        <Link className="btn btn-secondary btn-block" to={`/i/${token}/play?mode=mine${playQuery ? `&${playQuery}` : ""}`}>
          <Mic size={18} aria-hidden="true" /> Practise my part
        </Link>
        <button type="button" className="btn btn-ghost btn-block" onClick={() => onReview(lines[0]?.line.id ?? "")}>
          Back to my lines
        </button>
      </div>
    </main>
  );
}
