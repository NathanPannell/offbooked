import { Link2, Pencil, RefreshCw, Undo2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { errorMessage } from "../../api/client";
import { script as scriptApi, type DeletedLine } from "../../api/director";
import type { Character, Line, Production, Script, Section } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import { speakerLabel } from "../../lib/voices";
import { Dialog } from "../../components/Dialog";
import { SectionNav } from "../../components/SectionNav";
import { useToast } from "../../components/Toast";
import { CharactersPanel } from "./CharactersPanel";
import { canJoinAtSeam, joinPreview, undoJoin } from "./lineJoin";
import { caretFromClick, LineEditor, LineText } from "./LineEditor";
import { repeatsSceneTitle } from "./lineText";
import { MergeSuggestions } from "./MergeSuggestions";
import { scrollToLine } from "./reviewScroll";
import { readSummary } from "./setup";
import { SourcePane } from "./SourcePane";

export interface ReviewActions {
  /** Runs a change, refreshes the script, and offers `undo` when given. */
  run: (change: () => Promise<unknown>, undo?: { label: string; run: () => Promise<unknown> }) => Promise<boolean>;
  busy: boolean;
}

type Undo = { label: string; run: () => Promise<unknown> | void };

export function ScriptReview({
  production,
  script,
  reload,
  onReplace,
}: {
  production: Production;
  script: Script;
  reload: () => Promise<void>;
  onReplace: () => void;
}) {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Where the text caret goes when a line opens from a click on its text (null: just the controls).
  const [startText, setStartText] = useState<number | "end" | null>(null);
  const [showCharacters, setShowCharacters] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [busy, setBusy] = useState(false);

  const characters = useMemo(() => new Map(script.characters.map((c) => [c.id, c])), [script.characters]);
  const sections = useMemo(() => [...script.sections].sort((a, b) => a.seq - b.seq), [script.sections]);
  const lines = useMemo(() => [...script.lines].sort((a, b) => a.seq - b.seq), [script.lines]);
  const bySection = useMemo(() => {
    const map = new Map<string, Line[]>();
    for (const l of lines) {
      const list = map.get(l.sectionId);
      if (list) list.push(l);
      else map.set(l.sectionId, [l]);
    }
    return map;
  }, [lines]);
  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const selected = selectedId ? (lineById.get(selectedId) ?? null) : null;
  const recordingStarted = production.progress.linesRecorded > 0;

  const goTo = useCallback((line: Line | null, open = true) => {
    if (!line) return;
    setSelectedId(line.id);
    if (open) {
      setEditingId(line.id);
      setStartText(null);
    }
    // After React commits (the editor moves to this line), measure and scroll: see reviewScroll.ts.
    scrollToLine(line.id);
    requestAnimationFrame(() => document.getElementById(`line-${line.id}`)?.querySelector<HTMLElement>(".script-line")?.focus({ preventScroll: true }));
  }, []);

  // ---- edits ----

  const actions: ReviewActions = {
    busy,
    run: async (change, undoAction) => {
      setBusy(true);
      try {
        await change();
        await reload();
        setUndo(undoAction ?? null);
        return true;
      } catch (err) {
        toast(errorMessage(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
  };

  const runUndo = async () => {
    if (!undo) return;
    const action = undo;
    setUndo(null);
    const result = action.run();
    if (result instanceof Promise) {
      if (await actions.run(() => result)) toast("Undone");
    } else toast("Undone");
  };

  // One click deletes; Undo puts the line back where it was, in its scene, as it was.
  const deleteLine = async (line: Line) => {
    const index = lines.indexOf(line);
    const neighbour = lines[index + 1] ?? lines[index - 1] ?? null;
    const done: { gone?: DeletedLine } = {};
    const what = line.kind === "dialogue" ? "Line" : line.kind === "stage_direction" ? "Direction" : "Heading";
    const ok = await actions.run(
      async () => {
        done.gone = await scriptApi.deleteLine(line.id);
      },
      {
        label: `${what} deleted`,
        run: async () => {
          const gone = done.gone;
          if (!gone) return;
          const { line: was, removedSection } = gone;
          const { line: back } = await scriptApi.insertLine(production.id, {
            afterLineId: gone.afterLineId,
            ...(removedSection
              ? { newSection: { title: removedSection.title, act: removedSection.act, scene: removedSection.scene } }
              : { sectionId: was.sectionId }),
            kind: was.kind,
            characterId: was.characterId,
            text: was.text,
            sourceLine: was.sourceLine ?? null,
            sourcePage: was.page ?? null,
          });
          setSelectedId(back.id);
          setEditingId(back.id);
          setStartText(null);
          scrollToLine(back.id);
        },
      },
    );
    if (!ok) return;
    if (neighbour) goTo(neighbour);
    else {
      setSelectedId(null);
      setEditingId(null);
    }
  };

  // On small screens the original opens as a sheet over the bottom of the screen: keep the line
  // in the band above it (and back in the middle when it closes).
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    if (selectedRef.current && !window.matchMedia("(min-width: 1100px)").matches) scrollToLine(selectedRef.current);
  }, [sourceOpen]);

  // ---- join and split ----

  const characterName = useCallback((id: string) => characters.get(id)?.name, [characters]);

  /** Joins `lower` into `upper` (the upper line keeps its speaker). Undo splits it back. */
  const join = async (upper: Line, lower: Line) => {
    const preview = joinPreview(upper, lower, characterName);
    const plan = undoJoin(upper, lower);
    const ok = await actions.run(() => scriptApi.mergeNext(upper.id), {
      label: preview.done,
      run: () => scriptApi.splitLine(upper.id, plan.at, plan.second),
    });
    if (ok) {
      setSelectedId(upper.id);
      setEditingId((id) => (id === upper.id || id === lower.id ? upper.id : id));
    }
  };
  const joinRef = useRef(join);
  joinRef.current = join;
  const stableJoin = useCallback((upper: Line, lower: Line) => void joinRef.current(upper, lower), []);

  const onLineKey = useCallback(
    (e: KeyboardEvent, line: Line) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // The arrows move to the line below or above.
        e.preventDefault();
        const next = lines[lines.findIndex((l) => l.id === line.id) + (e.key === "ArrowDown" ? 1 : -1)];
        if (next) goTo(next, false);
      } else if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        setSelectedId(line.id);
        setEditingId(line.id);
        setStartText("end");
      }
    },
    [goTo, lines],
  );

  const onOpen = useCallback((line: Line, at: number | "end" | null) => {
    setSelectedId(line.id);
    setEditingId(line.id);
    setStartText(at);
  }, []);

  const nearbySpeakers = (line: Line): Character[] => {
    const index = lines.indexOf(line);
    const seen = new Set<string>();
    const out: Character[] = [];
    for (let d = 1; d < 40 && out.length < 4; d++) {
      for (const l of [lines[index - d], lines[index + d]]) {
        if (l?.kind === "dialogue" && l.characterId && !seen.has(l.characterId)) {
          seen.add(l.characterId);
          const c = characters.get(l.characterId);
          if (c) out.push(c);
        }
      }
    }
    return out;
  };

  // Rows are memoised; hand them stable callbacks that always see the latest state.
  const lineKeyRef = useRef(onLineKey);
  lineKeyRef.current = onLineKey;
  const stableLineKey = useCallback((e: KeyboardEvent, line: Line) => lineKeyRef.current(e, line), []);

  const editing = editingId ? (lineById.get(editingId) ?? null) : null;

  return (
    <div className={`review ${sourceOpen ? "source-open" : ""}`}>
      <p className="review-summary small muted">{readSummary(script)}</p>
      <div className="review-bar">
        <SectionNav sections={sections} idPrefix="section-" />
      </div>

      <div className="review-body">
        <div className="review-main">
          <article className="script-page" aria-label={`${production.title} script`}>
            {sections.map((section) => (
              <ScriptSection
                key={section.id}
                section={section}
                lines={bySection.get(section.id) ?? []}
                characters={characters}
                selectedId={selectedId}
                editingId={editingId}
                onOpen={onOpen}
                onLineKey={stableLineKey}
                onJoin={stableJoin}
                characterName={characterName}
                busy={busy}
                actions={actions}
                renderEditor={(line) => (
                  <LineEditor
                    key={line.id}
                    productionId={production.id}
                    line={line}
                    startText={startText}
                    onKey={onLineKey}
                    onSplit={(second) => {
                      setSelectedId(second.id);
                      setEditingId(second.id);
                      setStartText(null);
                      scrollToLine(second.id);
                    }}
                    characters={script.characters}
                    nearby={nearbySpeakers(line)}
                    actions={actions}
                    onDelete={() => void deleteLine(line)}
                    originalOpen={sourceOpen}
                    onToggleOriginal={() => setSourceOpen((o) => !o)}
                    onManageCharacters={() => setShowCharacters(true)}
                    onClose={() => {
                      setEditingId(null);
                      // After React swaps the editor back for the plain line.
                      setTimeout(() => document.getElementById(`line-${line.id}`)?.querySelector<HTMLElement>(".script-line")?.focus({ preventScroll: true }));
                    }}
                  />
                )}
              />
            ))}
          </article>

          <div className="review-footer">
            <button type="button" className="quiet-link" onClick={onReplace} disabled={recordingStarted}>
              <RefreshCw size={14} aria-hidden="true" /> Upload a different script
            </button>
          </div>
        </div>

        <SourcePane
          productionId={production.id}
          scriptKey={`${production.id}:${script.lines.length}:${script.lines[0]?.id ?? ""}`}
          line={selected ?? (editing as Line | null)}
          lines={lines}
          onClose={() => setSourceOpen(false)}
        />
      </div>

      {undo && (
        <div className="undo-bar" role="status">
          <span>{undo.label}</span>
          <button type="button" className="btn btn-sm undo-btn" onClick={runUndo} disabled={busy}>
            <Undo2 size={16} aria-hidden="true" /> Undo
          </button>
          <button type="button" className="icon-btn undo-dismiss" onClick={() => setUndo(null)} aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      )}

      <Dialog open={showCharacters} onClose={() => setShowCharacters(false)} title="Characters">
        <MergeSuggestions
          productionId={production.id}
          characters={script.characters}
          busy={busy}
          onMerge={(from, into) => actions.run(() => scriptApi.mergeCharacter(from.id, into.id))}
        />
        <CharactersPanel productionId={production.id} characters={script.characters} actions={actions} />
      </Dialog>
    </div>
  );
}

