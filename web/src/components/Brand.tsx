import { Link } from "react-router";

export function Brand({ to = "/" }: { to?: string }) {
  return (
    <Link to={to} className="brand">
      <span aria-hidden="true" className="brand-mark">
        🎭
      </span>
      Offbooked
    </Link>
  );
}
