import { AlertCircle, Check, CloudUpload, Pause, Play, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ActorLine } from "../../api/types";
import { AccuracyChip } from "../../components/AccuracyChip";
import { CharacterName } from "../../components/CharacterName";
import { WordDiff } from "../../components/WordDiff";
import { verdict, VERDICT_MESSAGE } from "../../stt/score";
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
  onPlay,
  onSelect,
  onRerecord,
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
  onPlay: (key: string, url: string) => void;
  onSelect: () => void;
  onRerecord: () => void;
  onRetry: (takeId: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const { line, cue, directions, take } = actorLine;
  const takeUrl = localTake?.url ?? take?.audioUrl ?? null;
  const recorded = !!takeUrl || !!upload;
  const takeKey = `take:${line.id}`;
  const cueKey = `cue:${line.id}`;
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
        <CharacterName name={speaker} />
        <span className="my-text">{line.text}</span>
      </button>

      {recorded && !recording && (
        <div className="line-actions">
          {takeUrl && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onPlay(takeKey, takeUrl)}>
              {playing === takeKey ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
              {playing === takeKey ? "Pause" : "Play take"}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRerecord}>
            <RotateCcw size={15} aria-hidden="true" /> Record again
          </button>
          {score && <AccuracyChip result={score.result} expanded={showDiff} onToggle={() => setShowDiff((s) => !s)} />}
        </div>
      )}
      {score && v !== "good" && !showDiff && !recording && <p className={`verdict-hint verdict-${v}`}>{VERDICT_MESSAGE[v!]}</p>}
      {score && showDiff && <WordDiff text={line.text} ops={score.result.ops} transcript={score.result.transcript} />}
    </article>
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
