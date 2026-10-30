import { OffbookedNative } from "./offbooked";
import { isNativeApp } from "./platform";

export interface NowPlayingInfo {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
}

export type RemoteCommand = "play" | "pause" | "toggle" | "next" | "previous";

export interface Controls {
  play(): void;
  pause(): void;
  toggle(): void;
  next(): void;
  previous(): void;
}

/** Lock screen, Control Center and headphone controls for whatever is playing. */
export interface NowPlaying {
  show(info: NowPlayingInfo): void;
  /** Routes the system's play, pause, next and previous to `controls`; returns the unsubscribe. */
  connect(controls: Controls): () => void;
}

const COMMANDS: Record<string, (c: Controls) => void> = {
  play: (c) => c.play(),
  pause: (c) => c.pause(),
  toggle: (c) => c.toggle(),
  next: (c) => c.next(),
  previous: (c) => c.previous(),
};

/** Runs one command from the lock screen; anything unknown is ignored. */
export function applyCommand(controls: Controls, command: string): boolean {
  const run = COMMANDS[command];
  if (!run) return false;
  run(controls);
  return true;
}

/** In the app: the native plugin, so the run-through keeps going with the screen locked. */
export function nativeNowPlaying(plugin = OffbookedNative): NowPlaying {
  return {
    show: (info) => void plugin.setNowPlaying(info).catch(() => {}),
    connect(controls) {
      let closed = false;
      const handle = plugin.addListener("remoteCommand", (e) => applyCommand(controls, e.command));
      return () => {
        if (closed) return;
        closed = true;
        void handle.then((h) => h.remove()).catch(() => {});
        void plugin.clearNowPlaying().catch(() => {});
      };
    },
  };
}

/**
 * The lock screen's buttons on the website. Next and previous move by line, or with a part by cue
 * (PlayerEngine); no seek handlers, so iOS shows them as track buttons rather than skip-15-seconds.
 * "stop" (some Android headsets and notifications) pauses.
 */
const WEB_ACTIONS = { play: "play", pause: "pause", stop: "pause", nexttrack: "next", previoustrack: "previous" } as const;

/** On the website: the Media Session API, where the browser has it. */
export function webNowPlaying(nav: Navigator = navigator): NowPlaying {
  const session = "mediaSession" in nav ? nav.mediaSession : null;
  return {
    show(info) {
      if (!session) return;
      session.metadata = new MediaMetadata({ title: info.title, artist: info.artist, album: info.album });
      session.playbackState = info.playing ? "playing" : "paused";
    },
    connect(controls) {
      if (!session) return () => {};
      for (const [action, command] of Object.entries(WEB_ACTIONS)) {
        try {
          session.setActionHandler(action as MediaSessionAction, () => applyCommand(controls, command));
        } catch {
          // An action this browser doesn't know ("stop" in older Safari) throws; the rest still work.
        }
      }
      return () => {
        for (const action of Object.keys(WEB_ACTIONS)) {
          try {
            session.setActionHandler(action as MediaSessionAction, null);
          } catch {
            // Never set (see above).
          }
        }
        // Off the player: nothing is playing, so the lock screen shouldn't name a line.
        session.metadata = null;
        session.playbackState = "none";
      };
    },
  };
}

export function nowPlaying(): NowPlaying {
  return isNativeApp() ? nativeNowPlaying() : webNowPlaying();
}
