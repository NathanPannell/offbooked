import { ChevronLeft, ChevronRight, FileQuestion, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../api/client";
import { script as scriptApi } from "../../api/director";
import type { Line, ScriptSource } from "../../api/types";
import { coverEnd, pageForLine, sourceRange } from "./sourceMatch";

// pdf.js is big: load it only when a PDF page is actually shown.
const PdfPage = lazy(() => import("./PdfPage"));

/**
 * The original document beside the script: the PDF page the selected line came from (with the line
 * highlighted when we can find it), or the original text around it for Word and plain text.
 */
export function SourcePane({
  productionId,
  scriptKey,
  line,
  lines,
  onClose,
}: {
  productionId: string;
  /** Changes when the script is replaced, so a cached PDF isn't reused. */
  scriptKey: string;
  line: Line | null;
  lines: Line[];
  onClose: () => void;
}) {
  const [excerpt, setExcerpt] = useState<ScriptSource | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"page" | "text">("page");
  const [page, setPage] = useState<number | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [matched, setMatched] = useState<boolean | null>(null);
  const cache = useRef(new Map<number, ScriptSource>());

  const range = useMemo(() => (line ? sourceRange(lines, line) : null), [line, lines]);
  const sourceLine = line?.sourceLine ?? null;

  // Fetch the original text around the line (debounced, cached by window).
  useEffect(() => {
    setLoadError(null);
    if (!sourceLine || !range) return;
    const cached = [...cache.current.values()].find(
      (s) => s.lines.length > 0 && s.from <= range.start && s.lines[s.lines.length - 1]!.n >= Math.min(range.end, range.start + 30),
    );
    if (cached) return setExcerpt(cached);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      scriptApi.source(productionId, sourceLine, 40, controller.signal).then(
        (result) => {
          cache.current.set(sourceLine, result);
          setExcerpt(result);
        },
        (err) => {
          if (!(err instanceof DOMException && err.name === "AbortError")) setLoadError(errorMessage(err));
        },
      );
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [productionId, sourceLine, range]);

  const sourcePages = useMemo(() => new Map((excerpt?.lines ?? []).map((l) => [l.n, l.page])), [excerpt]);
  const kind = excerpt?.kind ?? (line?.page ? "pdf" : null);
  const linePage = line ? pageForLine(line, sourcePages) : null;

  // Follow the selected line to its page.
  useEffect(() => {
    setPage(linePage);
    setMatched(null);
  }, [line?.id, linePage]);

  useEffect(() => {
    if (excerpt?.pageCount) setPageCount(excerpt.pageCount);
  }, [excerpt?.pageCount]);

  const noPosition = line && !line.sourceLine && !line.page;
  const showPdf = kind === "pdf" && mode === "page" && page !== null;
  const showText = !!excerpt && !!range && (kind !== "pdf" || mode === "text" || matched === false || page === null);

  return (
    <aside className="source-pane" aria-label="Original script">
      <div className="source-head">
        <p className="eyebrow">Original</p>
        {kind === "pdf" && (
          <div className="segmented source-mode" role="group" aria-label="Show">
            <button type="button" aria-pressed={mode === "page"} onClick={() => setMode("page")}>
              Page
            </button>
            <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
              Text
            </button>
          </div>
        )}
        <button type="button" className="icon-btn source-close" onClick={onClose} aria-label="Hide the original">
          <X size={18} />
        </button>
      </div>

      <div className="source-body">
        {!line ? (
          <div className="source-empty">
            <FileQuestion size={28} aria-hidden="true" />
            <p>Pick a line to see where it sits in your original script.</p>
          </div>
        ) : noPosition ? (
          <div className="source-empty">
            <FileQuestion size={28} aria-hidden="true" />
            <p>
              <strong>Original not available for this script.</strong>
            </p>
            <p className="small muted">It was read before Offbooked kept track of pages. Scripts you upload from now on show here.</p>
          </div>
        ) : (
          <>
            {showPdf && (
              <div className="pdf-wrap">
                <div className="pdf-nav">
                  <button type="button" className="icon-btn" disabled={page! <= 1} onClick={() => setPage((p) => Math.max(1, (p ?? 1) - 1))} aria-label="Previous page">
                    <ChevronLeft size={18} />
                  </button>
                  <span className="mono nums">
                    Page {page}
                    {pageCount ? ` of ${pageCount}` : ""}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={pageCount !== null && page! >= pageCount}
                    onClick={() => setPage((p) => (p ?? 1) + 1)}
                    aria-label="Next page"
                  >
                    <ChevronRight size={18} />
                  </button>
                  {page !== linePage && linePage !== null && (
                    <button type="button" className="quiet-link" onClick={() => setPage(linePage)}>
                      Back to the line
                    </button>
                  )}
                </div>
                <Suspense fallback={<div className="pdf-page is-loading" />}>
                  <PdfPage
                    key={scriptKey}
                    url={scriptApi.fileUrl(productionId)}
                    cacheKey={scriptKey}
                    page={page!}
                    highlight={page === linePage ? line.text : null}
                    onPageCount={setPageCount}
                    onMatch={setMatched}
                  />
                </Suspense>
                {matched === false && page === linePage && (
                  <p className="small muted source-note">Couldn't pinpoint the line on this page. Here it is in the text:</p>
                )}
              </div>
            )}
            {showText && <SourceExcerpt source={excerpt!} start={range!.start} end={coverEnd(excerpt!.lines, range!.start, line.text, range!.end)} />}
            {!excerpt && !showPdf && !loadError && line.sourceLine && <div className="spinner source-spinner" aria-label="Loading the original" />}
            {loadError && <p className="small field-error">{loadError}</p>}
          </>
        )}
      </div>
    </aside>
  );
}

/** Scrolls the pane (not the page) so `el` sits in the middle of it. */
export function centreInPane(el: HTMLElement) {
  const pane = el.closest<HTMLElement>(".source-body");
  if (!pane) return;
  const top = el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  pane.scrollTo({ top: Math.max(0, top - pane.clientHeight / 3) });
}

/** The original text around a line, with its source lines highlighted and the spacing kept. */
function SourceExcerpt({ source, start, end }: { source: ScriptSource; start: number; end: number }) {
  const ref = useRef<HTMLOListElement>(null);
  // Trailing blank lines aren't part of the line.
  let last = end;
  while (last > start && !source.lines.find((l) => l.n === last)?.text.trim()) last--;

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(".is-hit");
    if (first) centreInPane(first);
  }, [start, last]);

  return (
    <ol className="source-text" ref={ref}>
      {source.lines.map((l) => (
        <li key={l.n} className={l.n >= start && l.n <= last ? "is-hit" : undefined}>
          <span className="source-n" aria-hidden="true">
            {l.n}
          </span>
          <span className="source-line">{l.text || " "}</span>
        </li>
      ))}
    </ol>
  );
}
