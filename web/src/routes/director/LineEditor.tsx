import { Check, Plus, Scissors, SeparatorHorizontal, Combine } from "lucide-react";
import { useRef, useState } from "react";
import { script as api } from "../../api/director";
import type { Character, Line, LineKind } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import type { ReviewActions } from "./ScriptReview";

const KINDS: { kind: LineKind; label: string }[] = [
  { kind: "dialogue", label: "Dialogue" },
  { kind: "stage_direction", label: "Stage direction" },
  { kind: "heading", label: "Heading" },
];

export function LineEditor({
  productionId,
  line,
  nextLine,
  characters,
  actions,
  onClose,
}: {
  productionId: string;
  line: Line;
  nextLine: Line | null;
  characters: Character[];
  actions: ReviewActions;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [text, setText] = useState(line.text);
  const [sectionTitle, setSectionTitle] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { run, busy } = actions;

  const sorted = [...characters].sort((a, b) => b.lineCount - a.lineCount);
  const q = query.trim().toLowerCase();
  const matches = q
    ? sorted.filter((c) => c.name.toLowerCase().includes(q) || c.aliases.some((a) => a.toLowerCase().includes(q)))
    : sorted;
  const exact = sorted.some((c) => c.name.toLowerCase() === q);
  const restore = { characterId: line.characterId, kind: line.kind };
  // Fixing a flagged line also clears its flag.
  const resolveIfFlagged = async () => {
    if (line.flagged) await api.resolveLine(line.id);
  };

  const pick = async (character: Character) => {
    const ok = await run(async () => {
      await api.updateLine(line.id, { characterId: character.id, kind: "dialogue" });
      await resolveIfFlagged();
    }, {
      label: `Speaker set to ${character.name}`,
      run: () => api.updateLine(line.id, restore),
    });
    if (ok) onClose();
  };

  const createAndPick = async () => {
    const name = query.trim().toUpperCase();
    const ok = await run(async () => {
      const { character } = await api.createCharacter(productionId, name);
      await api.updateLine(line.id, { characterId: character.id, kind: "dialogue" });
      await resolveIfFlagged();
    });
    if (ok) onClose();
  };

  const setKind = (kind: LineKind) =>
    run(() => api.updateLine(line.id, { kind }), {
      label: `Marked as ${KINDS.find((k) => k.kind === kind)!.label.toLowerCase()}`,
      run: () => api.updateLine(line.id, restore),
    });

  const saveText = () =>
    run(async () => {
      await api.updateLine(line.id, { text });
      await resolveIfFlagged();
    }, {
      label: "Text changed",
      run: () => api.updateLine(line.id, { text: line.text }),
    });

  const split = async () => {
    const at = textRef.current?.selectionStart ?? 0;
    const ok = await run(() => api.splitLine(line.id, at), { label: "Line split", run: () => api.mergeNext(line.id) });
    if (ok) onClose();
  };

  const caretInside = () => {
    const at = textRef.current?.selectionStart ?? 0;
    return at > 0 && at < line.text.length && text === line.text;
  };
  const [canSplit, setCanSplit] = useState(false);

  return (
    <div className="stack line-editor">
      {line.flagged && (
        <div className="notice notice-warn spread">
          <span>{line.flagReason ?? "The parser wasn't sure about this line."}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={async () => {
              if (await run(() => api.resolveLine(line.id))) onClose();
            }}
          >
            <Check size={16} aria-hidden="true" /> Looks right
          </button>
        </div>
      )}

      <div className="segmented" role="group" aria-label="Line type">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            aria-pressed={line.kind === k.kind}
            disabled={busy}
            onClick={() => line.kind !== k.kind && void setKind(k.kind)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {line.kind === "dialogue" && (
        <fieldset className="picker">
          <legend className="field-label">Who says it?</legend>
          <input
            className="input"
            placeholder="Find or add a character"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Find or add a character"
          />
          <ul className="picker-list">
            {matches.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`picker-item ${c.id === line.characterId ? "is-selected" : ""}`}
                  aria-pressed={c.id === line.characterId}
                  disabled={busy}
                  onClick={() => (c.id === line.characterId ? onClose() : void pick(c))}
                >
                  <CharacterName name={c.name} />
                  <span className="small muted">{c.lineCount} lines</span>
                </button>
              </li>
            ))}
            {q && !exact && (
              <li>
                <button type="button" className="picker-item" disabled={busy} onClick={createAndPick}>
                  <Plus size={16} aria-hidden="true" /> New character “{query.trim().toUpperCase()}”
                </button>
              </li>
            )}
          </ul>
        </fieldset>
      )}

      <label className="field">
        <span>Text</span>
        <textarea
          ref={textRef}
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onSelect={() => setCanSplit(caretInside())}
          onKeyUp={() => setCanSplit(caretInside())}
          onClick={() => setCanSplit(caretInside())}
        />
        <span className="field-hint">To split, put the cursor where the new line should start.</span>
      </label>
      <div className="row">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || text.trim() === line.text || !text.trim()} onClick={saveText}>
          Save text
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !canSplit} onClick={split}>
          <Scissors size={16} aria-hidden="true" /> Split here
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || !nextLine}
          title={nextLine ? `Join with: ${nextLine.text.slice(0, 60)}` : "This is the last line"}
          onClick={async () => {
            if (await run(() => api.mergeNext(line.id))) onClose();
          }}
        >
          <Combine size={16} aria-hidden="true" /> Join with next line
        </button>
      </div>

      <form
        className="section-break"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api.sectionBreak(line.id, { title: sectionTitle.trim() }))) onClose();
        }}
      >
        <label className="field grow">
          <span>Start a new scene here</span>
          <input className="input" placeholder="e.g. Act 1, Scene 2" value={sectionTitle} onChange={(e) => setSectionTitle(e.target.value)} />
        </label>
        <button className="btn btn-secondary btn-sm" disabled={busy || !sectionTitle.trim()}>
          <SeparatorHorizontal size={16} aria-hidden="true" /> Add break
        </button>
      </form>
    </div>
  );
}
