import { Check, Combine, Plus, Scissors, Search, SeparatorHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { script as api } from "../../api/director";
import type { Character, Line, LineKind } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import type { ReviewActions } from "./ScriptReview";

const KINDS: { kind: LineKind; label: string }[] = [
  { kind: "dialogue", label: "Spoken line" },
  { kind: "stage_direction", label: "Direction" },
  { kind: "heading", label: "Heading" },
];

/** Fixes one line in place, inside the script, so the context stays in view. */
export function LineEditor({
  productionId,
  line,
  nextLine,
  characters,
  nearby,
  actions,
  onApprove,
  onFixed,
  onClose,
}: {
  productionId: string;
  line: Line;
  nextLine: Line | null;
  characters: Character[];
  /** Speakers just before and after this line: the likely picks. */
  nearby: Character[];
  actions: ReviewActions;
  /** Marks a flagged line right and moves on. */
  onApprove: () => void;
  /** A change fixed the line: move on if it was flagged, else close. */
  onFixed: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(line.text);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [breakTitle, setBreakTitle] = useState<string | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { run, busy } = actions;

  // The server may rewrite the text (a cue taken off the front when it becomes a spoken line).
  useEffect(() => setText(line.text), [line.text]);

  const speaker = characters.find((c) => c.id === line.characterId) ?? null;
  const restore = { characterId: line.characterId, kind: line.kind, text: line.text };
  const resolveIfFlagged = async () => {
    if (line.flagged) await api.resolveLine(line.id);
  };

  const sorted = [...characters].sort((a, b) => b.lineCount - a.lineCount);
  const q = query.trim().toLowerCase();
  const matches = q ? sorted.filter((c) => c.name.toLowerCase().includes(q) || c.aliases.some((a) => a.toLowerCase().includes(q))) : sorted;
  const exact = sorted.some((c) => c.name.toLowerCase() === q);
  const quickPicks = nearby.filter((c) => c.id !== line.characterId).slice(0, 4);

  const pick = async (character: Character) => {
    const ok = await run(
      async () => {
        await api.updateLine(line.id, { characterId: character.id, kind: "dialogue" });
        await resolveIfFlagged();
      },
      { label: `Speaker set to ${character.name}`, run: () => api.updateLine(line.id, { characterId: restore.characterId, kind: restore.kind }) },
    );
    if (ok) {
      setSearching(false);
      setQuery("");
      onFixed();
    }
  };

  const createAndPick = async () => {
    const name = query.trim().toUpperCase();
    const ok = await run(async () => {
      const { character } = await api.createCharacter(productionId, name);
      await api.updateLine(line.id, { characterId: character.id, kind: "dialogue" });
      await resolveIfFlagged();
    });
    if (ok) onFixed();
  };

  // One tap: the server guesses the speaker for a new spoken line (a cue at the start, else the
  // previous speaker). The guess shows straight away and stays changeable here.
  const setKind = async (kind: LineKind) => {
    if (kind === line.kind) return;
    const ok = await run(
      async () => {
        await api.updateLine(line.id, { kind });
        if (kind !== "dialogue") await resolveIfFlagged();
      },
      {
        label: `Marked as ${KINDS.find((k) => k.kind === kind)!.label.toLowerCase()}`,
        run: () => api.updateLine(line.id, restore),
      },
    );
    if (ok && kind !== "dialogue") onFixed();
  };

  const saveText = async () => {
    const ok = await run(
      async () => {
        await api.updateLine(line.id, { text });
        await resolveIfFlagged();
      },
      { label: "Text changed", run: () => api.updateLine(line.id, { text: line.text }) },
    );
    if (ok) onFixed();
  };

  const canSplit = caret !== null && caret > 0 && caret < line.text.length && text === line.text;
  const split = async () => {
    if (caret === null) return;
    const ok = await run(() => api.splitLine(line.id, caret), { label: "Line split", run: () => api.mergeNext(line.id) });
    if (ok) onClose();
  };

  const trackCaret = () => setCaret(textRef.current?.selectionStart ?? null);

  return (
    <div className="line-editor" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div className="editor-row">
        <div className="segmented" role="group" aria-label="This line is a">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" aria-pressed={line.kind === k.kind} disabled={busy} onClick={() => void setKind(k.kind)}>
              {k.label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn editor-close" onClick={onClose} aria-label="Close editor">
          <X size={18} />
        </button>
      </div>

      {line.kind === "dialogue" && (
        <div className="speaker-picker">
          <span className="field-label">Said by</span>
          <div className="row speaker-chips">
            {speaker ? (
              <span className="speaker-current">
                <CharacterName name={speaker.name} />
              </span>
            ) : (
              <span className="speaker-current is-missing">Nobody yet</span>
            )}
            {quickPicks.map((c) => (
              <button key={c.id} type="button" className="speaker-chip" disabled={busy} onClick={() => void pick(c)}>
                <CharacterName name={c.name} />
              </button>
            ))}
            <button type="button" className="speaker-chip speaker-other" aria-expanded={searching} onClick={() => setSearching((s) => !s)}>
              <Search size={14} aria-hidden="true" /> Someone else
            </button>
          </div>
          {searching && (
            <div className="picker">
              <input
                className="input"
                placeholder="Find or add a character"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Find or add a character"
                autoFocus
              />
              <ul className="picker-list">
                {matches.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`picker-item ${c.id === line.characterId ? "is-selected" : ""}`}
                      aria-pressed={c.id === line.characterId}
                      disabled={busy}
                      onClick={() => (c.id === line.characterId ? setSearching(false) : void pick(c))}
                    >
                      <CharacterName name={c.name} />
                      <span className="small muted">{c.lineCount} lines</span>
                    </button>
                  </li>
                ))}
                {q && !exact && (
                  <li>
                    <button type="button" className="picker-item" disabled={busy} onClick={createAndPick}>
                      <span>
                        <Plus size={15} aria-hidden="true" /> Add “{query.trim().toUpperCase()}”
                      </span>
                    </button>
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}

      <label className="field">
        <span className="sr-only">Line text</span>
        <textarea
          ref={textRef}
          className="input editor-text"
          value={text}
          rows={Math.min(10, Math.max(2, text.split("\n").length + 1))}
          onChange={(e) => setText(e.target.value)}
          onSelect={trackCaret}
          onKeyUp={trackCaret}
          onClick={trackCaret}
          spellCheck={false}
        />
      </label>

      <div className="editor-actions">
        {text !== line.text ? (
          <>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={saveText}>
              Save text
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setText(line.text)}>
              Undo typing
            </button>
          </>
        ) : (
          line.flagged && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onApprove}>
              <Check size={16} strokeWidth={3} aria-hidden="true" /> Looks right
            </button>
          )
        )}
        <span className="grow" />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy || !canSplit}
          title={canSplit ? "Split at the cursor" : "Put the cursor where the new line should start"}
          onClick={split}
        >
          <Scissors size={15} aria-hidden="true" /> Split
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy || !nextLine}
          title={nextLine ? `Join with: ${nextLine.text.slice(0, 60)}` : "This is the last line"}
          onClick={async () => {
            if (await run(() => api.mergeNext(line.id))) onClose();
          }}
        >
          <Combine size={15} aria-hidden="true" /> Join next
        </button>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={breakTitle !== null} onClick={() => setBreakTitle((t) => (t === null ? "" : null))}>
          <SeparatorHorizontal size={15} aria-hidden="true" /> New scene here
        </button>
      </div>

      {breakTitle !== null && (
        <form
          className="section-break"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api.sectionBreak(line.id, { title: breakTitle.trim() }))) onClose();
          }}
        >
          <input
            className="input grow"
            placeholder="Scene title, e.g. Act 1, Scene 2"
            aria-label="New scene title"
            value={breakTitle}
            onChange={(e) => setBreakTitle(e.target.value)}
            autoFocus
          />
          <button className="btn btn-secondary btn-sm" disabled={busy || !breakTitle.trim()}>
            Start scene
          </button>
        </form>
      )}
    </div>
  );
}
