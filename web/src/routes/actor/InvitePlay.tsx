import { ArrowLeft } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { actorApi } from "../../api/actor";
import { Brand } from "../../components/Brand";
import { RunThroughPlayer } from "../../player/RunThroughPlayer";

/**
 * The cast's listen-through. A cast member with a part opens on it (`?part=` picks one of
 * several), their lines on "Pause, then read" unless they chose otherwise; a listener with no
 * part just listens. `?mode=mine` opens on "Pause, then read" whatever was chosen before.
 */
export default function InvitePlay() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const api = useMemo(() => actorApi(token), [token]);
  const load = useCallback(() => api.runthrough(), [api]);

  return (
    <div className="actor-shell">
      <header className="actor-header">
        <Link to={`/i/${token}`} className="icon-btn" aria-label="Back to my lines">
          <ArrowLeft size={22} />
        </Link>
        <Brand to={`/i/${token}`} />
        <span className="actor-header-spacer" />
      </header>
      <main className="page page-player">
        <RunThroughPlayer load={load} audio={api.lineAudio} initialMode={params.get("mode") === "mine" ? "mine" : "full"} initialRole={params.get("part")} />
      </main>
    </div>
  );
}
