import { describe, expect, it } from "vitest";
import { FAQ, PLANS } from "./routes/landing/content";
import { headTags, pageFor, PAGES, SITE_URL, structuredData } from "./seo";

describe("marketing page metadata", () => {
  it("gives every page a title, description, canonical URL and link-preview tags", () => {
    expect(PAGES.map((p) => p.path)).toEqual(["/", "/pricing", "/privacy", "/terms"]);
    for (const page of PAGES) {
      const head = headTags(page);
      expect(head).toContain(`<title>${page.title}</title>`);
      expect(head).toContain(`<link rel="canonical" href="${SITE_URL}${page.path}">`);
      for (const tag of ["og:title", "og:description", "og:image", "og:url", "twitter:card", "twitter:image"]) expect(head).toContain(tag);
      expect(page.description.length).toBeLessThanOrEqual(200);
    }
  });

  it("puts structured data (the app, who makes it, the FAQ) on the landing page only", () => {
    expect(headTags(pageFor("/")!).match(/application\/ld\+json/g)).toHaveLength(3);
    expect(headTags(pageFor("/privacy")!)).not.toContain("ld+json");
    const [app, org, faq] = structuredData() as Record<string, unknown>[];
    expect(app!["@type"]).toBe("SoftwareApplication");
    expect(org!["@type"]).toBe("Organization");
    expect(faq!["@type"]).toBe("FAQPage");
    expect((faq!.mainEntity as unknown[]).length).toBe(FAQ.length);
  });

  it("escapes what it writes into HTML", () => {
    const head = headTags({ path: "/x", file: "x.html", title: `A "quoted" <b>`, description: "Fish & chips" });
    expect(head).toContain("<title>A &quot;quoted&quot; &lt;b&gt;</title>");
    expect(head).toContain('content="Fish &amp; chips"');
    expect(pageFor("/nowhere")).toBeUndefined();
  });
});

describe("the site's promises", () => {
  it("answers only what stops a director signing up, briefly", () => {
    expect(FAQ.map((f) => f.q)).toEqual([
      "Do my actors need an account?",
      "Is it free?",
      "What will it cost after the beta?",
      "Who can hear our recordings?",
      "What devices does it work on?",
    ]);
    expect(FAQ.length).toBeLessThanOrEqual(5);
    // Short answers: at most two sentences each.
    for (const f of FAQ) expect([f.q.endsWith("?"), f.a.length > 30, f.a.split(/(?<=[.!?])\s+(?=[A-Z])/).length <= 2]).toEqual([true, true, true]);
  });

  it("is free in the beta, and shows each launch price beside its founder price, half off", () => {
    expect(PLANS.filter((p) => p.now).map((p) => [p.name, p.price])).toEqual([["Public beta", "C$0"]]);
    expect(PLANS.filter((p) => !p.now).map((p) => [p.name, p.was, p.price])).toEqual([
      ["Show Pass", "C$79", "C$39"],
      ["Season", "C$249", "C$125"],
    ]);
    // The FAQ quotes the same prices.
    expect(FAQ.find((f) => f.q.includes("cost"))!.a).toContain("C$79 per production, or C$39 at the founder price");
  });
});
