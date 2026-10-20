import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { session } from "../../api/client";
import { auth, productions } from "../../api/director";
import { Brand } from "../../components/Brand";
import { Loading } from "../../components/Loading";
import { safeNext } from "../../lib/names";

// Sign-in tokens are single use. Share one request per token so a double render can't spend it twice.
const attempts = new Map<string, ReturnType<typeof auth.verify>>();

/** Back where you were, else straight to a new production when there are none yet. */
async function landing(next: string | null): Promise<string> {
  if (next) return next;
  const list = await productions.list().catch(() => null);
  return list && list.productions.length === 0 ? "/app/new" : "/app";
}

export default function Verify() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const [failed, setFailed] = useState(!token);

  useEffect(() => {
    if (!token) return;
    let attempt = attempts.get(token);
    if (!attempt) {
      attempt = auth.verify(token);
      attempts.set(token, attempt);
    }
    attempt.then(
      async ({ sessionToken }) => {
        session.set(sessionToken);
        navigate(await landing(next), { replace: true });
      },
      () => setFailed(true),
    );
  }, [token, next, navigate]);

  if (!failed) return <Loading label="Signing you in" />;
  return (
    <main className="page page-narrow center-page">
      <Brand />
      <div className="raised message-card stack">
        <h1 className="display">That link has expired</h1>
        <p className="muted">Sign-in links work once, for 15 minutes.</p>
        <Link className="btn btn-primary" to={next ? `/signin?next=${encodeURIComponent(next)}` : "/signin"}>
          Email me a new link
        </Link>
      </div>
    </main>
  );
}
