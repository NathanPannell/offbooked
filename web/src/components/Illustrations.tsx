// Small hand-drawn illustrations, inline SVG so they cost nothing to load.

/** An empty stage with the curtains drawn, for empty states. */
export function EmptyStage() {
  return (
    <svg className="empty-art" width="132" height="92" viewBox="0 0 132 92" aria-hidden="true" fill="none" strokeLinejoin="round">
      <rect x="6" y="8" width="120" height="70" rx="4" fill="var(--paper)" stroke="var(--edge-strong)" strokeWidth="1.25" />
      <path d="M7 9c10 20 14 40 10 68H7z" fill="var(--accent-soft)" stroke="var(--accent-line)" strokeWidth="1.25" />
      <path d="M125 9c-10 20-14 40-10 68h10z" fill="var(--accent-soft)" stroke="var(--accent-line)" strokeWidth="1.25" />
      <path d="M6 14h120" stroke="var(--edge-strong)" strokeWidth="1.25" />
      <ellipse cx="66" cy="72" rx="26" ry="3.5" fill="var(--marker)" opacity="0.8" />
      <path d="M2 82h128" stroke="var(--edge-strong)" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}
