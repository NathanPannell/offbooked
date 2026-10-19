import { Check, FileText, Scissors, Trash2, X } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { script as api } from "../../api/director";
import type { Character, Line, LineKind } from "../../api/types";
import { characterHue } from "../../lib/format";
import { splitTokens } from "./lineJoin";
import { caretOffsetAt, splitAtCaret, textRuns } from "./lineText";
import { keepFieldInView } from "./reviewScroll";
import type { ReviewActions } from "./ScriptReview";

const KINDS: { kind: LineKind; label: string }[] = [
  { kind: "dialogue", label: "Dialogue" },
  { kind: "stage_direction", label: "Direction" },
  { kind: "heading", label: "Heading" },
];
const NEW_CHARACTER = "__new";
const MANAGE_CHARACTERS = "__manage";
const SEVERAL = "__several";

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
  onClose,
  onDelete,
  onSplit,
  originalOpen,
  onToggleOriginal,
  onManageCharacters,
}: {
  productionId: string;
  line: Line;
  characters: Character[];
  /** Speakers just before and after this line: listed first. */
  nearby: Character[];
  actions: ReviewActions;
  /** Start editing the text with the caret here when the line opens ("end" for the end). */
  startText: number | "end" | null;
  /** Keys on the line itself (move between lines). */
  onKey: (e: KeyboardEvent, line: Line) => void;
  onClose: () => void;
  onDelete: () => void;
  /** The line was split: carry on with the new second part. */
  onSplit: (second: Line) => void;
  /** The original script beside (or under) the review, at this line. */
  originalOpen: boolean;
  onToggleOriginal: () => void;
  /** Rename or merge characters. */
  onManageCharacters: () => void;
}) {
  const { run, busy } = actions;
  const rowRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // Text that is being saved: shown until the script reloads with it.
  const [saving, setSaving] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  /** Picking several people who say the line together (or, on an ALL line, who is on stage). */
  const [together, setTogether] = useState<Set<string> | null>(null);
  const editing = useRef(false);
  const caret = useRef<number | null>(null);

  const startEdit = (at: number | "end" | null) => {
    setSplitting(false);
    editing.current = true;
    caret.current = at === "end" || at === null ? line.text.length : Math.min(at, line.text.length);
    setDraft(line.text);
  };

  const openAtStart = useEffectEvent(() => {
    if (startText !== null) startEdit(startText);
  });
  // Only when the line opens.
  useEffect(() => openAtStart(), []);

  // Grow with the text, and put the caret where the click was.
  useLayoutEffect(() => {
    if (draft === null && refocus.current) {
      // Back from typing: keys go to the line again (E edits, the arrows move).
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
    keepFieldInView(el);
  }, [draft]);

  // On a phone the keyboard opens after the field takes focus and covers the bottom of the page:
  // bring the field back above it whenever the visible area changes while typing.
  const isTyping = draft !== null;
  useEffect(() => {
    const vv = window.visualViewport;
    if (!isTyping || !vv) return;
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => keepFieldInView(textRef.current));
    };
    vv.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", onResize);
    };
  }, [isTyping]);

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
    await run(() => api.updateLine(line.id, { text: next }), {
      label: "Text changed",
      run: () => api.updateLine(line.id, { text: line.text }),
    });
    setSaving(null);
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

  // Undo puts the content back.
  const restore = { characterId: line.characterId, kind: line.kind, text: line.text };

  const setKind = async (kind: LineKind) => {
    if (kind === line.kind) return;
    await run(() => api.updateLine(line.id, { kind }), {
      label: `Marked as ${KINDS.find((k) => k.kind === kind)!.label.toLowerCase()}`,
      run: () => api.updateLine(line.id, restore),
    });
  };

  const pick = async (character: Character) => {
    if (character.id === line.characterId) return;
    await run(() => api.updateLine(line.id, { characterId: character.id, kind: "dialogue" }), {
      label: `Speaker set to ${character.name}`,
      run: () => api.updateLine(line.id, { characterId: restore.characterId, kind: restore.kind }),
    });
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
    if (ok) setAdding(null);
  };

  const saveTogether = async (ids: string[]) => {
    const was = { characterId: restore.characterId, kind: restore.kind, ...(speaker?.everyone ? { voiceIds: line.voiceIds ?? null } : {}) };
    const ok = await run(() => api.updateLine(line.id, { kind: "dialogue", voiceIds: ids }), {
      label: speaker?.everyone ? "Updated who says it" : "Shared line",
      run: () => api.updateLine(line.id, was),
    });
    if (ok) setTogether(null);
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

  const classes = ["script-row", `kind-${line.kind}`, "is-selected", "is-open"].join(" ");

  return (
    <div className={classes}>
      <div ref={rowRef} className="script-line is-editing" tabIndex={0} role="group" aria-label="Line being edited" onKeyDown={onRowKey}>
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
                  if (value === SEVERAL) {
                    e.target.value = line.characterId ?? "";
                    return setTogether(new Set(line.voiceIds ?? (line.characterId && !speaker?.group ? [line.characterId] : [])));
                  }
                  if (value === MANAGE_CHARACTERS) {
                    e.target.value = line.characterId ?? "";
                    return onManageCharacters();
                  }
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
                <option value={SEVERAL}>{speaker?.everyone ? `Who says ${speaker.name}…` : "Several together…"}</option>
                <option value={NEW_CHARACTER}>New character…</option>
                <option value={MANAGE_CHARACTERS}>Rename or merge characters…</option>
              </select>
            ))}
          <span className="line-tools">
            <button
              type="button"
              className="icon-btn line-tool"
              aria-pressed={originalOpen}
              onMouseDown={keepFocus}
              onClick={onToggleOriginal}
              aria-label={originalOpen ? "Hide the original" : "Show this line in the original"}
              title={originalOpen ? "Hide the original" : "Show this line in the original"}
            >
              <FileText size={16} />
            </button>
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

        {together && (
          <TogetherPicker
            characters={[...nearby, ...everyone].filter((c) => !c.group)}
            nearbyIds={nearbyIds}
            chosen={together}
            everyone={speaker?.everyone ? speaker.name : null}
            busy={busy}
            onChange={setTogether}
            onCancel={() => setTogether(null)}
            onSave={(ids) => void saveTogether(ids)}
          />
        )}

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
                  <button
                    key={i}
                    type="button"
                    className="split-word"
                    disabled={busy}
                    onClick={() => void split(t.at!)}
                    aria-label={`Start a new line at “${t.text}”`}
                  >
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
          <span className="script-text is-editable" onClick={(e) => startEdit(caretOffsetAt(e.currentTarget, e.clientX, e.clientY))} title="Click to edit">
            <LineText text={saving ?? line.text} kind={line.kind} />
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Who says a line together: tick two or more characters (a group like "ANGELO, ESCALUS" is made from
 * their names), or, on an ALL line, the characters on stage, replacing Claude's guess.
 */
