// User-agent sniffing is the only way to spot in-app browsers, which often block or limit the mic.

export interface InAppBrowser {
  name: string;
}

const IN_APP: [RegExp, string][] = [
  [/Instagram/i, "Instagram"],
  [/FBAN|FBAV|FB_IAB|FBIOS|FB4A/i, "Facebook"],
  [/Messenger|MessengerForiOS|MessengerLiteForiOS/i, "Messenger"],
  [/musical_ly|BytedanceWebview|TikTok|trill_/i, "TikTok"],
  [/LinkedInApp/i, "LinkedIn"],
  [/Snapchat/i, "Snapchat"],
  [/Twitter|TwitterAndroid/i, "X"],
  [/Line\/\d/i, "LINE"],
  [/MicroMessenger/i, "WeChat"],
  [/Pinterest/i, "Pinterest"],
  [/GSA\/\d/i, "the Google app"],
  [/\bWhatsApp/i, "WhatsApp"],
];

export function detectInAppBrowser(ua: string): InAppBrowser | null {
  for (const [pattern, name] of IN_APP) {
    if (pattern.test(ua)) return { name };
  }
  // Generic Android WebView ("; wv)") that isn't a full browser.
  if (/Android/i.test(ua) && /; wv\)/i.test(ua)) return { name: "this app" };
  return null;
}

export type Platform = "ios" | "android" | "mac-safari" | "desktop-chrome" | "desktop-firefox" | "desktop-other";

export function detectPlatform(ua: string, maxTouchPoints = 0): Platform {
  // iPadOS reports a Mac user agent, but has touch.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Firefox\//i.test(ua)) return "desktop-firefox";
  if (/Chrome\/|Chromium\/|Edg\//i.test(ua)) return "desktop-chrome";
  if (/Macintosh/i.test(ua) && /Safari\//i.test(ua)) return "mac-safari";
  return "desktop-other";
}

/** "Safari" on iOS, "Chrome" elsewhere, for "Open in …" copy. */
export function systemBrowserName(platform: Platform): string {
  return platform === "ios" || platform === "mac-safari" ? "Safari" : "Chrome";
}
