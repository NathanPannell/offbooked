import assert from "node:assert/strict";
import { test } from "node:test";
import { makePdf } from "../test/pdf.ts";
import { extractPdfText, ScriptInputError } from "./pdf.ts";

test("PDF text keeps reading order and drops running headers and page numbers", async () => {
  const page = (n: number, body: string[]): [number, number, string][] => [
    [72, 760, "THE TRAGEDY OF HAMLET"],
    ...body.map((s, i): [number, number, string] => [72, 700 - i * 14, s]),
    [300, 40, String(n)],
  ];
  const pdf = makePdf([
    page(1, ["HAMLET. A little more than kin,", "and less than kind.", "KING. How is it that the clouds"]),
    page(2, ["still hang on you?", "HAMLET. Not so, my lord."]),
    page(3, ["QUEEN. Good Hamlet, cast thy nighted", "colour off."]),
  ]);
  const { text, pages } = await extractPdfText(pdf);
  assert.equal(pages, 3);
  assert.ok(!text.includes("THE TRAGEDY OF HAMLET"), text);
  assert.ok(!/^\d+$/m.test(text), text);
  const order = ["A little more than kin", "and less than kind", "How is it that the clouds", "still hang on you", "Not so, my lord", "Good Hamlet"];
  const positions = order.map((s) => text.indexOf(s));
  assert.ok(
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!)),
    text,
  );
});

test("image-only PDFs are reported as scanned images", async () => {
  await assert.rejects(extractPdfText(makePdf([[], [], []])), (err) => err instanceof ScriptInputError && /scanned images/i.test(err.message));
  await assert.rejects(extractPdfText(new TextEncoder().encode("%PDF-1.4 garbage")), ScriptInputError);
});
