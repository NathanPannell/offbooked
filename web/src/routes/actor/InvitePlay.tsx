import { ArrowLeft } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { actorApi } from "../../api/actor";
import type { PracticeResult } from "../../api/types";
import { Brand } from "../../components/Brand";
import { RunThroughPlayer } from "../../player/RunThroughPlayer";

export default function InvitePlay() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const api = useMemo(() => actorApi(token), [token]);
  const load = useCallback(() => api.runthrough(), [api]);
  const savePractice = useCallback((results: PracticeResult[]) => api.practice(results), [api]);

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
        <RunThroughPlayer load={load} audio={api.lineAudio} onPracticeDone={savePractice} initialMode={params.get("mode") === "mine" ? "mine" : "full"}
          initialRole={params.get("part")}
        />
      </main>
    </div>
  );
}
