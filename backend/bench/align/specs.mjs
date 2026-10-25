// The utterances say.ps1 speaks for the aligner fixtures: each line (and with a beat), its cue, its
// first words (for a restart), and an "Okay." and an "Um" in each voice.
// Usage: node bench/align/specs.mjs <specs.json>
import { writeFileSync } from "node:fs";
import { LINES, LONG, VOICES } from "./lines.mjs";

const [, , outFile = "specs.json"] = process.argv;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const out = [];
for (const l of [...LINES, LONG]) {
  const voice = VOICES[l.voice];
  const say = (id, body) => out.push({ id, voice, rate: l.rate, pitch: "default", body });
  say(l.id, esc(l.say.replace(/ \| /g, " ")));
  say(`${l.id}-beat`, esc(l.say).replace(/ \| /g, " <break time='1400ms'/> "));
  if (l.cue) say(`${l.id}-cue`, esc(l.cue));
  if (l.frag) say(`${l.id}-frag`, esc(l.frag));
}
for (const [k, voice] of Object.entries(VOICES)) {
  out.push({ id: `okay-${k}`, voice, rate: "medium", pitch: "default", body: "Okay." });
  out.push({ id: `um-${k}`, voice, rate: "medium", pitch: "default", body: "Um, sorry, line?" });
}
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(`${out.length} utterances`);
