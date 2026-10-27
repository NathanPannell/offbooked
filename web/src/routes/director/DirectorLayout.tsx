import { useEffect, useState } from "react";
import { Link, Navigate, Outlet, useLocation, useOutletContext } from "react-router";
import { errorMessage, session, UNAUTHORIZED_EVENT } from "../../api/client";
import { auth } from "../../api/director";
import type { User } from "../../api/types";
import { Avatar } from "../../components/Avatar";
import { Brand } from "../../components/Brand";
import { Loading } from "../../components/Loading";
import { castFacingName } from "../../lib/names";

export interface DirectorContext {
  user: User;
  setUser: (user: User) => void;
}

export function useDirector() {
  return useOutletContext<DirectorContext>();
}

export default function DirectorLayout() {
  const location = useLocation();
  const [user, setUser] = useState<User | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [signedOut, setSignedOut] = useState(!session.get());

  useEffect(() => {
    const onUnauthorized = () => setSignedOut(true);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  useEffect(() => {
    if (signedOut) return;
    setLoadError(null);
    auth.me().then(
      ({ user }) => setUser(user),
      (err) => setLoadError(errorMessage(err)),
    );
  }, [signedOut, attempt]);

  if (signedOut) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (loadError && !user) {
    return (
      <main className="page page-narrow center-page">
        <Brand />
        <p role="alert">{loadError}</p>
        <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </main>
    );
  }
  if (!user) return <Loading />;

  const named = !!user.name?.trim();
  return (
    <div className="director">
      <header className="app-header">
        <div className="app-header-inner">
          <Brand to="/app" />
          <div className="header-actions">
            {user.admin && (
              <Link className="admin-link" to="/app/admin">
                Admin
              </Link>
            )}
            {/* The dot asks for a name until there is one: it's what the cast calls you. */}
            <Link className="account-btn" to="/app/account" aria-label={named ? "Your account" : "Your account: add your name"} title="Your account">
              <Avatar name={castFacingName(user.name, user.email)} size={36} />
              {!named && <span className="account-dot" aria-hidden="true" />}
            </Link>
          </div>
        </div>
      </header>
      <Outlet context={{ user, setUser } satisfies DirectorContext} />
    </div>
  );
}
