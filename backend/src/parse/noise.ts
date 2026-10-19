// Editions print reference numbers around the verse: Folger's "FTLN 0001" before every line,
// margin counters ("15", "20") after every fifth line, or a bare number before each line.
// Each pattern is only stripped when it runs through the document, so a lone number in a
// speech or a numbered scene heading survives.

export interface NoiseReport {
  leadingPrefix: string | null; // e.g. "FTLN"
  leadingNumbers: boolean;
  trailingCounters: number;
}

const PREFIXED_REF = /^([A-Z]{2,6})\s?\d{2,6}\b\s*/;
const LEADING_NUMBER = /^\d{1,5}\s+(?=\S)/;
const TRAILING_COUNTER = /(?<=\S)\s+(\d{1,4})$/;

export function stripLineNumbers(text: string): { text: string; report: NoiseReport } {
  const lines = text.split("\n");
  const content = lines.filter((l) => l.trim());
  const report: NoiseReport = { leadingPrefix: null, leadingNumbers: false, trailingCounters: 0 };
  if (content.length < 20) return { text, report };

  const prefixCounts = new Map<string, number>();
  for (const l of content) {
    const m = PREFIXED_REF.exec(l.trim());
    if (m) prefixCounts.set(m[1]!, (prefixCounts.get(m[1]!) ?? 0) + 1);
  }
  const [prefix, prefixHits] = [...prefixCounts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (prefix && prefixHits >= Math.max(20, content.length * 0.15)) report.leadingPrefix = prefix;

  const numbered = content.filter((l) => LEADING_NUMBER.test(l.trim())).length;
  report.leadingNumbers = !report.leadingPrefix && numbered >= Math.max(20, content.length * 0.3) && isMostlyIncreasing(content);

  const counters = content.map((l) => TRAILING_COUNTER.exec(l.trim())).filter((m) => m && Number(m[1]) % 5 === 0 && Number(m[1]) > 0);
  const stripCounters = counters.length >= Math.max(10, content.length * 0.03);

  const prefixRe = report.leadingPrefix ? new RegExp(`^\\s*${report.leadingPrefix}\\s?\\d{2,6}\\b\\s*`) : null;
  const out = lines.map((line) => {
    let l = line;
    if (prefixRe) l = l.replace(prefixRe, "");
    else if (report.leadingNumbers) l = l.replace(/^\s*\d{1,5}\s+(?=\S)/, "");
    if (stripCounters) {
      const m = TRAILING_COUNTER.exec(l.trimEnd());
      if (m && Number(m[1]) % 5 === 0 && Number(m[1]) > 0 && !/\b(?:act|scene|page|chapter|part)\s+\d+$/i.test(l.trimEnd())) {
        l = l.trimEnd().slice(0, m.index);
        report.trailingCounters++;
      }
    }
    return l;
  });
  return { text: out.join("\n"), report };
}

// Leading numbers that count up through the document are line numbers, not dialogue.
function isMostlyIncreasing(lines: string[]): boolean {
  const nums = lines
    .map((l) => /^\s*(\d{1,5})\s/.exec(l)?.[1])
    .filter((n): n is string => !!n)
    .map(Number);
  let up = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i]! >= nums[i - 1]!) up++;
  return nums.length > 1 && up / (nums.length - 1) > 0.7;
}
