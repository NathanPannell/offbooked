import { AlertCircle, Check, CloudOff, CloudUpload, Pause, Play, RotateCcw, Smartphone, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import type { ActorLine } from "../../api/types";
import { AccuracyChip } from "../../components/AccuracyChip";
import { CharacterName } from "../../components/CharacterName";
import { WordDiff } from "../../components/WordDiff";
import { pieceStates, segmentLine } from "../../stt/live";
import { verdict, VERDICT_MESSAGE } from "../../stt/score";
import { joinNames, titleCase } from "../../lib/format";
import { uploadState, type UploadItem } from "../../upload/queue";
import { getUploader } from "../../upload/uploader";
import { recordedByLabel, type TakeAuthor } from "./recordedBy";
import type { Score } from "./RecordSession";

export interface LocalTake {
  clientTakeId: string;
  url: string;
  durationMs: number;
}

/**
 * One line to record: the cue, any directions, the line itself and its take, with who recorded it.
 * Shared by the actor's recorder and the director's part studio.
 */
export function LineCard({
  actorLine,
  speaker,
  number,
  total,
  current,
  recording,
  localTake,
  finishing = false,
  upload,
  author,
  score,
  playing,
  noCueLabel = "You open the scene",
  liveCursor = null,
  liveHint,
  progress = 0,
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
  /** The take just recorded here is still being kept (the next line is already recording): shown as saving. */
  finishing?: boolean;
  upload: UploadItem | null;
  /** Who recorded the take that plays for this line now; null when nobody has. */
  author: TakeAuthor | null;
  score: Score | null;
  playing: string | null;
  /** Shown instead of a cue for the first line of a scene. */
  noCueLabel?: string;
  /** While recording with live transcription: tokens of the line heard so far. Null shows plain text. */
  liveCursor?: number | null;
  /** A short note under the line while it records, e.g. how the take will end. */
  liveHint?: string;
  /** How far the playing preview has got, 0 to 1. */
  progress?: number;
  onPlay: (key: string, url: string) => void;
  /** Plays several clips at once: a shared line's take with the others'. */
  onPlayTogether?: (key: string, urls: string[]) => void;
  onSelect: () => void;
  onRerecord: () => void;
  /** Deletes the take (the caller offers Undo). Left out while it is still saving, or when it isn't theirs to delete. */
  onDelete?: () => void;
  onRetry: (takeId: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const { line, cue, directions, take } = actorLine;
  // A take recorded on this screen is the person's own, whoever's played before.
  const who: TakeAuthor | null = localTake || upload || finishing ? { kind: author?.kind ?? "actor", name: "you", mine: true } : author;
  const mine = who?.mine ?? false;
  const takeUrl = localTake?.url ?? take?.audioUrl ?? actorLine.current?.audioUrl ?? null;
  const recorded = !!takeUrl || !!upload || finishing;
  const takeKey = `take:${line.id}`;
  const cueKey = `cue:${line.id}`;
  const togetherKey = `together:${line.id}`;
  const together = actorLine.together ?? [];
  const othersAudio = together.flatMap((t) => (t.audioUrl ? [t.audioUrl] : []));
  const durationMs = localTake?.durationMs ?? take?.durationMs ?? null;
  const v = score ? verdict(score.result) : null;
  const showTogether = !!takeUrl && othersAudio.length > 0 && !!onPlayTogether;

  const state = recording ? "is-recording" : current ? "is-current" : recorded ? "is-recorded" : "";

  return (
    <article className={`line-card ${state}`} aria-current={current ? "step" : undefined}>
      <div className="line-card-top">
        <span className="line-number mono nums">
          {number} <span className="muted">/ {total}</span>
        </span>
        {who && recorded && (
          <span className={`recorded-by${mine ? " is-mine" : ""}`}>
            <Check size={13} strokeWidth={3} aria-hidden="true" /> {recordedByLabel(who)}
          </span>
        )}
        <span className="grow" />
        <UploadStatus upload={upload} onRetry={onRetry} />
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
        <LineText text={line.text} cursor={recording ? liveCursor : null} tracked={recording} />
      </button>
      {recording && liveHint && <p className="live-hint">{liveHint}</p>}

      {recorded && !recording && (
        <div className="take-bar">
          <div className="take-actions">
            {takeUrl ? (
              <button
                type="button"
                className={`take-play${playing === takeKey ? " is-playing" : ""}`}
                onClick={() => onPlay(takeKey, takeUrl)}
                aria-label={`${playing === takeKey ? "Pause" : "Play"} ${mine ? "your take" : `${who?.name ?? "their"}'s take`}`}
              >
                {playing === takeKey ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                <span>{mine ? "Listen back" : "Listen"}</span>
                <span className="take-progress" aria-hidden="true" style={{ transform: `scaleX(${playing === takeKey ? progress : 0})` }} />
              </button>
            ) : upload ? (
              // Not on the server yet (say, after a reload or a crash): it plays from this device.
              <button
                type="button"
                className={`take-play${playing === takeKey ? " is-playing" : ""}`}
                onClick={() => void playFromDevice(upload.takeId, (url) => onPlay(takeKey, url))}
                aria-label={`${playing === takeKey ? "Pause" : "Play"} your take, kept on this device`}
              >
                {playing === takeKey ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                <span>Listen back</span>
                <span className="take-progress" aria-hidden="true" style={{ transform: `scaleX(${playing === takeKey ? progress : 0})` }} />
              </button>
            ) : (
              <span className="take-play is-pending">
                <CloudUpload size={16} aria-hidden="true" /> Saving…
              </span>
            )}
            <button type="button" className="btn btn-ghost btn-sm take-redo" onClick={onRerecord} aria-label={mine ? "Record this line again" : undefined}>
              <RotateCcw size={15} aria-hidden="true" /> {mine ? "Redo" : "Record your own"}
            </button>
            {onDelete && (
              <button type="button" className="btn btn-ghost btn-sm take-delete" onClick={onDelete} aria-label="Delete this take">
                <Trash2 size={15} aria-hidden="true" /> Delete
              </button>
            )}
            {durationMs !== null && mine && takeUrl && <span className="take-time nums">{formatSeconds(durationMs)}</span>}
          </div>
          {(showTogether || score) && (
            <div className="take-extra">
              {showTogether && (
                <button
                  type="button"
                  className={`btn btn-ghost btn-sm take-together${playing === togetherKey ? " is-playing" : ""}`}
                  onClick={() => onPlayTogether!(togetherKey, [takeUrl!, ...othersAudio])}
                >
                  {playing === togetherKey ? <Pause size={15} aria-hidden="true" /> : <Users size={15} aria-hidden="true" />}
                  {playing === togetherKey ? "Pause" : "Play together"}
                </button>
              )}
              {score && <AccuracyChip result={score.result} expanded={showDiff} onToggle={() => setShowDiff((s) => !s)} />}
            </div>
          )}
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
 * already said are lit and the next word is hinted. While it records at all (`tracked`), each word
 * carries its tokens (`data-tok-start`, `data-tok-end`) so the recorder can keep it in view.
 */
function LineText({ text, cursor, tracked = false }: { text: string; cursor: number | null; tracked?: boolean }) {
  const { pieces } = useMemo(() => segmentLine(text), [text]);
  const live = cursor !== null;
  const states = useMemo(() => pieceStates(pieces, cursor ?? 0), [pieces, cursor]);
  if (!pieces.some((p) => p.kind === "direction") && !live && !tracked) return <span className="my-text">{text}</span>;
  return (
    <span className={`my-text${live ? " is-live" : ""}`}>
      {pieces.map((piece, i) => {
        const state = states[i];
        if (state === "space") return piece.text;
        if (state === "direction")
          return (
            <span key={i} className="lw-dir">
              {piece.text}
            </span>
          );
        return (
          <span
            key={i}
            className={live ? `lw lw-${state}` : undefined}
            data-tok-start={tracked ? piece.tokenStart : undefined}
            data-tok-end={tracked ? piece.tokenEnd : undefined}
          >
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

/** The one blob URL for a take played from the device; revoked when another plays. */
let deviceUrl: string | null = null;

async function playFromDevice(takeId: string, play: (url: string) => void) {
  const blob = await getUploader().audio(takeId);
  if (!blob) return;
  if (deviceUrl) URL.revokeObjectURL(deviceUrl);
  deviceUrl = URL.createObjectURL(blob);
  play(deviceUrl);
}

/**
 * Only while a take is on its way: saving; kept on the phone while there's no signal or the server
 * won't take it yet (it keeps trying; tap to try now; a take kept only in this tab's memory asks for
 * the page to stay open); or failed for good, with Retry.
 */
function UploadStatus({ upload, onRetry }: { upload: UploadItem | null; onRetry: (takeId: string) => void }) {
  if (!upload) return null;
  switch (uploadState(upload)) {
    case "saved":
      return null;
    case "saving":
      return (
        <span className="chip">
          <CloudUpload size={13} aria-hidden="true" /> Saving…
        </span>
      );
    case "offline":
      return (
        <button type="button" className="chip chip-check" onClick={() => onRetry(upload.takeId)} title={upload.error ?? undefined}>
          <CloudOff size={13} aria-hidden="true" /> No signal · {upload.volatile ? "keep this page open" : "on this phone"}
        </button>
      );
    case "retrying":
      return (
        <button type="button" className="chip chip-check" onClick={() => onRetry(upload.takeId)} title={upload.error ?? undefined}>
          <Smartphone size={13} aria-hidden="true" /> Not sent yet · {upload.volatile ? "keep this page open" : "on this phone"}
        </button>
      );
    case "failed":
      return (
        <button type="button" className="chip chip-bad" onClick={() => onRetry(upload.takeId)} title={upload.error ?? undefined}>
          <AlertCircle size={13} aria-hidden="true" /> Didn't save · Retry
        </button>
      );
  }
}
