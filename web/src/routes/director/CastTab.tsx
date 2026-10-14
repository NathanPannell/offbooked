import { BellRing, Copy, Headphones, Link2, Pencil, RotateCcw, Share2, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { errorMessage } from "../../api/client";
import { cast as castApi, script as scriptApi } from "../../api/director";
import type { CastMember, Character, Production } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import { Dialog } from "../../components/Dialog";
import { Loading } from "../../components/Loading";
import { ProgressBar } from "../../components/ProgressBar";
import { useToast } from "../../components/Toast";
import { firstWord, joinNames, plural, relativeTime } from "../../lib/format";
import { copyText, shareOrCopy, type ShareOutcome } from "../../lib/share";
import { useInterval, useResource } from "../../lib/useResource";
import { ActorForm } from "./ActorForm";
import { MergeSuggestions } from "./MergeSuggestions";

const STATUS_LABEL: Record<CastMember["status"], string> = {
  not_opened: "Not opened",
  opened: "Opened",
  in_progress: "In progress",
  done: "Done",
};

const STATUS_CLASS: Record<CastMember["status"], string> = {
  not_opened: "",
  opened: "chip-accent",
  in_progress: "chip-check",
  done: "chip-good",
};

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
  const data = useResource(
    () => Promise.all([castApi.list(production.id), scriptApi.get(production.id)]),
    production.id,
  );
  const [form, setForm] = useState<{ member?: CastMember; characterIds: string[] } | null>(null);
  const [resetting, setResetting] = useState<CastMember | null>(null);
  const [merging, setMerging] = useState(false);

  useInterval(() => void data.reload(), 15_000, !!data.data);

  const characters = useMemo(() => new Map((data.data?.[1].characters ?? []).map((c) => [c.id, c])), [data.data]);

  if (data.loading) return <Loading />;
  if (data.error || !data.data) {
    return (
      <div className="notice notice-error" role="alert">
        {errorMessage(data.error)}
      </div>
    );
  }
  const [{ cast, uncastCharacterIds }, script] = data.data;

  if (script.status !== "ready") {
    return (
      <div className="card empty stack">
        <h2>Add the script first</h2>
        <p>Once it's read, the characters show up here, ready to cast.</p>
        <button type="button" className="btn btn-primary" onClick={onOpenScript}>
          Go to the script
        </button>
      </div>
    );
  }

  const roleNames = (m: CastMember) => joinNames(m.characterIds.map((id) => characters.get(id)?.name ?? "?"));
  const uncast = uncastCharacterIds.map((id) => characters.get(id)).filter((c): c is Character => !!c);
  const linesTotal = cast.reduce((n, m) => n + m.linesTotal, 0);
  const linesRecorded = cast.reduce((n, m) => n + m.linesRecorded, 0);
  const done = cast.filter((m) => m.status === "done").length;

  const report = (outcome: ShareOutcome) => {
    if (outcome === "copied") toast("Message and link copied");
    if (outcome === "failed") toast("Couldn't share or copy. Copy the link by hand.");
  };

  const inviteMessage = (m: CastMember) => ({
    title: `${production.title}: your lines`,
    text: `Hi ${firstWord(m.firstName || m.name)}! You're ${roleNames(m)} in ${production.title}. Record your lines on your phone here. It takes about ${minutesFor(m.linesTotal)} minutes, with no app or account:`,
    url: m.inviteUrl,
  });

  const share = async (m: CastMember) => report(await shareOrCopy(inviteMessage(m)));

  const nudge = async (m: CastMember) => {
    const left = m.linesTotal - m.linesRecorded;
    const who = firstWord(m.firstName || m.name);
    const text =
      m.status === "not_opened"
        ? `Hi ${who}, a quick reminder: your ${plural(m.linesTotal, "line")} for ${roleNames(m)} in ${production.title} are waiting. It only takes a few minutes:`
        : `Hi ${who}, you've got ${plural(left, "line")} left for ${roleNames(m)} in ${production.title}. Pick up where you left off:`;
    const outcome = await shareOrCopy({ title: production.title, text, url: m.inviteUrl });
    report(outcome);
    if (outcome === "shared" || outcome === "copied") {
      castApi.nudged(m.id).then(() => data.reload(), () => {});
    }
  };

  const copyAll = async () => {
    const lines = cast.map((m) => `${m.name} (${roleNames(m)}): ${m.inviteUrl}`);
    const text = `${production.title}: your Offbooked links. Tap yours to record your lines.\n\n${lines.join("\n")}`;
    toast((await copyText(text)) ? `Copied ${plural(cast.length, "link")} for the group chat` : "Couldn't copy");
  };

  const merge = async (from: Character, into: Character) => {
    setMerging(true);
    try {
      await scriptApi.mergeCharacter(from.id, into.id);
      toast(`Merged ${from.name} into ${into.name}`);
      data.reload();
      return true;
    } catch (err) {
      toast(errorMessage(err));
      return false;
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="stack cast">
      <MergeSuggestions productionId={production.id} characters={script.characters} busy={merging} onMerge={merge} />
      <div className="card overview">
        <div className="stack" style={{ gap: 8 }}>
          <div className="spread">
            <h2>Progress</h2>
            <span className="small muted">
              {done}/{cast.length} actors done
            </span>
          </div>
          <ProgressBar value={linesRecorded} max={linesTotal} label="Lines recorded across the cast" />
          <p className="small muted">
            {linesRecorded} of {plural(linesTotal, "cast line")} recorded
            {uncast.length > 0 && ` · ${plural(uncast.length, "character")} not cast yet`}
          </p>
        </div>
        <div className="row">
          {cast.length > 0 && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={copyAll}>
              <Copy size={16} aria-hidden="true" /> Copy all links
            </button>
          )}
          {linesRecorded > 0 && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenPlay}>
              <Headphones size={16} aria-hidden="true" /> Listen to the run-through
            </button>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setForm({ characterIds: [] })}>
            <UserPlus size={16} aria-hidden="true" /> Add actor
          </button>
        </div>
      </div>

      {cast.length > 0 && (
        <ul className="actor-list" aria-label="Cast">
          {cast.map((m) => (
            <li key={m.id} className="card actor-card">
              <div className="spread">
                <div className="stack" style={{ gap: 2 }}>
                  <h3>{m.name}</h3>
                  <p className="small">
                    {m.characterIds.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ", "}
                        <CharacterName name={characters.get(id)?.name ?? "?"} />
                      </span>
                    ))}
                  </p>
                </div>
                <span className={`chip ${STATUS_CLASS[m.status]}`}>{STATUS_LABEL[m.status]}</span>
              </div>
              <ProgressBar value={m.linesRecorded} max={m.linesTotal} label={`${m.name}'s lines recorded`} />
              <dl className="actor-stats small">
                <div>
                  <dt>Lines</dt>
                  <dd>
                    {m.linesRecorded}/{m.linesTotal}
                  </dd>
                </div>
                <div>
                  <dt>Last active</dt>
                  <dd>{relativeTime(m.lastActiveAt)}</dd>
                </div>
                <div>
                  <dt>Accuracy</dt>
                  <dd>{m.avgAccuracy === null ? "–" : `${Math.round(m.avgAccuracy * 100)}%`}</dd>
                </div>
                {m.nudgedAt && (
                  <div>
                    <dt>Nudged</dt>
                    <dd>{relativeTime(m.nudgedAt)}</dd>
                  </div>
                )}
              </dl>
              <div className="row actor-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => share(m)}>
                  <Share2 size={16} aria-hidden="true" /> Share link
                </button>
                {m.status !== "done" && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => nudge(m)}>
                    <BellRing size={16} aria-hidden="true" /> Nudge
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Copy ${m.name}'s link`}
                  title="Copy link"
                  onClick={async () => toast((await copyText(m.inviteUrl)) ? "Link copied" : "Couldn't copy")}
                >
                  <Link2 size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Edit ${m.name}`}
                  title="Edit"
                  onClick={() => setForm({ member: m, characterIds: m.characterIds })}
                >
                  <Pencil size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Reset ${m.name}'s link`}
                  title="Reset link"
                  onClick={() => setResetting(m)}
                >
                  <RotateCcw size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {uncast.length > 0 && (
        <section className="stack" style={{ gap: 10 }}>
          <h2>Not cast yet</h2>
          <p className="small muted">
            Leave walk-ons uncast if you like: their lines play as “not yet recorded” in the run-through.
          </p>
          <ul className="uncast-list">
            {uncast.map((c) => (
              <li key={c.id} className="uncast-row">
                <div className="grow">
                  <CharacterName name={c.name} /> <span className="small muted">· {plural(c.lineCount, "line")}</span>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setForm({ characterIds: [c.id] })}>
                  Cast
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Dialog open={!!form} onClose={() => setForm(null)} title={form?.member ? `Edit ${form.member.name}` : "Add an actor"}>
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
              if (created) {
                toast(`${member.name} added. Share their link when you're ready.`);
              }
            }}
          />
        )}
      </Dialog>

      <Dialog open={!!resetting} onClose={() => setResetting(null)} title="Reset link">
        {resetting && (
          <ResetLink
            member={resetting}
            onReset={async () => {
              const { member } = await castApi.resetLink(resetting.id);
              setResetting(member);
              await data.reload();
              return member;
            }}
            onShare={(m) => share(m)}
          />
        )}
      </Dialog>
    </div>
  );
}

function ResetLink({
  member,
  onReset,
  onShare,
}: {
  member: CastMember;
  onReset: () => Promise<CastMember>;
  onShare: (m: CastMember) => void;
}) {
  const [state, setState] = useState<"confirm" | "busy" | "done">("confirm");
  const [error, setError] = useState<string | null>(null);
  if (state === "done") {
    return (
      <div className="stack">
        <p>{member.name}'s old link no longer works. Send them the new one.</p>
        <p className="link-box">{member.inviteUrl}</p>
        <button type="button" className="btn btn-primary" onClick={() => onShare(member)}>
          <Share2 size={18} aria-hidden="true" /> Share new link
        </button>
      </div>
    );
  }
  return (
    <div className="stack">
      <p>
        This makes a new link for {member.name} and turns the old one off. Their recordings stay. Use it if the link went
        to the wrong person.
      </p>
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
