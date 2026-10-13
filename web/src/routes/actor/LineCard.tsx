import { AlertCircle, Check, CloudUpload, Pause, Play, RotateCcw } from "lucide-react";
import { useState } from "react";
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
        <span className="line-number">
          {number} <span className="muted">of {total}</span>
        </span>
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
              {playing === cueKey ? <Pause size={18} /> : <Play size={18} />}
            </button>
          ) : null}
          <div className="grow">
            <p className="cue-who">
              <span className="eyebrow">Cue</span> <CharacterName name={cue.characterName} />
            </p>
            <p className="cue-text">{cue.text}</p>
          </div>
        </div>
      ) : (
        <p className="cue cue-none eyebrow">You open the scene</p>
      )}

      {directions.length > 0 && (
        <p className="directions">{directions.map((d) => d.replace(/^\(|\)$/g, "")).join(" ")}</p>
      )}

      <button type="button" className="my-line" onClick={onSelect} aria-label={`Line ${number}: ${line.text}`}>
        <CharacterName name={speaker} />
        <span className="my-text">{line.text}</span>
      </button>

      {recorded && !recording && (
        <div className="line-actions">
          {takeUrl && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onPlay(takeKey, takeUrl)}>
              {playing === takeKey ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
              {playing === takeKey ? "Pause" : "Play take"}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRerecord}>
            <RotateCcw size={16} aria-hidden="true" /> Re-record
          </button>
          {score && <AccuracyChip result={score.result} expanded={showDiff} onToggle={() => setShowDiff((s) => !s)} />}
        </div>
      )}
      {score && v !== "good" && !showDiff && !recording && (
        <p className={`verdict-hint verdict-${v}`}>{VERDICT_MESSAGE[v!]}</p>
      )}
      {score && showDiff && <WordDiff text={line.text} ops={score.result.ops} transcript={score.result.transcript} />}
    </article>
  );
}

function UploadStatus({
  upload,
  hasServerTake,
  onRetry,
}: {
  upload: UploadItem | null;
  hasServerTake: boolean;
  onRetry: (takeId: string) => void;
}) {
  if (!upload) {
    return hasServerTake ? (
      <span className="chip chip-good">
        <Check size={14} aria-hidden="true" /> Saved
      </span>
    ) : null;
  }
  switch (upload.status) {
    case "saved":
      return (
        <span className="chip chip-good">
          <Check size={14} aria-hidden="true" /> Saved
        </span>
      );
    case "uploading":
      return (
        <span className="chip">
          <CloudUpload size={14} aria-hidden="true" /> Uploading…
        </span>
      );
    case "queued":
      return (
        <span className="chip" title={upload.error ?? undefined}>
          <CloudUpload size={14} aria-hidden="true" /> {upload.attempts > 0 ? "Waiting for signal…" : "Uploading…"}
        </span>
      );
    case "failed":
      return (
        <button type="button" className="chip chip-bad" onClick={() => onRetry(upload.takeId)} title={upload.error ?? undefined}>
          <AlertCircle size={14} aria-hidden="true" /> Didn't upload · Retry
        </button>
      );
  }
}
