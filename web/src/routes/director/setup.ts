import type { Script } from "../../api/types";

/** Scripts are PDF or Word .docx files, up to 20 MB. */
export const SCRIPT_ACCEPT = "application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx";
export const MAX_SCRIPT_BYTES = 20 * 1024 * 1024;
const SCRIPT_TYPES = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

/** Why a file can't be used as the script, or null when it can. */
export function scriptFileProblem(file: { name: string; type: string; size: number }): string | null {
  if (!/\.(pdf|docx)$/i.test(file.name) && !SCRIPT_TYPES.includes(file.type)) return "That file won't work. Use a PDF or a Word .docx file.";
  if (file.size > MAX_SCRIPT_BYTES) return "That file is over 20 MB. Try a smaller export of the script.";
  if (file.size === 0) return "That file is empty. Try exporting the script again.";
  return null;
}

/** Why the performance dates can't be saved, or null when they can. Dates are YYYY-MM-DD. */
export function performanceDatesProblem(start: string, end: string, today: string): string | null {
  if (!start || !end) return "Add the dates of the first and final performance.";
  if (start > end) return "The final performance can't be before the first.";
  if (end < today) return "The final performance has already passed. Check the dates.";
  return null;
}

/** The friendly lines that rotate under the heading while the script is read, one set per real stage. The heading already names the file, so they never repeat it. */
export function readingLines(stage: 0 | 1 | 2): string[] {
  if (stage === 0) return ["Opening the file…", "Turning the pages…", "Finding where the play starts…"];
  if (stage === 1) return ["Separating characters…", "Finding the scenes…", "Double-checking stage directions…", "Matching each speech to its speaker…"];
  return ["Setting out the parts…", "Saving your script…"];
}

/** The line to show `elapsedMs` into a stage, moving on every `everyMs` and staying on the last one. */
export function readingLine(stage: 0 | 1 | 2, elapsedMs: number, everyMs = 3500): string {
  const lines = readingLines(stage);
  return lines[Math.min(lines.length - 1, Math.max(0, Math.floor(elapsedMs / everyMs)))]!;
}

/** "Read 1,223 lines across 34 parts": the dialogue lines and the parts the cast can take. */
export function readSummary(script: Pick<Script, "lines" | "characters">, locale?: string): string {
  const lines = script.lines.filter((l) => l.kind === "dialogue").length;
  const parts = script.characters.filter((c) => !c.group).length;
  const count = (n: number, one: string) => `${n.toLocaleString(locale)} ${n === 1 ? one : `${one}s`}`;
  return `Read ${count(lines, "line")} across ${count(parts, "part")}`;
}

/** Today in the browser's own time zone, as YYYY-MM-DD (what a date input gives). */
export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface SetupDraft {
  title: string;
  performanceStartsOn: string;
  performanceEndsOn: string;
  file: File;
}

export interface SetupApi {
  create: (input: { title: string; performanceStartsOn: string; performanceEndsOn: string }) => Promise<{ production: { id: string } }>;
  update: (id: string, input: { title: string; performanceStartsOn: string; performanceEndsOn: string }) => Promise<unknown>;
  upload: (id: string, file: File) => Promise<unknown>;
}

/**
 * Creates the production with its dates (or, trying again after a failed upload or read, updates
 * the one already made, so a retry never makes a second production) and uploads the script.
 * `onCreated` hears the new id as soon as it exists. Resolves with the production id.
 */
export async function sendSetup(api: SetupApi, draft: SetupDraft, existingId: string | null, onCreated: (id: string) => void): Promise<string> {
  const details = { title: draft.title.trim(), performanceStartsOn: draft.performanceStartsOn, performanceEndsOn: draft.performanceEndsOn };
  let id = existingId;
  if (id) {
    await api.update(id, details);
  } else {
    id = (await api.create(details)).production.id;
    onCreated(id);
  }
  await api.upload(id, draft.file);
  return id;
}
