import { useEffect, useRef, useState } from "react";

const reducedMotion = () => typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

/**
 * Eases a set of numbers toward new targets, so counts that arrive in bursts tick up instead of
 * jumping. Snaps straight to the target when the user prefers reduced motion.
 */
export function useTweenedNumbers<T extends Record<string, number>>(target: T, durationMs = 900): T {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const key = JSON.stringify(target);

  useEffect(() => {
    const from = shownRef.current;
    const to = JSON.parse(key) as T;
    if (reducedMotion()) {
      shownRef.current = to;
      setShown(to);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = {} as Record<string, number>;
      for (const k of Object.keys(to)) {
        const a = from[k] ?? 0;
        const b = to[k]!;
        next[k] = b < a ? b : Math.round(a + (b - a) * eased);
      }
      shownRef.current = next as T;
      setShown(next as T);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [key, durationMs]);

  return shown;
}
