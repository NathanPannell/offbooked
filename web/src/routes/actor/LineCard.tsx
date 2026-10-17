import { AlertCircle, Check, CloudUpload, Pause, Play, RotateCcw, Trash2, Users } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ActorLine } from "../../api/types";
import { AccuracyChip } from "../../components/AccuracyChip";
import { CharacterName } from "../../components/CharacterName";
import { WordDiff } from "../../components/WordDiff";
import { pieceStates, segmentLine } from "../../stt/live";
import { verdict, VERDICT_MESSAGE } from "../../stt/score";
import { joinNames, titleCase } from "../../lib/format";
import type { UploadItem } from "../../upload/queue";
import type { Score } from "./RecordSession";

export interface LocalTake {
  clientTakeId: string;
  url: string;
  durationMs: number;
}

/**
 * One line to record: the cue, any directions, the line itself and its take. Shared by the actor's
 * recorder and the director's stand-in recorder.
 */
export function LineCard({
  actorLine,
  speaker,
  number,
  total,
  current,
  recording,
  localTake,
  upload,
  score,
  playing,
  voice,
  noCueLabel = "You open the scene",
  liveCursor = null,
  liveHint,
  progress = 0,
  takeLabel = "Your take",
  onPlay,
  onPlayTogether,
  onSelect,
  onRerecord,
  onDelete,
  onRetry,
}: {
  actorLine: ActorLine;
  speaker: string;
  number: number;
  total: number;
  current: boolean;
  recording: boolean;
  localTake: LocalTake | null;
  upload: UploadItem | null;
  score: Score | null;
  playing: string | null;
  /** Who or what voices this line now (director view). */
  voice?: ReactNode;
  /** Shown instead of a cue for the first line of a scene. */
  noCueLabel?: string;
  /** While recording with live transcription: tokens of the line heard so far. Null shows plain text. */
  liveCursor?: number | null;
  /** A short note under the line while it records, e.g. how the take will end. */
  liveHint?: string;
  /** How far the playing preview has got, 0 to 1. */
  progress?: number;
  /** What the take is called on its play button ("Your take", "Cast take"). */
  takeLabel?: string;
  onPlay: (key: string, url: string) => void;
  /** Plays several clips at once: a shared line's take with the others'. */
  onPlayTogether?: (key: string, urls: string[]) => void;
  onSelect: () => void;
  onRerecord: () => void;
  /** Deletes the take (the caller offers Undo). Left out while the take is still saving. */
  onDelete?: () => void;
  onRetry: (takeId: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const { line, cue, directions, take } = actorLine;
  const takeUrl = localTake?.url ?? take?.audioUrl ?? null;
  const recorded = !!takeUrl || !!upload;
  const takeKey = `take:${line.id}`;
  const cueKey = `cue:${line.id}`;
  const togetherKey = `together:${line.id}`;
  const together = actorLine.together ?? [];
  const othersAudio = together.flatMap((t) => (t.audioUrl ? [t.audioUrl] : []));
  const durationMs = localTake?.durationMs ?? take?.durationMs ?? null;
  const v = score ? verdict(score.result) : null;

  const state = recording ? "is-recording" : current ? "is-current" : recorded ? "is-recorded" : "";

  return (
    <article className={`line-card ${state}`} aria-current={current ? "step" : undefined}>
      <div className="line-card-top">
        <span className="line-number mono nums">
          {number} <span className="muted">/ {total}</span>
        </span>
        {voice}
        <span className="grow" />
        <UploadStatus upload={upload} hasServerTake={!!take} onRetry={onRetry} />
      </div>

      {cue ? (
        <div className="cue">
          {cue.audioUrl ? (
            <button
              type="button"
              className="icon-btn cue-play"
              onClick={() => onPlay(cueKey, cue.audioUrl!)}
              aria-label={playing === cueKey ? "Pause cue" : `Play ${cue.characterName}'s cue`}
            >
              {playing === cueKey ? <Pause size={16} /> : <Play size={16} />}
            </button>
          ) : null}
          <div className="grow">
            <p className="cue-who">
              <CharacterName name={cue.characterName} />
              {cue.audioSource === "tts" && <span className="tag tag-tts">TTS</span>}
              {cue.audioSource === "standin" && <span className="tag tag-standin">stand-in</span>}
            </p>
            <CueText text={cue.text} />
          </div>
        </div>
      ) : (
        <p className="cue-none eyebrow">{noCueLabel}</p>
      )}

      {directions.length > 0 && <p className="directions">{directions.map((d) => d.replace(/^\(|\)$/g, "")).join(" ")}</p>}

      <button type="button" className="my-line" onClick={onSelect} aria-label={`Line ${number}: ${line.text}`}>
        <span className="my-line-who">
          <CharacterName name={speaker} />
          {together.length > 0 && (
            <span className="together-with">
              <Users size={13} aria-hidden="true" /> with {joinNames(together.map((t) => titleCase(t.characterName)))}
            </span>
          )}
        </span>
        <LineText text={line.text} cursor={recording ? liveCursor : null} />
      </button>
      {recording && liveHint && <p className="live-hint">{liveHint}</p>}

      {!recorded && !recording && actorLine.current && (
        <div className="take-bar placeholder-bar">
          <button
            type="button"
            className={`take-play is-placeholder${playing === `now:${line.id}` ? " is-playing" : ""}`}
            onClick={() => onPlay(`now:${line.id}`, actorLine.current!.audioUrl)}
            aria-label={`${playing === `now:${line.id}` ? "Pause" : "Play"} what plays now`}
          >
            {playing === `now:${line.id}` ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            <span>{actorLine.current.source === "actor" ? `${actorLine.current.by ?? "Earlier"}'s take` : "Stand-in"}</span>
          </button>
          <span className="small muted grow placeholder-note">
            {actorLine.current.source === "actor" ? "Plays for now. Record over it any time." : "Plays until you record yours."}
          </span>
          {actorLine.current.source === "actor" && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRerecord}>
              <RotateCcw size={15} aria-hidden="true" /> Record over
            </button>
          )}
        </div>
      )}
      {recorded && !recording && (
        <div className="take-bar">
          {takeUrl ? (
            <button
              type="button"
              className={`take-play${playing === takeKey ? " is-playing" : ""}`}
              onClick={() => onPlay(takeKey, takeUrl)}
              aria-label={`${playing === takeKey ? "Pause" : "Play"} ${takeLabel.toLowerCase()}`}
            >
              {playing === takeKey ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
              <span>{takeLabel}</span>
              {durationMs !== null && <span className="take-time nums">{formatSeconds(durationMs)}</span>}
              <span className="take-progress" aria-hidden="true" style={{ transform: `scaleX(${playing === takeKey ? progress : 0})` }} />
            </button>
          ) : (
            <span className="take-play is-pending">
              <CloudUpload size={16} aria-hidden="true" /> Saving your take…
            </span>
          )}
          {takeUrl && othersAudio.length > 0 && onPlayTogether && (
            <button
              type="button"
              className={`btn btn-ghost btn-sm take-together${playing === togetherKey ? " is-playing" : ""}`}
              onClick={() => onPlayTogether(togetherKey, [takeUrl, ...othersAudio])}
            >
              {playing === togetherKey ? <Pause size={15} aria-hidden="true" /> : <Users size={15} aria-hidden="true" />}
              {playing === togetherKey ? "Pause" : "Play together"}
            </button>
          )}
          {score && <AccuracyChip result={score.result} expanded={showDiff} onToggle={() => setShowDiff((s) => !s)} />}
          <span className="take-tools">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRerecord} aria-label="Record this line again">
              <RotateCcw size={15} aria-hidden="true" /> Redo
            </button>
            {onDelete && (
              <button type="button" className="btn btn-ghost btn-sm take-delete" onClick={onDelete} aria-label="Delete this take">
                <Trash2 size={15} aria-hidden="true" /> Delete
              </button>
            )}
          </span>
        </div>
      )}
      {score && v !== "complete" && !showDiff && !recording && <p className={`verdict-hint verdict-${v}`}>{VERDICT_MESSAGE[v!]}</p>}
      {score && showDiff && <WordDiff text={line.text} ops={score.result.ops} transcript={score.result.transcript} />}
    </article>
  );
}

const formatSeconds = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};


