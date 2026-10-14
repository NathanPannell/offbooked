// Runs fixtures through the real parser (Claude Haiku) and scores them against their goldens.
//   node --env-file-if-exists=.env bench/run.ts [--dir bench/fixtures] [--only slug,slug] [--no-llm]
// Results: bench/results/history.jsonl (appended), bench/results/latest.md, and the full
// prediction plus speaker errors per fixture in .data/bench/ (gitignored).
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createClaudeLabeler } from "../src/parse/label.ts";
import { parseScriptText } from "../src/parse/pipeline.ts";
import { detectSourceKind, extractSourceText } from "../src/parse/source.ts";
import { pct, scoreParse, type Golden } from "./score.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string", default: path.join(import.meta.dirname, "fixtures") },
    only: { type: "string" },
    "no-llm": { type: "boolean", default: false },
    label: { type: "string", default: "" },
  },
});

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!values["no-llm"] && !apiKey) throw new Error("ANTHROPIC_API_KEY is not set (run from backend/ with .env)");
const labeler = values["no-llm"] ? null : createClaudeLabeler(apiKey!);
const log = {
  info() {},
  warn(obj: unknown, msg?: string) {
    console.warn("  warn:", msg, JSON.stringify(obj).slice(0, 300));
  },
  error(obj: unknown, msg?: string) {
    console.error("  error:", msg, JSON.stringify(obj).slice(0, 300));
  },
};

const only = values.only ? new Set(values.only.split(",")) : null;
const slugs = fs
  .readdirSync(values.dir!, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (!only || only.has(d.name)))
  .map((d) => d.name)
  .sort();
const outDir = path.join(import.meta.dirname, "..", ".data", "bench");
const resultsDir = path.join(import.meta.dirname, "results");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });
const holdout = !path.resolve(values.dir!).startsWith(path.resolve(import.meta.dirname));

const rows: string[] = [];
for (const slug of slugs) {
  const dir = path.join(values.dir!, slug);
  const sourceFile = fs.readdirSync(dir).find((f) => f.startsWith("source."));
  if (!sourceFile) continue;
  const goldenPath = path.join(dir, "golden.json");
  const golden: Golden | null = fs.existsSync(goldenPath) ? JSON.parse(fs.readFileSync(goldenPath, "utf8")) : null;
  const data = fs.readFileSync(path.join(dir, sourceFile));
  const started = Date.now();
  process.stdout.write(`${slug} (${sourceFile}) … `);
  try {
    const kind = detectSourceKind(data, sourceFile);
    const text = await extractSourceText(data, kind);
    const { structure, usage } = await parseScriptText(text, { labeler, log });
    const seconds = (Date.now() - started) / 1000;
    const flagged = structure.lines.filter((l) => l.flagReason).length;
    fs.writeFileSync(path.join(outDir, `${slug}.pred.json`), JSON.stringify({ usage, structure }, null, 1));
    const record: Record<string, unknown> = {
      at: new Date().toISOString(),
      label: values.label,
      slug,
      holdout,
      format: kind,
      seconds,
      chunks: usage.chunks,
      fallbackChunks: usage.fallbackChunks,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      lines: structure.lines.length,
      flagged,
      characters: structure.characters.length,
    };
    if (golden) {
      const { errors, ...score } = scoreParse(golden, structure);
      Object.assign(record, score);
      fs.writeFileSync(path.join(outDir, `${slug}.errors.txt`), [...score.failures, "", ...errors].join("\n"));
      console.log(`${score.pass ? "PASS" : "FAIL"} ${seconds.toFixed(0)}s speaker ${pct(score.speakerAccuracy)} speech ${pct(score.speechAccuracy)} recall ${pct(score.recall)} precision ${pct(score.precision)} names ${pct(score.nameAgreement)} sections ${score.sections.pred}/${score.sections.gold} flagged ${flagged}`);
      if (!score.pass) console.log(`   ${score.failures.join(" | ")}`);
      rows.push(`| ${slug} | ${kind} | ${score.pass ? "✅" : "❌"} | ${pct(score.speakerAccuracy)} | ${pct(score.speechAccuracy)} | ${pct(score.recall)} | ${pct(score.precision)} | ${pct(score.nameAgreement)} | ${score.sections.pred}/${score.sections.gold} | ${flagged} | ${seconds.toFixed(0)}s | ${usage.inputTokens + usage.outputTokens} |`);
    } else {
      console.log(`parsed in ${seconds.toFixed(0)}s, ${structure.lines.length} lines, no golden`);
    }
    fs.appendFileSync(path.join(resultsDir, "history.jsonl"), JSON.stringify(record) + "\n");
  } catch (err) {
    console.log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
    rows.push(`| ${slug} | | ❌ error | | | | | | | | | |`);
  }
}

if (rows.length && !holdout && !only) {
  const table = [
    `# Parser benchmark (${new Date().toISOString().slice(0, 16)}Z${values.label ? `, ${values.label}` : ""})`,
    "",
    "| Fixture | Format | Pass | Speaker | Speech | Recall | Precision | Names | Sections | Flagged | Time | Tokens |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  fs.writeFileSync(path.join(resultsDir, "latest.md"), table + "\n");
}
