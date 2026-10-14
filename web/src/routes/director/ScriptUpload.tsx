import { ClipboardPaste, FileUp } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { ApiError, errorMessage } from "../../api/client";
import { script } from "../../api/director";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_BYTES = 20 * 1024 * 1024;

function validate(file: File): string | null {
  const ok = /\.(pdf|docx|txt|text|fountain)$/i.test(file.name) || ["application/pdf", "text/plain", DOCX_TYPE].includes(file.type);
  if (!ok) return "That file type won't work. Use a PDF, a Word .docx or a plain text file, or paste the script.";
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
  onStarted: (fileName: string | null) => void;
}) {
  const [mode, setMode] = useState<"file" | "paste">(failure ? "paste" : "file");
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const send = async (label: string, fileName: string | null, work: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
      onStarted(fileName);
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

  const upload = (file: File | undefined) => {
    if (!file) return;
    const problem = validate(file);
    if (problem) return setError(problem);
    void send(`Uploading ${file.name}…`, file.name, () => script.uploadFile(productionId, file));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files[0]);
  };

  return (
    <div className="upload stack">
      {failure && (
        <div className="notice notice-error" role="alert">
          <div>
            <strong>We couldn't read that script.</strong> {failure} Try the file again, or paste the text. Pasting usually works
            best for scanned or unusual layouts.
          </div>
        </div>
      )}

      {mode === "file" ? (
        <div
          className={`upload-drop ${dragging ? "is-drag" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <ScriptIllustration />
          <h2 className="display">Drop your script here</h2>
          <p className="muted">PDF, Word or plain text, up to 20 MB. We'll find the scenes, characters and lines for you.</p>
          <button type="button" className="btn btn-primary btn-lg" disabled={!!busy} onClick={() => inputRef.current?.click()}>
            <FileUp size={19} aria-hidden="true" /> {busy ?? "Choose a file"}
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
          <button type="button" className="quiet-link" onClick={() => setMode("paste")}>
            Or paste the text instead
          </button>
        </div>
      ) : (
        <form
          className="stack panel"
          onSubmit={(e) => {
            e.preventDefault();
            void send("Sending…", null, () => script.uploadText(productionId, text));
          }}
        >
          <label className="field">
            <span>Paste your script</span>
            <textarea
              className="input script-paste"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"HAMLET\nWho's there?\n\nHORATIO\nFriends to this ground."}
              spellCheck={false}
            />
            <span className="field-hint">Keep the character names, line breaks and indentation as they are.</span>
          </label>
          <div className="row">
            <button className="btn btn-primary" disabled={!!busy || !text.trim()}>
              <ClipboardPaste size={18} aria-hidden="true" /> {busy ?? "Use this text"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setMode("file")}>
              Upload a file instead
            </button>
          </div>
        </form>
      )}
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

/** A little script page with a marker swipe, for the empty upload state. */
function ScriptIllustration() {
  return (
    <svg className="upload-art" width="120" height="104" viewBox="0 0 120 104" aria-hidden="true">
      <rect x="30" y="10" width="66" height="86" rx="6" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2" transform="rotate(6 63 53)" />
      <rect x="22" y="6" width="66" height="86" rx="6" fill="#fff" stroke="var(--ink)" strokeWidth="2" />
      <rect x="32" y="20" width="22" height="5" rx="2.5" fill="var(--ink)" />
      <rect x="32" y="31" width="46" height="4" rx="2" fill="var(--line-strong)" />
      <rect x="29" y="42" width="52" height="11" rx="3" fill="var(--sun)" opacity="0.85" />
      <rect x="32" y="45.5" width="44" height="4" rx="2" fill="var(--ink)" />
      <rect x="32" y="60" width="18" height="5" rx="2.5" fill="var(--ink)" />
      <rect x="32" y="71" width="40" height="4" rx="2" fill="var(--line-strong)" />
      <rect x="32" y="80" width="30" height="4" rx="2" fill="var(--line-strong)" />
      <circle cx="98" cy="22" r="10" fill="var(--accent)" stroke="var(--ink)" strokeWidth="2" />
      <path d="M93 22h10M98 17v10" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
