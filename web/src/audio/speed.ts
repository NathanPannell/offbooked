import { useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "../lib/storage";

// How fast recordings play back: one speed for every player in the app (the run-through, Listen
// back and the other takes on a recording screen), picked with SpeedButton and remembered on this
// device. Voices keep their pitch at any speed.

/** The speeds a tap on SpeedButton steps through, in order; after the last it starts again. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const MIN_SPEED = SPEEDS[0];
export const MAX_SPEED = SPEEDS[SPEEDS.length - 1];
export const DEFAULT_SPEED = 1;
export const SPEED_KEY = "offbooked.playbackSpeed";

/** Any rate as one the players accept: between MIN_SPEED and MAX_SPEED, 1× for nonsense. */
export function clampSpeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_SPEED;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, value));
}

/** The speed after `current` on a tap: the next step up, or the slowest after the fastest. */
export function nextSpeed(current: number): number {
  const up = SPEEDS.find((s) => s > clampSpeed(current) + 1e-9);
  return up ?? SPEEDS[0];
}

export const formatSpeed = (speed: number) => `${speed}×`;

/** The step nearest any rate (clamped first), so a speed set in code is always one offered. */
export function snapSpeed(value: unknown): number {
  const r = clampSpeed(value);
  return SPEEDS.reduce((best, s) => (Math.abs(s - r) < Math.abs(best - r) ? s : best), DEFAULT_SPEED as number);
}

/**
 * How long until a clip playing at `rate` reaches `endMs` of its media, from `currentTimeS`: the
 * timer that ends Listen back at the end of the voice.
 */
export function msUntil(endMs: number, currentTimeS: number, rate: number): number {
  return Math.max(0, endMs - currentTimeS * 1000) / (rate > 0 ? rate : 1);
}

/** A stored speed, or 1× when there is none or it isn't one of the steps. */
export function parseSpeed(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  return (SPEEDS as readonly number[]).includes(n) ? n : DEFAULT_SPEED;
}

type PitchAudio = HTMLMediaElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };

/**
 * Plays `audio` at `rate`, pitch kept. Sets defaultPlaybackRate too: loading a new src resets
 * playbackRate to it, so the next clip keeps the speed.
 */
export function applySpeed(audio: HTMLMediaElement, rate: number): void {
  const a = audio as PitchAudio;
  a.preservesPitch = true;
  a.webkitPreservesPitch = true; // Safari before 17
  a.mozPreservesPitch = true; // Firefox before 101
  const r = clampSpeed(rate);
  a.defaultPlaybackRate = r;
  a.playbackRate = r;
}

// The chosen speed, shared by every player on the page and kept in step across tabs.
let current: number | null = null;
const listeners = new Set<() => void>();

export function getSpeed(): number {
  return (current ??= parseSpeed(readStorage(SPEED_KEY)));
}

export function setSpeed(speed: number): void {
  const next = snapSpeed(speed);
  if (next === getSpeed()) return;
  current = next;
  writeStorage(SPEED_KEY, String(next));
  listeners.forEach((l) => l());
}

const onStorage = (e: StorageEvent) => {
  // null: another tab cleared storage.
  if (e.key !== SPEED_KEY && e.key !== null) return;
  current = parseSpeed(e.key === null ? null : e.newValue);
  listeners.forEach((l) => l());
};

export function subscribeSpeed(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    // Unheard while nothing listens, so read it again next time: another tab may have changed it.
    current = null;
  };
}

/** For tests: forget the speed read from storage. */
export function resetSpeedForTests(): void {
  current = null;
}

/** The chosen playback speed, re-rendering when it changes (here or in another tab). */
export function usePlaybackSpeed(): number {
  return useSyncExternalStore(subscribeSpeed, getSpeed, () => DEFAULT_SPEED);
}
