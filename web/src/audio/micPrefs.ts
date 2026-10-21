// What a device remembers about recording: the chosen mic, and the two first-run moments (the mic
// check before the very first take, and the one hint shown on it). All in localStorage, all
// guarded: without storage the app still works and simply shows the first-run help again.

import { readStorage, removeStorage, writeStorage } from "../lib/storage";

export const MIC_DEVICE_KEY = "offbooked.micDevice";
export const MIC_CHECKED_KEY = "offbooked.micChecked";
export const FIRST_TAKE_HINT_KEY = "offbooked.firstTakeHint";

/** The mic picked in mic settings, or null for the browser's default. */
export function rememberedMic(): string | null {
  return readStorage(MIC_DEVICE_KEY) || null;
}

export function rememberMic(deviceId: string | null): void {
  if (deviceId) writeStorage(MIC_DEVICE_KEY, deviceId);
  else removeStorage(MIC_DEVICE_KEY);
}

export interface MicOption {
  /** "" is the browser's default mic. */
  id: string;
  label: string;
}

/**
 * The mics to offer, from `enumerateDevices`: the default first, then each input once. Browsers
 * leave labels empty until the mic has been allowed, so those get a plain numbered name.
 */
export function micOptions(devices: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[]): MicOption[] {
  const options: MicOption[] = [{ id: "", label: "Default microphone" }];
  let n = 0;
  for (const d of devices) {
    // Chrome lists the default and communications devices again under these ids.
    if (d.kind !== "audioinput" || !d.deviceId || d.deviceId === "default" || d.deviceId === "communications") continue;
    if (options.some((o) => o.id === d.deviceId)) continue;
    n++;
    options.push({ id: d.deviceId, label: d.label.trim() || `Microphone ${n}` });
  }
  return options;
}

/** The mic to use: the remembered one while it is still plugged in, else the default (""). */
export function chooseMic(options: readonly MicOption[], remembered: string | null): string {
  return remembered && options.some((o) => o.id === remembered) ? remembered : "";
}

/** Whether to offer the mic check: only before the very first take on this device. */
export function needsMicCheck(): boolean {
  return readStorage(MIC_CHECKED_KEY) !== "1";
}

/** The mic check was done or skipped, or a take was recorded: never offer it again. */
export function markMicChecked(): void {
  writeStorage(MIC_CHECKED_KEY, "1");
}

/** True the first time it is asked on this device, then never again: the first take's hint. */
export function claimFirstTakeHint(): boolean {
  if (readStorage(FIRST_TAKE_HINT_KEY) === "1") return false;
  writeStorage(FIRST_TAKE_HINT_KEY, "1");
  return true;
}
