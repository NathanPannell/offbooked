import { ChevronDown, Headphones, ListChecks, Mail, Mic, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { ActorApi } from "../../api/actor";
import type { ActorLine, Invite } from "../../api/types";
import { plural, titleCase } from "../../lib/format";
import { VERDICT_CHIP } from "../../components/AccuracyChip";
import { formatVerdictCounts, scoreLabel, verdict, verdictCounts } from "../../stt/score";
import type { SttState } from "../../stt/session";
import type { UploadItem } from "../../upload/queue";
import { byScene } from "./byScene";
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
  onOpenProfile,
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
  /** Opens the profile dialog (the initials at the top right), where the email is set up. */
  onOpenProfile: () => void;
  onReview: (lineId: string) => void;
}) {
  const [pickUpOpen, setPickUpOpen] = useState(false);

  const saving = unsaved.filter((i) => i.status !== "failed");
  const failed = unsaved.filter((i) => i.status === "failed");
  const results = lines.map((l) => scores.get(l.line.id)?.result).filter((r) => !!r);
  const counts = verdictCounts(results);
  // Every line of the part (all the actor's lines without one), under its scene in script order.
  const scenes = byScene(lines);
  const scoring = pendingScores > 0;
  const partName = partId ? invite.characters.find((c) => c.id === partId)?.name : undefined;
  const nextPart = otherParts.find((p) => p.left > 0);
  const allComplete = results.length > 0 && counts.partial === 0 && counts.unattempted === 0;

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
        <p className="lede">Every line is in.</p>
      </div>

      <Link className="btn btn-primary btn-lg btn-block" to={`/i/${token}/play${partId ? `?part=${partId}` : ""}`}>
        <Headphones size={20} aria-hidden="true" /> Listen through the play
      </Link>

      {nextPart && onSwitchPart && (
        <button type="button" className="btn btn-secondary btn-block" onClick={() => onSwitchPart(nextPart.id)}>
          <Mic size={18} aria-hidden="true" /> Record {titleCase(nextPart.name)} next · {plural(nextPart.left, "line")}
        </button>
      )}

      {!invite.hasEmail && (
        <p className="wrapped-email">
          <Mail size={18} aria-hidden="true" />
          <span className="grow">
            {invite.pendingEmail ? "Check your inbox to verify your email." : "Add your email in your profile to hear when the play is ready."}
          </span>
          <button type="button" className="link-btn" onClick={onOpenProfile}>
            {invite.pendingEmail ? "Open profile" : "Add email"}
          </button>
        </p>
      )}

      <section className="card stack accuracy-summary" aria-live="polite">
        <h2 className="row" style={{ gap: 8 }}>
          <ListChecks size={20} aria-hidden="true" /> How your lines went
        </h2>
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
        {results.length === 0 && !scoring && (
          <p className="muted">
            {sttState.status === "unavailable" ? "Accuracy check isn't available on this device." : "No lines checked yet."} Listen back to any line to check
            it.
          </p>
        )}
        {allComplete && !scoring && <p>Every line sounded complete.</p>}
        {scenes.length > 0 && <p className="small">Tap a line to re-record it.</p>}
        {scenes.map((scene) => (
          <div key={scene.sectionId} className="summary-scene">
            <h3 className="eyebrow">{scene.title}</h3>
            <ul className="summary-list">
              {scene.items.map((l) => {
                const result = scores.get(l.line.id)?.result;
                return (
                  <li key={l.line.id}>
                    <button type="button" className="summary-line" onClick={() => onReview(l.line.id)}>
                      <span className="grow">{l.line.text}</span>
                      {result && <span className={`chip ${VERDICT_CHIP[verdict(result)]}`}>{scoreLabel(result)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <section className="card pick-up-card">
        <button type="button" className="pick-up-toggle" aria-expanded={pickUpOpen} aria-controls="wrapped-pick-up" onClick={() => setPickUpOpen((o) => !o)}>
          <Plus size={20} aria-hidden="true" />
          <span className="grow">Record lines for another character</span>
          <ChevronDown size={20} aria-hidden="true" className="pick-up-chevron" />
        </button>
        {pickUpOpen && (
          <div id="wrapped-pick-up" className="pick-up-body">
            <PickUpParts api={api} onPicked={onPickedUp} />
          </div>
        )}
      </section>

      <button type="button" className="btn btn-ghost btn-block" onClick={() => onReview(lines[0]?.line.id ?? "")}>
        Back to my lines
      </button>
    </main>
  );
}
