import { useEffect, useState, useSyncExternalStore } from "react";
import { SttSession } from "./session";

/**
 * One speech session per tab, shared by the actor pages, so the model that starts loading on the
 * cast link or welcome page is the one the recorder uses. It is freed (worker and 200–300 MB of
 * model memory) once no screen has used it for RELEASE_MS; the files stay in the Cache API.
 */
const RELEASE_MS = 20_000;
let shared: SttSession | null = null;
let users = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function sharedSession(): SttSession {
  shared ??= new SttSession();
  return shared;
}

function acquire(): () => void {
  clearTimeout(releaseTimer);
  users++;
  return () => {
    users--;
    if (users > 0) return;
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (users === 0) shared?.dispose();
    }, RELEASE_MS);
  };
}

/** The shared STT session, kept alive while the calling screen is mounted. */
export function useSttSession() {
  const [session] = useState(sharedSession);
  useEffect(acquire, []);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  return { session, state };
}

/**
 * Starts loading the model as soon as an actor page opens (when `ready`), so the accuracy check and
 * live highlighting are ready by the first take. `start` still declines on data saver or an
 * unsupported device.
 */
export function usePrewarmStt(ready: boolean) {
  const [session] = useState(sharedSession);
  useEffect(acquire, []);
  useEffect(() => {
    if (ready) void session.start();
  }, [ready, session]);
}
