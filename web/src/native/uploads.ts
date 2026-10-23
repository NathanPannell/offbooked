import { App } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { openTakeStore, type TakeStore } from "../upload/store";
import { capacitorTakeFiles } from "./capacitorFiles";
import { FileTakeStore, type TakeFiles } from "./fileTakeStore";
import { OffbookedNative } from "./offbooked";

/** The app's take store: files in its own container, or IndexedDB if the folder can't be read. */
export async function openNativeTakeStore(files: TakeFiles = capacitorTakeFiles, fallback = openTakeStore): Promise<{ store: TakeStore; persistent: boolean }> {
  const store = new FileTakeStore(files);
  try {
    await store.open();
    return { store, persistent: true };
  } catch {
    return fallback();
  }
}

/**
 * Takes waiting on the phone go up as soon as there's a way: when the phone gets a signal back
 * (iOS tells the app, rather than the web view's unreliable `online` event) and whenever the app
 * comes back to the front. While one is uploading, iOS is asked for time to finish it if the app
 * goes to the background.
 */
export function connectNativeUploads(uploader: { retryNow(): void }) {
  void Network.addListener("networkStatusChange", (status) => {
    if (status.connected) uploader.retryNow();
  });
  void App.addListener("resume", () => uploader.retryNow());
}

export function nativeBusyChange(busy: boolean) {
  void (busy ? OffbookedNative.beginBackgroundWork() : OffbookedNative.endBackgroundWork()).catch(() => {});
}
