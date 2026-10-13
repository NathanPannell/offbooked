import { Link } from "react-router";
import { Brand } from "../components/Brand";

export function NotFound() {
  return (
    <main className="page page-narrow center-page">
      <Brand />
      <h1 className="display">Wrong theatre.</h1>
      <p className="muted">This page doesn't exist. If someone sent you a link, ask them for a fresh one.</p>
      <Link className="btn btn-secondary" to="/">
        Go to Offbooked
      </Link>
    </main>
  );
}
