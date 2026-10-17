import { getDocument, GlobalWorkerOptions, RenderingCancelledException, Util, type PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { directorHeaders } from "../../api/client";
import { matchTextItems } from "./sourceMatch";

// Loaded lazily from SourcePane, so pdf.js never weighs on other screens.
GlobalWorkerOptions.workerSrc = workerUrl;

const documents = new Map<string, Promise<PDFDocumentProxy>>();

function loadDocument(url: string, cacheKey: string): Promise<PDFDocumentProxy> {
  let doc = documents.get(cacheKey);
  if (!doc) {
    doc = getDocument({
      url,
      httpHeaders: directorHeaders(),
      // One plain GET: range requests would need a CORS preflight for the Range header.
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
    }).promise;
    doc.catch(() => documents.delete(cacheKey));
    documents.set(cacheKey, doc);
  }
  return doc;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One page of the original PDF, with the selected line marked where its text is found. */
export default function PdfPage({
  url,
  cacheKey,
  page,
  highlight,
  onPageCount,
  onMatch,
}: {
  url: string;
  cacheKey: string;
  page: number;
  highlight: string | null;
  onPageCount: (n: number) => void;
  onMatch: (found: boolean | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!width || !canvasRef.current) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    setRendering(true);
    (async () => {
      try {
        const doc = await loadDocument(url, cacheKey);
        if (cancelled) return;
        onPageCount(doc.numPages);
        const pageNumber = Math.min(Math.max(1, page), doc.numPages);
        const pdfPage = await doc.getPage(pageNumber);
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: width / base.width });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = canvasRef.current!;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        setSize({ w: viewport.width, h: viewport.height });
        const render = pdfPage.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
        task = render;
        await render.promise;
        if (cancelled) return;
        setRendering(false);
        setError(null);

        if (!highlight) {
          setBoxes([]);
          onMatch(null);
          return;
        }
        const content = await pdfPage.getTextContent();
        if (cancelled) return;
        const items = content.items.filter((i): i is TextItem => "str" in i);
        const hits = matchTextItems(
          items.map((i) => i.str),
          highlight,
        );
        const found = hits.map((index) => {
          const item = items[index]!;
          const tx = Util.transform(viewport.transform, item.transform) as number[];
          const fontHeight = Math.hypot(tx[2]!, tx[3]!);
          return { left: tx[4]!, top: tx[5]! - fontHeight * 0.95, width: item.width * viewport.scale, height: fontHeight * 1.2 };
        });
        setBoxes(found);
        onMatch(found.length > 0);
      } catch (err) {
        if (cancelled || err instanceof RenderingCancelledException) return;
        setRendering(false);
        setError("Couldn't open the original PDF.");
        onMatch(false);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
    // onPageCount and onMatch are state setters from the parent.
  }, [url, cacheKey, page, highlight, width]);

  // SourcePane keeps the highlight centred in the pane (as boxes arrive, the sheet opens or resizes).

  return (
    <div ref={wrapRef} className={`pdf-page ${rendering ? "is-loading" : ""}`} style={size ? { height: size.h } : undefined}>
      <canvas ref={canvasRef} style={size ? { width: size.w, height: size.h } : undefined} aria-label={`Page ${page} of the original script`} role="img" />
      {boxes.map((b, i) => (
        <span key={i} className="pdf-hit" style={{ left: b.left - 2, top: b.top, width: b.width + 4, height: b.height }} />
      ))}
      {error && <p className="pdf-error small">{error}</p>}
    </div>
  );
}
