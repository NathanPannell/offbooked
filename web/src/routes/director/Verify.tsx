import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { errorMessage, session } from "../../api/client";
import { auth } from "../../api/director";
import { Brand } from "../../components/Brand";
import { Loading } from "../../components/Loading";

// Sign-in tokens are single use. Share one request per token so a double render can't spend it twice.
const attempts = new Map<string, ReturnType<typeof auth.verify>>();

export default function Verify() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError("This sign-in link is missing its code.");
      return;
    }
    let attempt = attempts.get(token);
    if (!attempt) {
      attempt = auth.verify(token);
      attempts.set(token, attempt);
    }
    attempt.then(
      ({ sessionToken }) => {
        session.set(sessionToken);
        navigate("/app", { replace: true });
      },
      (err) => setError(errorMessage(err)),
    );
  }, [token, navigate]);

  if (!error) return <Loading label="Signing you in" />;
  return (
    <main className="page page-narrow center-page">
      <Brand />
      <div className="sticker message-card stack">
        <h1 className="display">That link didn't work</h1>
        <p className="muted">{error} Sign-in links work once and expire after 15 minutes.</p>
        <Link className="btn btn-primary" to="/signin">
          Send a new link
        </Link>
      </div>
    </main>
  );
}
