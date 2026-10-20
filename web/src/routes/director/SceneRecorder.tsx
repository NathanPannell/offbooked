import { ArrowLeft, Headphones } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError, errorMessage } from "../../api/client";
import { productions, script as scriptApi, standins } from "../../api/director";
import type { ActorLine, Section, SectionLine } from "../../api/types";
import { usePlayback, useTakeRecorder } from "../../audio/useTakeRecorder";
import { CharacterName } from "../../components/CharacterName";
import { Loading } from "../../components/Loading";
import { PartProgress } from "../../components/PartProgress";
import { RecordDock } from "../../components/RecordDock";
import { useToast } from "../../components/Toast";
import { useResource } from "../../lib/useResource";
import { latestForLine } from "../../upload/queue";
import { useUploads } from "../../upload/useUploads";
import { LineCard, type LocalTake } from "../actor/LineCard";
import { takeAuthor } from "../actor/recordedBy";

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * The director records lines, scene by scene and partner by partner, or one part's lines across
 * the play (`?character=`, its studio, opened from the call sheet). A director's take counts like
 * anyone's.
 */
export default function SceneRecorder() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const characterId = params.get("character");
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
  const script = base.data[1];

  if (characterId) {
    const character = script.characters.find((c) => c.id === characterId);
    return (
      <div className="scene-recorder">
        <div className="page scene-head">
          <Link className="back-link" to={`/app/p/${id}?tab=script`}>
            <ArrowLeft size={16} aria-hidden="true" /> Back to script
          </Link>
          <div className="spread scene-title-row">
            <h1 className="display part-title">
              Recording for <CharacterName name={character?.name ?? "this part"} />
            </h1>
            <Link className="btn btn-ghost btn-sm" to={`/app/p/${id}?tab=play`}>
              <Headphones size={16} aria-hidden="true" /> Listen through
            </Link>
          </div>
        </div>
        <SceneLines
          key={characterId}
          productionId={id}
          cacheKey={`character:${id}:${characterId}`}
          load={() => standins.characterLines(id, characterId)}
          progressLabel={`${character?.name ?? "This part"}'s lines recorded`}
          onError={toast}
        />
      </div>
    );
  }

  return (
    <div className="scene-recorder">
      <div className="page scene-head">
        <Link className="back-link" to={`/app/p/${id}?tab=script`}>
          <ArrowLeft size={16} aria-hidden="true" /> Back to script
        </Link>
        <div className="spread scene-title-row">
          <h1 className="display">Read in for your cast</h1>
          <Link className="btn btn-ghost btn-sm" to={`/app/p/${id}?tab=play`}>
            <Headphones size={16} aria-hidden="true" /> Listen through
          </Link>
        </div>
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
        <SceneLines
          key={sectionId}
          productionId={id}
          cacheKey={`${id}:${sectionId}`}
          load={() => standins.sectionLines(id, sectionId)}
          progressLabel="Lines in this scene recorded"
          onError={toast}
        />
      ) : (
        <p className="page muted">This script has no scenes yet.</p>
      )}
    </div>
  );
}

