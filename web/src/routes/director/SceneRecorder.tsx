import { ArrowLeft, Headphones } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError, errorMessage } from "../../api/client";
import { productions, script as scriptApi, standins } from "../../api/director";
import type { ActorLine, AudioSource, SectionLine } from "../../api/types";
import { usePlayback, useTakeRecorder } from "../../audio/useTakeRecorder";
import { CharacterName } from "../../components/CharacterName";
import { Loading } from "../../components/Loading";
import { RecordDock } from "../../components/RecordDock";
import { useToast } from "../../components/Toast";
import { plural } from "../../lib/format";
import { useResource } from "../../lib/useResource";
import { latestForLine } from "../../upload/queue";
import { useUploads } from "../../upload/useUploads";
import { LineCard, type LocalTake } from "../actor/LineCard";

const VOICE_LABEL: Record<AudioSource, string> = {
  actor: "Cast take",
  standin: "Stand-in",
  tts: "TTS voice",
  none: "Silent",
};

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** The director records stand-in lines, scene by scene and partner by partner. */
export default function SceneRecorder() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const base = useResource(() => Promise.all([productions.get(id), scriptApi.get(id)]), `scene:${id}`);
  const sections = useMemo(() => [...(base.data?.[1].sections ?? [])].sort((a, b) => a.seq - b.seq), [base.data]);
  const sectionId = params.get("section") ?? sections[0]?.id ?? "";

  if (base.loading) return <Loading />;
  if (base.error || !base.data) {
    return (
      <main className="page">
        <div className="notice notice-error" role="alert">
          {errorMessage(base.error)} <Link to={`/app/p/${id}`}>Back to the production</Link>
        </div>
      </main>
    );
  }
  const [{ production }] = base.data;

  return (
    <div className="scene-recorder">
      <div className="page scene-head">
        <Link className="back-link" to={`/app/p/${id}?tab=cast`}>
          <ArrowLeft size={16} aria-hidden="true" /> {production.title}
        </Link>
        <div className="spread scene-title-row">
          <div>
            <p className="eyebrow">Stand-ins</p>
            <h1 className="display">Read in for your cast</h1>
          </div>
          <Link className="btn btn-ghost btn-sm" to={`/app/p/${id}?tab=play`}>
            <Headphones size={16} aria-hidden="true" /> Run-through
          </Link>
        </div>
        <p className="muted">
          Every line starts in a computer voice. Record any of them here and your take plays instead, until the actor records their
          own.
        </p>
        <label className="field scene-picker">
          <span>Scene</span>
          <select className="input" value={sectionId} onChange={(e) => setParams({ section: e.target.value }, { replace: true })}>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {sectionId ? (
        <SceneLines key={sectionId} productionId={id} sectionId={sectionId} onError={toast} />
      ) : (
        <p className="page muted">This script has no scenes yet.</p>
      )}
    </div>
  );
}

