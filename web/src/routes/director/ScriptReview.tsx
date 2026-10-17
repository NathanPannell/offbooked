import { ArrowRight, Check, Link2, Pencil, RefreshCw, Undo2, X } from "lucide-react";
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
import { flagCounts, flagPosition, nextFlagged, type FlagFilter } from "./flagNav";
import { canJoinAtSeam, joinPreview, undoJoin } from "./lineJoin";
import { caretFromClick, FlagNote, LineEditor, LineText } from "./LineEditor";
import { MergeSuggestions } from "./MergeSuggestions";
import { scrollToLine } from "./reviewScroll";
import { SourcePane } from "./SourcePane";

export interface ReviewActions {
  /** Runs a change, refreshes the script, and offers `undo` when given. */
  run: (change: () => Promise<unknown>, undo?: { label: string; run: () => Promise<unknown> }) => Promise<boolean>;
  busy: boolean;
}

type Undo = { label: string; run: () => Promise<unknown> | void };

const APPROVE_COMMIT_MS = 4500;
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

export function ScriptReview({
  production,
  script,
  reload,
  setScript,
  onReplace,
  onDone,
}: {
  production: Production;
  script: Script;
  reload: () => Promise<void>;
  setScript: (update: (current: Script | undefined) => Script) => void;
  onReplace: () => void;
  onDone: () => void;
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
  // Approvals wait a moment before they're sent, so Undo can simply cancel them.
  const [approving, setApproving] = useState<Map<string, number>>(new Map());
  const approvingRef = useRef(approving);
  approvingRef.current = approving;
  const lastSeq = useRef<number | null>(null);

  const characters = useMemo(() => new Map(script.characters.map((c) => [c.id, c])), [script.characters]);
  const sections = useMemo(() => [...script.sections].sort((a, b) => a.seq - b.seq), [script.sections]);
  const lines = useMemo(
    () =>
      [...script.lines]
        .sort((a, b) => a.seq - b.seq)
        .map((l) => (l.flagged && approving.has(l.id) ? { ...l, flagged: false } : l)),
    [script.lines, approving],
  );
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
  const selected = selectedId ? lineById.get(selectedId) ?? null : null;
  const counts = useMemo(() => flagCounts(lines), [lines]);
  // A reason with nothing left to check falls back to all of them.
  // J/K and Next walk every flagged line (the per-reason filter left the bar to keep it one row).
  const flagFilter: FlagFilter = "all";
  const position = flagPosition(lines, selectedId, flagFilter);
  const allFlagged = counts.reduce((n, c) => n + c.count, 0);
  const recordingStarted = production.progress.linesRecorded > 0;
  if (selected) lastSeq.current = selected.seq;

  // ---- approvals ----

  const commitApproval = useCallback(
    async (lineId: string) => {
      const timer = approvingRef.current.get(lineId);
      if (timer === undefined) return;
      clearTimeout(timer);
      try {
        await scriptApi.resolveLine(lineId);
        setScript((s) => ({
          ...s!,
          lines: s!.lines.map((l) => (l.id === lineId ? { ...l, flagged: false } : l)),
          flaggedCount: Math.max(0, s!.flaggedCount - 1),
        }));
      } catch (err) {
        toast(`Couldn't save that approval. ${errorMessage(err)}`);
      } finally {
        setApproving((m) => {
          const next = new Map(m);
          next.delete(lineId);
          return next;
        });
      }
    },
    [setScript, toast],
  );

  const flushApprovals = useCallback(() => Promise.all([...approvingRef.current.keys()].map(commitApproval)), [commitApproval]);

  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && void flushApprovals();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void flushApprovals();
    };
  }, [flushApprovals]);

  const goTo = useCallback(
    (line: Line | null, open = true) => {
      if (!line) return;
      setSelectedId(line.id);
      if (open) {
        setEditingId(line.id);
        setStartText(null);
      }
      // After React commits (the editor moves to this line), measure and scroll: see reviewScroll.ts.
      scrollToLine(line.id);
      requestAnimationFrame(() =>
        document.getElementById(`line-${line.id}`)?.querySelector<HTMLElement>(".script-line")?.focus({ preventScroll: true }),
      );
    },
    [],
  );

  const approve = useCallback(
    (line: Line) => {
      if (!line.flagged) return;
      // Only the newest approval can be undone; send any earlier one now.
      void flushApprovals();
      const timer = window.setTimeout(() => void commitApproval(line.id), APPROVE_COMMIT_MS);
      setApproving((m) => new Map(m).set(line.id, timer));
      setUndo({
        label: "Marked as right",
        run: () => {
          clearTimeout(timer);
          setApproving((m) => {
            const next = new Map(m);
            next.delete(line.id);
            return next;
          });
          goTo(line, false);
        },
      });
      // The navigator moves on: if this was the line in hand, go to the next one to check.
      if (line.id === selectedId || editingId === line.id) {
        const remaining = lines.map((l) => (l.id === line.id ? { ...l, flagged: false } : l));
        const next = nextFlagged(remaining, line.seq, 1, flagFilter) ?? nextFlagged(remaining, line.seq, 1);
        if (next) goTo(next);
        else {
          setEditingId(null);
          toast("That's every line checked");
        }
      }
    },
    [commitApproval, editingId, flagFilter, flushApprovals, goTo, lines, selectedId, toast],
  );

  // ---- other edits ----

  const actions: ReviewActions = {
    busy,
    run: async (change, undoAction) => {
      setBusy(true);
      try {
        await flushApprovals();
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

  const moveFlag = (direction: 1 | -1, filter: FlagFilter = flagFilter) => goTo(nextFlagged(lines, lastSeq.current, direction, filter));

  // A fix moves on to the next line to check, if this one was flagged; otherwise the line stays open.
  const afterFix = (line: Line) => {
    if (!line.flagged) return;
    const remaining = lines.map((l) => (l.id === line.id ? { ...l, flagged: false } : l));
    const next = nextFlagged(remaining, line.seq, 1, flagFilter) ?? nextFlagged(remaining, line.seq, 1);
    if (next) goTo(next);
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
            flagged: was.flagged,
            flagCode: was.flagCode ?? null,
            flagReason: was.flagReason,
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

  // J/K anywhere (outside text fields) walk the flagged lines.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        moveFlag(1);
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        moveFlag(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onLineKey = useCallback(
    (e: KeyboardEvent, line: Line) => {
      if (e.key === "Enter" && line.flagged && !e.shiftKey) {
        e.preventDefault();
        approve(line);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        goTo(nextFlagged(lines, line.seq, e.key === "ArrowDown" ? 1 : -1), false);
      } else if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        setSelectedId(line.id);
        setEditingId(line.id);
        setStartText("end");
      }
    },
    [approve, goTo, lines],
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
  const approveRef = useRef(approve);
  approveRef.current = approve;
  const lineKeyRef = useRef(onLineKey);
  lineKeyRef.current = onLineKey;
  const stableApprove = useCallback((line: Line) => approveRef.current(line), []);
  const stableLineKey = useCallback((e: KeyboardEvent, line: Line) => lineKeyRef.current(e, line), []);

  const editing = editingId ? lineById.get(editingId) ?? null : null;
  const total = position.total;

  return (
    <div className={`review ${sourceOpen ? "source-open" : ""}`}>
      <div className="review-bar">
        {allFlagged > 0 ? (
          <button
            type="button"
            className="btn btn-primary review-next"
            onClick={() => moveFlag(1)}
            aria-label={position.index ? `Next line to check (${position.index} of ${total}) (J)` : `Next line to check (${total} left) (J)`}
            title="Next (J); K goes back"
          >
            <span className="flag-dot" aria-hidden="true" />
            Next
            <span className="review-next-count nums" aria-live="polite">
              {position.index ? `${position.index}/${total}` : total}
            </span>
          </button>
        ) : (
          <button type="button" className="btn btn-primary review-next is-clear" onClick={onDone}>
            <Check size={16} strokeWidth={3} aria-hidden="true" /> Share with the cast <ArrowRight size={16} aria-hidden="true" />
          </button>
        )}
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
                onApprove={stableApprove}
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
                    onApprove={() => approve(line)}
                    onFixed={() => afterFix(line)}
                    onDelete={() => void deleteLine(line)}
                    originalOpen={sourceOpen}
                    onToggleOriginal={() => setSourceOpen((o) => !o)}
                    onManageCharacters={() => setShowCharacters(true)}
                    onClose={() => {
                      setEditingId(null);
                      // After React swaps the editor back for the plain line.
                      setTimeout(() =>
                        document.getElementById(`line-${line.id}`)?.querySelector<HTMLElement>(".script-line")?.focus({ preventScroll: true }),
                      );
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
            <button type="button" className="btn btn-primary" onClick={onDone}>
              Next: share with the cast <ArrowRight size={18} aria-hidden="true" />
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
  onApprove,
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
  onApprove: (line: Line) => void;
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

  return (
    <section id={`section-${section.id}`} className={`script-section ${hasOpen ? "has-open" : ""}`} style={{ containIntrinsicSize: `auto ${lines.length * 64}px` }}>
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
        {lines.map((line, i) => (
          <li key={line.id} id={`line-${line.id}`} className="script-line-item">
            {canJoinAtSeam(lines[i - 1], line) && (
              <JoinSeam
                upper={lines[i - 1]!}
                lower={line}
                near={[lines[i - 1]!.id, line.id].some((id) => id === selectedId || id === editingId)}
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
                characterName={line.characterId ? characters.get(line.characterId)?.name ?? null : null}
                voices={speakerLabel(line, characters).voices}
                selected={line.id === selectedId}
                onOpen={onOpen}
                onApprove={onApprove}
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
  onApprove,
  onKey,
}: {
  line: Line;
  characterName: string | null;
  /** An ALL-style line: who says it. */
  voices: string | null;
  selected: boolean;
  onOpen: (line: Line, at: number | "end" | null) => void;
  onApprove: (line: Line) => void;
  onKey: (e: KeyboardEvent, line: Line) => void;
}) {
  const classes = ["script-row", `kind-${line.kind}`, line.flagged && "is-flagged", selected && "is-selected"].filter(Boolean).join(" ");
  const reasonId = `reason-${line.id}`;
  // A click on the text starts editing it right there; a click on the name opens the line's controls.
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    const onText = (e.target as HTMLElement).closest(".script-text");
    onOpen(line, onText ? caretFromClick(e) ?? "end" : null);
  };
  return (
    <div className={classes}>
      <button
        type="button"
        className="script-line"
        onClick={open}
        onKeyDown={(e) => onKey(e, line)}
        aria-expanded={false}
        aria-describedby={line.flagged ? reasonId : undefined}
      >
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
        {line.flagged && (
          <>
            <FlagNote line={line} id={reasonId} />
            <span className="sr-only">. Press Enter if it's right, or E to edit.</span>
          </>
        )}
      </button>
      {line.flagged && (
        <button type="button" className="approve-btn" onClick={() => onApprove(line)} aria-label="Looks right" title="Looks right (Enter)">
          <Check size={18} strokeWidth={3} />
        </button>
      )}
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