function ScriptSection({
  section,
  lines,
  characters,
  selectedId,
  editingId,
  onOpen,
  onLineKey,
  onJoin,
  characterName,
  busy,
  actions,
  renderEditor,
}: {
  section: Section;
  lines: Line[];
  characters: Map<string, Character>;
  selectedId: string | null;
  editingId: string | null;
  onOpen: (line: Line, at: number | "end" | null) => void;
  onLineKey: (e: KeyboardEvent, line: Line) => void;
  onJoin: (upper: Line, lower: Line) => void;
  characterName: (id: string) => string | undefined;
  busy: boolean;
  actions: ReviewActions;
  renderEditor: (line: Line) => ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(section.title);
  const hasOpen = lines.some((l) => l.id === editingId || l.id === selectedId);
  // Heading lines that only repeat the title above ("ACT 1", "SCENE 1") aren't shown twice. They
  // stay in the script, and show again while one is being edited.
  const shown = lines.filter((l) => !repeatsSceneTitle(l, section.title) || l.id === editingId || l.id === selectedId);

  return (
    <section
      id={`section-${section.id}`}
      className={`script-section ${hasOpen ? "has-open" : ""}`}
      style={{ containIntrinsicSize: `auto ${lines.length * 64}px` }}
    >
      <header className="section-head">
        {renaming ? (
          <form
            className="row grow"
            onSubmit={async (e) => {
              e.preventDefault();
              const previous = section.title;
              const next = title.trim();
              const ok = await actions.run(() => scriptApi.renameSection(section.id, next), {
                label: `Renamed to “${next}”`,
                run: () => scriptApi.renameSection(section.id, previous),
              });
              if (ok) setRenaming(false);
            }}
          >
            <input className="input grow" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Scene title" autoFocus />
            <button className="btn btn-secondary btn-sm" disabled={actions.busy || !title.trim()}>
              Save
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <h3>{section.title}</h3>
            <button
              type="button"
              className="icon-btn section-rename"
              aria-label={`Rename ${section.title}`}
              onClick={() => {
                setTitle(section.title);
                setRenaming(true);
              }}
            >
              <Pencil size={15} />
            </button>
          </>
        )}
      </header>
      <ol className="script-lines">
        {shown.map((line, i) => (
          <li key={line.id} id={`line-${line.id}`} className="script-line-item">
            {canJoinAtSeam(shown[i - 1], line) && (
              <JoinSeam
                upper={shown[i - 1]!}
                lower={line}
                near={[shown[i - 1]!.id, line.id].some((id) => id === selectedId || id === editingId)}
                characterName={characterName}
                busy={busy}
                onJoin={onJoin}
              />
            )}
            {line.id === editingId ? (
              renderEditor(line)
            ) : (
              <ScriptLine
                line={line}
                characterName={line.characterId ? (characters.get(line.characterId)?.name ?? null) : null}
                voices={speakerLabel(line, characters).voices}
                selected={line.id === selectedId}
                onOpen={onOpen}
                onKey={onLineKey}
              />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

const ScriptLine = memo(function ScriptLine({
  line,
  characterName,
  voices,
  selected,
  onOpen,
  onKey,
}: {
  line: Line;
  characterName: string | null;
  /** An ALL-style line: who says it. */
  voices: string | null;
  selected: boolean;
  onOpen: (line: Line, at: number | "end" | null) => void;
  onKey: (e: KeyboardEvent, line: Line) => void;
}) {
  const classes = ["script-row", `kind-${line.kind}`, selected && "is-selected"].filter(Boolean).join(" ");
  // A click on the text starts editing it right there; a click on the name opens the line's controls.
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    const onText = (e.target as HTMLElement).closest(".script-text");
    onOpen(line, onText ? (caretFromClick(e) ?? "end") : null);
  };
  return (
    <div className={classes}>
      <button type="button" className="script-line" onClick={open} onKeyDown={(e) => onKey(e, line)} aria-expanded={false}>
        {line.kind === "dialogue" &&
          (characterName ? (
            <span className="script-speaker-row">
              <CharacterName name={characterName} className="script-speaker" />
              {voices && <span className="script-voices">{voices}</span>}
            </span>
          ) : (
            <span className="character-name script-speaker missing">Who says this?</span>
          ))}
        <span className="script-text">
          <LineText text={line.text} kind={line.kind} />
        </span>
      </button>
    </div>
  );
});

/**
 * The break between two lines. Hover (or focus) shows a "Join" control right where the break is; on
 * touch screens it shows beside the line you're on. The upper line keeps its speaker, and the
 * control says so when the two differ.
 */
const JoinSeam = memo(function JoinSeam({
  upper,
  lower,
  near,
  characterName,
  busy,
  onJoin,
}: {
  upper: Line;
  lower: Line;
  near: boolean;
  characterName: (id: string) => string | undefined;
  busy: boolean;
  onJoin: (upper: Line, lower: Line) => void;
}) {
  const preview = joinPreview(upper, lower, characterName);
  return (
    <div className={`seam ${near ? "is-near" : ""} ${preview.differs ? "differs" : ""}`}>
      <button
        type="button"
        className="seam-btn"
        disabled={busy}
        // Only the breaks around the line you're on are tab stops; the editor has Join above and below too.
        tabIndex={near ? 0 : -1}
        onClick={() => onJoin(upper, lower)}
        aria-label={preview.description}
        title={preview.description}
      >
        <Link2 size={14} aria-hidden="true" />
        {preview.label}
      </button>
    </div>
  );
});
