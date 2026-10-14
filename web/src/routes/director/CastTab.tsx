import { BellRing, Copy, Headphones, Link2, Mic, MoreHorizontal, Pencil, RotateCcw, Share2, UserPlus } from "lucide-react";
import { useMemo, useState, type MouseEvent } from "react";
import { Link } from "react-router";
import { errorMessage } from "../../api/client";
import { cast as castApi, joinLink, script as scriptApi } from "../../api/director";
import type { CastMember, Character, Production } from "../../api/types";
import { Avatar } from "../../components/Avatar";
import { CharacterName } from "../../components/CharacterName";
import { Confetti } from "../../components/Confetti";
import { Dialog } from "../../components/Dialog";
import { EmptyStage } from "../../components/Illustrations";
import { Loading } from "../../components/Loading";
import { ProgressBar } from "../../components/ProgressBar";
import { useToast } from "../../components/Toast";
import { firstWord, joinNames, plural, relativeTime } from "../../lib/format";
import { copyText, shareOrCopy, type ShareOutcome } from "../../lib/share";
import { readStorage, writeStorage } from "../../lib/storage";
import { useInterval, useResource } from "../../lib/useResource";
import { ActorForm } from "./ActorForm";
import { MergeSuggestions } from "./MergeSuggestions";

function minutesFor(lines: number): number {
  return Math.max(2, Math.ceil((lines * 12) / 60));
}

