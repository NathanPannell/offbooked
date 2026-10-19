// Puts the on-device speech model into public/models/<dir>/ so the app serves it from its own
// origin (see docs/on-device-stt.md). Files come from the pinned Hugging Face revision in
// src/stt/hosted-model.json and must match their SHA-256. Downloads are kept in
// node_modules/.cache/offbooked-stt, so later runs (and Vercel builds with a warm cache) copy
// instead of downloading. Runs before `npm run dev` and `npm run build`.
//
//   node scripts/fetch-stt-model.mjs            fail on any error (build)
//   node scripts/fetch-stt-model.mjs --soft     warn and carry on (dev, offline)
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(web, "src/stt/hosted-model.json"), "utf8"));
const cacheDir = path.join(web, "node_modules/.cache/offbooked-stt");
const outDir = path.join(web, "public/models", manifest.dir);
const soft = process.argv.includes("--soft");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readIfValid(file, expected) {
  try {
    const bytes = await readFile(file);
    return sha256(bytes) === expected ? bytes : null;
  } catch {
    return null;
  }
}

async function download(file) {
  const url = `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/${file.path}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = sha256(bytes);
      if (actual !== file.sha256) throw new Error(`SHA-256 mismatch: got ${actual}`);
      return bytes;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${file.path}: ${err.message}`, { cause: err });
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function main() {
  await mkdir(cacheDir, { recursive: true });
  let downloaded = 0;
  for (const file of manifest.files) {
    const target = path.join(outDir, file.path);
    const current = await stat(target).catch(() => null);
    // Same size is enough to skip on a dev restart; a fresh copy is always verified below.
    if (current?.size === file.size && (await readIfValid(target, file.sha256))) continue;
    const cached = path.join(cacheDir, file.sha256);
    let bytes = await readIfValid(cached, file.sha256);
    if (!bytes) {
      bytes = await download(file);
      await writeFile(`${cached}.tmp`, bytes);
      await rename(`${cached}.tmp`, cached);
      downloaded += bytes.length;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(cached, target);
  }
  // Drop older model folders and files so they don't ship in the build.
  for (const entry of await readdir(path.join(web, "public/models")).catch(() => [])) {
    if (entry !== manifest.dir) await rm(path.join(web, "public/models", entry), { recursive: true, force: true });
  }
  const wanted = new Set(manifest.files.map((f) => path.normalize(f.path)));
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path.relative(outDir, path.join(entry.parentPath, entry.name));
    if (!wanted.has(rel)) await rm(path.join(outDir, rel), { force: true });
  }
  const total = manifest.files.reduce((sum, f) => sum + f.size, 0);
  console.log(
    `[stt] ${manifest.dir}: ${manifest.files.length} files, ${(total / 1e6).toFixed(1)} MB` +
      (downloaded ? ` (downloaded ${(downloaded / 1e6).toFixed(1)} MB)` : " (cached)"),
  );
}

main().catch((err) => {
  console.error(`[stt] Couldn't fetch the speech model: ${err.message}`);
  if (soft) console.error("[stt] The accuracy check won't load until this succeeds.");
  else process.exit(1);
});
