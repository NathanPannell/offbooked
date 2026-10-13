import { useEffect, useRef } from "react";

const BAR = 3;
const GAP = 2;

/** Live scrolling level meter from the mic analyser, so the actor can see the mic is working. */
export function Waveform({ analyser, active }: { analyser: AnalyserNode | null; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser || !active) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const samples = new Uint8Array(analyser.fftSize);
    const levels: number[] = [];
    let frame = 0;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += ((s - 128) / 128) ** 2;
      // Perceptual-ish scaling so normal speech fills most of the height.
      const level = Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.6);
      levels.push(level);
      const maxBars = Math.ceil(width / (BAR + GAP));
      while (levels.length > maxBars) levels.shift();

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = getComputedStyle(canvas).color;
      const offset = width - levels.length * (BAR + GAP);
      levels.forEach((l, i) => {
        const h = Math.max(2, l * height);
        ctx.fillRect(offset + i * (BAR + GAP), (height - h) / 2, BAR, h);
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser, active]);

  return <canvas ref={canvasRef} className="waveform" aria-hidden="true" />;
}
