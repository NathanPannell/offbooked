import { Crosshair, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { errorMessage } from "../api/client";
import type { Line, LineAudioApi, RunThrough } from "../api/types";
import { useWakeLock } from "../audio/wakeLock";
import { CharacterName } from "../components/CharacterName";
import { repeatsSceneTitle } from "../routes/director/lineText";
import { Loading } from "../components/Loading";
import { SectionNav } from "../components/SectionNav";
import { sceneLabel } from "./sceneLabel";
import { useResource } from "../lib/useResource";
import { saysLine, speakerLabel, voicesOf } from "../lib/voices";
import { ClipLoader } from "./clips";
import { PlayerEngine, type PlayerState } from "./engine";
import { followLine } from "./follow";
import { LineText, LiveText, type CueSpan } from "./LiveText";
import { NO_PART, placeholderMs, type MyLineMode, type Part, type QueueLine } from "./queue";
import { changeSettings, defaultSettings, loadSettings, MY_PART, roleCharacters, saveSettings, type PlayerSettings } from "./settings";
import { SPEEDS } from "./timing";
import { cueRange } from "./words";

/** After scrolling by hand, how long before the play is followed again. */
const RESUME_FOLLOW_MS = 4000;

/** What happens on the listener's own lines: the closed label, a phone-width label, and the fuller option text. */
const MODES: { mode: MyLineMode; label: string; short: string; option: string }[] = [
  { mode: "read", label: "Read", short: "Read", option: "Read: play my lines too" },
  { mode: "skip", label: "Silent", short: "Silent", option: "Silent: a gap to say them" },
  { mode: "pause", label: "Pause, then read", short: "Pause", option: "Pause, then read" },
];

const formatSpeed = (speed: number) => `${speed}×`;

interface Props {
  load: () => Promise<RunThrough>;
  /** Per-line audio: the player fetches each line's clip as it goes, instead of one stitched file. */
  audio: LineAudioApi;
  /** "mine" opens with the listener's lines on "Pause, then read" (a cast member's default anyway). */
  initialMode?: "full" | "mine";
  /** One of the actor's parts to open as "your part" (from the recorder of an actor with several). */
  initialRole?: string | null;
}

export function RunThroughPlayer({ load, audio, initialMode = "full", initialRole = null }: Props) {
  const rt = useResource(load, "runthrough");
  const audioRef = useRef<HTMLAudioElement>(null);
  const [engine, setEngine] = useState<PlayerEngine | null>(null);
  const [stored, setStored] = useState<PlayerSettings | null>(null);
  const [following, setFollowing] = useState(true);
  const lineRefs = useRef(new Map<string, HTMLElement>());
  const rootRef = useRef<HTMLDivElement>(null);

  const data = rt.data;
  const lines = useMemo(() => (data ? [...data.lines].sort((a, b) => a.seq - b.seq) : []), [data]);
  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const characters = useMemo(() => [...(data?.characters ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [data]);
  const characterName = useMemo(() => new Map(characters.map((c) => [c.id, c.name])), [characters]);
  const characterById = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);
  const myCharacterIds = useMemo(() => data?.myCharacterIds ?? [], [data]);
  const isActor = myCharacterIds.length > 0;

  // Role, my-line mode and speed: remembered per production, read once the run-through loads.
  const productionId = data?.production.id;
  const loadStored = useEffectEvent((productionId: string) => {
    const roles = new Set([...(isActor ? [MY_PART] : []), ...characters.map((c) => c.id)]);
    const loaded = loadSettings(productionId, defaultSettings(isActor, initialMode), roles);
    const withMode = initialMode === "mine" ? { ...loaded, role: loaded.role || (isActor ? MY_PART : ""), mode: "pause" as const } : loaded;
    // Opened for one part: only its lines are yours, and the scene list keeps only its scenes.
    setStored(initialRole && roles.has(initialRole) ? { ...withMode, role: initialRole } : withMode);
  });
  useEffect(() => {
    // Only when the production changes: later reloads of the same run-through keep the settings.
    if (productionId) loadStored(productionId);
  }, [productionId]);
  const settings = stored ?? defaultSettings(isActor, initialMode);
  const update = (patch: Partial<PlayerSettings>) => {
    const next = changeSettings(settings, patch);
    setStored(next);
    if (productionId) saveSettings(productionId, next);
  };

  const roleIds = useMemo(() => roleCharacters(settings.role, myCharacterIds), [settings.role, myCharacterIds]);
  // Who speaks in each scene, in order of first line.
  const speakersBySection = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const l of lines) {
      if (l.kind !== "dialogue" || !l.characterId) continue;
      const list = out.get(l.sectionId) ?? [];
      for (const id of voicesOf(l)) if (!list.includes(id)) list.push(id);
      out.set(l.sectionId, list);
    }
    return out;
  }, [lines]);

  const mine = useMemo(() => {
    const ids = roleIds;
    return new Set(lines.filter((l) => l.kind === "dialogue" && saysLine(l, ids)).map((l) => l.id));
  }, [roleIds, lines]);
  const hasRole = settings.role !== "";
  const part = useMemo<Part>(() => (hasRole ? { mine, mode: settings.mode } : NO_PART), [hasRole, mine, settings.mode]);

  // The play queue: dialogue and stage directions (read by the narrator), in order.
  const queue = useMemo<QueueLine[]>(
    () =>
      lines
        .filter((l) => l.kind === "dialogue" || l.kind === "stage_direction")
        .map((l) => ({ lineId: l.id, sectionId: l.sectionId, text: l.text, kind: l.kind === "stage_direction" ? "stage_direction" : "dialogue" })),
    [lines],
  );
  const segmentByLine = useMemo(() => new Map(queue.map((q, index) => [q.lineId, index])), [queue]);

  // The listener's cues: the last sentence of the line before each of theirs (in its scene, and
  // not their own), underlined. Keyed by the cue line, with the line each one cues.
  const cues = useMemo(() => {
    const spans = new Map<string, CueSpan>();
    const cueFor = new Map<string, string>();
    if (!hasRole) return { spans, cueFor };
    let before: Line | undefined;
    for (const l of lines) {
      if (l.kind !== "dialogue") continue;
      if (mine.has(l.id) && before && before.sectionId === l.sectionId && !mine.has(before.id)) {
        const span = cueRange(before.text);
        if (span) {
          spans.set(before.id, span);
          cueFor.set(l.id, before.id);
        }
      }
      before = l;
    }
    return { spans, cueFor };
  }, [hasRole, lines, mine]);

  // The engine owns the <audio> element and the clip cache for the life of the screen.
  const linesRef = useRef(lineById);
  linesRef.current = lineById;
  const hasData = data !== undefined;
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const clips = new ClipLoader(audio, (lineId) => {
      const line = linesRef.current.get(lineId);
      // A direction nobody can voice is passed over; dialogue keeps the render's silence.
      return line?.kind === "stage_direction" ? 0 : placeholderMs(line?.text ?? "");
    });
    const e = new PlayerEngine(el, clips);
    setEngine(e);
    return () => {
      e.destroy();
      clips.dispose();
    };
  }, [hasData, audio]);

  useEffect(() => {
    engine?.setLines(queue);
  }, [engine, queue]);

  const state = useSyncExternalStore(engine?.subscribe ?? noopSubscribe, engine?.getState ?? initialState);
  // Nobody touches the phone during a run-through: keep the screen on for as long as it plays,
  // through gaps, the listener's own lines and waits for a clip.
  useWakeLock(state.playing);

  useEffect(() => {
    engine?.setPart(part);
  }, [engine, part]);

  useEffect(() => {
    engine?.setSpeed(settings.speed);
  }, [engine, settings.speed]);

  const currentSegment = queue[state.index];
  const currentLine = currentSegment ? lineById.get(currentSegment.lineId) : undefined;
  const currentSeq = currentLine?.seq ?? -Infinity;

  // Follows the current line between the pinned row and the player bar (follow.ts): a line that
  // fits with the end of its cue above it is placed once as it starts and then stays put; a long
  // one glides up a row at a time as it is read. The cue is the underlined one for the listener's
  // own lines, else the line played before it in the scene.
  const followCurrent = useRef<(atStart: boolean) => void>(() => {});
  followCurrent.current = (atStart) => {
    if (!currentSegment) return;
    const el = lineRefs.current.get(currentSegment.lineId);
    const text = el?.querySelector(".lyric-text");
    if (!el || !text) return;
    const cueLine = cues.cueFor.get(currentSegment.lineId);
    const before = queue[state.index - 1];
    const cue =
      (cueLine ? lineRefs.current.get(cueLine)?.querySelector(".lyric-cue") : null) ??
      (before && before.sectionId === currentSegment.sectionId ? lineRefs.current.get(before.lineId)?.querySelector(".lyric-text") : null) ??
      null;
    followLine(text, cue, el.querySelector(".rw.is-now"), rootRef.current, atStart);
  };

  // As each line starts, and on coming back to it ("Back to current line", or after a scroll by
  // hand), unless the listener has scrolled away.
  useEffect(() => {
    if (following && currentSegment) followCurrent.current(true);
  }, [currentSegment, following]);

  const playingRef = useRef(false);
  playingRef.current = state.playing;
  const followingRef = useRef(following);
  followingRef.current = following;
  // Each new word: only a long line moves the page mid-way.
  const onAdvance = useCallback(() => {
    if (followingRef.current && playingRef.current) followCurrent.current(false);
  }, []);

  // Scrolling by hand pauses following for a few seconds; it picks up again if the play is running.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopFollowing = () => {
      setFollowing(false);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (playingRef.current) setFollowing(true);
      }, RESUME_FOLLOW_MS);
    };
    const onKey = (e: KeyboardEvent) => {
      if (["PageUp", "PageDown", "Home", "End"].includes(e.key)) stopFollowing();
    };
    window.addEventListener("wheel", stopFollowing, { passive: true });
    window.addEventListener("touchmove", stopFollowing, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
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
      album: section?.title ?? "Listen",
    });
    navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
  }, [currentLine, characterName, data, state.playing]);

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
  // With a part picked, the scene list keeps only the scenes that part speaks in.
  const sceneChoices = hasRole ? sections.filter((s) => speakersBySection.get(s.id)?.some((id) => roleIds.has(id))) : sections;
  const ownNames = myCharacterIds
    .map((id) => characterName.get(id))
    .filter(Boolean)
    .join(" & ");
  const roleName = settings.role === MY_PART ? ownNames || "your part" : (characterName.get(settings.role) ?? "");
  const currentMode = MODES.find((m) => m.mode === settings.mode) ?? MODES[0];
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(settings.speed) + 1) % SPEEDS.length];
  const speedLabel = `${hasRole ? "Speed of other people's lines" : "Speed"}: ${formatSpeed(settings.speed)}`;

  const onLineTap = (line: Line) => {
    if (!engine || !hasAudio) return;
    const index = segmentByLine.get(line.id) ?? queue.findIndex((q) => (lineById.get(q.lineId)?.seq ?? 0) > line.seq);
    if (index < 0) return;
    setFollowing(true);
    engine.seekToSegment(index);
  };

  return (
    <div ref={rootRef} className={`player ${hasRole ? "is-my-part" : ""}`}>
      <audio ref={audioRef} preload="auto" playsInline />

      {/* One row pinned to the top: who you are, what happens on your lines, and the scene. */}
      <div className="runthrough-bar">
        <BarSelect
          className="role-select"
          label="Your part"
          value={settings.role}
          onChange={(role) => update({ role })}
          display={hasRole ? `You: ${roleName}` : "Just listening"}
        >
          {isActor && <option value={MY_PART}>{ownNames ? `Me (${ownNames})` : "My part"}</option>}
          <option value="">Just listening</option>
          {characters
            .filter((c) => !c.group)
            .filter((c) => !(isActor && myCharacterIds.length === 1 && c.id === myCharacterIds[0]))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </BarSelect>
        {hasRole && (
          <BarSelect
            className="mode-select"
            label="Your lines"
            value={settings.mode}
            onChange={(mode) => {
              const next = MODES.find((m) => m.mode === mode);
              if (next) update({ mode: next.mode });
            }}
            display={
              <>
                <span className="rt-long">{currentMode.label}</span>
                <span className="rt-short">{currentMode.short}</span>
              </>
            }
          >
            {MODES.map((m) => (
              <option key={m.mode} value={m.mode}>
                {m.option}
              </option>
            ))}
          </BarSelect>
        )}
        <SectionNav
          sections={sceneChoices}
          always={hasRole}
          placeholder={hasRole ? "Your scenes" : "Scenes"}
          label={(s) => sceneLabel(s.title, speakersBySection.get(s.id) ?? [], characterName)}
          onJump={(sectionId) => {
            const first = lines.find((l) => l.sectionId === sectionId && segmentByLine.has(l.id));
            if (first && hasAudio) onLineTap(first);
            else document.getElementById(`rt-section-${sectionId}`)?.scrollIntoView({ block: "start" });
          }}
        />
      </div>

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
                // A heading that only repeats the scene title above it isn't shown twice (unless it plays).
                .filter((l) => l.sectionId === section.id && !(repeatsSceneTitle(l, section.title) && !segmentByLine.has(l.id)))
                .map((line) => {
                  const segment = segmentByLine.get(line.id);
                  const isCurrent = segment !== undefined && segment === state.index;
                  const isMine = mine.has(line.id);
                  const skipped = isMine && settings.mode === "skip";
                  const inGap = isCurrent && state.gap !== null;
                  const label = speakerLabel(line, characterById);
                  const who = label.name || undefined;
                  const cue = cues.spans.get(line.id) ?? null;
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
                            {label.voices && <span className="lyric-voices">{label.voices}</span>}
                            {isMine && <span className="sr-only">{skipped ? "(your line, silent)" : "(your line)"}</span>}
                            {cue && <span className="sr-only">(your cue)</span>}
                          </span>
                        )}
                        {isCurrent && engine && audioRef.current ? (
                          <LiveText
                            text={line.text}
                            kind={line.kind === "stage_direction" ? "stage_direction" : "dialogue"}
                            index={segment}
                            engine={engine}
                            audio={audioRef.current}
                            cue={cue}
                            onAdvance={onAdvance}
                          />
                        ) : (
                          <LineText text={line.text} cue={cue} />
                        )}
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
        <button type="button" className="speed-btn" onClick={() => update({ speed: nextSpeed })} aria-label={speedLabel} title={speedLabel}>
          {formatSpeed(settings.speed)}
        </button>
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
        {/* Balances the speed button, so play stays in the middle. */}
        <span className="controls-spacer" aria-hidden="true" />
      </div>

      <p className="small muted player-waiting" role="status" aria-live="polite">
        {state.waiting && state.playing ? "Getting the next line…" : ""}
      </p>

      <p className="sr-only" aria-live="polite">
        {state.gap ? "Your line. Say it now." : ""}
      </p>
    </div>
  );
}

/**
 * A compact select for the top bar. The closed state shows `display` (e.g. "You: FIRST WITCH"),
 * which can be shorter than the option text; the native picker still opens on tap.
 */
function BarSelect({
  label,
  value,
  onChange,
  display,
  className = "",
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  display: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`bar-select ${className}`}>
      <span className="bar-select-value" aria-hidden="true">
        {display}
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {children}
      </select>
    </label>
  );
}

const IDLE: PlayerState = { index: -1, playing: false, gap: null, ended: false, waiting: false };
const initialState = () => IDLE;
const noopSubscribe = () => () => {};
