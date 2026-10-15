import { Mic } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Link } from "react-router";
import { productions } from "../../api/director";
import type { Production } from "../../api/types";
import { RunThroughPlayer } from "../../player/RunThroughPlayer";

export function RunThroughTab({ production }: { production: Production }) {
  const load = useCallback(() => productions.runthrough(production.id), [production.id]);
  const audio = useMemo(() => productions.lineAudio(production.id), [production.id]);
  return (
    <div className="stack">
      <div className="runthrough-intro">
        <p className="small muted">
          Lines nobody has recorded yet play in a computer voice, marked <span className="tag tag-tts">TTS</span>. Read some in yourself and
          they play instead, marked <span className="tag tag-standin">stand-in</span>.
        </p>
        <Link className="btn btn-secondary btn-sm" to={`/app/p/${production.id}/record`}>
          <Mic size={15} aria-hidden="true" /> Record stand-ins
        </Link>
      </div>
      <RunThroughPlayer load={load} audio={audio} />
    </div>
  );
}
