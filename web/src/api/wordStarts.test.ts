import { afterEach, describe, expect, it, vi } from "vitest";
import { actorApi } from "./actor";
import { standins } from "./director";

// The server finds each take's words in the recording itself and trusts nothing from the phone but
// the audio, so a take never carries the phone's word timing.
describe("take uploads", () => {
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

  it("send no word timing, an actor's or a director's", async () => {
    stubFetch();
    await actorApi("token").putTake("line", audio, "take", 1000);
    await standins.putTake("line", audio, "take", 1000, undefined, null);
    expect(sent).toHaveLength(2);
    for (const headers of sent) {
      expect(headers.has("X-Word-Starts")).toBe(false);
      expect(headers.get("X-Take-Id")).toBe("take");
    }
  });
});
