import { Check, Copy, Headphones, Mic, Share2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { errorMessage } from "../../api/client";
import { cast as castApi, joinLink } from "../../api/director";
import type { CallSheetCharacter, Production } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import { Confetti } from "../../components/Confetti";
import { EmptyStage } from "../../components/Illustrations";
import { Loading } from "../../components/Loading";
import { ProgressBar } from "../../components/ProgressBar";
import { useToast } from "../../components/Toast";
import { plural } from "../../lib/format";
import { copyText, shareOrCopy } from "../../lib/share";
import { readStorage, writeStorage } from "../../lib/storage";
import { useInterval, useResource } from "../../lib/useResource";

/**
 * The director's cast page: the one cast link up top, a read-only call sheet of every part, and a
 * way to record a part yourself in the same recording flow the cast uses.
 */
export function CastTab({
  production,
  onOpenScript,
  onOpenPlay,
}: {
  production: Production;
  onOpenScript: () => void;
  onOpenPlay: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const sheet = useResource(() => castApi.callSheet(production.id).then((r) => r.characters), `sheet:${production.id}`);
  const [opening, setOpening] = useState<string | null>(null);

  useInterval(() => void sheet.reload(), 15_000, !!sheet.data);

  const recordAs = async (characterId: string) => {
    setOpening(characterId);
    try {
      const { inviteToken } = await castApi.recordAs(production.id, characterId);
      navigate(`/i/${inviteToken}`);
    } catch (err) {
      toast(errorMessage(err));
      setOpening(null);
      void sheet.reload();
    }
  };

  if (sheet.loading) return <Loading />;
  if (sheet.error || !sheet.data) {
    return (
      <div className="notice notice-error" role="alert">
        {errorMessage(sheet.error)}{" "}
        <button className="link-btn" onClick={() => void sheet.reload()}>
          Try again
        </button>
      </div>
    );
  }

  const parts = sheet.data;
  if (parts.length === 0) {
    return (
      <div className="empty-state">
        <EmptyStage />
        <h2 className="display">The cast list comes from the script</h2>
        <p className="muted">Once your script is read, every character shows up here, ready for the cast to claim.</p>
        <button type="button" className="btn btn-primary" onClick={onOpenScript}>
          {production.scriptStatus === "parsing" ? "See how the script is going" : "Add the script"}
        </button>
      </div>
    );
  }

  const linesTotal = parts.reduce((n, c) => n + c.lineCount, 0);
  const linesRecorded = parts.reduce((n, c) => n + c.linesRecorded, 0);
  const taken = parts.filter((c) => c.takenBy).length;
  const wrapped = parts.every((c) => c.linesRecorded >= c.lineCount);

  return (
    <div className="cast">
      <CastLink production={production} />

      {wrapped && <WrapBanner productionId={production.id} onListen={onOpenPlay} />}

      <section className="call-sheet" aria-labelledby="call-sheet-title">
        <header className="call-sheet-head">
          <div>
            <p className="eyebrow">Call sheet</p>
            <h2 id="call-sheet-title" className="display">
              {linesRecorded.toLocaleString()} of {plural(linesTotal, "line")} recorded
            </h2>
            <p className="small muted">
              {taken === 0 ? "Nobody has picked a part yet." : `${taken} of ${plural(parts.length, "part")} taken.`}
            </p>
          </div>
          {linesRecorded > 0 && !wrapped && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenPlay}>
              <Headphones size={16} aria-hidden="true" /> Listen so far
            </button>
          )}
        </header>
        <ProgressBar value={linesRecorded} max={linesTotal} label="Lines recorded across the cast" />

        <ul className="sheet-list" aria-label="Parts">
          {parts.map((c) => (
            <SheetRow key={c.id} part={c} busy={opening === c.id} onRecord={() => void recordAs(c.id)} />
          ))}
        </ul>
        <p className="small muted">Until someone records a part, its lines play in a computer voice in the run-through.</p>
      </section>

      <RecordYourself parts={parts} opening={opening} onRecord={(id) => void recordAs(id)} />
    </div>
  );
}

function SheetRow({ part, busy, onRecord }: { part: CallSheetCharacter; busy: boolean; onRecord: () => void }) {
  const done = part.linesRecorded >= part.lineCount;
  const state = done ? "is-done" : part.takenBy ? "is-taken" : "is-open";
  return (
    <li className={`sheet-row ${state}`}>
      <div className="sheet-part">
        <CharacterName name={part.name} className="sheet-name" />
        <span className={`sheet-who small ${part.takenBy ? "" : "muted"}`}>
          {part.mine ? "You" : (part.takenBy ?? "Not taken yet")}
        </span>
      </div>
      <div className="sheet-progress">
        {done ? (
          <span className="sheet-done small">
            <Check size={14} strokeWidth={2.5} aria-hidden="true" /> All {part.lineCount} in
          </span>
        ) : (
          <>
            <span className="mono nums" aria-label={`${part.linesRecorded} of ${part.lineCount} lines recorded`}>
              {part.linesRecorded}/{part.lineCount}
            </span>
            <ProgressBar value={part.linesRecorded} max={part.lineCount} label={`${part.name} lines recorded`} className="sheet-bar" />
          </>
        )}
      </div>
      {part.mine && (
        <button type="button" className="btn btn-ghost btn-sm sheet-record" onClick={onRecord} disabled={busy} aria-label={`Record ${part.name}`}>
          <Mic size={15} aria-hidden="true" /> <span className="hide-sm">{done ? "Re-record" : "Record"}</span>
        </button>
      )}
    </li>
  );
}

