import { useEffect, useState } from "react";
import type { LineAudioApi, ListenTrack, ListenTrackRequest } from "../api/types";
import type { Jump } from "./autoSkip";
import { TRACK_URL_FRESH_MS, type PlayerEngine } from "./engine";
import { nextIndex, playableFrom, sameLines, samePart, type Part, type QueueLine } from "./queue";

// Keeps a listen track ready for where the listener is in the play, so the website keeps playing
// with the phone locked (see PlayerEngine and the server's track/track.ts). The stretch around the
// current line is asked for as soon as the player opens, before play: the server builds the usual
// ones ahead of time (track/prebuild.ts), so the first play usually starts on the track. When it
// isn't ready, play starts line by line and the engine moves onto the track at the next line once
// it is. Stretches start every TRACK_STRIDE lines, the ones built ahead; near the end of one the
// next is asked for, and a jump outside it, or a change of part or mode, asks again from there.
// With "Skip to my cues" a stretch is this listener's own (it leaves lines out and may end at a
// stop), so nothing is built ahead for it: it starts at their line and is built when asked for.

/** The most lines one track covers (the server's MAX_TRACK_LINES). */
export const TRACK_LINES = 300;
/** Ask for the next stretch once the listener is this close to the end of the one playing. */
export const REFRESH_LINES = 40;
/** Stretches start every this many lines (the server's TRACK_STRIDE), so each overlaps the next by REFRESH_LINES. */
export const TRACK_STRIDE = TRACK_LINES - REFRESH_LINES;

/** Where the stretch for the line at `index` starts, in a queue of `count` lines (the server's trackStart). */
export function trackStart(index: number, count: number): number {
  const last = Math.max(0, Math.ceil((count - TRACK_LINES) / TRACK_STRIDE)) * TRACK_STRIDE;
  return Math.min(Math.floor(Math.max(0, index) / TRACK_STRIDE) * TRACK_STRIDE, last);
}
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
 * The player bar's note about the screen lock, on the website. `covered`: the engine has a track
 * for the current line. A track that failed, or one the engine dropped (it wouldn't play), leaves
 * this stretch line by line, which a locked phone may stop: say so.
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

/**
 * Where to ask for a stretch from, for a listener at `index`, or null to keep the one asked for:
 * it covers them (to its stop, or to where the next one is asked for) and its URL is fresh, or the
 * engine has a track that covers them for a while yet. `reach`: the last line of the engine's track
 * for `index`. From the grid of tracks built ahead, unless "Skip to my cues" plans jumps: a grid
 * line may be on the far side of a stop from the listener, so those stretches start at their line.
 */
export function stretchToAsk(
  asked: { queue: QueueLine[]; part: Part; start: number; end: number; stop: Jump | null; at: number } | null,
  queue: QueueLine[],
  part: Part,
  index: number,
  reach: number | null,
  now = Date.now(),
): number | null {
  const start = part.jumps?.size ? index : trackStart(index, queue.length);
  if (!asked || !sameLines(asked.queue, queue) || !samePart(asked.part, part)) return start;
  const coverEnd = asked.stop || asked.end >= queue.length ? asked.end : asked.end - REFRESH_LINES;
  // Asked on open, hours before play: again, for a URL the engine will still use.
  if (index >= asked.start && index < coverEnd) return now - asked.at > TRACK_URL_FRESH_MS ? asked.start : null;
  if (!asked.stop && !needsTrack(reach, index, queue.length)) return null;
  return start;
}

/** Where to fetch the stretch after a stop from, once the listener at `index` nears the stop that stretch `job` ends at. */
export function stopToFetch(job: { end: number; stop: Jump | null } | null, index: number): number | null {
  return job?.stop && index >= job.end - REFRESH_LINES ? job.stop.to : null;
}

/** One stretch being asked for: cancelled when the listener moves on, the player goes, or it gives up. */
export interface Poll {
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

interface Job extends Poll {
  queue: QueueLine[];
  part: Part;
  /** The first line of the stretch asked for, and when (Date.now()). */
  start: number;
  at: number;
  end: number;
  /** It ends at a "Skip to my cues" stop: the stretch after the jump is asked for separately. */
  stop: Jump | null;
  ready?: boolean;
  failed?: boolean;
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
 * Asks for listen tracks while `active` (the player is open, on the website) and hands each ready
 * one to the engine. Returns where the newest one stands.
 */
export function useListenTrack(opts: {
  engine: PlayerEngine | null;
  api: LineAudioApi;
  queue: QueueLine[];
  part: Part;
  index: number;
  active: boolean;
  /** Playing: a play after the player sat open for hours asks again for a fresh URL. */
  playing: boolean;
}): TrackStatus {
  const { engine, api, queue, part, index, active, playing } = opts;
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
      const job: Job = { queue, part, ...windowSpan(queue, from, part, req), at: Date.now(), cancelled: false };
      if (main) setStatus("building");
      pollTrack(job, ask, req, {
        ready: (track) => {
          job.ready = true;
          engine.addTrack(track);
          if (box.job === job) setStatus("ready");
        },
        failed: () => {
          job.failed = true;
          if (box.job === job) setStatus("failed");
        },
      });
      return job;
    };

    // A stretch fetched ahead of a stop that no longer fits (the skips or the part changed).
    if (box.ahead && !same(box.ahead)) {
      cancel(box.ahead);
      box.ahead = null;
    }

    const askMain = () => {
      const current = box.job;
      const from = stretchToAsk(current && !current.cancelled ? current : null, queue, part, index, engine.trackReach(index));
      if (from === null) return;
      if (current) cancel(current);
      // The stretch after a stop, already asked for: it is the one now.
      const ahead = box.ahead;
      if (same(ahead) && ahead.start === from) {
        box.job = ahead;
        box.ahead = null;
        setStatus(ahead.ready ? "ready" : ahead.failed ? "failed" : "building");
        return;
      }
      box.job = start(from, true);
    };
    askMain();

    // Near a stop, the stretch after the jump, so the jump needs no request with the phone locked.
    const after = stopToFetch(box.job, index);
    if (after !== null && !(same(box.ahead) && box.ahead.start === after)) {
      if (box.ahead) cancel(box.ahead);
      box.ahead = start(after, false);
    }
  }, [engine, api, queue, part, index, active, playing, box]);

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
