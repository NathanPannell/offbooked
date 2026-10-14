import { ClipboardPaste, FileUp } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { ApiError, errorMessage } from "../../api/client";
import { script } from "../../api/director";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_BYTES = 20 * 1024 * 1024;

function validate(file: File): string | null {
  const ok = /\.(pdf|docx|txt|text|fountain)$/i.test(file.name) || ["application/pdf", "text/plain", DOCX_TYPE].includes(file.type);
  if (!ok) return "Upload a PDF, a Word .docx or a plain text file, or paste the script below.";
  if (file.size > MAX_BYTES) return "That file is over 20 MB. Try a smaller export, or paste the text.";
  return null;
}

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
  onStarted: () => void;
}) {
  const [mode, setMode] = useState<"pdf" | "paste">(failure ? "paste" : "pdf");
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const send = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onStarted();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "This script already has recordings, so it can't be replaced. Fix lines in the review instead."
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    const problem = validate(file);
    if (problem) return setError(problem);
    void send(() => script.uploadFile(productionId, file));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files[0]);
  };

  return (
    <div className="stack">
      {failure && (
        <div className="notice notice-error" role="alert">
          <div>
            <strong>We couldn't read that script.</strong> {failure} Try the file again, or paste the text below. Pasted
            text usually works best for scanned or unusual layouts.
          </div>
        </div>
      )}
      <div className="spread">
        <h2>Add your script</h2>
        <div className="segmented" role="group" aria-label="Script source">
          <button type="button" aria-pressed={mode === "pdf"} onClick={() => setMode("pdf")}>
            File
          </button>
          <button type="button" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>
            Paste text
          </button>
        </div>
      </div>

      {mode === "pdf" ? (
        <div
          className={`upload-drop ${dragging ? "is-drag" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <FileUp size={36} aria-hidden="true" />
          <p>
            <strong>Drop your script here</strong>
          </p>
          <p className="small muted">PDF, Word (.docx) or plain text, up to 20 MB. Scanned pages without a text layer don't work yet.</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "Uploading…" : "Choose a file"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={`application/pdf,.pdf,${DOCX_TYPE},.docx,text/plain,.txt`}
            hidden
            onChange={(e) => {
              upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void send(() => script.uploadText(productionId, text));
          }}
        >
          <label className="field">
            <span>Script text</span>
            <textarea
              className="input script-paste"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"HAMLET\nWho's there?\n\nHORATIO\nFriends to this ground."}
              spellCheck={false}
            />
            <span className="field-hint">Keep the character names and line breaks as they are in the script.</span>
          </label>
          <button className="btn btn-primary" disabled={busy || !text.trim()}>
            <ClipboardPaste size={18} aria-hidden="true" /> {busy ? "Sending…" : "Use this text"}
          </button>
        </form>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {canCancel && (
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Keep the current script
        </button>
      )}
    </div>
  );
}
