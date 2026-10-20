import { useState } from "react";
import { ApiError, errorMessage } from "../../api/client";
import { script } from "../../api/director";
import { ScriptDropZone } from "./ScriptDropZone";

/** Adds or replaces a production's script: a PDF or Word file, read as soon as it's chosen. */
export function ScriptUpload({
  productionId,
  failure,
  canCancel,
  onCancel,
  onStarted,
}: {
  productionId: string;
  failure: string | null;
  canCancel: boolean;
  onCancel: () => void;
  onStarted: (fileName: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(`Uploading ${file.name}…`);
    setError(null);
    try {
      await script.uploadFile(productionId, file);
      onStarted(file.name);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "This script already has recordings, so it can't be replaced. Fix lines in the script instead."
          : errorMessage(err),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="upload stack">
      {failure && (
        <div className="notice notice-error" role="alert">
          <div>
            <strong>We couldn't read that script.</strong> {failure} Try another file: a PDF exported from Word or Google Docs, or the .docx itself, usually
            reads best.
          </div>
        </div>
      )}
      <ScriptDropZone
        onFile={(f) => void upload(f)}
        onProblem={setError}
        disabled={!!busy}
        buttonLabel={busy ?? (failure ? "Try another file" : "Choose a file")}
      />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {canCancel && (
        <button type="button" className="quiet-link" style={{ alignSelf: "center" }} onClick={onCancel}>
          Keep the current script
        </button>
      )}
    </div>
  );
}
