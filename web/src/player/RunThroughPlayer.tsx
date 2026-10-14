import {
  Crosshair,
  Headphones,
  Mic,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { errorMessage } from "../api/client";
import type { Line, PracticeResult, RunThrough } from "../api/types";
import { CharacterName } from "../components/CharacterName";
import { Dialog } from "../components/Dialog";
import { Loading } from "../components/Loading";
import { MicHelp } from "../components/MicHelp";
import { SectionNav } from "../components/SectionNav";
import { useToast } from "../components/Toast";
import { WordDiff } from "../components/WordDiff";
import { plural } from "../lib/format";
import { readStorage, writeStorage } from "../lib/storage";
import { useInterval, useResource } from "../lib/useResource";
import { formatAccuracy, overallAccuracy, scoreLabel, verdict } from "../stt/score";
import { PlayerEngine, type PlayerState } from "./engine";
import { audioSourceOf, audioSourceTag, buildSegments, GAP_MULTIPLIER_MAX, GAP_MULTIPLIER_MIN, type Segment } from "./timing";
import { usePractice } from "./usePractice";

const GAP_KEY = "offbooked.gapMultiplier";
const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

interface Props {
  load: () => Promise<RunThrough>;
  /** Director only: force a fresh render. */
  onRender?: () => Promise<unknown>;
  /** Actor only: save a "Score me" practice run. */
  onPracticeDone?: (results: PracticeResult[]) => Promise<unknown>;
  /** Start in my-part mode. */
  initialMode?: "full" | "mine";
}

export function RunThroughPlayer({ load, onRender, onPracticeDone, initialMode = "full" }: Props) {
  const toast = useToast();
  const rt = useResource(load, "runthrough");
  const audioRef = useRef<HTMLAudioElement>(null);
  const [engine, setEngine] = useState<PlayerEngine | null>(null);
  const [activeRenderAt, setActiveRenderAt] = useState<string | null>(null);
  const [mode, setMode] = useState<"full" | "mine">(initialMode);
  const [multiplier, setMultiplier] = useState(() => {
    const stored = Number(readStorage(GAP_KEY));
    return stored >= GAP_MULTIPLIER_MIN && stored <= GAP_MULTIPLIER_MAX ? stored : 1.2;
  });
  const [following, setFollowing] = useState(true);
  const [picking, setPicking] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const lineRefs = useRef(new Map<string, HTMLElement>());

  const data = rt.data;
  const render = data?.render;
  const lines = useMemo(() => (data ? [...data.lines].sort((a, b) => a.seq - b.seq) : []), [data]);
  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const characterName = useMemo(() => new Map((data?.characters ?? []).map((c) => [c.id, c.name])), [data]);
  const mine = useMemo(() => {
    const ids = new Set(data?.myCharacterIds ?? []);
    return new Set(lines.filter((l) => l.kind === "dialogue" && l.characterId && ids.has(l.characterId)).map((l) => l.id));
  }, [data, lines]);
  const isActor = (data?.myCharacterIds.length ?? 0) > 0;

  const [segments, setSegments] = useState<Segment[]>([]);
  const segmentByLine = useMemo(() => new Map(segments.map((s) => [s.lineId, s])), [segments]);

  const practice = usePractice((lineId) => lineById.get(lineId)?.text ?? "");

  // The engine owns the <audio> element for the life of the screen.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const e = new PlayerEngine(audio);
    setEngine(e);
    return () => e.destroy();
  }, [data !== undefined]);

  const state = useSyncExternalStore(
    engine?.subscribe ?? noopSubscribe,
    engine?.getState ?? initialState,
  );

  // Apply a render when it's new, but don't yank the audio out from under someone mid-line.
  const pendingRender = render?.status === "ready" && render.audioUrl && render.createdAt !== activeRenderAt ? render : null;
  const applyRender = useCallback(() => {
    if (!engine || !pendingRender || !audioRef.current) return;
    const audio = audioRef.current;
    const currentLine = segments[engine.getState().index]?.lineId;
    const nextSegments = buildSegments(pendingRender.timing);
    audio.src = pendingRender.audioUrl!;
    setActiveRenderAt(pendingRender.createdAt);
    setSegments(nextSegments);
    engine.setTimeline(nextSegments, new Map(lines.map((l) => [l.id, l.text])));
    const resumeAt = nextSegments.find((s) => s.lineId === currentLine);
    if (resumeAt) audio.currentTime = resumeAt.startMs / 1000;
  }, [engine, pendingRender, segments, lines]);

  useEffect(() => {
    if (pendingRender && engine && (!activeRenderAt || !state.playing)) applyRender();
  }, [pendingRender, engine, activeRenderAt, state.playing, applyRender]);

  useEffect(() => {
    engine?.setMine(mode === "mine" ? mine : null);
  }, [engine, mode, mine]);

  useEffect(() => {
    engine?.setGapMultiplier(multiplier);
    writeStorage(GAP_KEY, String(multiplier));
  }, [engine, multiplier]);

  useEffect(() => {
    if (engine) engine.gapListener = mode === "mine" ? practice.gapListener : null;
  });

  const needsPoll = !!render && (render.stale || (render.status !== "ready" && render.status !== "failed"));
  useInterval(() => void rt.reload(), 8000, needsPoll);

  // Signed audio URLs expire after about an hour. Fetch a fresh one and carry on from the same spot.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onError = async () => {
      const at = audio.currentTime;
      try {
        const fresh = await load();
        if (fresh.render.audioUrl) {
          audio.src = fresh.render.audioUrl;
          audio.currentTime = at;
        }
      } catch {
        toast("The run-through stopped loading. Check your connection.");
      }
    };
    audio.addEventListener("error", onError);
    return () => audio.removeEventListener("error", onError);
  }, [engine, load, toast]);

  const currentSegment = segments[state.index];
  const currentLine = currentSegment ? lineById.get(currentSegment.lineId) : undefined;
  const currentSeq = currentLine?.seq ?? -Infinity;

  // Keep the current line centred, unless the listener has scrolled away.
  useEffect(() => {
    if (!following || !currentSegment) return;
    lineRefs.current.get(currentSegment.lineId)?.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [currentSegment, following]);

  useEffect(() => {
    const stopFollowing = () => setFollowing(false);
    const onKey = (e: KeyboardEvent) => {
      if (["PageUp", "PageDown", "Home", "End"].includes(e.key)) stopFollowing();
    };
    window.addEventListener("wheel", stopFollowing, { passive: true });
    window.addEventListener("touchmove", stopFollowing, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", stopFollowing);
      window.removeEventListener("touchmove", stopFollowing);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Lock screen and headphone controls.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !engine) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => engine.play());
    ms.setActionHandler("pause", () => engine.pause());
    ms.setActionHandler("nexttrack", () => engine.next());
    ms.setActionHandler("previoustrack", () => engine.previous());
    return () => {
      for (const action of ["play", "pause", "nexttrack", "previoustrack"] as const) ms.setActionHandler(action, null);
    };
  }, [engine]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !data) return;
    const who = currentLine?.characterId ? characterName.get(currentLine.characterId) : undefined;
    const section = data.sections.find((s) => s.id === currentLine?.sectionId);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentLine ? `${who ? who + ": " : ""}${currentLine.text}`.slice(0, 120) : data.production.title,
      artist: data.production.title,
      album: section?.title ?? "Run-through",
    });
    navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
  }, [currentLine, characterName, data, state.playing]);

  // A practice run ends with the play: show how it went.
  useEffect(() => {
    if (state.ended && practice.enabled && practice.results.size > 0) setSummaryOpen(true);
  }, [state.ended, practice.enabled, practice.results.size]);

  if (rt.loading) return <Loading />;
  if (rt.error || !data || !render) {
    return (
      <div className="notice notice-error" role="alert">
        {errorMessage(rt.error)}{" "}
        <button className="link-btn" onClick={() => void rt.reload()}>
          Try again
        </button>
      </div>
    );
  }

  const hasAudio = !!activeRenderAt;
  const busyRendering = render.status === "queued" || render.status === "rendering" || render.stale;
  const sections = [...data.sections].sort((a, b) => a.seq - b.seq);

  const onLineTap = (line: Line) => {
    if (!engine || !hasAudio) return;
    const segment = segmentByLine.get(line.id) ?? segments.find((s) => (lineById.get(s.lineId)?.seq ?? 0) > line.seq);
    if (!segment) return;
    if (picking) {
      engine.setAbPoint(segment.index);
      if (engine.getState().ab.b !== null) setPicking(false);
      return;
    }
    setFollowing(true);
    engine.seekToSegment(segment.index);
  };

  const ab = state.ab;
  const abSet = ab.a !== null && ab.b !== null;
  const inAb = (segment: Segment | undefined) =>
    !!segment && ab.a !== null && segment.index >= Math.min(ab.a, ab.b ?? ab.a) && segment.index <= Math.max(ab.a, ab.b ?? ab.a);

  return (
    <div className={`player ${mode === "mine" ? "is-my-part" : ""}`}>
      <audio ref={audioRef} preload="auto" playsInline />

      <div className="player-toolbar">
        {isActor && (
          <div className="segmented" role="group" aria-label="Playback mode">
            <button type="button" aria-pressed={mode === "full"} onClick={() => setMode("full")}>
              Full cast
            </button>
            <button type="button" aria-pressed={mode === "mine"} onClick={() => setMode("mine")}>
              My part
            </button>
          </div>
        )}
        <SectionNav
          sections={sections}
          onJump={(sectionId) => {
            const first = lines.find((l) => l.sectionId === sectionId && segmentByLine.has(l.id));
            if (first && hasAudio) onLineTap(first);
            else document.getElementById(`rt-section-${sectionId}`)?.scrollIntoView({ block: "start" });
          }}
        />
        {mode === "mine" && (
          <div className="my-part-settings">
            <label className="gap-setting">
              <span className="small">
                Pause for my lines <strong>{multiplier.toFixed(1)}×</strong>
              </span>
              <input
                type="range"
                min={GAP_MULTIPLIER_MIN}
                max={GAP_MULTIPLIER_MAX}
                step={0.1}
                value={multiplier}
                onChange={(e) => setMultiplier(Number(e.target.value))}
              />
            </label>
            {onPracticeDone && (
              <label className="checkbox score-toggle">
                <input
                  type="checkbox"
                  checked={practice.enabled}
                  onChange={(e) => (e.target.checked ? void practice.enable() : practice.disable())}
                />
                <Mic size={16} aria-hidden="true" /> Score me
              </label>
            )}
          </div>
        )}
      </div>

      {mode === "mine" && onPracticeDone && !practice.enabled && !practice.micError && (
        <p className="small muted practice-tip">
          <Headphones size={15} aria-hidden="true" /> Turn on “Score me” to check your lines as you say them. Headphones
          help: the mic hears only you.
        </p>
      )}
      {practice.micError && <MicHelp kind={practice.micError.kind} onRetry={() => void practice.enable()} />}
      {practice.enabled && (
        <div className="notice notice-accent practice-bar" role="status" aria-live="polite">
          <Mic size={18} aria-hidden="true" />
          <span className="grow">
            {practice.sttState.status === "unavailable"
              ? "Accuracy check isn't available on this device."
              : practice.sttState.status === "loading" || practice.sttState.status === "checking"
                ? `Accuracy check warming up${practice.sttState.progress ? ` (${Math.round(practice.sttState.progress * 100)}%)` : "…"}`
                : `Scoring your lines. Headphones on? ${practice.results.size} scored so far.`}
          </span>
          {practice.results.size > 0 && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setSummaryOpen(true)}>
              How did I do?
            </button>
          )}
        </div>
      )}

      {(busyRendering || render.status === "failed" || !hasAudio) && (
        <div className={`notice ${render.status === "failed" ? "notice-error" : "notice-accent"} render-banner`} role="status">
          {busyRendering || render.status === "none" ? <div className="spinner" aria-hidden="true" /> : null}
          <div className="grow">
            {render.status === "failed"
              ? "The last render failed."
              : busyRendering
                ? hasAudio
                  ? "Rendering latest takes… You're hearing the previous version."
                  : "Rendering latest takes…"
                : "No run-through yet. It's put together as soon as there's something to play."}
          </div>
          {onRender && (render.status === "failed" || render.status === "none" || render.stale) && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={rendering}
              onClick={async () => {
                setRendering(true);
                try {
                  await onRender();
                  await rt.reload();
                } catch (err) {
                  toast(errorMessage(err));
                } finally {
                  setRendering(false);
                }
              }}
            >
              Render now
            </button>
          )}
        </div>
      )}
      {pendingRender && activeRenderAt && state.playing && (
        <button type="button" className="chip chip-accent update-pill" onClick={applyRender}>
          New takes are in · Switch to the new version
        </button>
      )}
      {picking && (
        <p className="notice notice-accent" role="status">
          {ab.a === null ? "Tap the first line of the bit to repeat." : "Now tap the last line."}
        </p>
      )}

      <ol className="lyrics" aria-label={`${data.production.title} script`}>
        {sections.map((section) => (
          <li key={section.id} id={`rt-section-${section.id}`} className="lyric-section">
            <h3 className="lyric-section-title">{section.title}</h3>
            <ol>
              {lines
                .filter((l) => l.sectionId === section.id)
                .map((line) => {
                  const segment = segmentByLine.get(line.id);
                  const isCurrent = segment !== undefined && segment.index === state.index;
                  const isMine = mine.has(line.id);
                  const inGap = isCurrent && state.gap !== null;
                  const source = audioSourceOf(segment);
                  const tag = audioSourceTag(source);
                  const who = line.characterId ? characterName.get(line.characterId) : undefined;
                  const result = practice.results.get(line.id);
                  const classes = [
                    "lyric",
                    `kind-${line.kind}`,
                    isCurrent && "is-current",
                    line.seq < currentSeq && "is-past",
                    isMine && "is-mine",
                    inAb(segment) && "in-ab",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  if (line.kind !== "dialogue") {
                    return (
                      <li key={line.id} className={classes}>
                        <p className="lyric-text">{line.text}</p>
                      </li>
                    );
                  }
                  return (
                    <li
                      key={line.id}
                      className={classes}
                      ref={(el) => {
                        if (el) lineRefs.current.set(line.id, el);
                        else lineRefs.current.delete(line.id);
                      }}
                      aria-current={isCurrent ? "true" : undefined}
                    >
                      <button type="button" className="lyric-button" onClick={() => onLineTap(line)} disabled={!hasAudio}>
                        <span className="lyric-who">
                          {who && <CharacterName name={who} />}
                          {isMine && mode === "mine" && <span className="your-line">your line</span>}
                          {tag && (
                            <span className={`tag tag-${source}`} title={SOURCE_TITLE[source]}>
                              {tag}
                            </span>
                          )}
                          {result && (
                            <span className={`chip chip-${verdictClass(verdict(result))}`}>{scoreLabel(result)}</span>
                          )}
                        </span>
                        <span className="lyric-text">{line.text}</span>
                      </button>
                      {inGap && state.gap && (
                        <div
                          className={`gap-meter ${state.gap.endsAt === null ? "is-paused" : ""}`}
                          style={{ "--gap-ms": `${state.gap.durationMs}ms` } as CSSProperties}
                          key={`${state.gap.index}-${state.gap.durationMs}`}
                          aria-hidden="true"
                        >
                          <span />
                        </div>
                      )}
                    </li>
                  );
                })}
            </ol>
          </li>
        ))}
      </ol>

      {!following && currentSegment && (
        <button
          type="button"
          className="back-to-current"
          onClick={() => {
            setFollowing(true);
          }}
        >
          <Crosshair size={16} aria-hidden="true" /> Back to current line
        </button>
      )}

      <div className="player-controls" role="group" aria-label="Playback">
        <button type="button" className="icon-btn" onClick={() => engine?.previous()} disabled={!hasAudio} aria-label="Previous line">
          <SkipBack size={24} />
        </button>
        <button
          type="button"
          className="play-button"
          onClick={() => {
            setFollowing(true);
            engine?.toggle();
          }}
          disabled={!hasAudio}
          aria-label={state.playing ? "Pause" : "Play"}
        >
          {state.playing ? <Pause size={30} /> : <Play size={30} />}
        </button>
        <button type="button" className="icon-btn" onClick={() => engine?.next()} disabled={!hasAudio} aria-label="Next line">
          <SkipForward size={24} />
        </button>
        <button
          type="button"
          className={`icon-btn ab-button ${abSet || picking ? "is-on" : ""}`}
          disabled={!hasAudio}
          aria-pressed={abSet || picking}
          aria-label={abSet ? "Stop repeating" : "Repeat a section: tap two lines"}
          onClick={() => {
            if (abSet || picking) {
              engine?.clearAb();
              setPicking(false);
            } else {
              engine?.clearAb();
              setPicking(true);
            }
          }}
        >
          {abSet ? <X size={22} /> : <Repeat size={22} />}
          <span className="ab-label">A–B</span>
        </button>
      </div>

      <p className="sr-only" aria-live="polite">
        {state.gap ? "Your line. Say it now." : ""}
      </p>

      <Dialog open={summaryOpen} onClose={() => setSummaryOpen(false)} title="How that went">
        <PracticeSummary
          results={[...practice.results.values()]}
          pending={practice.pending}
          lineText={(id) => lineById.get(id)?.text ?? ""}
          onJump={(lineId) => {
            setSummaryOpen(false);
            const segment = segmentByLine.get(lineId);
            if (segment && engine) {
              setFollowing(true);
              engine.seekToSegment(segment.index, false);
            }
          }}
          onSave={async (results) => {
            try {
              await onPracticeDone?.(results);
              practice.reset();
              setSummaryOpen(false);
              toast("Practice saved");
            } catch (err) {
              toast(errorMessage(err));
            }
          }}
        />
      </Dialog>
    </div>
  );
}

