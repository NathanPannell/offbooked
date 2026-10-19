import { Copy, ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { detectInAppBrowser, detectPlatform, systemBrowserName } from "../lib/browser";
import { copyText } from "../lib/share";
import { useToast } from "./Toast";

/** In-app browsers (Instagram, Messenger, TikTok…) often block the mic. Steer people to a real browser. */
export function InAppBanner() {
  const toast = useToast();
  const info = useMemo(() => {
    const inApp = detectInAppBrowser(navigator.userAgent);
    if (!inApp) return null;
    const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
    return { inApp, platform, browser: systemBrowserName(platform) };
  }, []);
  if (!info) return null;

  const url = window.location.href;
  // Android can hand the page straight to Chrome. iOS has no such link, so we copy.
  const chromeIntent =
    info.platform === "android"
      ? `intent://${url.replace(/^https?:\/\//, "")}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`
      : null;

  return (
    <div className="notice notice-warn in-app" role="alert">
      <ExternalLink size={20} aria-hidden="true" />
      <div className="stack" style={{ gap: 10 }}>
        <p>
          <strong>Open this in {info.browser}.</strong> {info.inApp.name === "this app" ? "This app's" : `${info.inApp.name}'s`} built-in browser often can't
          use the microphone.
          {info.platform === "ios" ? " Tap ••• or the share icon, then “Open in Safari”, or copy the link and paste it into Safari." : ""}
        </p>
        <div className="row">
          {chromeIntent && (
            <a className="btn btn-primary btn-sm" href={chromeIntent}>
              Open in Chrome
            </a>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={async () => toast((await copyText(url)) ? "Link copied" : "Couldn't copy. Press and hold the address instead.")}
          >
            <Copy size={16} aria-hidden="true" /> Copy link
          </button>
        </div>
      </div>
    </div>
  );
}
