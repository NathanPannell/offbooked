import { useEffect, useState, useSyncExternalStore } from "react";
import { SttSession } from "./session";

/** An STT session owned by the calling screen and disposed when it unmounts. */
export function useSttSession() {
  const [session] = useState(() => new SttSession());
  useEffect(() => () => session.dispose(), [session]);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  return { session, state };
}