/**
 * The line as written, with [directions] muted. While a take records with live transcription, words
 * already said are lit and the next word is hinted.
 */
function LineText({ text, cursor }: { text: string; cursor: number | null }) {
  const { pieces } = useMemo(() => segmentLine(text), [text]);
  const live = cursor !== null;
  const states = useMemo(() => pieceStates(pieces, cursor ?? 0), [pieces, cursor]);
  if (!pieces.some((p) => p.kind === "direction") && !live) return <span className="my-text">{text}</span>;
  return (
    <span className={`my-text${live ? " is-live" : ""}`}>
      {pieces.map((piece, i) => {
        const state = states[i];
        if (state === "space") return piece.text;
        if (state === "direction") return <span key={i} className="lw-dir">{piece.text}</span>;
        return (
          <span key={i} className={live ? `lw lw-${state}` : undefined}>
            {piece.text}
          </span>
        );
      })}
    </span>
  );
}

const CUE_TAIL = 180;

/** Long cues show their last words (the part you're listening for), with the rest a tap away. */
function CueText({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  if (full || text.length <= CUE_TAIL + 40) return <p className="cue-text">{text}</p>;
  const cut = text.slice(-CUE_TAIL);
  const start = cut.search(/\s/);
  return (
    <p className="cue-text">
      <button type="button" className="link-btn cue-more" onClick={() => setFull(true)} aria-label="Show the whole cue">
        …
      </button>{" "}
      {start >= 0 ? cut.slice(start + 1) : cut}
    </p>
  );
}

function UploadStatus({ upload, hasServerTake, onRetry }: { upload: UploadItem | null; hasServerTake: boolean; onRetry: (takeId: string) => void }) {
  if (!upload) {
    return hasServerTake ? (
      <span className="chip chip-good">
        <Check size={13} strokeWidth={3} aria-hidden="true" /> Saved
      </span>
    ) : null;
  }
  switch (upload.status) {
    case "saved":
      return (
        <span className="chip chip-good">
          <Check size={13} strokeWidth={3} aria-hidden="true" /> Saved
        </span>
      );
    case "uploading":
      return (
        <span className="chip">
          <CloudUpload size={13} aria-hidden="true" /> Saving…
        </span>
      );
    case "queued":
      return (
        <span className="chip" title={upload.error ?? undefined}>
          <CloudUpload size={13} aria-hidden="true" /> {upload.attempts > 0 ? "Waiting for signal…" : "Saving…"}
        </span>
      );
    case "failed":
      return (
        <button type="button" className="chip chip-bad" onClick={() => onRetry(upload.takeId)} title={upload.error ?? undefined}>
          <AlertCircle size={13} aria-hidden="true" /> Didn't save · Retry
        </button>
      );
  }
}
