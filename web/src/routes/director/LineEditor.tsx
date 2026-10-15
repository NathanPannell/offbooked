import { AlertTriangle, Check, Scissors, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { script as api } from "../../api/director";
import type { Character, Line, LineKind } from "../../api/types";
import { characterHue } from "../../lib/format";
import { flagLabel } from "./flagNav";
import { splitTokens } from "./lineJoin";
import { caretOffsetAt, splitAtCaret, textRuns } from "./lineText";
import type { ReviewActions } from "./ScriptReview";

const KINDS: { kind: LineKind; label: string }[] = [
  { kind: "dialogue", label: "Dialogue" },
  { kind: "stage_direction", label: "Direction" },
  { kind: "heading", label: "Heading" },
];
const NEW_CHARACTER = "__new";

/** A line's text as the script shows it: [bracketed] directions in spoken lines set as directions. */
export function LineText({ text, kind }: { text: string; kind: LineKind }) {
  if (!text) return <> </>;
  return (
    <>
      {textRuns(text, kind).map((run, i) =>
        run.direction ? (
          <span key={i} className="inline-direction">
            {run.text}
          </span>
        ) : (
          run.text
        ),
      )}
    </>
  );
}

/** What to check on a flagged line: a chip with the reason, and the parser's note when it left one. */
export function FlagNote({ line, id }: { line: Line; id: string }) {
  const label = flagLabel(line);
  const note = line.flagReason && line.flagReason !== label ? line.flagReason : null;
  return (
    <span className="flag-note" id={id}>
      <span className="flag-chip">
        <AlertTriangle size={12} aria-hidden="true" /> {label}
      </span>
      {note && <span className="flag-detail">{note}</span>}
    </span>
  );
}

/** Where a click on a line's text landed, so editing can start with the caret there. */
export const caretFromClick = (e: MouseEvent<HTMLElement>): number | null => {
  const text = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(".script-text") ?? e.currentTarget;
  return caretOffsetAt(text, e.clientX, e.clientY);
};

/**
 * The open line, edited in place: the speaker's name becomes the line's controls (its type, who says
 * it, split, delete) and the text itself is editable where it stands.
 */
export function LineEditor({
  productionId,
  line,
  characters,
  nearby,
  actions,
  startText,
  onKey,
  onApprove,
  onFixed,
  onClose,
  onDelete,
  onSplit,
}: {
  productionId: string;
  line: Line;
  characters: Character[];
  /** Speakers just before and after this line: listed first. */
  nearby: Character[];
  actions: ReviewActions;
  /** Start editing the text with the caret here when the line opens ("end" for the end). */
  startText: number | "end" | null;
  /** Keys on the line itself (approve, move between flags). */
  onKey: (e: KeyboardEvent, line: Line) => void;
  onApprove: () => void;
  /** A change fixed the line: the review moves on if it was flagged. */
  onFixed: () => void;
  onClose: () => void;
  onDelete: () => void;
  /** The line was split: carry on with the new second part. */
  onSplit: (second: Line) => void;
}) {
  const { run, busy } = actions;
  const rowRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // Text that is being saved: shown until the script reloads with it.
  const [saving, setSaving] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const editing = useRef(false);
  const caret = useRef<number | null>(null);

  const startEdit = (at: number | "end" | null) => {
    setSplitting(false);
    editing.current = true;
    caret.current = at === "end" || at === null ? line.text.length : Math.min(at, line.text.length);
    setDraft(line.text);
  };

  useEffect(() => {
    if (startText !== null) startEdit(startText);
    // Only when the line opens.
  }, []);

  // Grow with the text, and put the caret where the click was.
  useLayoutEffect(() => {
    if (draft === null && refocus.current) {
      // Back from typing: keys go to the line again (Enter approves, J and K move).
      refocus.current = false;
      rowRef.current?.focus({ preventScroll: true });
    }
    const el = textRef.current;
    if (!el || draft === null) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
    if (caret.current !== null) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [draft]);

  const refocus = useRef(false);
  const focusRow = () => {
    refocus.current = true;
  };

  const stopEditing = () => {
    editing.current = false;
    setDraft(null);
  };

  const commit = async (how: "enter" | "blur") => {
    if (!editing.current || draft === null) return;
    const next = draft;
    stopEditing();
    if (how === "enter") focusRow();
    if (next === line.text || !next.trim()) return;
    setSaving(next);
    const ok = await run(() => api.updateLine(line.id, { text: next }), {
      label: "Text changed",
      run: () => api.updateLine(line.id, { text: line.text }),
    });
    setSaving(null);
    if (ok && how === "enter") onFixed();
  };

  const cancel = () => {
    stopEditing();
    focusRow();
  };

  const onTextKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void commit("enter");
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (splitting) setSplitting(false);
      else onClose();
    } else if (e.key === "e" || e.key === "E") {
      e.preventDefault();
      startEdit("end");
    } else if (e.key === "Delete") {
      e.preventDefault();
      onDelete();
    } else onKey(e, line);
  };

  // ---- type and speaker ----

  const restore = { characterId: line.characterId, kind: line.kind, text: line.text };

  const setKind = async (kind: LineKind) => {
    if (kind === line.kind) return;
    const ok = await run(() => api.updateLine(line.id, { kind }), {
      label: `Marked as ${KINDS.find((k) => k.kind === kind)!.label.toLowerCase()}`,
      run: () => api.updateLine(line.id, restore),
    });
    // A new spoken line gets a guessed speaker: leave it open to check the guess.
    if (ok && kind !== "dialogue") onFixed();
  };

  const pick = async (character: Character) => {
    if (character.id === line.characterId) return;
    const ok = await run(() => api.updateLine(line.id, { characterId: character.id, kind: "dialogue" }), {
      label: `Speaker set to ${character.name}`,
      run: () => api.updateLine(line.id, { characterId: restore.characterId, kind: restore.kind }),
    });
    if (ok) onFixed();
  };

  const createAndPick = async (raw: string) => {
    const name = raw.trim().toUpperCase();
    if (!name) return;
    const existing = characters.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      setAdding(null);
      return pick(existing);
    }
    const ok = await run(async () => {
      const { character } = await api.createCharacter(productionId, name);
      await api.updateLine(line.id, { characterId: character.id, kind: "dialogue" });
    });
    if (ok) {
      setAdding(null);
      onFixed();
    }
  };

  const nearbyIds = new Set(nearby.map((c) => c.id));
  const everyone = [...characters].filter((c) => !nearbyIds.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
  const speaker = characters.find((c) => c.id === line.characterId) ?? null;

  // ---- split ----

  const tokens = splitTokens(line.text);
  const canSplit = tokens.some((t) => t.at !== null);
  const split = async (at: number) => {
    let second: Line | null = null;
    stopEditing();
    const ok = await run(
      async () => {
        second = (await api.splitLine(line.id, at)).lines[1];
      },
      {
        label: "Split in two. Check who says the new line",
        // Joining puts a line break where the split was: put the original text back exactly.
        run: async () => {
          const { line: joined } = await api.mergeNext(line.id);
          if (joined.text !== line.text) await api.updateLine(line.id, { text: line.text });
        },
      },
    );
    setSplitting(false);
    if (ok && second) onSplit(second);
  };

  const onSplitClick = () => {
    // While typing, split where the caret is (once the typing is saved or undone).
    if (draft !== null && textRef.current) {
      if (draft !== line.text) return;
      const at = splitAtCaret(line.text, textRef.current.selectionStart);
      if (at !== null) return void split(at);
      stopEditing();
    }
    setSplitting((s) => !s);
  };

  // Buttons beside the text keep the text field focused, so a split can read the caret.
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  const typing = draft !== null && draft !== line.text;

  const classes = ["script-row", `kind-${line.kind}`, line.flagged && "is-flagged", "is-selected", "is-open"].filter(Boolean).join(" ");
  const reasonId = `reason-${line.id}`;

  return (
    <div className={classes}>
      <div
        ref={rowRef}
        className="script-line is-editing"
        tabIndex={0}
        role="group"
        aria-label="Line being edited"
        aria-describedby={line.flagged ? reasonId : undefined}
        onKeyDown={onRowKey}
      >
        <div className="line-controls">
          <select
            className="line-select kind-select"
            aria-label="Line type"
            value={line.kind}
            disabled={busy}
            onChange={(e) => void setKind(e.target.value as LineKind)}
          >
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          {line.kind === "dialogue" &&
            (adding !== null ? (
              <form
                className="new-character"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createAndPick(adding);
                }}
              >
                <input
                  className="line-select new-character-input"
                  placeholder="NAME"
                  aria-label="New character's name"
                  value={adding}
                  maxLength={80}
                  onChange={(e) => setAdding(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") setAdding(null);
                  }}
                  autoFocus
                />
                <button className="icon-btn line-tool" disabled={busy || !adding.trim()} aria-label="Add character">
                  <Check size={16} strokeWidth={3} />
                </button>
              </form>
            ) : (
              <select
                className={`line-select speaker-select ${speaker ? "" : "is-missing"}`}
                aria-label="Said by"
                value={line.characterId ?? ""}
                disabled={busy}
                style={speaker ? ({ "--hue": characterHue(speaker.name) } as CSSProperties) : undefined}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === NEW_CHARACTER) return setAdding("");
                  const c = characters.find((x) => x.id === value);
                  if (c) void pick(c);
                }}
              >
                {!speaker && (
                  <option value="" disabled>
                    Who says this?
                  </option>
                )}
                {nearby.length > 0 && (
                  <optgroup label="Nearby">
                    {nearby.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label={nearby.length > 0 ? "Everyone else" : "Characters"}>
                  {everyone.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
                <option value={NEW_CHARACTER}>New character…</option>
              </select>
            ))}
          <span className="line-tools">
            <button
              type="button"
              className="icon-btn line-tool"
              aria-pressed={splitting}
              disabled={busy || !canSplit || typing}
              onMouseDown={keepFocus}
              onClick={onSplitClick}
              aria-label={draft !== null ? "Split at the cursor" : splitting ? "Cancel split" : "Split this line in two"}
              title={typing ? "Save or undo your typing first" : draft !== null ? "Split at the cursor" : "Split this line in two"}
            >
              <Scissors size={16} />
            </button>
            <button
              type="button"
              className="icon-btn line-tool line-delete"
              disabled={busy}
              onMouseDown={keepFocus}
              onClick={() => {
                stopEditing();
                onDelete();
              }}
              aria-label="Delete this line"
              title="Delete this line (Delete)"
            >
              <Trash2 size={16} />
            </button>
            <button type="button" className="icon-btn line-tool" onMouseDown={keepFocus} onClick={onClose} aria-label="Close" title="Close (Esc)">
              <X size={16} />
            </button>
          </span>
        </div>

        {splitting ? (
          <div className="split-mode">
            <p className="split-hint" id={`split-hint-${line.id}`}>
              <Scissors size={14} aria-hidden="true" /> Tap the word the new line starts with.
            </p>
            <p className="split-text" role="group" aria-describedby={`split-hint-${line.id}`}>
              {tokens.map((t, i) =>
                t.at === null ? (
                  <span key={i}>{t.text}</span>
                ) : (
                  <button key={i} type="button" className="split-word" disabled={busy} onClick={() => void split(t.at!)} aria-label={`Start a new line at “${t.text}”`}>
                    {t.text}
                  </button>
                ),
              )}
            </p>
          </div>
        ) : draft !== null ? (
          <textarea
            ref={textRef}
            className="script-text inline-text"
            aria-label="Line text. Enter saves, Shift+Enter starts a new line, Escape cancels."
            value={draft}
            rows={1}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onTextKey}
            onBlur={() => void commit("blur")}
          />
        ) : (
          <span
            className="script-text is-editable"
            onClick={(e) => startEdit(caretOffsetAt(e.currentTarget, e.clientX, e.clientY))}
            title="Click to edit"
          >
            <LineText text={saving ?? line.text} kind={line.kind} />
          </span>
        )}

        {line.flagged && <FlagNote line={line} id={reasonId} />}
      </div>
      {line.flagged && (
        <button type="button" className="approve-btn" onClick={onApprove} aria-label="Looks right" title="Looks right (Enter)">
          <Check size={18} strokeWidth={3} />
        </button>
      )}
    </div>
  );
}
