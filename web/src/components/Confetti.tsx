import { useEffect, useMemo, useState, type CSSProperties } from "react";

const COLOURS = ["var(--accent)", "var(--sun)", "var(--ink)", "#7cc4a4", "#8fb6f0"];

/** A short burst of paper confetti. Renders nothing for people who prefer reduced motion. */
export function Confetti({ pieces = 60, durationMs = 2800 }: { pieces?: number; durationMs?: number }) {
  const [done, setDone] = useState(false);
  const reduced = typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const bits = useMemo(
    () =>
      Array.from({ length: pieces }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 400,
        fall: 1600 + Math.random() * 1200,
        drift: (Math.random() - 0.5) * 160,
        spin: (Math.random() - 0.5) * 900,
        colour: COLOURS[i % COLOURS.length]!,
        wide: Math.random() > 0.5,
      })),
    [pieces],
  );

  useEffect(() => {
    const id = setTimeout(() => setDone(true), durationMs + 600);
    return () => clearTimeout(id);
  }, [durationMs]);

  if (reduced || done) return null;
  return (
    <div className="confetti" aria-hidden="true">
      {bits.map((b, i) => (
        <span
          key={i}
          style={
            {
              left: `${b.left}%`,
              background: b.colour,
              width: b.wide ? 10 : 6,
              height: b.wide ? 6 : 12,
              animationDelay: `${b.delay}ms`,
              animationDuration: `${b.fall}ms`,
              "--drift": `${b.drift}px`,
              "--spin": `${b.spin}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
