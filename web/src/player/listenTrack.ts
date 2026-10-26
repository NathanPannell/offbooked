import { useEffect, useState } from "react";
import type { LineAudioApi, ListenTrackRequest } from "../api/types";
import type { PlayerEngine } from "./engine";
import { nextIndex, playableFrom, sameLines, samePart, type Part, type QueueLine } from "./queue";

// Keeps a listen track ready for where the listener is in the play, so the website keeps playing
// with the phone locked (see PlayerEngine and the server's track/track.ts). The player starts line
// by line as before; once someone has pressed play, the stretch from the current line is built on
// the server and the engine moves onto it at the next line. Near its end the next stretch is
// asked for, and a jump outside it, or a change of part or mode, asks again from there.

/** The most lines one track covers (the server's MAX_TRACK_LINES). */
export const TRACK_LINES = 300;
/** Ask for the next stretch once the listener is this close to the end of the one playing. */
export const REFRESH_LINES = 40;
/** How often to ask again while a track is building, and after one failed. */
export const POLL_MS = 3000;
export const RETRY_FAILED_MS = 30_000;

export type TrackStatus = "off" | "building" | "ready" | "failed";

/** The request for the stretch starting at `index`: up to TRACK_LINES lines in playback order. */
export function trackWindow(queue: QueueLine[], index: number, part: Part, max = TRACK_LINES): ListenTrackRequest {
  const lineIds: string[] = [];
  for (let i = playableFrom(queue, index, part); i !== null && lineIds.length < max; i = nextIndex(queue, i, part)) lineIds.push(queue[i]!.lineId);
  const mine = part.mine ? lineIds.filter((id) => part.mine!.has(id)) : [];
  return { lineIds, mine, mode: mine.length ? part.mode : "read" };
}

/** Whether the listener at `index` needs a track asked for: none covers it, or the one that does ends soon. */
export function needsTrack(reach: number | null, index: number, queueLength: number): boolean {
  if (reach === null) return true;
  return reach < queueLength - 1 && reach - index < REFRESH_LINES;
}

interface Job {
  queue: QueueLine[];
  part: Part;
  /** The stretch asked for, as line indexes [start, end). */
  start: number;
  end: number;
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

/**
 * Asks for listen tracks while `active` (someone has pressed play, on the website) and hands each
 * ready one to the engine. Returns where the newest one stands.
 */
export function useListenTrack(opts: {
  engine: PlayerEngine | null;
  api: LineAudioApi;
  queue: QueueLine[];
  part: Part;
  index: number;
  active: boolean;
}): TrackStatus {
  const { engine, api, queue, part, index, active } = opts;
  const [status, setStatus] = useState<TrackStatus>("off");
  // The request in flight (or the last one), kept across renders.
  const [box] = useState<{ job: Job | null }>(() => ({ job: null }));

  useEffect(() => {
    const ask = api.track;
    if (!engine || !ask || !active || index < 0 || !queue.length) return;
    const current = box.job;
    // Same script, part and mode as the stretch asked for last: ask again only once the listener
    // is outside it or near its end, and the engine has no track that covers them for a while yet.
    if (current && !current.cancelled && sameLines(current.queue, queue) && samePart(current.part, part)) {
      const coverEnd = current.end < queue.length ? current.end - REFRESH_LINES : queue.length;
      if (index >= current.start && index < coverEnd) return;
      if (!needsTrack(engine.trackReach(index), index, queue.length)) return;
    }
    if (current) cancel(current);
    const req = trackWindow(queue, index, part);
    if (!req.lineIds.length) return;
    const next: Job = { queue, part, start: index, end: index + req.lineIds.length, cancelled: false };
    box.job = next;
    setStatus("building");
    const poll = () => {
      ask(req).then(
        ({ track }) => {
          if (next.cancelled) return;
          if (track.status === "ready") {
            engine.addTrack(track);
            setStatus("ready");
          } else if (track.status === "building") {
            next.timer = setTimeout(poll, POLL_MS);
          } else {
            setStatus("failed");
            next.timer = setTimeout(poll, RETRY_FAILED_MS);
          }
        },
        () => {
          if (!next.cancelled) next.timer = setTimeout(poll, RETRY_FAILED_MS);
        },
      );
    };
    poll();
  }, [engine, api, queue, part, index, active, box]);

  // Stop asking when the player goes.
  useEffect(
    () => () => {
      if (box.job) cancel(box.job);
    },
    [box],
  );

  return active ? status : "off";
}

function cancel(job: Job) {
  job.cancelled = true;
  clearTimeout(job.timer);
}