const SOURCE_TITLE: Record<string, string> = {
  standin: "Read in by a stand-in until the actor records it",
  tts: "A computer voice until someone records it",
  none: "Not recorded yet",
};

function verdictClass(v: ReturnType<typeof verdict>): string {
  return v === "good" ? "good" : v === "check" ? "check" : "bad";
}

function PracticeSummary({
  results,
  pending,
  lineText,
  onJump,
  onSave,
}: {
  results: PracticeResult[];
  pending: number;
  lineText: (id: string) => string;
  onJump: (lineId: string) => void;
  onSave: (results: PracticeResult[]) => Promise<void>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const overall = overallAccuracy(results);
  const sorted = [...results].sort((a, b) => a.accuracy - b.accuracy);
  return (
    <div className="stack practice-summary">
      {overall !== null && (
        <p className="summary-score">
          <span className="display">{formatAccuracy(overall)}</span> of your words matched the script, across{" "}
          {plural(results.length, "line")}
        </p>
      )}
      {pending > 0 && <p className="small muted">Still checking {pending} more…</p>}
      <ol className="summary-list">
        {sorted.map((r) => (
          <li key={r.lineId}>
            <div className="spread">
              <button type="button" className="summary-line" onClick={() => onJump(r.lineId)}>
                {lineText(r.lineId)}
              </button>
              <button
                type="button"
                className={`chip chip-${verdictClass(verdict(r))}`}
                aria-expanded={open === r.lineId}
                onClick={() => setOpen(open === r.lineId ? null : r.lineId)}
              >
                {scoreLabel(r)}
              </button>
            </div>
            {open === r.lineId && <WordDiff text={lineText(r.lineId)} ops={r.ops} transcript={r.transcript} />}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="btn btn-primary"
        disabled={saving || results.length === 0}
        onClick={async () => {
          setSaving(true);
          try {
            await onSave(results);
          } finally {
            setSaving(false);
          }
        }}
      >
        Done
      </button>
    </div>
  );
}

const IDLE: PlayerState = { index: -1, playing: false, gap: null, ab: { a: null, b: null }, ended: false };
const initialState = () => IDLE;
const noopSubscribe = () => () => {};
