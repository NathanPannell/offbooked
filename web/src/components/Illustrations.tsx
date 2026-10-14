// Small hand-drawn illustrations, inline SVG so they cost nothing to load.

/** An empty stage with the curtains drawn, for empty states. */
export function EmptyStage() {
  return (
    <svg className="empty-art" width="132" height="92" viewBox="0 0 132 92" aria-hidden="true">
      <rect x="6" y="8" width="120" height="70" rx="6" fill="#fff" stroke="var(--ink)" strokeWidth="2" />
      <path d="M8 10c10 20 14 40 10 66H8z" fill="var(--accent)" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
      <path d="M124 10c-10 20-14 40-10 66h10z" fill="var(--accent)" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
      <path d="M6 14h120" stroke="var(--ink)" strokeWidth="2" />
      <ellipse cx="66" cy="74" rx="30" ry="5" fill="var(--sun)" opacity="0.7" />
      <path d="M66 18 50 72M66 18l16 54" stroke="var(--sun)" strokeWidth="1.5" strokeDasharray="3 4" />
      <rect x="2" y="78" width="128" height="8" rx="3" fill="var(--ink)" />
    </svg>
  );
}
