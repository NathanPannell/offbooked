import { ArrowLeft, Headphones } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError, errorMessage } from "../../api/client";
import { productions, script as scriptApi, standins } from "../../api/director";
import type { ActorLine, Section, SectionLine } from "../../api/types";
import { claimFirstTakeHint } from "../../audio/micPrefs";
import { usePlayback, useTakeRecorder } from "../../audio/useTakeRecorder";
import { CharacterName } from "../../components/CharacterName";
import { Loading } from "../../components/Loading";
import { PartProgress } from "../../components/PartProgress";
import { RecordDock } from "../../components/RecordDock";
import { firstTakeHint as firstTakeHintText, RecordOptions, useRecordOptions } from "../../components/RecordOptions";
import { useToast } from "../../components/Toast";
import { useResource } from "../../lib/useResource";
import { useLiveTake } from "../../stt/useLiveTake";
import { useSttSession } from "../../stt/useStt";
import { takeWordStarts, type TakeTiming } from "../../stt/wordTiming";
import { latestForLine } from "../../upload/queue";
import { savedTakeId } from "../../upload/uploader";
import { useUploads } from "../../upload/useUploads";
import { LineCard, type LocalTake } from "../actor/LineCard";
import { takeAuthor } from "../actor/recordedBy";
import { revealAfterTakeIn, studioBand, useFollowWhileRecording } from "../actor/recorderFollow";

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
          <Link className="back-link" to={`/app/p/${id}?tab=cast`}>
            <ArrowLeft size={16} aria-hidden="true" /> Back to cast
          </Link>
          <div className="scene-title-row">
            <h1 className="display part-title">
              Recording for <CharacterName name={character?.name ?? "this part"} />
            </h1>
            <ListenThrough productionId={id} />
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
        <div className="scene-title-row">
          <h1 className="display">Read in for your cast</h1>
          <ListenThrough productionId={id} />
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

/** Beside the studio's title: the label goes on a phone, the headphones stay. */
function ListenThrough({ productionId }: { productionId: string }) {
  return (
    <Link className="btn btn-ghost btn-sm scene-listen" to={`/app/p/${productionId}?tab=play`} aria-label="Listen through the play">
      <Headphones size={18} aria-hidden="true" />
      <span className="scene-listen-label">Listen through</span>
    </Link>
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
  const stopRef = useRef<(opts?: { recordNext?: boolean }) => void>(() => {});
  /** The latest start, for the timer that records the next line. */
  const startRef = useRef<(lineId: string) => Promise<void>>(async () => {});
  /** The move to the next line after a take; cleared on leaving, so it can't open the mic on a screen that's gone. */
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    },
    [],
  );
  const recorder = useTakeRecorder({
    onLimit: () => {
      onError("That take ran for an hour, so we stopped and kept it.");
      stopRef.current();
    },
  });
  // Hands-free like the cast's recorder: words light up as they're heard, and a pause at the end of
  // the line stops the take and moves on (mic settings turn that off, or record the next line too).
  const { session: stt } = useSttSession();
  const options = useRecordOptions();
  const { autoAdvance, keepRecording } = options;
  const [firstTakeHint, setFirstTakeHint] = useState(false);
  /** What timing the take's words needs, filled by the live take. */
  const timingRef = useRef<TakeTiming | null>(null);

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
  const live = useLiveTake({
    recording: recorder.recording,
    capture: recorder.capture,
    analyser: recorder.analyser,
    stt,
    text: all.find((l) => l.line.id === recorder.recording?.lineId)?.line.text ?? "",
    autoAdvance,
    onAdvance: (_lineId, mode) => stopRef.current({ recordNext: keepRecording && mode === "live" }),
    timingRef,
  });

  useEffect(() => {
    void stt.start();
  }, [stt]);

  // The next word to say stays near the middle while a take records, between the app's pinned
  // header (the studio's own title scrolls away) and the dock; a scroll by hand pauses that a moment.
  useFollowWhileRecording({ recordingLineId: recorder.recording?.lineId ?? null, live, cardRefs, band: studioBand });

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

  const start = async (lineId: string) => {
    if (recorder.recording) return;
    playback.pause();
    setCurrentId(lineId);
    if (!(await recorder.start(lineId))) return;
    if (autoAdvance && claimFirstTakeHint()) setFirstTakeHint(true);
  };
  startRef.current = start;

  /** Stops and keeps the take, then moves to the next line; with "Keep recording" it records that one too. */
  const stop = async ({ recordNext = false }: { recordNext?: boolean } = {}) => {
    const lineId = recorder.recording?.lineId;
    setFirstTakeHint(false);
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
        wordStartsMs: takeWordStarts(timingRef.current, lineId, take.durationMs),
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
    // On to the next line in view that nobody has recorded, else just the next one. "Keep recording"
    // only carries on into a line nobody has recorded, never over someone's take.
    const index = shown.findIndex((l) => l.line.id === lineId);
    const unrecorded = shown.slice(index + 1).find((l) => !l.take && !localTakes.has(l.line.id));
    const next = unrecorded ?? shown[index + 1];
    if (next) {
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = null;
        setCurrentId(next.line.id);
        const card = cardRefs.current.get(next.line.id);
        if (card) revealAfterTakeIn(cardRefs.current.get(lineId) ?? null, card, studioBand());
        if (recordNext && unrecorded) void startRef.current(next.line.id);
      }, 600);
    }
  };
  stopRef.current = (opts) => void stop(opts);

  /** Deletes the take shown on a line (anyone's), with Undo. One kept a moment ago is deleted once it lands. */
  const remove = async (lineId: string) => {
    playback.pause();
    const local = localTakes.get(lineId);
    const takeId = local ? await savedTakeId(uploader, serverTakeIds.current, local.clientTakeId) : (all.find((l) => l.line.id === lineId)?.take?.id ?? null);
    if (!takeId) return onError("That take is still saving. Try again once it's saved.");
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
                  liveCursor={live?.lineId === l.line.id && live.mode === "live" ? live.cursor : null}
                  liveHint={live?.lineId === l.line.id && !autoAdvance && live.mode === "live" ? "Tap stop when you're done." : undefined}
                  noCueLabel="Opens the scene"
                  author={l.take ? takeAuthor(l.take) : null}
                  progress={playback.progress}
                  onPlay={playback.play}
                  onPlayTogether={playback.playTogether}
                  onDelete={l.take || localTakes.has(l.line.id) ? () => void remove(l.line.id) : undefined}
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
        note={recorder.recording && firstTakeHint ? firstTakeHintText(keepRecording && live?.mode === "live") : undefined}
        disabled={!current}
        label={current ? `Record ${current.characterName}'s line` : "Record"}
        onToggle={() => (recorder.recording ? void stop() : current && void start(current.line.id))}
        onRetry={() => currentId && void start(currentId)}
        onDeviceChange={recorder.setDevice}
        recordedBefore={all.some((l) => l.take?.mine)}
        settings={<RecordOptions options={options} />}
      />
    </>
  );
}
