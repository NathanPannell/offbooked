// Runs the real live speech model (Moonshine in the app's worker, through the Vite dev server) over
// each fixture take, pacing and windowing passes exactly as useLiveTake does, in virtual time: a pass
// starts when the one before it (and the pacing wait) is over, hears the audio up to that moment and
// answers after its measured latency. `slow` multiplies every latency, as on a slow phone.
// Writes the fixtures with their 20 ms frame levels and every pass, for the pure replay.
// Usage (with `npm run dev` running): node bench/live/record-passes.mjs <takes dir> <out.json> [slow factors, e.g. 1,3,5]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [, , dir, outFile, factors = "1,3"] = process.argv;
const fixtures = JSON.parse(readFileSync(path.join(dir, "fixtures.json"), "utf8"));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("**/__fx/**", (route) =>
  route.fulfill({ body: readFileSync(path.join(dir, decodeURIComponent(route.request().url().split("/__fx/")[1]))), contentType: "audio/wav" }),
);
page.on("console", (m) => m.type() === "error" && console.log("page:", m.text()));
await page.goto("http://localhost:5173/");
const result = await page.evaluate(
  async ({ fixtures, factors }) => {
    const { SttSession } = await import("/src/stt/session.ts");
    const { prepareForAsr } = await import("/src/stt/prepare.ts");
    const live = await import("/src/stt/live.ts");
    const s = new SttSession();
    await s.start();
    for (let i = 0; i < 600 && s.getState().status !== "ready"; i++) await new Promise((r) => setTimeout(r, 200));
    if (s.getState().status !== "ready") throw new Error("model not ready: " + s.getState().status);
    const RATE = 16000;
    const FRAME = RATE / 50;
    const out = [];
    for (const f of fixtures) {
      const buf = await (await fetch(`/__fx/${f.file}`)).arrayBuffer();
      const view = new DataView(buf);
      let off = 12;
      while (off < buf.byteLength && String.fromCharCode(...new Uint8Array(buf, off, 4)) !== "data") off += 8 + view.getUint32(off + 4, true);
      const n = view.getUint32(off + 4, true) / 2;
      const samples = new Float32Array(n);
      for (let k = 0; k < n; k++) samples[k] = view.getInt16(off + 8 + k * 2, true) / 32768;
      const frameDb = [];
      for (let k = 0; k + FRAME <= n; k += FRAME) frameDb.push(Math.round(live.rmsDb(samples, k, k + FRAME) * 10) / 10);
      // Voiced time by ms, as the live VAD has it (the loop only transcribes once there's speech).
      let vad = live.startVad();
      const speechAt = [];
      // When the voice pauses (useLiveTake wakes its pass loop then, if live.pauseBegan exists).
      const pauses = [];
      for (let k = 0; k < frameDb.length; k++) {
        const before = vad;
        vad = live.vadStep(vad, frameDb[k], 20);
        speechAt.push(vad.speechMs);
        if (live.pauseBegan && live.pauseBegan(before, vad)) pauses.push((k + 1) * 20);
      }
      const schedules = {};
      for (const slow of factors) {
        const passes = [];
        let tv = 0;
        let latency = 400;
        let covered = 0;
        while (tv < (n / RATE) * 1000) {
          const began = tv;
          const total = Math.min(n, Math.floor((tv / 1000) * RATE));
          const speech = speechAt[Math.min(speechAt.length - 1, Math.floor(tv / 20))] ?? 0;
          if (speech > 0 && total >= RATE / 2 && total - covered >= RATE / 5) {
            const { full, window } = live.passWindowSeconds(latency);
            const windowed = total > full * RATE;
            const from = windowed ? total - window * RATE : 0;
            const prepared = prepareForAsr(samples.slice(from, total));
            if (!prepared.noSpeech) {
              const t0 = performance.now();
              const text = await s.transcribeLive(prepared.audio);
              latency = (performance.now() - t0) * slow;
              tv += latency;
              passes.push({
                fromMs: Math.round((from / RATE) * 1000),
                toMs: Math.round((total / RATE) * 1000),
                windowed,
                text,
                doneAtMs: Math.round(tv),
                latencyMs: Math.round(latency),
              });
            }
            covered = total;
          }
          const heardTo = (total / RATE) * 1000;
          const paced = began + live.nextPassInterval(latency);
          const pause = pauses.find((p) => p > heardTo && p < paced);
          tv = pause === undefined ? Math.max(tv, paced) : Math.max(tv, pause);
        }
        schedules[`x${slow}`] = passes;
      }
      out.push({ id: f.id, text: f.text, speechStartMs: f.speechStartMs, speechEndMs: f.speechEndMs, beats: f.beats, totalMs: f.totalMs, frameDb, schedules });
    }
    return out;
  },
  { fixtures, factors: factors.split(",").map(Number) },
);
writeFileSync(outFile, JSON.stringify(result));
for (const f of result)
  console.log(
    f.id,
    Object.entries(f.schedules)
      .map(([k, p]) => `${k}: ${p.length} passes, last "${p.at(-1)?.text}"`)
      .join(" | "),
  );
await browser.close();