/** Pick a free part (or one already yours) and record it in the same flow the cast uses. */
function RecordYourself({ parts, opening, onRecord }: { parts: CallSheetCharacter[]; opening: string | null; onRecord: (characterId: string) => void }) {
  const choices = parts.filter((c) => c.mine || !c.takenBy);
  const [picked, setPicked] = useState("");
  const value = choices.some((c) => c.id === picked) ? picked : (choices[0]?.id ?? "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value) onRecord(value);
  };

  return (
    <section className="record-yourself" aria-labelledby="record-yourself-title">
      <div>
        <p className="eyebrow">Reading in</p>
        <h2 id="record-yourself-title" className="display">
          Record a part yourself
        </h2>
        <p className="small muted">
          Pick a part and record its lines on this device, just like the cast does. It shows as yours on the call sheet, so nobody else can claim it.
        </p>
      </div>
      {choices.length === 0 ? (
        <p className="small muted">Every part is taken.</p>
      ) : (
        <form className="record-yourself-form" onSubmit={submit}>
          <label className="field grow">
            <span className="sr-only">Part to record</span>
            <select className="input" value={value} onChange={(e) => setPicked(e.target.value)}>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {plural(c.lineCount, "line")}
                  {c.mine ? " · yours" : ""}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-secondary" disabled={!value || opening !== null}>
            <Mic size={16} aria-hidden="true" /> {opening ? "Opening…" : "Start recording"}
          </button>
        </form>
      )}
    </section>
  );
}

/** The one link for the whole cast: the main way people join. */
function CastLink({ production }: { production: Production }) {
  const toast = useToast();
  const link = useResource(() => joinLink.get(production.id).then((r) => r.joinUrl), `join:${production.id}`);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);

  const share = async () => {
    if (!link.data) return;
    const outcome = await shareOrCopy({
      title: `${production.title}: record your lines`,
      text: `Hi all! Record your lines for ${production.title} here. Pick your character and go: it takes a few minutes on your phone, with no app or account.`,
      url: link.data,
    });
    if (outcome === "copied") toast("Message and link copied. Paste it in the cast chat.");
    if (outcome === "failed") toast("Couldn't copy. Select the link and copy it by hand.");
  };

  const reset = async () => {
    setBusy(true);
    try {
      const { joinUrl } = await joinLink.reset(production.id);
      link.setData(joinUrl);
      setConfirmReset(false);
      toast("New cast link made. The old one no longer works.");
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cast-link raised" aria-labelledby="cast-link-title">
      <div className="cast-link-copy">
        <p className="eyebrow">Cast link</p>
        <h2 id="cast-link-title" className="display">
          One link for the whole cast
        </h2>
        <p className="muted">Drop it in the group chat. Each person picks their part, types their first name and starts recording. No accounts.</p>
      </div>
      {link.error ? (
        <div className="notice notice-error" role="alert">
          {errorMessage(link.error)}{" "}
          <button className="link-btn" onClick={() => void link.reload()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="link-ticket">
            <span className="link-ticket-url mono">{link.data ? link.data.replace(/^https?:\/\//, "") : "Making your link…"}</span>
            <button
              type="button"
              className="icon-btn link-ticket-copy"
              disabled={!link.data}
              aria-label="Copy the cast link"
              onClick={async () => toast((await copyText(link.data!)) ? "Link copied" : "Couldn't copy")}
            >
              <Copy size={18} />
            </button>
          </div>
          <button type="button" className="btn btn-primary btn-lg cast-link-share" onClick={share} disabled={!link.data}>
            <Share2 size={18} aria-hidden="true" /> Share the cast link
          </button>
          {confirmReset ? (
            <div className="reset-confirm">
              <p className="small">The old link stops working for anyone who hasn't joined yet. People already in keep their place.</p>
              <div className="row">
                <button type="button" className="btn btn-danger btn-sm" onClick={reset} disabled={busy}>
                  Make a new link
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmReset(false)}>
                  Keep this one
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="quiet-link cast-link-reset" onClick={() => setConfirmReset(true)}>
              Link shared with the wrong people? Reset it
            </button>
          )}
        </>
      )}
    </section>
  );
}

function WrapBanner({ productionId, onListen }: { productionId: string; onListen: () => void }) {
  const key = `offbooked.wrapped.${productionId}`;
  const [firstTime] = useState(() => !readStorage(key));
  if (firstTime) writeStorage(key, "1");
  return (
    <section className="wrap-banner" role="status">
      {firstTime && <Confetti />}
      <span className="wrap-bow" aria-hidden="true">
        <Check size={24} strokeWidth={2} />
      </span>
      <div className="grow">
        <h2 className="display">That's a wrap!</h2>
        <p>Every part is cast and every line is in. Take a bow, then have a listen.</p>
      </div>
      <button type="button" className="btn btn-primary" onClick={onListen}>
        <Headphones size={18} aria-hidden="true" /> Hear the run-through
      </button>
    </section>
  );
}
