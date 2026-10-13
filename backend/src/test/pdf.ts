// Writes a minimal PDF: each page is a list of [x, y, text] in points (origin bottom left).
export function makePdf(pages: [number, number, string][][]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // returns the object number
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const items of pages) {
    const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const stream = items.map(([x, y, s]) => `BT /F1 11 Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}
