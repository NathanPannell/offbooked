import { useEffect, useState } from "react";
import type { LineAudioApi, ListenTrack, ListenTrackRequest } from "../api/types";
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
/** How often to ask again while a track is building. */
export const POLL_MS = 3000;
/**
 * How long to wait after a failed track (or a request that failed) before asking again: the
 * server's own wait before it builds a failed track again. After MAX_TRIES the stretch plays line
 * by line, so a track that keeps failing doesn't keep the server and its database awake.
 */
export const RETRY_FAILED_MS = 10 * 60_000;
export const MAX_TRIES = 3;

export type TrackStatus = "off" | "building" | "ready" | "failed";

/** The request for the stretch starting at `index`: up to TRACK_LINES lines in playback order. */
export function trackWindow(queue: QueueLine[], index: number, part: Part, max = TRACK_LINES): ListenTrackRequest {
  const lineIds: string[] = [];
  for (let i = playableFrom(queue, index, part); i !== null && lineIds.length < max; i = nextIndex(queue, i, part)) lineIds.push(queue[i]!.lineId);
  const mine = part.mine ? lineIds.filter((id) => part.mine!.has(id)) : [];
  return { lineIds, mine, mode: mine.length ? part.mode : "read" };
}

/**
 * The line under the player's controls about the screen lock, on the website. `covered`: the
 * engine has a track for the current line. A track that failed, or one the engine dropped (it
 * wouldn't play), leaves this stretch line by line, which a locked phone may stop: say so.
 */
export function lockNote(s: { playing: boolean; interrupted: boolean; status: TrackStatus; onTrack: boolean; covered: boolean }): string {
  if (s.interrupted && !s.playing) return "The phone stopped the play while the screen was off. Press play to carry on.";
  if (!s.playing || s.status === "off") return "";
  if (s.onTrack) return "Ready to play with the screen locked.";
  if (s.status === "building" || (s.status === "ready" && s.covered)) return "Getting ready to play with the screen locked… Keep the screen on until then.";
  return "This part can't play with the screen locked yet. Keep the screen on.";
}

/** Whether the listener at `index` needs a track asked for: none covers it, or the one that does ends soon. */
export function needsTrack(reach: number | null, index: number, queueLength: number): boolean {
  if (reach === null) return true;
  return reach < queueLength - 1 && reach - index < REFRESH_LINES;
}

/** One stretch being asked for: cancelled when the listener moves on, the player goes, or it gives up. */
export interface Poll {
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

interface Job extends Poll {
  queue: QueueLine[];
  part: Part;
  /** The stretch asked for, as line indexes [start, end). */
  start: number;
  end: number;
}

/**
 * Asks for one stretch's track until it is ready (`onReady`): again every POLL_MS while it builds,
 * and after a failure RETRY_FAILED_MS later, MAX_TRIES times in all before giving up.
 */
export function pollTrack(
  poll: Poll,
  ask: (req: ListenTrackRequest) => Promise<{ track: ListenTrack }>,
  req: ListenTrackRequest,
  on: { ready: (track: ListenTrack & { status: "ready" }) => void; failed: () => void },
): void {
  let tries = 0;
  const failed = () => {
    if (poll.cancelled) return;
    on.failed();
    // Giving up leaves the poll in place (not cancelled), so this stretch isn't asked for again.
    if (++tries < MAX_TRIES) poll.timer = setTimeout(once, RETRY_FAILED_MS);
  };
  const once = () => {
    ask(req).then(({ track }) => {
      if (poll.cancelled) return;
      if (track.status === "ready") on.ready(track);
      else if (track.status === "building") poll.timer = setTimeout(once, POLL_MS);
      else failed();
    }, failed);
  };
  once();
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
    pollTrack(next, ask, req, {
      ready: (track) => {
        engine.addTrack(track);
        setStatus("ready");
      },
      failed: () => setStatus("failed"),
    });
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
