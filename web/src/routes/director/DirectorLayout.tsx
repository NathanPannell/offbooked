import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate, useOutletContext } from "react-router";
import { errorMessage, session, UNAUTHORIZED_EVENT } from "../../api/client";
import { auth } from "../../api/director";
import type { User } from "../../api/types";
import { Brand } from "../../components/Brand";
import { Loading } from "../../components/Loading";

export interface DirectorContext {
  user: User;
  setUser: (user: User) => void;
}

export function useDirector() {
  return useOutletContext<DirectorContext>();
}

export default function DirectorLayout() {
  const location = useLocation();
  const navigate = useNavigate();
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

  if (signedOut) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname)}`} replace />;
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

  const signOut = async () => {
    await auth.logout().catch(() => {});
    session.clear();
    navigate("/", { replace: true });
  };

  return (
    <div className="director">
      <header className="app-header">
        <div className="app-header-inner">
          <Brand to="/app" />
          <div className="row" style={{ gap: 4 }}>
            <span className="small muted header-user">{user.name || user.email}</span>
            <button type="button" className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
              <LogOut size={20} />
            </button>
          </div>
        </div>
      </header>
      <Outlet context={{ user, setUser } satisfies DirectorContext} />
    </div>
  );
}
