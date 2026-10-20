import { afterEach, describe, expect, it, vi } from "vitest";
import { actorApi, MAX_WORD_STARTS, MAX_WORD_STARTS_HEADER, wordStartHeaders } from "./actor";
import { standins } from "./director";

describe("X-Word-Starts", () => {
  it("sends one start per word, in whole ms", () => {
    expect(wordStartHeaders([120.4, 480, 1300.6])).toEqual({ "X-Word-Starts": "120,480,1301" });
    expect(wordStartHeaders([])).toEqual({});
    expect(wordStartHeaders(null)).toEqual({});
  });

  it("is left out when there are too many to send safely, so the take still uploads", () => {
    const many = Array.from({ length: MAX_WORD_STARTS + 1 }, (_, i) => i);
    expect(wordStartHeaders(many)).toEqual({});
    // Under the count but over the size: an hour-long take's starts are long numbers.
    const long = Array.from({ length: 1500 }, (_, i) => 3_000_000 + i);
    expect(long.join(",").length).toBeGreaterThan(MAX_WORD_STARTS_HEADER);
    expect(wordStartHeaders(long)).toEqual({});
    const fits = Array.from({ length: 1000 }, (_, i) => i * 7);
    expect(wordStartHeaders(fits)["X-Word-Starts"]).toBeDefined();
  });

  describe("on the uploads", () => {
    const sent: Headers[] = [];
    afterEach(() => {
      vi.unstubAllGlobals();
      sent.length = 0;
    });
    const stubFetch = () =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          sent.push(new Headers(init.headers));
          return new Response(JSON.stringify({ take: {}, linesRecorded: 1, linesTotal: 1 }), { status: 200, headers: { "content-type": "application/json" } });
        }),
      );
    const audio = new Blob(["x"], { type: "audio/webm" });
    const tooMany = Array.from({ length: MAX_WORD_STARTS + 5 }, (_, i) => i * 10);

    it("an actor's take carries them, and leaves too many out", async () => {
      stubFetch();
      const api = actorApi("token");
      await api.putTake("line", audio, "take", 1000, undefined, undefined, [100, 400]);
      await api.putTake("line", audio, "take", 1000, undefined, undefined, tooMany);
      expect(sent[0]!.get("X-Word-Starts")).toBe("100,400");
      expect(sent[1]!.has("X-Word-Starts")).toBe(false);
    });

    it("a director's take too", async () => {
      stubFetch();
      await standins.putTake("line", audio, "take", 1000, undefined, null, undefined, [100, 400]);
      await standins.putTake("line", audio, "take", 1000, undefined, null, undefined, tooMany);
      expect(sent[0]!.get("X-Word-Starts")).toBe("100,400");
      expect(sent[1]!.has("X-Word-Starts")).toBe(false);
    });
  });
});
