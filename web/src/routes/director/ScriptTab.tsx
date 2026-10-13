import { FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/client";
import { script as scriptApi } from "../../api/director";
import type { Production, Script } from "../../api/types";
import { Loading } from "../../components/Loading";
import { useInterval, useResource } from "../../lib/useResource";
import { ScriptReview } from "./ScriptReview";
import { ScriptUpload } from "./ScriptUpload";

export function ScriptTab({
  production,
  onChanged,
  onDone,
}: {
  production: Production;
  onChanged: () => void;
  onDone: () => void;
}) {
  const script = useResource<Script>(() => scriptApi.get(production.id), production.id);
  const [replacing, setReplacing] = useState(false);
  const status = script.data?.status;
  const previousStatus = useRef(status);

  useInterval(() => void script.reload(), 2500, status === "parsing");

  useEffect(() => {
    if (previousStatus.current === "parsing" && status && status !== "parsing") onChanged();
    previousStatus.current = status;
  }, [status, onChanged]);

  if (script.loading) return <Loading />;
  if (script.error || !script.data) {
    return (
      <div className="notice notice-error" role="alert">
        {errorMessage(script.error)}{" "}
        <button className="link-btn" onClick={() => void script.reload()}>
          Try again
        </button>
      </div>
    );
  }

  const data = script.data;
  if (data.status === "parsing") {
    return (
      <div className="card stack parsing" aria-live="polite">
        <FileText size={32} className="accent-icon" aria-hidden="true" />
        <h2>Reading your script…</h2>
        <p className="muted">
          We're sorting it into scenes, characters and lines. This usually takes under a minute. You can leave this page;
          it keeps going.
        </p>
        <div className="progress progress-indeterminate" role="progressbar" aria-label="Parsing script">
          <span />
        </div>
      </div>
    );
  }

  if (data.status === "none" || data.status === "failed" || replacing) {
    return (
      <ScriptUpload
        productionId={production.id}
        failure={data.status === "failed" ? data.error || "We couldn't read that script." : null}
        canCancel={replacing}
        onCancel={() => setReplacing(false)}
        onStarted={() => {
          setReplacing(false);
          script.setData((s) => ({ ...s!, status: "parsing", error: null }));
          onChanged();
        }}
      />
    );
  }

  return (
    <ScriptReview
      production={production}
      script={data}
      reload={script.reload}
      onReplace={() => setReplacing(true)}
      onDone={onDone}
    />
  );
}
