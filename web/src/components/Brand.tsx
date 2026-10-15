import { Link } from "react-router";

/** The Offbooked mark: a spotlight on a theatre-red tile. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <circle cx="16" cy="16" r="7.5" fill="none" stroke="#fff" strokeWidth="2" />
      <circle cx="16" cy="16" r="2" fill="#fff" />
    </svg>
  );
}

/** The wordmark. Pass `to={null}` where it shouldn't be a link (an actor's screens). */
export function Brand({ to = "/" }: { to?: string | null }) {
  const inner = (
    <>
      <BrandMark />
      <span className="brand-word">Offbooked</span>
    </>
  );
  if (to === null) return <span className="brand">{inner}</span>;
  return (
    <Link to={to} className="brand">
      {inner}
    </Link>
  );
}
