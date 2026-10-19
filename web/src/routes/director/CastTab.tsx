import { Check, ChevronDown, Copy, Headphones, Merge, Mic, MoreHorizontal, Share2, UserMinus, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { errorMessage } from "../../api/client";
import { cast as castApi, joinLink, script as scriptApi } from "../../api/director";
import type { CallSheetCharacter, Production } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import { Confetti } from "../../components/Confetti";
import { EmptyStage } from "../../components/Illustrations";
import { Loading } from "../../components/Loading";
import { ProgressBar } from "../../components/ProgressBar";
import { useToast } from "../../components/Toast";
import { plural, titleCase } from "../../lib/format";
import { copyText, shareOrCopy } from "../../lib/share";
import { readStorage, writeStorage } from "../../lib/storage";
import { useInterval, useResource, type Resource } from "../../lib/useResource";
import { suggestMerges } from "./duplicateCharacters";

/**
 * The director's cast page. Two actions: share the cast link (the main one), and record some lines
 * yourself. Who has taken which part and what's recorded fold away below.
 */
export function CastTab({ production, onOpenScript, onOpenPlay }: { production: Production; onOpenScript: () => void; onOpenPlay: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const sheet = useResource(() => castApi.callSheet(production.id).then((r) => r.characters), `sheet:${production.id}`);
  const [opening, setOpening] = useState<string | null>(null);
  const link = useResource(() => joinLink.get(production.id).then((r) => r.joinUrl), `join:${production.id}`);

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
  // Likely duplicates ("ISABEL" and "ISABELLA (ASIDE)"), offered first when merging.
  const suggested = new Map(
    suggestMerges(parts.map((c) => ({ id: c.id, name: c.name, aliases: [], lineCount: c.lineCount }))).map((m) => [m.from.id, m.into.id]),
  );

  return (
    <div className="cast">
      <section className="cast-actions" aria-label="Get the lines recorded">
        <CastLink production={production} link={link} />
        <RecordYourself parts={parts} opening={opening} onRecord={(id) => void recordAs(id)} />
      </section>

      {wrapped && <WrapBanner productionId={production.id} onListen={onOpenPlay} />}

      <details className="call-sheet">
        <summary>
          <span className="call-sheet-summary">
            <span className="call-sheet-title">Cast and recordings</span>
            <span className="small muted">
              {linesRecorded.toLocaleString()} of {plural(linesTotal, "line")} recorded · {taken} of {plural(parts.length, "part")} taken
            </span>
          </span>
          <ChevronDown size={18} aria-hidden="true" className="call-sheet-chevron" />
        </summary>
        <ProgressBar value={linesRecorded} max={linesTotal} label="Lines recorded across the cast" />
        {linesRecorded > 0 && !wrapped && (
          <button type="button" className="btn btn-ghost btn-sm call-sheet-listen" onClick={onOpenPlay}>
            <Headphones size={16} aria-hidden="true" /> Listen so far
          </button>
        )}
        <ul className="sheet-list" aria-label="Parts">
          {parts.map((c) => (
            <SheetRow
              key={c.id}
              productionId={production.id}
              part={c}
              parts={parts}
              suggestion={suggested.get(c.id) ?? null}
              busy={opening === c.id}
              onRecord={() => void recordAs(c.id)}
              onMerged={() => void sheet.reload()}
            />
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * One part on the call sheet. The name opens the part's studio (their lines and takes; your own
 * recorder for a part you took). The menu merges a duplicate into another part.
 */
function SheetRow({
  productionId,
  part,
  parts,
  suggestion,
  busy,
  onRecord,
  onMerged,
}: {
  productionId: string;
  part: CallSheetCharacter;
  parts: CallSheetCharacter[];
  suggestion: string | null;
  busy: boolean;
  onRecord: () => void;
  onMerged: () => void;
}) {
  /** The row's ⋯ menu, or one of its forms. */
  const [panel, setPanel] = useState<null | "menu" | "merge" | "unassign">(null);
  const merging = panel !== null;
  const done = part.linesRecorded >= part.lineCount;
  const state = done ? "is-done" : part.takenBy ? "is-taken" : "is-open";
  const shared = part.sharedLines ?? 0;
  return (
    <li className={`sheet-row ${state}${merging ? " is-merging" : ""}`}>
      <div className="sheet-main">
        <div className="sheet-part">
          {part.mine ? (
            <button type="button" className="sheet-name-link" onClick={onRecord} disabled={busy} aria-label={`Open ${part.name}'s studio`}>
              <CharacterName name={part.name} className="sheet-name" />
            </button>
          ) : (
            <Link className="sheet-name-link" to={`/app/p/${productionId}/record?character=${part.id}`} aria-label={`Open ${part.name}'s studio`}>
              <CharacterName name={part.name} className="sheet-name" />
            </Link>
          )}
          <span className={`sheet-who small ${part.takenBy ? "" : "muted"}`}>
            {part.mine ? "You" : (part.takenBy ?? "Not taken yet")}
            {shared > 0 && (
              <span className="sheet-shared" title={`${plural(shared, "line")} said with others`}>
                {" "}
                · <Users size={12} aria-hidden="true" /> {shared} shared
              </span>
            )}
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
        <button
          type="button"
          className="icon-btn sheet-more"
          aria-label={`More for ${part.name}`}
          aria-expanded={merging}
          onClick={() => setPanel((p) => (p ? null : "menu"))}
        >
          <MoreHorizontal size={18} />
        </button>
      </div>
      {panel === "menu" && (
        <div className="sheet-menu" role="menu" aria-label={`${part.name} options`}>
          <button type="button" role="menuitem" className="sheet-menu-item" onClick={() => setPanel("merge")}>
            <Merge size={16} aria-hidden="true" /> Merge into another part…
          </button>
          {part.takenBy && (
            <button type="button" role="menuitem" className="sheet-menu-item" onClick={() => setPanel("unassign")}>
              <UserMinus size={16} aria-hidden="true" /> Unassign {part.mine ? "yourself" : part.takenBy}…
            </button>
          )}
        </div>
      )}
      {panel === "unassign" && (
        <UnassignForm
          productionId={productionId}
          part={part}
          onCancel={() => setPanel(null)}
          onDone={() => {
            setPanel(null);
            onMerged();
          }}
        />
      )}
      {panel === "merge" && (
        <MergeForm
          part={part}
          choices={parts.filter((c) => c.id !== part.id)}
          suggestion={suggestion}
          onCancel={() => setPanel(null)}
          onMerged={() => {
            setPanel(null);
            onMerged();
          }}
        />
      )}
    </li>
  );
}

/**
 * Takes a part away from whoever has it, so someone else can pick it up. What they recorded stays
 * and keeps playing; the new person records the rest, or over it.
 */
function UnassignForm({ productionId, part, onCancel, onDone }: { productionId: string; part: CallSheetCharacter; onCancel: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const who = part.mine ? "You" : part.takenBy;
  const name = titleCase(part.name);
  const unassign = async () => {
    setBusy(true);
    try {
      await castApi.unassign(productionId, part.id);
      toast(`${name} is free for someone else to pick up`);
      onDone();
    } catch (err) {
      toast(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <div className="sheet-merge">
      <p className="small">
        <strong>
          {who} {part.mine ? "stop" : "stops"} playing {name}.
        </strong>{" "}
        {part.linesRecorded > 0
          ? `The ${plural(part.linesRecorded, "line")} already recorded keep playing. Whoever picks up ${name} from the cast link records the other ${plural(Math.max(0, part.lineCount - part.linesRecorded), "line")} and can record over ${part.mine ? "yours" : `${part.takenBy}'s`}.`
          : `Whoever picks up ${name} from the cast link records its ${plural(part.lineCount, "line")}.`}
      </p>
      <div className="row">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void unassign()}>
          <UserMinus size={15} aria-hidden="true" /> {busy ? "Unassigning…" : `Unassign ${part.mine ? "me" : part.takenBy}`}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Merges a duplicate part into another: its lines (and their recordings) move to the one kept. */
function MergeForm({
  part,
  choices,
  suggestion,
  onCancel,
  onMerged,
}: {
  part: CallSheetCharacter;
  choices: CallSheetCharacter[];
  suggestion: string | null;
  onCancel: () => void;
  onMerged: () => void;
}) {
  const toast = useToast();
  const [into, setInto] = useState(suggestion ?? "");
  const [busy, setBusy] = useState(false);
  const target = choices.find((c) => c.id === into);
  const ordered = suggestion ? [...choices].sort((a, b) => Number(b.id === suggestion) - Number(a.id === suggestion)) : choices;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    try {
      await scriptApi.mergeCharacter(part.id, target.id);
      toast(`${titleCase(part.name)} merged into ${titleCase(target.name)}`);
      onMerged();
    } catch (err) {
      toast(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="sheet-merge" onSubmit={submit}>
      <label className="field">
        <span>
          Merge <strong>{part.name}</strong> into
        </span>
        <select className="input" value={into} onChange={(e) => setInto(e.target.value)} autoFocus>
          <option value="" disabled>
            Pick the part to keep…
          </option>
          {ordered.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.id === suggestion ? " (looks like the same part)" : ""}
              {c.takenBy ? ` · ${c.mine ? "you" : c.takenBy}` : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="small muted">
        {plural(part.lineCount, "line")} and {part.lineCount === 1 ? "its recording" : "their recordings"} move to{" "}
        {target ? titleCase(target.name) : "the part you keep"}.
        {part.takenBy && target?.takenBy && part.actorId !== target.actorId
          ? ` ${part.takenBy} won't have this part any more; ${target.takenBy} keeps ${titleCase(target.name)}.`
          : ""}
        {part.takenBy && target && !target.takenBy ? ` ${part.takenBy} takes ${titleCase(target.name)}.` : ""}
      </p>
      <div className="row">
        <button className="btn btn-secondary btn-sm" disabled={!target || busy}>
          <Merge size={15} aria-hidden="true" /> {busy ? "Merging…" : "Merge"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The secondary action: record lines yourself, in the same flow the cast uses. A part you already
 * have opens straight away; otherwise a picker of free parts opens in place.
 */
function RecordYourself({ parts, opening, onRecord }: { parts: CallSheetCharacter[]; opening: string | null; onRecord: (characterId: string) => void }) {
  const mine = parts.filter((c) => c.mine);
  const choices = parts.filter((c) => c.mine || !c.takenBy);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState("");
  const value = choices.some((c) => c.id === picked) ? picked : (choices[0]?.id ?? "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value) onRecord(value);
  };

  if (choices.length === 0) return null;
  if (!picking && mine.length === 1) {
    const part = mine[0]!;
    return (
      <div className="record-yourself">
        <button type="button" className="btn btn-secondary btn-lg" onClick={() => onRecord(part.id)} disabled={opening !== null}>
          <Mic size={18} aria-hidden="true" /> {opening ? "Opening…" : `Record ${part.name}'s lines`}
        </button>
        {choices.length > 1 && (
          <button type="button" className="quiet-link" onClick={() => setPicking(true)}>
            Record another part
          </button>
        )}
      </div>
    );
  }
  if (!picking) {
    return (
      <div className="record-yourself">
        <button type="button" className="btn btn-secondary btn-lg" onClick={() => setPicking(true)}>
          <Mic size={18} aria-hidden="true" /> Record some lines yourself
        </button>
      </div>
    );
  }
  return (
    <form className="record-yourself record-yourself-form" onSubmit={submit}>
      <label className="field grow">
        <span className="sr-only">Part to record</span>
        <select className="input" value={value} onChange={(e) => setPicked(e.target.value)} autoFocus>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {plural(c.lineCount, "line")}
              {c.mine ? " · yours" : ""}
            </option>
          ))}
        </select>
      </label>
      <button className="btn btn-secondary" disabled={!value || opening !== null}>
        <Mic size={16} aria-hidden="true" /> {opening ? "Opening…" : "Record"}
      </button>
    </form>
  );
}

/** The one link for the whole cast: the main way people join. */
type LinkResource = Resource<string>;

function CastLink({ production, link }: { production: Production; link: LinkResource }) {
  const toast = useToast();

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

  return (
    <section className="cast-link raised" aria-labelledby="cast-link-title">
      <h2 id="cast-link-title" className="display cast-link-title">
        Send this to your cast
      </h2>
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
          {link.data && <ResetLink productionId={production.id} onReset={(url) => link.setData(url)} />}
        </>
      )}
    </section>
  );
}

/** A new cast link, for one shared with the wrong people. People already in keep their place. */
function ResetLink({ productionId, onReset }: { productionId: string; onReset: (url: string) => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    setBusy(true);
    try {
      const { joinUrl } = await joinLink.reset(productionId);
      onReset(joinUrl);
      setConfirm(false);
      toast("New cast link made. The old one no longer works.");
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!confirm) {
    return (
      <button type="button" className="quiet-link cast-link-reset" onClick={() => setConfirm(true)}>
        Link shared with the wrong people? Make a new one
      </button>
    );
  }
  return (
    <div className="reset-confirm">
      <p className="small">The old link stops working for anyone who hasn't joined yet. People already in keep their place.</p>
      <div className="row">
        <button type="button" className="btn btn-danger btn-sm" onClick={reset} disabled={busy}>
          Make a new link
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>
          Keep this one
        </button>
      </div>
    </div>
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