function SceneLines({ productionId, sectionId, onError }: { productionId: string; sectionId: string; onError: (m: string) => void }) {
  const data = useResource(() => standins.sectionLines(productionId, sectionId), `${productionId}:${sectionId}`);
  const setData = data.setData;
  const { uploader, items } = useUploads();
  const playback = usePlayback(() => onError("Couldn't play that. Try again."));
  const [who, setWho] = useState<string>("all");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [localTakes, setLocalTakes] = useState(new Map<string, LocalTake>());
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const stopRef = useRef<() => void>(() => {});
  const recorder = useTakeRecorder({
    onLimit: () => {
      onError("That's the 2 minute limit, so we stopped there.");
      stopRef.current();
    },
  });

  const all = useMemo(() => (data.data?.lines ?? []).filter((l) => l.line.kind === "dialogue"), [data.data]);
  const speakers = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const l of all) {
      const key = l.line.characterId ?? l.characterName;
      const entry = counts.get(key) ?? { name: l.characterName, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [all]);
  const shown = who === "all" ? all : all.filter((l) => (l.line.characterId ?? l.characterName) === who);
  const myItems = useMemo(() => items.filter((i) => i.kind === "director" && i.token === productionId), [items, productionId]);

  useEffect(() => {
    if (!currentId && shown.length) setCurrentId((shown.find((l) => l.audioSource !== "actor") ?? shown[0]!).line.id);
  }, [shown, currentId]);

  useEffect(
    () =>
      uploader.onSaved((item, result) => {
        if (item.kind !== "director" || item.token !== productionId) return;
        setData((current) =>
          current
            ? {
                ...current,
                lines: current.lines.map((l) => (l.line.id === item.lineId ? { ...l, take: result.take, audioSource: "standin" } : l)),
              }
            : current!,
        );
      }),
    [uploader, productionId, setData],
  );

  const scrollTo = useCallback((lineId: string) => {
    cardRefs.current.get(lineId)?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  const start = async (lineId: string) => {
    if (recorder.recording) return;
    playback.pause();
    setCurrentId(lineId);
    await recorder.start(lineId);
  };

  const stop = async () => {
    const lineId = recorder.recording?.lineId;
    const take = await recorder.stop();
    if (!take || !lineId) return;
    if (take.tooShort) return onError("Too short. Tap record, read the line, then tap stop.");
    const url = URL.createObjectURL(take.blob);
    try {
      const clientTakeId = await uploader.add({ kind: "director", token: productionId, lineId, audio: take.blob, durationMs: take.durationMs });
      setLocalTakes((m) => {
        const next = new Map(m);
        const old = next.get(lineId);
        if (old) URL.revokeObjectURL(old.url);
        next.set(lineId, { clientTakeId, url, durationMs: take.durationMs });
        return next;
      });
    } catch {
      URL.revokeObjectURL(url);
      return onError("Couldn't save that take on this device. Try again.");
    }
    // On to the next line in view that nobody from the cast has recorded.
    const index = shown.findIndex((l) => l.line.id === lineId);
    const next = shown.slice(index + 1).find((l) => l.audioSource !== "actor" && !localTakes.has(l.line.id)) ?? shown[index + 1];
    if (next) {
      setTimeout(() => {
        setCurrentId(next.line.id);
        scrollTo(next.line.id);
      }, 600);
    }
  };
  stopRef.current = () => void stop();

  if (data.loading) return <Loading />;
  if (data.error instanceof ApiError && data.error.status === 404) {
    return (
      <div className="page">
        <div className="notice notice-accent" role="status">
          Stand-in recording isn't ready on the server yet. Check back soon: it's on its way.
        </div>
      </div>
    );
  }
  if (data.error || !data.data) {
    return (
      <div className="page">
        <div className="notice notice-error" role="alert">
          {errorMessage(data.error)}{" "}
          <button className="link-btn" onClick={() => void data.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const current = shown.find((l) => l.line.id === currentId) ?? null;
  const voiced = (l: SectionLine): AudioSource => (localTakes.has(l.line.id) ? "standin" : l.audioSource);
  const counts = all.reduce((acc, l) => ((acc[voiced(l)] = (acc[voiced(l)] ?? 0) + 1), acc), {} as Partial<Record<AudioSource, number>>);

  return (
    <>
      <div className="page scene-filter">
        <p className="small muted nums">
          {plural(all.length, "line")}: {counts.actor ?? 0} by the cast · {counts.standin ?? 0} stand-in · {(counts.tts ?? 0) + (counts.none ?? 0)} still computer voice
        </p>
        {speakers.length > 1 && (
          <div className="chip-row" role="group" aria-label="Show lines for">
            <button type="button" className="filter-chip" aria-pressed={who === "all"} onClick={() => setWho("all")}>
              Everyone
            </button>
            {speakers.map(([key, s]) => (
              <button key={key} type="button" className="filter-chip" aria-pressed={who === key} onClick={() => setWho(key)}>
                <CharacterName name={s.name} /> <span className="muted nums">{s.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <main className="record-main">
        <ol className="line-list">
          {shown.map((l, i) => {
            const source = voiced(l);
            const actorLine: ActorLine = { line: l.line, sectionTitle: "", cue: l.cue, directions: [], take: l.take };
            return (
              <li
                key={l.line.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(l.line.id, el);
                  else cardRefs.current.delete(l.line.id);
                }}
              >
                <LineCard
                  actorLine={actorLine}
                  speaker={l.characterName}
                  number={i + 1}
                  total={shown.length}
                  current={l.line.id === currentId}
                  recording={recorder.recording?.lineId === l.line.id}
                  localTake={localTakes.get(l.line.id) ?? null}
                  upload={latestForLine(myItems, productionId, l.line.id)}
                  score={null}
                  playing={playback.playing}
                  noCueLabel="Opens the scene"
                  voice={<span className={`tag tag-${source}`}>{VOICE_LABEL[source]}</span>}
                  onPlay={playback.play}
                  onSelect={() => !recorder.recording && setCurrentId(l.line.id)}
                  onRerecord={() => void start(l.line.id)}
                  onRetry={(takeId) => uploader.retry(takeId)}
                />
              </li>
            );
          })}
        </ol>
      </main>
      <RecordDock
        recording={!!recorder.recording}
        elapsed={recorder.elapsed}
        analyser={recorder.analyser}
        micStatus={recorder.micStatus}
        micError={recorder.micError}
        hint={
          current
            ? current.audioSource === "actor"
              ? "The cast has recorded this one. Tap to replace it with yours."
              : `Tap and read ${current.characterName}'s line.`
            : "Pick a line to read."
        }
        disabled={!current}
        label={current ? `Record ${current.characterName}'s line` : "Record"}
        onToggle={() => (recorder.recording ? void stop() : current && void start(current.line.id))}
        onRetry={() => currentId && void start(currentId)}
      />
    </>
  );
}
