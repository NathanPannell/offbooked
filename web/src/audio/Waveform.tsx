import { useEffect, useRef } from "react";
import { drawLevel, traceBars } from "./micTest";

/** A recorded clip's levels to draw whole, lit up to how far it has played (0 to 1). */
export interface WaveTrace {
  levels: number[];
  progress: () => number;
}

/** Bar width and gap: wider bars on a tall meter (the mic check's). */
const barSize = (height: number) => (height >= 56 ? { bar: 4, gap: 3 } : { bar: 3, gap: 2 });

/**
 * Live scrolling level meter from the mic analyser, so the actor can see the mic is working. With
 * `trace` it draws a recorded clip instead, the part already played in full colour.
 */
export function Waveform({ analyser, active, trace, className }: { analyser: AnalyserNode | null; active: boolean; trace?: WaveTrace; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || (!trace && (!analyser || !active))) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const samples = analyser ? new Float32Array(analyser.fftSize) : null;
    const levels: number[] = [];
    let frame = 0;

    const size = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = getComputedStyle(canvas).color;
      return { width, height, ...barSize(height) };
    };
    const bar = (x: number, level: number, width: number, height: number) => {
      const h = Math.max(2, level * height);
      ctx.fillRect(x, (height - h) / 2, width, h);
    };

    const drawLive = () => {
      const { width, height, bar: w, gap } = size();
      analyser!.getFloatTimeDomainData(samples!);
      levels.push(drawLevel(samples!));
      const maxBars = Math.ceil(width / (w + gap));
      while (levels.length > maxBars) levels.shift();
      const offset = width - levels.length * (w + gap);
      levels.forEach((l, i) => bar(offset + i * (w + gap), l, w, height));
      frame = requestAnimationFrame(drawLive);
    };

    const drawTrace = () => {
      const { width, height, bar: w, gap } = size();
      const bars = traceBars(trace!.levels, Math.max(1, Math.floor((width + gap) / (w + gap))));
      const played = Math.max(0, Math.min(1, trace!.progress()));
      bars.forEach((l, i) => {
        ctx.globalAlpha = (i + 0.5) / bars.length <= played ? 1 : 0.28;
        bar(i * (w + gap), l, w, height);
      });
      ctx.globalAlpha = 1;
      if (played < 1) frame = requestAnimationFrame(drawTrace);
    };

    frame = requestAnimationFrame(trace ? drawTrace : drawLive);
    return () => cancelAnimationFrame(frame);
  }, [analyser, active, trace]);

  return <canvas ref={canvasRef} className={`waveform${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}
