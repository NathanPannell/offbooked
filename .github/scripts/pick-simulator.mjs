// Reads `xcrun simctl list devices available --json` on stdin and prints the UDID of an iPhone on
// the newest iOS runtime installed (preferring a plain "iPhone NN" over Pro/Max/Plus/e models).
import { readFileSync } from "node:fs";

const { devices } = JSON.parse(readFileSync(0, "utf8"));
const version = (runtime) => (runtime.match(/iOS-(\d+)-(\d+)/) ?? []).slice(1).map(Number);
const newer = (a, b) => b[0] - a[0] || b[1] - a[1];
const runtimes = Object.keys(devices)
  .filter((r) => r.includes("SimRuntime.iOS"))
  .sort((a, b) => newer(version(a), version(b)));
for (const runtime of runtimes) {
  const phones = devices[runtime].filter((d) => d.isAvailable && /^iPhone/.test(d.name));
  const pick = phones.find((d) => /^iPhone \d+$/.test(d.name)) ?? phones[0];
  if (pick) {
    console.error(`${pick.name} on ${runtime}`);
    console.log(pick.udid);
    process.exit(0);
  }
}
console.error("no available iPhone simulator");
process.exit(1);
