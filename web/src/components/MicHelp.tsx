import { MicOff } from "lucide-react";
import type { MicErrorKind } from "../audio/recorder";
import { detectPlatform, type Platform } from "../lib/browser";

const STEPS: Record<Platform, string[]> = {
  ios: [
    "Tap “aA” in the address bar, then Website Settings.",
    "Set Microphone to Allow.",
    "If that's missing: Settings app → Safari → Microphone → Allow.",
    "Come back and tap Try again.",
  ],
  android: [
    "Tap the icon left of the address bar, then Permissions.",
    "Turn Microphone on.",
    "If Chrome itself is blocked: Settings → Apps → Chrome → Permissions → Microphone.",
    "Come back and tap Try again.",
  ],
  "mac-safari": [
    "In the menu bar choose Safari → Settings for This Website.",
    "Set Microphone to Allow.",
    "Then tap Try again.",
  ],
  "desktop-chrome": [
    "Click the icon at the left of the address bar.",
    "Turn Microphone on (or choose Allow).",
    "Then click Try again. You may need to reload the page.",
  ],
  "desktop-firefox": [
    "Click the microphone icon in the address bar.",
    "Remove the block, then click Try again and choose Allow.",
  ],
  "desktop-other": ["Allow microphone access for this site in your browser's settings, then try again."],
};

const TITLES: Record<MicErrorKind, string> = {
  denied: "The microphone is blocked",
  "no-mic": "No microphone found",
  busy: "The microphone is busy",
  insecure: "The microphone isn't available here",
  unsupported: "This browser can't record",
  unknown: "The microphone didn't start",
};

/** Recovery steps after a mic failure, for the platform in hand. */
export function MicHelp({ kind, onRetry }: { kind: MicErrorKind; onRetry: () => void }) {
  const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const steps =
    kind === "denied"
      ? STEPS[platform]
      : kind === "busy"
        ? ["Close other apps or tabs that might be using the mic (calls, voice notes).", "Then try again."]
        : kind === "no-mic"
          ? ["Plug in or switch on a microphone, or use your phone.", "Then try again."]
          : ["Open this link in Safari (iPhone) or Chrome (Android and computers)."];
  return (
    <div className="notice notice-error mic-help" role="alert">
      <MicOff size={20} aria-hidden="true" />
      <div className="stack" style={{ gap: 10 }}>
        <strong>{TITLES[kind]}</strong>
        <ol className="mic-steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <div>
          <button type="button" className="btn btn-primary btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
