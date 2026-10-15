import { Crosshair, Gauge, Headphones, Mic, Pause, Play, SkipBack, SkipForward, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { errorMessage } from "../api/client";
import type { AudioSource, Line, LineAudioApi, PracticeResult, RunThrough } from "../api/types";
import { CharacterName } from "../components/CharacterName";
import { Dialog } from "../components/Dialog";
import { Loading } from "../components/Loading";
import { MicHelp } from "../components/MicHelp";
import { SectionNav } from "../components/SectionNav";
import { useToast } from "../components/Toast";
import { WordDiff } from "../components/WordDiff";
import { plural } from "../lib/format";
import { useResource } from "../lib/useResource";
import { formatAccuracy, overallAccuracy, scoreLabel, verdict } from "../stt/score";
import { ClipLoader } from "./clips";
import { PlayerEngine, type PlayerState } from "./engine";
import { NO_PART, placeholderMs, type MyLineMode, type Part, type QueueLine } from "./queue";
import { defaultSettings, loadSettings, MY_PART, roleCharacters, saveSettings, type PlayerSettings } from "./settings";
import { audioSourceTag, isSpeed, SPEEDS } from "./timing";
import { usePractice } from "./usePractice";

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const MODE_LABELS: [MyLineMode, string][] = [
  ["read", "Read"],
  ["skip", "Skip"],
  ["pause", "Pause, then read"],
];

interface Props {
  load: () => Promise<RunThrough>;
  /** Per-line audio: the player fetches each line's clip as it goes, instead of one stitched file. */
  audio: LineAudioApi;
  /** Actor only: save a "Score me" practice run. */
  onPracticeDone?: (results: PracticeResult[]) => Promise<unknown>;
  /** "mine" opens with the listener's lines on "Pause, then read". */
  initialMode?: "full" | "mine";
}

export function RunThroughPlayer({ load, audio, onPracticeDone, initialMode = "full" }: Props) {
  const toast = useToast();
  const rt = useResource(load, "runthrough");
  const audioRef = useRef<HTMLAudioElement>(null);
  const [engine, setEngine] = useState<PlayerEngine | null>(null);
  const [stored, setStored] = useState<PlayerSettings | null>(null);
  const [following, setFollowing] = useState(true);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const lineRefs = useRef(new Map<string, HTMLElement>());

  const data = rt.data;
  const lines = useMemo(() => (data ? [...data.lines].sort((a, b) => a.seq - b.seq) : []), [data]);
  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const characters = useMemo(() => [...(data?.characters ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [data]);
  const characterName = useMemo(() => new Map(characters.map((c) => [c.id, c.name])), [characters]);
  const myCharacterIds = useMemo(() => data?.myCharacterIds ?? [], [data]);
  const isActor = myCharacterIds.length > 0;

  // Role, my-line mode and speed: remembered per production, read once the run-through loads.
  const productionId = data?.production.id;
  useEffect(() => {
    if (!productionId) return;
    const roles = new Set([...(isActor ? [MY_PART] : []), ...characters.map((c) => c.id)]);
    const loaded = loadSettings(productionId, defaultSettings(isActor, initialMode), roles);
    setStored(initialMode === "mine" ? { ...loaded, role: loaded.role || (isActor ? MY_PART : ""), mode: "pause" } : loaded);
    // Only when the production changes: later reloads of the same run-through keep the settings.
  }, [productionId]);
  const settings = stored ?? defaultSettings(isActor, initialMode);
  const update = (patch: Partial<PlayerSettings>) => {
    const next = { ...settings, ...patch };
    setStored(next);
    if (productionId) saveSettings(productionId, next);
  };

  const mine = useMemo(() => {
    const ids = roleCharacters(settings.role, myCharacterIds);
    return new Set(lines.filter((l) => l.kind === "dialogue" && l.characterId && ids.has(l.characterId)).map((l) => l.id));
  }, [settings.role, myCharacterIds, lines]);
  const hasRole = settings.role !== "";
  const part = useMemo<Part>(() => (hasRole ? { mine, mode: settings.mode } : NO_PART), [hasRole, mine, settings.mode]);
  const pausing = hasRole && settings.mode === "pause";

  // The play queue: dialogue and stage directions (read by the narrator), in order.
  const queue = useMemo<QueueLine[]>(
    () =>
      lines
        .filter((l) => l.kind === "dialogue" || l.kind === "stage_direction")
        .map((l) => ({ lineId: l.id, sectionId: l.sectionId, text: l.text, kind: l.kind === "stage_direction" ? "stage_direction" : "dialogue" })),
    [lines],
  );
  const segmentByLine = useMemo(() => new Map(queue.map((q, index) => [q.lineId, index])), [queue]);
  // Each line's audio source: what the run-through said, updated as clips arrive (a take may land meanwhile).
  const [sourceUpdates, setSources] = useState<Record<string, AudioSource>>({});
  const sourceOf = (lineId: string): AudioSource => sourceUpdates[lineId] ?? data?.sources?.[lineId] ?? "none";

  const practice = usePractice((lineId) => lineById.get(lineId)?.text ?? "");

  // The engine owns the <audio> element and the clip cache for the life of the screen.
  const linesRef = useRef(lineById);
  linesRef.current = lineById;
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const clips = new ClipLoader(audio, (lineId) => {
      const line = linesRef.current.get(lineId);
      // A direction nobody can voice is passed over; dialogue keeps the render's silence.
      return line?.kind === "stage_direction" ? 0 : placeholderMs(line?.text ?? "");
    });
    clips.onSource = (lineId, source) => setSources((s) => (s[lineId] === source ? s : { ...s, [lineId]: source }));
    const e = new PlayerEngine(el, clips);
    setEngine(e);
    return () => {
      e.destroy();
      clips.dispose();
    };
  }, [data !== undefined, audio]);

  useEffect(() => {
    engine?.setLines(queue);
  }, [engine, queue]);

  const state = useSyncExternalStore(engine?.subscribe ?? noopSubscribe, engine?.getState ?? initialState);

  useEffect(() => {
    engine?.setPart(part);
  }, [engine, part]);

  useEffect(() => {
    engine?.setSpeed(settings.speed);
  }, [engine, settings.speed]);

  useEffect(() => {
    if (engine) engine.gapListener = pausing ? practice.gapListener : null;
  });

  // "Score me" listens during the pauses, so it only runs in "Pause, then read".
  const { enabled: practiceOn, disable: stopPractice } = practice;
  useEffect(() => {
    if (!pausing && practiceOn) stopPractice();
  }, [pausing, practiceOn, stopPractice]);

  const currentSegment = queue[state.index];
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
  if (rt.error || !data) {
    return (
      <div className="notice notice-error" role="alert">
        {errorMessage(rt.error)}{" "}
        <button className="link-btn" onClick={() => void rt.reload()}>
          Try again
        </button>
      </div>
    );
  }

  const hasAudio = queue.length > 0;
  const sections = [...data.sections].sort((a, b) => a.seq - b.seq);
  const ownNames = myCharacterIds.map((id) => characterName.get(id)).filter(Boolean).join(" & ");

  const onLineTap = (line: Line) => {
    if (!engine || !hasAudio) return;
    const index = segmentByLine.get(line.id) ?? queue.findIndex((q) => (lineById.get(q.lineId)?.seq ?? 0) > line.seq);
    if (index < 0) return;
    setFollowing(true);
    engine.seekToSegment(index);
  };

  return (
    <div className={`player ${hasRole ? "is-my-part" : ""}`}>
      <audio ref={audioRef} preload="auto" playsInline />

      <div className="player-toolbar">
        <label className="pill-select">
          <UserRound size={17} aria-hidden="true" />
          <span className="sr-only">My role</span>
          <select className="input" value={settings.role} onChange={(e) => update({ role: e.target.value })}>
            {isActor && <option value={MY_PART}>{ownNames ? `Me (${ownNames})` : "My part"}</option>}
            <option value="">No role, just listen</option>
            {characters
              .filter((c) => !(isActor && myCharacterIds.length === 1 && c.id === myCharacterIds[0]))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label className="pill-select">
          <Gauge size={17} aria-hidden="true" />
          <span className="sr-only">Speed of other people's lines</span>
          <select
            className="input"
            value={String(settings.speed)}
            onChange={(e) => {
              const speed = Number(e.target.value);
              if (isSpeed(speed)) update({ speed });
            }}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={String(s)}>
                {hasRole ? `Others ${s}×` : `${s}×`}
              </option>
            ))}
          </select>
        </label>
        <SectionNav
          sections={sections}
          onJump={(sectionId) => {
            const first = lines.find((l) => l.sectionId === sectionId && segmentByLine.has(l.id));
            if (first && hasAudio) onLineTap(first);
            else document.getElementById(`rt-section-${sectionId}`)?.scrollIntoView({ block: "start" });
          }}
        />
        {hasRole && (
          <div className="my-lines-setting" role="group" aria-label="My lines">
            <span className="eyebrow">My lines</span>
            <div className="segmented">
              {MODE_LABELS.map(([mode, label]) => (
                <button key={mode} type="button" aria-pressed={settings.mode === mode} onClick={() => update({ mode })}>
                  {label}
                </button>
              ))}
            </div>
            {pausing && onPracticeDone && (
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

      {pausing && onPracticeDone && !practice.enabled && !practice.micError && (
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

      {!hasAudio && (
        <div className="notice notice-accent render-banner" role="status">
          <div className="grow">There are no lines to play yet.</div>
        </div>
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
                  const isCurrent = segment !== undefined && segment === state.index;
                  const isMine = mine.has(line.id);
                  const skipped = isMine && settings.mode === "skip";
                  const inGap = isCurrent && state.gap !== null;
                  const source = sourceOf(line.id);
                  const tag = line.kind === "dialogue" ? audioSourceTag(source) : null;
                  const who = line.characterId ? characterName.get(line.characterId) : undefined;
                  const result = practice.results.get(line.id);
                  const classes = [
                    "lyric",
                    `kind-${line.kind}`,
                    isCurrent && "is-current",
                    line.seq < currentSeq && "is-past",
                    isMine && "is-mine",
                    skipped && "is-skipped",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  if (segment === undefined) {
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
                        {line.kind === "dialogue" && (
                          <span className="lyric-who">
                            {who && <CharacterName name={who} />}
                            {isMine && <span className="your-line">{skipped ? "your line, skipped" : "your line"}</span>}
                            {tag && (
                              <span className={`tag tag-${source}`} title={SOURCE_TITLE[source]}>
                                {tag}
                              </span>
                            )}
                            {result && (
                              <span className={`chip chip-${verdictClass(verdict(result))}`}>{scoreLabel(result)}</span>
                            )}
                          </span>
                        )}
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
      </div>

      <p className="small muted player-waiting" role="status" aria-live="polite">
        {state.waiting && state.playing ? "Getting the next line…" : ""}
      </p>

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
            if (segment !== undefined && engine) {
              setFollowing(true);
              engine.seekToSegment(segment, false);
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

const IDLE: PlayerState = { index: -1, playing: false, gap: null, ended: false, waiting: false };
const initialState = () => IDLE;
const noopSubscribe = () => () => {};
