import mammoth from "mammoth";
import { extractPdfText, ScriptInputError } from "./pdf.ts";

export type SourceKind = "pdf" | "docx" | "text";

const isPdf = (data: Buffer) => data.subarray(0, 5).toString("latin1") === "%PDF-";
const isZip = (data: Buffer) => data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;

// Works out what an uploaded file is from its bytes, falling back to the name for plain text.
export function detectSourceKind(data: Buffer, filename = ""): SourceKind {
  if (isPdf(data)) return "pdf";
  if (/\.pdf$/i.test(filename)) throw new ScriptInputError("That file isn't a readable PDF. Export it again, or upload a Word .docx or text file.");
  if (/\.docx$/i.test(filename) && !isZip(data)) throw new ScriptInputError("That file isn't a readable Word document. Save it again as .docx, or upload a PDF.");
  if (isZip(data)) {
    if (/\.docx$/i.test(filename) || data.includes("word/document.xml")) return "docx";
    throw new ScriptInputError("That file looks like a zip archive. Upload a PDF, a Word .docx file or plain text.");
  }
  if (/\.doc$/i.test(filename) || data.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    throw new ScriptInputError("Old Word .doc files aren't supported. Save it as .docx or PDF, or paste the text.");
  }
  if (looksBinary(data)) throw new ScriptInputError("We can't read that kind of file. Upload a PDF, a Word .docx file or plain text.");
  return "text";
}

export async function extractSourceText(data: Buffer, kind: SourceKind): Promise<string> {
  return (await extractSource(data, kind)).text;
}

// The text, plus the page count for PDFs (shown while the script is being read).
export async function extractSource(data: Buffer, kind: SourceKind): Promise<{ text: string; pages: number | null }> {
  if (kind === "pdf") return extractPdfText(new Uint8Array(data));
  if (kind === "docx") return { text: await extractDocxText(data), pages: null };
  return { text: decodeText(data), pages: null };
}

// Goes through HTML because mammoth's raw-text export drops soft line breaks (Shift+Enter), which
// verse uses for every line: "fall to't, yarely,<br>or we run" would become "yarely,or".
async function extractDocxText(data: Buffer): Promise<string> {
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer: data }));
  } catch {
    throw new ScriptInputError("We couldn't read this Word file. Try saving it again, or upload a PDF instead.");
  }
  return htmlToText(html);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|tr|table)>/gi, "\n\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// UTF-8 (with or without BOM), UTF-16 with BOM, or Windows-1252 for old Gutenberg-style files.
export function decodeText(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  const start = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(start));
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

function looksBinary(data: Buffer): boolean {
  const sample = data.subarray(0, 4096);
  if (sample[0] === 0xff && sample[1] === 0xfe) return false;
  if (sample[0] === 0xfe && sample[1] === 0xff) return false;
  let control = 0;
  for (const b of sample) if (b === 0 || (b < 9 && b !== 0)) control++;
  return control > sample.length * 0.01;
}