export function CastTab({
  production,
  onOpenScript,
  onOpenPlay,
}: {
  production: Production;
  onOpenScript: () => void;
  onOpenPlay: () => void;
}) {
  const toast = useToast();
  const data = useResource(() => Promise.all([castApi.list(production.id), scriptApi.get(production.id)]), production.id);
  const [form, setForm] = useState<{ member?: CastMember; characterIds: string[] } | null>(null);
  const [resetting, setResetting] = useState<CastMember | null>(null);
  const [merging, setMerging] = useState(false);

  useInterval(() => void data.reload(), 15_000, !!data.data);

  const characters = useMemo(() => new Map((data.data?.[1].characters ?? []).map((c) => [c.id, c])), [data.data]);

  if (data.loading) return <Loading />;
  if (data.error || !data.data) {
    return (
      <div className="notice notice-error" role="alert">
        {errorMessage(data.error)}{" "}
        <button className="link-btn" onClick={() => void data.reload()}>
          Try again
        </button>
      </div>
    );
  }
  const [{ cast, uncastCharacterIds }, script] = data.data;

  if (script.status !== "ready") {
    return (
      <div className="empty-state">
        <EmptyStage />
        <h2 className="display">The cast list comes from the script</h2>
        <p className="muted">Once your script is read, every character shows up here, ready for the cast to claim.</p>
        <button type="button" className="btn btn-primary" onClick={onOpenScript}>
          {script.status === "parsing" ? "See how the script is going" : "Add the script"}
        </button>
      </div>
    );
  }

  const roleNames = (m: CastMember) => joinNames(m.characterIds.map((id) => characters.get(id)?.name ?? "?"));
  const uncast = uncastCharacterIds
    .map((id) => characters.get(id))
    .filter((c): c is Character => !!c && c.lineCount > 0)
    .sort((a, b) => b.lineCount - a.lineCount);
  const linesTotal = cast.reduce((n, m) => n + m.linesTotal, 0);
  const linesRecorded = cast.reduce((n, m) => n + m.linesRecorded, 0);
  const wrapped = cast.length > 0 && cast.every((m) => m.status === "done") && uncast.length === 0;

  const report = (outcome: ShareOutcome) => {
    if (outcome === "copied") toast("Message and link copied");
    if (outcome === "failed") toast("Couldn't share or copy. Copy the link by hand.");
  };

  const shareMember = async (m: CastMember) =>
    report(
      await shareOrCopy({
        title: `${production.title}: your lines`,
        text: `Hi ${firstWord(m.firstName || m.name)}! You're ${roleNames(m)} in ${production.title}. Record your lines here. It takes about ${minutesFor(m.linesTotal)} minutes, with no app or account:`,
        url: m.inviteUrl,
      }),
    );

  const nudge = async (m: CastMember) => {
    const left = m.linesTotal - m.linesRecorded;
    const who = firstWord(m.firstName || m.name);
    const text =
      m.status === "not_opened"
        ? `Hi ${who}, a quick reminder: your ${plural(m.linesTotal, "line")} for ${roleNames(m)} in ${production.title} are waiting. It only takes a few minutes:`
        : `Hi ${who}, you've got ${plural(left, "line")} left for ${roleNames(m)} in ${production.title}. Pick up where you left off:`;
    const outcome = await shareOrCopy({ title: production.title, text, url: m.inviteUrl });
    report(outcome);
    if (outcome === "shared" || outcome === "copied") castApi.nudged(m.id).then(() => data.reload(), () => {});
  };

  const merge = async (from: Character, into: Character) => {
    setMerging(true);
    try {
      await scriptApi.mergeCharacter(from.id, into.id);
      toast(`Merged ${from.name} into ${into.name}`);
      void data.reload();
      return true;
    } catch (err) {
      toast(errorMessage(err));
      return false;
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="cast">
      <CastLink production={production} castCount={cast.length} />

      <MergeSuggestions productionId={production.id} characters={script.characters} busy={merging} onMerge={merge} />

      {wrapped && <WrapBanner productionId={production.id} onListen={onOpenPlay} />}

      <section className="call-sheet" aria-labelledby="call-sheet-title">
        <header className="call-sheet-head">
          <div>
            <p className="eyebrow">Call sheet</p>
            <h2 id="call-sheet-title" className="display">
              {cast.length === 0 ? "Nobody's joined yet" : `${linesRecorded.toLocaleString()} of ${plural(linesTotal, "line")} recorded`}
            </h2>
          </div>
          {linesRecorded > 0 && !wrapped && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenPlay}>
              <Headphones size={16} aria-hidden="true" /> Listen so far
            </button>
          )}
        </header>
        {cast.length > 0 && <ProgressBar value={linesRecorded} max={linesTotal} label="Lines recorded across the cast" />}

        {cast.length === 0 ? (
          <p className="muted call-sheet-empty">
            When someone opens the cast link and picks a part, they show up here, and you can watch their lines come in.
          </p>
        ) : (
          <ul className="actor-list" aria-label="Cast">
            {cast.map((m) => (
              <li key={m.id} className={`actor-row status-${m.status}`}>
                <Avatar name={m.firstName || m.name} />
                <div className="actor-main">
                  <p className="actor-name">
                    {m.firstName || m.name}
                    {m.status === "done" && <span className="stamp">Wrapped!</span>}
                  </p>
                  <p className="actor-roles small">
                    {m.characterIds.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ", "}
                        <CharacterName name={characters.get(id)?.name ?? "?"} />
                      </span>
                    ))}
                  </p>
                  {m.status !== "done" && (
                    <div className="actor-progress">
                      <ProgressBar value={m.linesRecorded} max={m.linesTotal} label={`${m.name}'s lines recorded`} />
                      <span className="mono nums">
                        {m.linesRecorded}/{m.linesTotal}
                      </span>
                    </div>
                  )}
                  <p className="actor-meta small muted">
                    {m.status === "not_opened" ? "Hasn't opened their link" : `Active ${relativeTime(m.lastActiveAt).toLowerCase()}`}
                    {m.avgAccuracy !== null && ` · ${Math.round(m.avgAccuracy * 100)}% word-perfect`}
                    {m.nudgedAt && ` · nudged ${relativeTime(m.nudgedAt).toLowerCase()}`}
                  </p>
                </div>
                <div className="actor-actions">
                  {m.status !== "done" && (
                    <button type="button" className="btn btn-secondary btn-sm nudge-btn" onClick={() => nudge(m)} aria-label={`Nudge ${m.firstName || m.name}`}>
                      <BellRing size={15} aria-hidden="true" /> <span className="hide-sm">Nudge</span>
                    </button>
                  )}
                  <details className="menu">
                    <summary className="icon-btn" aria-label={`More for ${m.name}`}>
                      <MoreHorizontal size={20} />
                    </summary>
                    <div className="menu-items" role="menu">
                      <button type="button" role="menuitem" onClick={(e) => (closeMenu(e), void shareMember(m))}>
                        <Share2 size={16} aria-hidden="true" /> Share their own link
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={async (e) => {
                          closeMenu(e);
                          toast((await copyText(m.inviteUrl)) ? "Link copied" : "Couldn't copy");
                        }}
                      >
                        <Link2 size={16} aria-hidden="true" /> Copy their link
                      </button>
                      <button type="button" role="menuitem" onClick={(e) => (closeMenu(e), setForm({ member: m, characterIds: m.characterIds }))}>
                        <Pencil size={16} aria-hidden="true" /> Edit name or parts
                      </button>
                      <button type="button" role="menuitem" onClick={(e) => (closeMenu(e), setResetting(m))}>
                        <RotateCcw size={16} aria-hidden="true" /> Reset their link
                      </button>
                    </div>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {uncast.length > 0 && (
        <section className="open-roles" aria-labelledby="open-roles-title">
          <div className="spread">
            <div>
              <p className="eyebrow">Open roles</p>
              <h2 id="open-roles-title" className="display">
                {plural(uncast.length, "part")} still free
              </h2>
            </div>
            <Link className="btn btn-secondary btn-sm" to={`/app/p/${production.id}/record`}>
              <Mic size={15} aria-hidden="true" /> Read some yourself
            </Link>
          </div>
          <p className="small muted">
            Until someone records them, these lines play in a computer voice in the run-through. Anyone can still claim them
            through the cast link.
          </p>
          <ul className="role-list">
            {uncast.map((c) => (
              <li key={c.id} className="role-row">
                <CharacterName name={c.name} />
                <span className="small muted nums">{plural(c.lineCount, "line")}</span>
                <span className="grow" />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm({ characterIds: [c.id] })}>
                  Assign
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="cast-footer">
        <button type="button" className="quiet-link" onClick={() => setForm({ characterIds: [] })}>
          <UserPlus size={14} aria-hidden="true" /> Add someone by hand
        </button>
        <Link className="quiet-link" to={`/app/p/${production.id}/record`}>
          <Mic size={14} aria-hidden="true" /> Record stand-in lines
        </Link>
      </div>

      <Dialog open={!!form} onClose={() => setForm(null)} title={form?.member ? `Edit ${form.member.name}` : "Add someone"}>
        {form && (
          <ActorForm
            productionId={production.id}
            member={form.member}
            initialCharacterIds={form.characterIds}
            characters={[...characters.values()]}
            castMembers={cast}
            onSaved={async (member, created) => {
              setForm(null);
              await data.reload();
              if (created) toast(`${member.name} added. Share their link from the call sheet.`);
            }}
          />
        )}
      </Dialog>

      <Dialog open={!!resetting} onClose={() => setResetting(null)} title="Reset their link">
        {resetting && (
          <ResetLink
            member={resetting}
            onReset={async () => {
              const { member } = await castApi.resetLink(resetting.id);
              setResetting(member);
              await data.reload();
              return member;
            }}
            onShare={(m) => void shareMember(m)}
          />
        )}
      </Dialog>
    </div>
  );
}

function closeMenu(e: MouseEvent) {
  (e.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
}

/** The one link for the whole cast: the main way people join. */
function CastLink({ production, castCount }: { production: Production; castCount: number }) {
  const toast = useToast();
  const link = useResource(() => joinLink.get(production.id).then((r) => r.joinUrl), `join:${production.id}`);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);

  const message = {
    title: `${production.title}: record your lines`,
    text: `Hi all! Record your lines for ${production.title} here. Pick your character and go: it takes a few minutes on your phone, with no app or account.`,
  };

  const share = async () => {
    if (!link.data) return;
    const outcome = await shareOrCopy({ ...message, url: link.data });
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
    <section className="cast-link sticker" aria-labelledby="cast-link-title">
      <div className="cast-link-copy">
        <p className="eyebrow">{castCount === 0 ? "Step 2 · Invite your cast" : "Cast link"}</p>
        <h2 id="cast-link-title" className="display">
          One link for the whole cast
        </h2>
        <p className="muted">
          Drop it in the group chat. Each person picks their character, types their first name and starts recording. No accounts.
        </p>
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
          </div>
          <div className="row cast-link-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={share} disabled={!link.data}>
              <Share2 size={18} aria-hidden="true" /> Share the cast link
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!link.data}
              onClick={async () => toast((await copyText(link.data!)) ? "Link copied" : "Couldn't copy")}
            >
              <Copy size={16} aria-hidden="true" /> Copy
            </button>
          </div>
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
            <button type="button" className="quiet-link" style={{ alignSelf: "flex-start" }} onClick={() => setConfirmReset(true)}>
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
        🎭
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

function ResetLink({ member, onReset, onShare }: { member: CastMember; onReset: () => Promise<CastMember>; onShare: (m: CastMember) => void }) {
  const [state, setState] = useState<"confirm" | "busy" | "done">("confirm");
  const [error, setError] = useState<string | null>(null);
  if (state === "done") {
    return (
      <div className="stack">
        <p>{member.name}'s old link no longer works. Send them the new one.</p>
        <p className="link-box mono">{member.inviteUrl}</p>
        <button type="button" className="btn btn-primary" onClick={() => onShare(member)}>
          <Share2 size={18} aria-hidden="true" /> Share new link
        </button>
      </div>
    );
  }
  return (
    <div className="stack">
      <p>This makes a new personal link for {member.name} and turns the old one off. Their recordings stay. Use it if their link went to the wrong person.</p>
      {error && <p className="field-error">{error}</p>}
      <button
        type="button"
        className="btn btn-danger"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          try {
            await onReset();
            setState("done");
          } catch (err) {
            setError(errorMessage(err));
            setState("confirm");
          }
        }}
      >
        Reset link
      </button>
    </div>
  );
}
