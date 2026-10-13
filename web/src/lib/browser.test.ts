import { describe, expect, it } from "vitest";
import { detectInAppBrowser, detectPlatform } from "./browser";

const UA = {
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  instagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0.0 (iPhone14,5; iOS 17_4; en_US)",
  facebook:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/460.0.0.0;FBBV/1]",
  messengerAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-A546B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/450.0.0.0;]",
  tiktok:
    "Mozilla/5.0 (Linux; Android 12; SM-G991B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 trill_340000 BytedanceWebview/d8a21c6",
  linkedin:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.1",
  snapchat:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.60.0.40 (like Safari/8617.1.17.10.9, panda)",
  androidWebView:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  desktopChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
};

describe("detectInAppBrowser", () => {
  it("leaves real browsers alone", () => {
    for (const ua of [UA.iosSafari, UA.androidChrome, UA.macSafari, UA.desktopChrome, UA.firefox]) {
      expect(detectInAppBrowser(ua)).toBeNull();
    }
  });

  it("names the common in-app browsers", () => {
    expect(detectInAppBrowser(UA.instagram)?.name).toBe("Instagram");
    expect(detectInAppBrowser(UA.facebook)?.name).toBe("Facebook");
    expect(detectInAppBrowser(UA.messengerAndroid)?.name).toBe("Facebook");
    expect(detectInAppBrowser(UA.tiktok)?.name).toBe("TikTok");
    expect(detectInAppBrowser(UA.linkedin)?.name).toBe("LinkedIn");
    expect(detectInAppBrowser(UA.snapchat)?.name).toBe("Snapchat");
  });

  it("catches unnamed Android WebViews", () => {
    expect(detectInAppBrowser(UA.androidWebView)?.name).toBe("this app");
  });
});

describe("detectPlatform", () => {
  it("tells the platforms apart", () => {
    expect(detectPlatform(UA.iosSafari)).toBe("ios");
    expect(detectPlatform(UA.androidChrome)).toBe("android");
    expect(detectPlatform(UA.macSafari)).toBe("mac-safari");
    expect(detectPlatform(UA.macSafari, 5)).toBe("ios");
    expect(detectPlatform(UA.desktopChrome)).toBe("desktop-chrome");
    expect(detectPlatform(UA.firefox)).toBe("desktop-firefox");
  });
});
