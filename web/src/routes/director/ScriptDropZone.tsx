import { FileText, FileUp } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { SCRIPT_ACCEPT, scriptFileProblem } from "./setup";

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/**
 * Where the script file goes: a drop zone on desktop, and on touch screens just the "Choose a file"
 * button (the drop hint hides for coarse pointers). PDF or Word .docx only; a file that won't work
 * goes to `onProblem` instead of `onFile`.
 */
export function ScriptDropZone({
  chosen,
  onFile,
  onProblem,
  disabled = false,
  buttonLabel = "Choose a file",
  invalid = false,
  describedBy,
}: {
  chosen?: File | null;
  onFile: (file: File) => void;
  onProblem: (message: string) => void;
  disabled?: boolean;
  buttonLabel?: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = (file: File | undefined) => {
    if (!file || disabled) return;
    const problem = scriptFileProblem(file);
    if (problem) onProblem(problem);
    else onFile(file);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    take(e.dataTransfer.files[0]);
  };

  return (
    <div
      className={`upload-drop ${dragging ? "is-drag" : ""} ${chosen ? "has-file" : ""} ${invalid ? "is-invalid" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {chosen ? (
        <div className="upload-file">
          <FileText size={22} aria-hidden="true" />
          <span className="upload-file-name">{chosen.name}</span>
          <span className="small muted nums">{size(chosen.size)}</span>
        </div>
      ) : (
        <>
          <ScriptIllustration />
          <p className="upload-drop-hint">Drop your script here</p>
        </>
      )}
      <button
        type="button"
        className="btn btn-secondary upload-choose"
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={() => input.current?.click()}
      >
        <FileUp size={18} aria-hidden="true" /> {chosen ? "Choose another file" : buttonLabel}
      </button>
      {!chosen && <p className="small muted">PDF or Word .docx, up to 20 MB</p>}
      <input
        ref={input}
        type="file"
        accept={SCRIPT_ACCEPT}
        hidden
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** A little script page with one line marked, for the empty upload state. */
function ScriptIllustration() {
  return (
    <svg className="upload-art" width="120" height="104" viewBox="0 0 120 104" aria-hidden="true" fill="none">
      <rect x="28" y="12" width="66" height="86" rx="4" fill="var(--paper)" stroke="var(--line-strong)" strokeWidth="1.25" />
      <rect x="22" y="6" width="66" height="86" rx="4" fill="#fff" stroke="var(--edge-strong)" strokeWidth="1.25" />
      <rect x="32" y="20" width="22" height="3" rx="1.5" fill="var(--edge-strong)" />
      <rect x="32" y="30" width="46" height="2.5" rx="1.25" fill="var(--line-strong)" />
      <rect x="29" y="40" width="52" height="11" rx="2" fill="var(--marker)" />
      <rect x="32" y="44.5" width="44" height="2.5" rx="1.25" fill="var(--ink-soft)" />
      <rect x="32" y="60" width="18" height="3" rx="1.5" fill="var(--edge-strong)" />
      <rect x="32" y="70" width="40" height="2.5" rx="1.25" fill="var(--line-strong)" />
      <rect x="32" y="78" width="30" height="2.5" rx="1.25" fill="var(--line-strong)" />
      <circle cx="98" cy="22" r="10" fill="var(--accent)" />
      <path d="M93.5 22h9M98 17.5v9" stroke="#fff" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
