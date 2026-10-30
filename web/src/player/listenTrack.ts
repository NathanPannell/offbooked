import { useEffect, useState } from "react";
import type { LineAudioApi, ListenTrack, ListenTrackRequest } from "../api/types";
import type { Jump } from "./autoSkip";
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

/**
 * The request for the stretch starting at `index`: up to TRACK_LINES lines in playback order. With
 * "Skip to my cues", the lines a skip leaves out aren't in it (`skips` says where the fast-forward
 * sound goes), and it ends at a stop: what follows is asked for on its own (see stopAfter).
 */
export function trackWindow(queue: QueueLine[], index: number, part: Part, max = TRACK_LINES): ListenTrackRequest {
  const lineIds: string[] = [];
  const skips: string[] = [];
  for (let i = playableFrom(queue, index, part); i !== null && lineIds.length < max; i = nextIndex(queue, i, part)) {
    lineIds.push(queue[i]!.lineId);
    const jump = part.jumps?.get(i);
    if (jump?.kind === "stop") break;
    if (jump?.kind === "skip" && lineIds.length < max) skips.push(queue[i]!.lineId);
  }
  const mine = part.mine ? lineIds.filter((id) => part.mine!.has(id)) : [];
  return { lineIds, mine, mode: mine.length ? part.mode : "read", ...(skips.length ? { skips } : {}) };
}

/** Where a stretch asked for from `index` ends, as [start, end) line indexes, and the stop it ends at. */
export function windowSpan(queue: QueueLine[], index: number, part: Part, req: ListenTrackRequest): { start: number; end: number; stop: Jump | null } {
  const last = req.lineIds[req.lineIds.length - 1];
  let end = index;
  while (end < queue.length && queue[end]!.lineId !== last) end++;
  const jump = part.jumps?.get(end);
  return { start: index, end: end + 1, stop: jump?.kind === "stop" ? jump : null };
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
  /** It ends at a "Skip to my cues" stop: the stretch after the jump is asked for separately. */
  stop: Jump | null;
  ready?: boolean;
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
  // The request in flight (or the last one), kept across renders, and the one for the stretch
  // after a stop it ends at.
  const [box] = useState<{ job: Job | null; ahead: Job | null }>(() => ({ job: null, ahead: null }));

  useEffect(() => {
    const ask = api.track;
    if (!engine || !ask || !active || index < 0 || !queue.length) return;
    const same = (job: Job | null): job is Job => Boolean(job && !job.cancelled && sameLines(job.queue, queue) && samePart(job.part, part));
    const start = (from: number, main: boolean): Job | null => {
      const req = trackWindow(queue, from, part);
      if (!req.lineIds.length) return null;
      const job: Job = { queue, part, ...windowSpan(queue, from, part, req), cancelled: false };
      if (main) setStatus("building");
      pollTrack(job, ask, req, {
        ready: (track) => {
          job.ready = true;
          engine.addTrack(track);
          if (box.job === job) setStatus("ready");
        },
        failed: () => {
          if (box.job === job) setStatus("failed");
        },
      });
      return job;
    };

    const askMain = () => {
      const current = box.job;
      // Same script, part and mode as the stretch asked for last: ask again only once the listener
      // is outside it or near its end, and the engine has no track that covers them for a while yet.
      // A stretch that ends at a stop covers them to the stop.
      if (same(current)) {
        const coverEnd = current.stop || current.end >= queue.length ? current.end : current.end - REFRESH_LINES;
        if (index >= current.start && index < coverEnd) return;
        if (!current.stop && !needsTrack(engine.trackReach(index), index, queue.length)) return;
      }
      if (current) cancel(current);
      // The stretch after a stop, already asked for: it is the one now.
      const ahead = box.ahead;
      if (same(ahead) && ahead.start === index) {
        box.job = ahead;
        box.ahead = null;
        setStatus(ahead.ready ? "ready" : "building");
        return;
      }
      box.job = start(index, true);
    };
    askMain();

    // Near a stop, the stretch after the jump, so the jump needs no request with the phone locked.
    const stop = box.job?.stop;
    if (stop && index >= box.job!.end - REFRESH_LINES && !(same(box.ahead) && box.ahead.start === stop.to)) {
      if (box.ahead) cancel(box.ahead);
      box.ahead = start(stop.to, false);
    }
  }, [engine, api, queue, part, index, active, box]);

  // Stop asking when the player goes.
  useEffect(
    () => () => {
      if (box.job) cancel(box.job);
      if (box.ahead) cancel(box.ahead);
    },
    [box],
  );

  return active ? status : "off";
}

function cancel(job: Job) {
  job.cancelled = true;
  clearTimeout(job.timer);
}
