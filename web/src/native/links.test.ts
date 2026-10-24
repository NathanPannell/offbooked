import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../capacitor.config";
import { appPathFromUrl } from "./links";

describe("links that open the app", () => {
  it("lands cast and sign-in links on their page, keeping the query", () => {
    expect(appPathFromUrl("https://offbooked.com/join/abc123")).toBe("/join/abc123");
    expect(appPathFromUrl("https://www.offbooked.com/i/tok/play?part=p1")).toBe("/i/tok/play?part=p1");
    expect(appPathFromUrl("https://offbooked.com/auth/verify?token=t&next=%2Fapp&app=1")).toBe("/auth/verify?token=t&next=%2Fapp&app=1");
    expect(appPathFromUrl("https://OFFBOOKED.com/app/p/1?tab=cast")).toBe("/app/p/1?tab=cast");
  });

  it("takes the offbooked:// scheme too", () => {
    expect(appPathFromUrl("offbooked://join/abc")).toBe("/join/abc");
    expect(appPathFromUrl("offbooked://i/tok")).toBe("/i/tok");
    expect(appPathFromUrl("offbooked://signin")).toBe("/signin");
  });

  it("ignores anything else", () => {
    for (const url of [
      "https://evil.test/join/abc",
      "https://offbooked.com.evil.test/join/abc",
      "http://offbooked.com/join/abc",
      "https://offbooked.com/",
      "https://offbooked.com/join/",
      "https://offbooked.com/i/a/b/c",
      "offbooked://elsewhere",
      "javascript:alert(1)",
      "not a url",
    ])
      expect(appPathFromUrl(url), url).toBeNull();
  });

  it("the site's apple-app-site-association names this app and only paths the app opens", () => {
    const aasa = JSON.parse(readFileSync(new URL("../../public/.well-known/apple-app-site-association", import.meta.url), "utf8"));
    const [detail] = aasa.applinks.details;
    const appId = config.appId!.replace(/\./g, "\\.");
    for (const id of detail.appIDs) expect(id).toMatch(new RegExp(`^[A-Z0-9]+\\.${appId}$`));
    for (const component of detail.components) {
      const query = component["?"] ? `?${new URLSearchParams(component["?"])}` : "";
      const sample = `https://offbooked.com${component["/"].replace("*", "abc")}${query}`;
      expect(appPathFromUrl(sample), sample).not.toBeNull();
    }
  });
});
