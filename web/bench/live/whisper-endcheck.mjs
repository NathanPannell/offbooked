// Would a teacher-forced Whisper check end hands-free takes better than Moonshine and the live
// tracker? At chosen moments of each fixture take (mid-line: halfway through the speech and the
// middle of its longest beat; after the line: 300 and 700 ms past the last word) it asks:
//  - Moonshine: the live tracker's state from the passes recorded in live-takes.json that had come
//    back by then (desktop speed), as the app has it;
//  - Whisper: the most likely "first k words of the line, then nothing" for the audio so far;
//  - Whisper guided: the same, but only k from Moonshine's cursor on (it confirms the rest);
//  - either: Moonshine or Whisper guided.
// It also times a Whisper check and a Moonshine pass on the same audio, both on the page's main
// thread, so the CPU throttle (4 for a mid-range phone) slows both alike.
// Usage (with `npm run dev` running): node bench/live/whisper-endcheck.mjs <takes dir> [cpu throttle]
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [, , dir, throttle = "1"] = process.argv;
const fixtures = JSON.parse(readFileSync(path.join(dir, "fixtures.json"), "utf8"));
const recorded = JSON.parse(readFileSync(new URL("../../src/stt/fixtures/live-takes.json", import.meta.url), "utf8"));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("**/__fx/**", (route) =>
  route.fulfill({ body: readFileSync(path.join(dir, decodeURIComponent(route.request().url().split("/__fx/")[1]))), contentType: "audio/wav" }),
);
page.on("console", (m) => m.type() === "error" && console.log("page:", m.text().slice(0, 300)));
await page.goto("http://localhost:5173/");
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(throttle) });
const result = await page.evaluate(
  async ({ fixtures, recorded }) => {
    const models = await import("/bench/live/endcheck-models.mjs");
    const live = await import("/src/stt/live.ts");
    const { prepareForAsr } = await import("/src/stt/prepare.ts");
    let t = performance.now();
    const moonshine = await models.loadMoonshine();
    const moonshineLoadMs = performance.now() - t;
    t = performance.now();
    const whisper = await models.loadWhisper();
    const whisperLoadMs = performance.now() - t;
    const rows = [];
    for (const f of fixtures) {
      const buf = await (await fetch(`/__fx/${f.file}`)).arrayBuffer();
      const view = new DataView(buf);
      let off = 12;
      while (String.fromCharCode(...new Uint8Array(buf, off, 4)) !== "data") off += 8 + view.getUint32(off + 4, true);
      const n = view.getUint32(off + 4, true) / 2;
      const samples = new Float32Array(n);
      for (let k = 0; k < n; k++) samples[k] = view.getInt16(off + 8 + k * 2, true) / 32768;
      const longest = [...f.beats].sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
      const moments = [
        ["mid-speech", Math.round((f.speechStartMs + f.speechEndMs) / 2), false],
        ...(longest && longest[1] - longest[0] >= 1000 ? [["mid-beat", Math.round((longest[0] + longest[1]) / 2), false]] : []),
        ["end+300", f.speechEndMs + 300, true],
        ["end+700", f.speechEndMs + 700, true],
      ];
      const passes = recorded.find((r) => r.id === f.id)?.schedules.x1 ?? [];
      const { tokens } = live.segmentLine(f.text);
      for (const [what, at, over] of moments) {
        const audio = samples.slice(0, Math.min(n, Math.round((at / 1000) * 16000)));
        let start = performance.now();
        const w = await whisper(audio, f.text);
        const whisperMs = performance.now() - start;
        // A live pass hears the whole take up to 10 s, then its last 7 s.
        const heard = audio.length > 160000 ? audio.slice(audio.length - 112000) : audio;
        const prepared = prepareForAsr(heard);
        start = performance.now();
        await moonshine(prepared.noSpeech ? heard : prepared.audio);
        const moonshineMs = performance.now() - start;
        let p = live.startProgress(tokens.length);
        for (const q of passes) if (q.doneAtMs <= at) p = live.applyPass(p, tokens, q.text, q.windowed);
        const moon = p.ended || p.cursor >= tokens.length;
        // Moonshine's cursor in words of the line; Whisper guided only decides whether the rest followed.
        const from = Math.min(w.words, Math.round((p.cursor / Math.max(1, tokens.length)) * w.words));
        let k = from;
        for (let j = from; j <= w.words; j++) if (w.hyp[j] > w.hyp[k]) k = j;
        const guided = k >= w.words;
        rows.push({
          id: f.id,
          what,
          over,
          seconds: audio.length / 16000,
          whisperMs,
          moonshineMs,
          moon,
          whisper: w.saidWords >= w.words,
          guided,
          either: moon || guided,
        });
      }
    }
    return { moonshineLoadMs, whisperLoadMs, rows };
  },
  { fixtures, recorded },
);
await browser.close();

const { rows } = result;
const count = (key) => {
  const mid = rows.filter((r) => !r.over);
  const end = rows.filter((r) => r.over);
  const at300 = end.filter((r) => r.what === "end+300");
  return `${mid.filter((r) => r[key]).length}/${mid.length} false ends mid-line, end heard ${end.filter((r) => r[key]).length}/${end.length} (at +300 ms ${at300.filter((r) => r[key]).length}/${at300.length})`;
};
const spread = (key) => {
  const ms = rows.map((r) => r[key]).sort((a, b) => a - b);
  return `median ${Math.round(ms[ms.length >> 1])} ms, p90 ${Math.round(ms[Math.floor(ms.length * 0.9)])} ms, max ${Math.round(ms.at(-1))} ms`;
};
console.log(`CPU throttle ${throttle}, ${rows.length} moments over ${fixtures.length} takes`);
console.log(`load: Moonshine ${(result.moonshineLoadMs / 1000).toFixed(1)} s, Whisper ${(result.whisperLoadMs / 1000).toFixed(1)} s`);
console.log(`per check: Moonshine pass ${spread("moonshineMs")}; Whisper ${spread("whisperMs")}`);
for (const key of ["moon", "whisper", "guided", "either"]) console.log(`${key.padEnd(8)} ${count(key)}`);
