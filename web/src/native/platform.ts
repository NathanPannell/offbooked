import { Capacitor } from "@capacitor/core";

/** True inside the iOS app (Capacitor), false on the website. See docs/mobile.md. */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}
