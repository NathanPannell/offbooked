import { useCallback } from "react";
import { productions } from "../../api/director";
import type { Production } from "../../api/types";
import { RunThroughPlayer } from "../../player/RunThroughPlayer";

export function RunThroughTab({ production }: { production: Production }) {
  const load = useCallback(() => productions.runthrough(production.id), [production.id]);
  const render = useCallback(() => productions.render(production.id), [production.id]);
  return <RunThroughPlayer load={load} onRender={render} />;
}