function TogetherPicker({
  characters,
  nearbyIds,
  chosen,
  everyone,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  characters: Character[];
  nearbyIds: Set<string>;
  chosen: Set<string>;
  /** The ALL-style name being filled in, or null for a plain group. */
  everyone: string | null;
  busy: boolean;
  onChange: (next: Set<string>) => void;
  onCancel: () => void;
  onSave: (ids: string[]) => void;
}) {
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  // Keep the script's order of the ticked names: nearby first, as listed.
  const ids = characters.filter((c) => chosen.has(c.id)).map((c) => c.id);
  const enough = everyone ? ids.length >= 1 : ids.length >= 2;
  return (
    <div
      className="together-picker"
      role="group"
      aria-label={everyone ? `Who says ${everyone}` : "Who says this together"}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <p className="small muted">
        {everyone
          ? `Who says ${everyone} here? Each of them records it, and the takes play together.`
          : "Pick everyone who says this line. Each of them records it, and the takes play together."}
      </p>
      <div className="together-options">
        {characters.map((c) => (
          <label key={c.id} className={`checkbox together-option${nearbyIds.has(c.id) ? " is-nearby" : ""}`}>
            <input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} />
            {c.name}
          </label>
        ))}
      </div>
      <div className="row">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !enough} onClick={() => onSave(ids)}>
          {everyone ? "Save" : ids.length >= 2 ? `Said by ${ids.length} together` : "Pick at least two"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
