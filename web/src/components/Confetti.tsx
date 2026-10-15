import { useEffect, useMemo, useState, type CSSProperties } from "react";

// Muted paper in the page's own colours: a brief, quiet flourish, not a party.
const COLOURS = ["var(--accent)", "var(--sun)", "var(--accent-line)", "#b9d4c3", "var(--line-strong)"];

/** A short, gentle fall of paper. Renders nothing for people who prefer reduced motion. */
export function Confetti({ pieces = 28, durationMs = 2600 }: { pieces?: number; durationMs?: number }) {
  const [done, setDone] = useState(false);
  const reduced = typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const bits = useMemo(
    () =>
      Array.from({ length: pieces }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 400,
        fall: 1600 + Math.random() * 1200,
        drift: (Math.random() - 0.5) * 80,
        spin: (Math.random() - 0.5) * 360,
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
              width: b.wide ? 7 : 4,
              height: b.wide ? 4 : 8,
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
