import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/** The app's own native plugin (ios/App/App/OffbookedNativePlugin.swift). Only exists in the app. */
export interface OffbookedNativePlugin {
  /** Shows the run-through on the lock screen and in Control Center, and keeps it playing there. */
  setNowPlaying(info: { title: string; artist: string; album: string; playing: boolean }): Promise<void>;
  clearNowPlaying(): Promise<void>;
  /** Asks iOS for time to finish an upload if the app goes to the background meanwhile. */
  beginBackgroundWork(): Promise<void>;
  endBackgroundWork(): Promise<void>;
  addListener(event: "remoteCommand", listener: (e: { command: string }) => void): Promise<PluginListenerHandle>;
}

export const OffbookedNative = registerPlugin<OffbookedNativePlugin>("OffbookedNative");
