import { Check, ChevronDown, Copy, Headphones, Merge, Mic, MoreHorizontal, Share2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { errorMessage } from "../../api/client";
import { auth, cast as castApi, joinLink, script as scriptApi } from "../../api/director";
import type { CallSheetCharacter, Production } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import { Confetti } from "../../components/Confetti";
import { Dialog } from "../../components/Dialog";
import { EmptyStage } from "../../components/Illustrations";
import { Loading } from "../../components/Loading";
import { ProgressBar } from "../../components/ProgressBar";
import { useToast } from "../../components/Toast";
import { plural, titleCase } from "../../lib/format";
import { castFacingName } from "../../lib/names";
import { recorderDescription, recorderLabel } from "../../lib/recorders";
import { markLinkShared } from "../../lib/linkShared";
import { copyText, shareOrCopy } from "../../lib/share";
import { readStorage, writeStorage } from "../../lib/storage";
import { useInterval, useResource, type Resource } from "../../lib/useResource";
import { useDirector } from "./DirectorLayout";
import { suggestMerges } from "./duplicateCharacters";

/**
 * The director's cast page. Two actions: share the cast link (the main one), and record some lines
 * yourself. Who is recording which part, and what's recorded, fold away below. Parts aren't owned:
 * anyone can record any line, so the call sheet only says who has recorded most of each part.
 */
export function CastTab({ production, onOpenScript, onOpenPlay }: { production: Production; onOpenScript: () => void; onOpenPlay: () => void }) {
  const sheet = useResource(() => castApi.callSheet(production.id), `sheet:${production.id}`);
  const link = useResource(() => joinLink.get(production.id).then((r) => r.joinUrl), `join:${production.id}`);

  useInterval(() => void sheet.reload(), 15_000, !!sheet.data);

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

  const parts = sheet.data.characters;
  if (parts.length === 0) {
    return (
      <div className="empty-state">
        <EmptyStage />
        <h2 className="display">The cast list comes from the script</h2>
        <p className="muted">Once your script is read, every character shows up here, ready for the cast to pick.</p>
        <button type="button" className="btn btn-primary" onClick={onOpenScript}>
          {production.scriptStatus === "parsing" ? "See how the script is going" : "Add the script"}
        </button>
      </div>
    );
  }

  // The script's own count, so it matches the script page and the production card (a shared line is
  // under every part that says it, so the parts add up to more).
  const { total: linesTotal, recorded: linesRecorded } = sheet.data.lines;
  const started = parts.filter((c) => c.linesRecorded > 0).length;
  const wrapped = parts.every((c) => c.linesRecorded >= c.lineCount);
  const mine = parts.filter((c) => c.mine);
  // Parts under way first, then the rest; each group biggest first, as the server sends them.
  const others = [...parts.filter((c) => !c.mine && c.linesRecorded > 0), ...parts.filter((c) => !c.mine && c.linesRecorded === 0)];
  // Likely duplicates ("ISABEL" and "ISABELLA (ASIDE)"), offered first when merging.
  const suggested = new Map(
    suggestMerges(parts.map((c) => ({ id: c.id, name: c.name, aliases: [], lineCount: c.lineCount }))).map((m) => [m.from.id, m.into.id]),
  );
  const rows = (list: CallSheetCharacter[], label: string) => (
    <ul className="sheet-list" aria-label={label}>
      {list.map((c) => (
        <SheetRow
          key={c.id}
          productionId={production.id}
          part={c}
          parts={parts}
          suggestion={suggested.get(c.id) ?? null}
          onMerged={() => void sheet.reload()}
        />
      ))}
    </ul>
  );

  return (
    <div className="cast">
      <section className="cast-actions" aria-label="Get the lines recorded">
        <CastLink production={production} link={link} />
        {/* An admin's view is read only: recording, the name prompt and resetting the link are the director's. */}
        {production.access !== "admin" && <RecordYourself productionId={production.id} parts={parts} />}
      </section>

      {wrapped && <WrapBanner productionId={production.id} onListen={onOpenPlay} />}

      <details className="call-sheet">
        <summary>
          <span className="call-sheet-summary">
            <span className="call-sheet-title">Cast and recordings</span>
            <span className="small muted">
              {linesRecorded.toLocaleString("en-US")} of {plural(linesTotal, "line")} recorded · {started} of {plural(parts.length, "part")} started
            </span>
          </span>
          <ChevronDown size={18} aria-hidden="true" className="call-sheet-chevron" />
        </summary>
        <ProgressBar value={linesRecorded} max={linesTotal} label="Lines recorded across the cast" />
        {linesRecorded > 0 && !wrapped && (
          <button type="button" className="btn btn-ghost btn-sm call-sheet-listen" onClick={onOpenPlay}>
            <Headphones size={16} aria-hidden="true" /> Listen through what's recorded so far
          </button>
        )}
        {mine.length > 0 ? (
          <>
            <h3 className="eyebrow sheet-group">My roles</h3>
            {rows(mine, "My roles")}
            {others.length > 0 && (
              <>
                <h3 className="eyebrow sheet-group">Everyone else's</h3>
                {rows(others, "Everyone else's parts")}
              </>
            )}
          </>
        ) : (
          rows(others, "Parts")
        )}
      </details>
    </div>
  );
}

/**
 * One part on the call sheet: its name opens the part's studio (every line, with its takes to play,
 * delete or record over), then who recorded most of it, then progress. The menu merges a duplicate.
 */
function SheetRow({
  productionId,
  part,
  parts,
  suggestion,
  onMerged,
}: {
  productionId: string;
  part: CallSheetCharacter;
  parts: CallSheetCharacter[];
  suggestion: string | null;
  onMerged: () => void;
}) {
  /** The row's ⋯ menu, or its merge form. */
  const [panel, setPanel] = useState<null | "menu" | "merge">(null);
  const open = panel !== null;
  const done = part.linesRecorded >= part.lineCount;
  const by = recorderLabel(part.topRecorder);
  return (
    <li className={`sheet-row ${done ? "is-done" : by ? "is-started" : "is-open"}${open ? " is-merging" : ""}`}>
      <div className="sheet-main">
        <div className="sheet-part">
          <Link className="sheet-name-link" to={`/app/p/${productionId}/record?character=${part.id}`} aria-label={`Open ${part.name}'s studio`}>
            <CharacterName name={part.name} className="sheet-name" />
          </Link>
          <span className={`sheet-who small ${by ? "" : "is-none"}`} aria-label={recorderDescription(part.topRecorder)}>
            {by ?? "Not taken yet"}
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
        <button
          type="button"
          className="icon-btn sheet-more"
          aria-label={`More for ${part.name}`}
          aria-expanded={open}
          onClick={() => setPanel((p) => (p ? null : "menu"))}
        >
          <MoreHorizontal size={18} />
        </button>
      </div>
      {panel === "menu" && (
        <div className="sheet-menu">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPanel("merge")}>
            <Merge size={16} aria-hidden="true" /> Merge into another part…
          </button>
        </div>
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
              {c.topRecorder ? ` · ${recorderLabel(c.topRecorder)}` : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="small muted">
        {plural(part.lineCount, "line")} and {part.lineCount === 1 ? "its recording" : "their recordings"} move to{" "}
        {target ? titleCase(target.name) : "the part you keep"}. Whoever picked {titleCase(part.name)} has {target ? titleCase(target.name) : "that part"} now.
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
 * The secondary action: record lines yourself. The button opens a part picker in place; picking a
 * part opens its studio, where you record any of its lines. Your roles come first.
 */
function RecordYourself({ productionId, parts }: { productionId: string; parts: CallSheetCharacter[] }) {
  const [open, setOpen] = useState(false);
  const ordered = [...parts.filter((c) => c.mine), ...parts.filter((c) => !c.mine)];
  return (
    <div className={`record-yourself${open ? " is-open" : ""}`}>
      <button type="button" className="btn btn-secondary btn-lg" aria-expanded={open} aria-controls="record-yourself-parts" onClick={() => setOpen((o) => !o)}>
        <Mic size={18} aria-hidden="true" /> Record some lines yourself
        <ChevronDown size={18} aria-hidden="true" className="record-yourself-chevron" />
      </button>
      {open && (
        <div className="record-picker" id="record-yourself-parts">
          <p className="small muted">Pick a part to record. Your take plays until someone records over it.</p>
          <ul className="record-picker-list" aria-label="Parts to record">
            {ordered.map((c) => {
              const by = recorderLabel(c.topRecorder);
              return (
                <li key={c.id}>
                  <Link className="record-picker-part" to={`/app/p/${productionId}/record?character=${c.id}`}>
                    <CharacterName name={c.name} className="record-picker-name" />
                    <span className="small muted nums">
                      {plural(c.lineCount, "line")}
                      {c.mine ? " · yours" : by ? ` · ${by}` : ""}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
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
    if (outcome === "shared" || outcome === "copied") markLinkShared(production.id);
    if (outcome === "copied") toast("Message and link copied. Paste it in the cast chat.");
    if (outcome === "failed") toast("Couldn't copy. Select the link and copy it by hand.");
  };
  const copy = async () => {
    const ok = await copyText(link.data!);
    if (ok) markLinkShared(production.id);
    toast(ok ? "Link copied" : "Couldn't copy");
  };

  return (
    <section className="cast-link raised" aria-labelledby="cast-link-title">
      <div className="stack" style={{ gap: 4 }}>
        <h2 id="cast-link-title" className="display cast-link-title">
          Invite your cast
        </h2>
        <p className="muted">Send one link. Everyone picks their part and records their lines on their phone.</p>
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
            <button type="button" className="icon-btn link-ticket-copy" disabled={!link.data} aria-label="Copy the cast link" onClick={() => void copy()}>
              <Copy size={18} />
            </button>
          </div>
          <button type="button" className="btn btn-primary btn-lg cast-link-share" onClick={share} disabled={!link.data}>
            <Share2 size={18} aria-hidden="true" /> Share link with your cast
          </button>
          {production.access !== "admin" && <NamePrompt />}
          {link.data && production.access !== "admin" && <ResetLink productionId={production.id} onReset={(url) => link.setData(url)} />}
        </>
      )}
    </section>
  );
}

/**
 * Until a director sets their name, the cast sees the start of their email. The cast page says so in
 * one line under the share button, with a way to change it, until it's set or dismissed.
 */
function NamePrompt() {
  const { user, setUser } = useDirector();
  const toast = useToast();
  const key = `offbooked.namePrompt.${user.id}`;
  const [dismissed, setDismissed] = useState(() => readStorage(key) === "dismissed");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallback = castFacingName(null, user.email);
  if (user.name?.trim() || dismissed) return null;

  const dismiss = () => {
    writeStorage(key, "dismissed");
    setDismissed(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { user: updated } = await auth.updateMe(name.trim());
      setUser(updated);
      toast(`Your cast will see “${updated.name}”`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  // One quiet line under the share button, so inviting stays the first thing on the page.
  if (!editing) {
    return (
      <p className="name-line small">
        <span className="grow">
          Your cast will see “{fallback}”.{" "}
          <button type="button" className="link-btn" onClick={() => setEditing(true)}>
            Change it
          </button>
        </span>
        <button type="button" className="icon-btn name-line-close" onClick={dismiss} aria-label={`Keep “${fallback}”`} title="Keep it">
          <X size={16} />
        </button>
      </p>
    );
  }
  return (
    <form className="name-line name-line-form" onSubmit={save}>
      <label htmlFor="name-prompt-input" className="sr-only">
        Your name, as your cast will see it
      </label>
      <input
        id="name-prompt-input"
        className="input"
        value={name}
        maxLength={100}
        autoComplete="name"
        placeholder="Your name"
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <button className="btn btn-secondary" disabled={busy || !name.trim()}>
        {busy ? "Saving…" : "Save"}
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} disabled={busy}>
        Cancel
      </button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
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

  return (
    <>
      <button type="button" className="quiet-link cast-link-reset" onClick={() => setConfirm(true)}>
        Link shared with the wrong people? Make a new one
      </button>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Make a new cast link?" variant="confirm">
        <div className="stack">
          <p>The old link stops working for anyone who hasn't joined yet. People already in keep their place.</p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-danger" onClick={() => void reset()} disabled={busy}>
              {busy ? "Making a new link…" : "Make a new link"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirm(false)} disabled={busy} autoFocus>
              Keep this one
            </button>
          </div>
        </div>
      </Dialog>
    </>
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
        <p>Every line is in. Take a bow, then have a listen.</p>
      </div>
      <button type="button" className="btn btn-primary" onClick={onListen}>
        <Headphones size={18} aria-hidden="true" /> Listen through the play
      </button>
    </section>
  );
}
