import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/client";
import { script as scriptApi } from "../../api/director";
import type { Production, Script } from "../../api/types";
import { Loading } from "../../components/Loading";
import { useInterval, useResource } from "../../lib/useResource";
import { ParseProgressView } from "./ParseProgressView";
import { ScriptReview } from "./ScriptReview";
import { ScriptUpload } from "./ScriptUpload";

export function ScriptTab({ production, onChanged }: { production: Production; onChanged: () => void }) {
  const script = useResource<Script>(() => scriptApi.get(production.id), production.id);
  const [replacing, setReplacing] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const status = script.data?.status;
  const previousStatus = useRef(status);

  useInterval(() => void script.reload(), 1500, status === "parsing");

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
  if (data.status === "parsing") return <ParseProgressView progress={data.progress} fileName={fileName} />;

  if (data.status === "none" || data.status === "failed" || replacing) {
    return (
      <ScriptUpload
        productionId={production.id}
        failure={data.status === "failed" ? data.error || "We couldn't read that script." : null}
        canCancel={replacing}
        onCancel={() => setReplacing(false)}
        onStarted={(name) => {
          setReplacing(false);
          setFileName(name);
          script.setData((s) => ({ ...s!, status: "parsing", error: null, progress: null }));
          onChanged();
        }}
      />
    );
  }

  return <ScriptReview production={production} script={data} reload={script.reload} onReplace={() => setReplacing(true)} />;
}
