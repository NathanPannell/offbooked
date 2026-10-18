import { describe, expect, it } from "vitest";
import type { TakePart, TakePartResult, TakeUploadResult } from "../api/actor";
import { sendInParts } from "./uploader";

const done = { take: { id: "t1" }, linesRecorded: 1, linesTotal: 2 } as unknown as TakeUploadResult;

/** A fake server that joins parts like the real one: missing parts until all are in. */
function server(opts: { loseFirst?: boolean } = {}) {
  const got = new Map<number, string>();
  const calls: (TakePart | undefined)[] = [];
  let lost = !opts.loseFirst;
  const send = async (body: Blob, part?: TakePart): Promise<TakeUploadResult | TakePartResult> => {
    calls.push(part);
    if (!part) return done;
    if (!lost && part.index === 0) {
      lost = true; // e.g. a restart wiped it
    } else got.set(part.index, await body.text());
    const missing = Array.from({ length: part.total }, (_, i) => i).filter((i) => !got.has(i));
    return missing.length ? { partial: true, parts: part.total, missing } : done;
  };
  return { send, calls, got };
}

describe("uploading a long take in parts", () => {
  it("sends a short take in one request", async () => {
    const s = server();
    expect(await sendInParts(new Blob(["short"]), s.send, 10)).toBe(done);
    expect(s.calls).toEqual([undefined]);
  });

  it("splits a long take into byte ranges that join back into the same file", async () => {
    const s = server();
    const text = "abcdefghijklmnopqrstuvwxy"; // 25 bytes, parts of 10
    expect(await sendInParts(new Blob([text]), s.send, 10)).toBe(done);
    expect(s.calls).toEqual([0, 1, 2].map((index) => ({ index, total: 3 })));
    expect([0, 1, 2].map((i) => s.got.get(i)).join("")).toBe(text);
  });

  it("sends the parts the server says are missing again", async () => {
    const s = server({ loseFirst: true });
    expect(await sendInParts(new Blob(["abcdefghijklmnopqrstuvwxy"]), s.send, 10)).toBe(done);
    expect(s.calls.map((c) => c?.index)).toEqual([0, 1, 2, 0]);
  });
});