function SceneLines({
  productionId,
  cacheKey,
  load,
  progressLabel,
  onError,
}: {
  productionId: string;
  cacheKey: string;
  /** A scene's lines, or a character's (with the scenes they're in, for headings). */
  load: () => Promise<{ lines: SectionLine[]; sections?: Section[] }>;
  progressLabel: string;
  onError: (m: string, action?: { label: string; onClick: () => void }) => void;
}) {
  const data = useResource(load, cacheKey);
  const setData = data.setData;
  const { uploader, items } = useUploads();
  const playback = usePlayback(() => onError("Couldn't play that. Try again."));
  const [who, setWho] = useState<string>("all");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [localTakes, setLocalTakes] = useState(new Map<string, LocalTake>());
  /** Server take ids of takes saved on this screen, by client take id. */
  const serverTakeIds = useRef(new Map<string, string>());
  const [deleted, setDeleted] = useState(new Set<string>());
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const stopRef = useRef<() => void>(() => {});
  const recorder = useTakeRecorder({
    onLimit: () => {
      onError("That take ran for an hour, so we stopped and kept it.");
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
    if (!currentId && shown.length) setCurrentId((shown.find((l) => !l.take) ?? shown[0]!).line.id);
  }, [shown, currentId]);

  useEffect(
    () =>
      uploader.onSaved((item, result) => {
        if (item.kind !== "director" || item.token !== productionId) return;
        serverTakeIds.current.set(item.takeId, result.take.id);
        setData((current) =>
          current
            ? {
                ...current,
                lines: current.lines.map((l) => (l.line.id === item.lineId ? { ...l, take: { ...result.take, mine: true }, audioSource: "director" } : l)),
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
      const voiceId = all.find((l) => l.line.id === lineId)?.voiceId ?? null;
      const clientTakeId = await uploader.add({
        kind: "director",
        token: productionId,
        lineId,
        characterId: voiceId,
        audio: take.blob,
        durationMs: take.durationMs,
      });
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
    // On to the next line in view that nobody has recorded.
    const index = shown.findIndex((l) => l.line.id === lineId);
    const next = shown.slice(index + 1).find((l) => !l.take && !localTakes.has(l.line.id)) ?? shown[index + 1];
    if (next) {
      setTimeout(() => {
        setCurrentId(next.line.id);
        scrollTo(next.line.id);
      }, 600);
    }
  };
  stopRef.current = () => void stop();

  /** Deletes the take shown on a line (anyone's), with Undo. */
  const remove = async (lineId: string, takeId: string) => {
    playback.pause();
    const local = localTakes.get(lineId);
    try {
      await standins.deleteTake(takeId);
    } catch (err) {
      return onError(errorMessage(err));
    }
    if (local) setDeleted((d) => new Set(d).add(local.clientTakeId));
    setLocalTakes((m) => {
      const next = new Map(m);
      next.delete(lineId);
      return next;
    });
    const refresh = async () => {
      const fresh = await load().catch(() => null);
      if (fresh) setData(fresh);
    };
    await refresh();
    onError("Take deleted", {
      label: "Undo",
      onClick: () =>
        void standins.restoreTake(takeId).then(
          async () => {
            if (local) {
              setDeleted((d) => {
                const next = new Set(d);
                next.delete(local.clientTakeId);
                return next;
              });
            }
            await refresh();
          },
          (err) => onError(errorMessage(err)),
        ),
    });
  };

  if (data.loading) return <Loading />;
  if (data.error instanceof ApiError && data.error.status === 404) {
    return (
      <div className="page">
        <div className="notice notice-accent" role="status">
          Recording here isn't ready on the server yet. Check back soon: it's on its way.
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
  const sectionTitles = new Map((data.data.sections ?? []).map((sec) => [sec.id, sec.title]));
  const uploadFor = (lineId: string) => {
    // Once saved, the server's lines are the truth; only takes still on their way count from the queue.
    const item = latestForLine(myItems, productionId, lineId);
    return item && item.status !== "saved" && !deleted.has(item.takeId) ? item : null;
  };
  const shownTake = (l: SectionLine): string | null => {
    const local = localTakes.get(l.line.id);
    if (local) return serverTakeIds.current.get(local.clientTakeId) ?? null;
    return l.take?.id ?? null;
  };
  const isRecorded = (l: SectionLine) => !!l.take || localTakes.has(l.line.id) || !!uploadFor(l.line.id);
  const recordedCount = all.filter(isRecorded).length;

  return (
    <>
      <div className="page scene-filter">
        <PartProgress total={all.length} recorded={recordedCount} label={progressLabel} />
        {speakers.length > 1 && !data.data.sections && (
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
            const actorLine: ActorLine = { line: l.line, sectionTitle: "", cue: l.cue, directions: [], take: l.take, together: l.together };
            const heading =
              sectionTitles.size > 0 && (i === 0 || shown[i - 1]!.line.sectionId !== l.line.sectionId) ? sectionTitles.get(l.line.sectionId) : null;
            const takeId = shownTake(l);
            return (
              <li
                key={l.line.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(l.line.id, el);
                  else cardRefs.current.delete(l.line.id);
                }}
              >
                {heading && <h2 className="eyebrow studio-scene">{heading}</h2>}
                <LineCard
                  actorLine={actorLine}
                  speaker={l.characterName}
                  number={i + 1}
                  total={shown.length}
                  current={l.line.id === currentId}
                  recording={recorder.recording?.lineId === l.line.id}
                  localTake={localTakes.get(l.line.id) ?? null}
                  upload={uploadFor(l.line.id)}
                  score={null}
                  playing={playback.playing}
                  noCueLabel="Opens the scene"
                  author={l.take ? takeAuthor(l.take) : null}
                  progress={playback.progress}
                  onPlay={playback.play}
                  onPlayTogether={playback.playTogether}
                  onDelete={takeId ? () => void remove(l.line.id, takeId) : undefined}
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
        disabled={!current}
        label={current ? `Record ${current.characterName}'s line` : "Record"}
        onToggle={() => (recorder.recording ? void stop() : current && void start(current.line.id))}
        onRetry={() => currentId && void start(currentId)}
        onDeviceChange={recorder.setDevice}
      />
    </>
  );
}
