import { ChevronLeft, ChevronRight, FileQuestion, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
  const bodyRef = useRef<HTMLDivElement>(null);

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

  useCentreHits(bodyRef, `${line?.id ?? ""}:${mode}:${page ?? ""}`);

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

      <div className="source-body" ref={bodyRef}>
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
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={page! <= 1}
                    onClick={() => setPage((p) => Math.max(1, (p ?? 1) - 1))}
                    aria-label="Previous page"
                  >
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

/** Re-measures after a line changes, while pdf.js and the excerpt lay out. */
const SETTLE_MS = [60, 200, 450, 900, 1600];

/**
 * Keeps the highlighted original (the PDF marks, else the excerpt's source lines) centred in the
 * pane: when `key` (the line, mode and page) changes, and again whenever the pane opens, resizes or
 * its content lays out. On phones the pane is hidden until its sheet opens, so a line picked while
 * it is closed is centred as it opens. Scrolling the pane by hand stops it until the next line or
 * the next time the sheet opens.
 */
function useCentreHits(bodyRef: RefObject<HTMLDivElement | null>, key: string) {
  const auto = useRef(true);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    auto.current = true;
    let frame = 0;
    const centre = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (auto.current) centreHits(body);
      });
    };
    let shown = body.clientHeight > 0;
    const resize = new ResizeObserver(() => {
      const nowShown = body.clientHeight > 0;
      // The sheet opening again picks the line back up, even after a scroll by hand.
      if (nowShown && !shown) auto.current = true;
      shown = nowShown;
      centre();
    });
    const observeChildren = () => {
      for (const child of body.children) resize.observe(child);
    };
    resize.observe(body);
    observeChildren();
    // The excerpt arriving, a PDF page's size and its highlight boxes.
    const mutation = new MutationObserver(() => {
      observeChildren();
      centre();
    });
    mutation.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    const timers = SETTLE_MS.map((ms) => setTimeout(centre, ms));
    centre();

    const stop = () => {
      auto.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) stop();
    };
    // Pressing on the pane itself (not its content) is its scrollbar.
    const onPointer = (e: PointerEvent) => {
      if (e.target === body) stop();
    };
    body.addEventListener("wheel", stop, { passive: true });
    body.addEventListener("touchmove", stop, { passive: true });
    body.addEventListener("keydown", onKey);
    body.addEventListener("pointerdown", onPointer);
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      resize.disconnect();
      mutation.disconnect();
      body.removeEventListener("wheel", stop);
      body.removeEventListener("touchmove", stop);
      body.removeEventListener("keydown", onKey);
      body.removeEventListener("pointerdown", onPointer);
    };
  }, [bodyRef, key]);
}

/**
 * Scrolls the pane (not the page) so the highlight sits in its middle: the PDF's marks when there
 * are any, else the excerpt's highlighted lines. A highlight taller than the pane starts near its top.
 */
function centreHits(pane: HTMLElement) {
  const height = pane.clientHeight;
  if (height === 0) return;
  let hits = [...pane.querySelectorAll<HTMLElement>(".pdf-hit")];
  if (hits.length === 0) hits = [...pane.querySelectorAll<HTMLElement>(".source-text .is-hit")];
  if (hits.length === 0) return;
  const paneTop = pane.getBoundingClientRect().top;
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of hits) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  if (top === Infinity) return;
  const offset = bottom - top > height * 0.7 ? top - paneTop - 24 : (top + bottom) / 2 - paneTop - height / 2;
  const target = Math.max(0, Math.min(pane.scrollHeight - height, pane.scrollTop + offset));
  if (Math.abs(target - pane.scrollTop) > 2) pane.scrollTo({ top: target });
}

/** The original text around a line, with its source lines highlighted and the spacing kept. */
function SourceExcerpt({ source, start, end }: { source: ScriptSource; start: number; end: number }) {
  // Trailing blank lines aren't part of the line.
  let last = end;
  while (last > start && !source.lines.find((l) => l.n === last)?.text.trim()) last--;

  return (
    <ol className="source-text">
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
