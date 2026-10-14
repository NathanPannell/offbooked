import { AlertTriangle, ArrowRight, Check, ChevronDown, ChevronUp, FileText, Pencil, RefreshCw, Undo2, Users, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { errorMessage } from "../../api/client";
import { script as scriptApi } from "../../api/director";
import type { Character, Line, Production, Script, Section } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import { Dialog } from "../../components/Dialog";
import { SectionNav } from "../../components/SectionNav";
import { useToast } from "../../components/Toast";
import { plural } from "../../lib/format";
import { CharactersPanel } from "./CharactersPanel";
import { flagPosition, nextFlagged } from "./flagNav";
import { LineEditor } from "./LineEditor";
import { MergeSuggestions } from "./MergeSuggestions";
import { SourcePane } from "./SourcePane";

export interface ReviewActions {
  /** Runs a change, refreshes the script, and offers `undo` when given. */
  run: (change: () => Promise<unknown>, undo?: { label: string; run: () => Promise<unknown> }) => Promise<boolean>;
  busy: boolean;
}

type Undo = { label: string; run: () => Promise<unknown> | void };

const APPROVE_COMMIT_MS = 4500;
const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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
  const position = flagPosition(lines, selectedId);
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
      if (open) setEditingId(line.id);
      requestAnimationFrame(() => {
        const el = document.getElementById(`line-${line.id}`);
        el?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
        el?.querySelector<HTMLElement>(".script-line")?.focus({ preventScroll: true });
      });
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
        const next = nextFlagged(remaining, line.seq, 1);
        if (next) goTo(next);
        else {
          setEditingId(null);
          toast("That's every line checked");
        }
      }
    },
    [commitApproval, editingId, flushApprovals, goTo, lines, selectedId, toast],
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

  const moveFlag = (direction: 1 | -1) => goTo(nextFlagged(lines, lastSeq.current, direction));

  // A fix moves on to the next line to check, if this one was flagged.
  const afterFix = (line: Line) => {
    if (line.flagged) {
      const next = nextFlagged(lines.map((l) => (l.id === line.id ? { ...l, flagged: false } : l)), line.seq, 1);
      if (next) return goTo(next);
    }
    setEditingId(null);
  };

  // On small screens the original opens as a sheet over the bottom half: keep the line above it.
  useEffect(() => {
    if (!sourceOpen || !selectedId || window.matchMedia("(min-width: 1100px)").matches) return;
    document.getElementById(`line-${selectedId}`)?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [sourceOpen, selectedId]);

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
      }
    },
    [approve, goTo, lines],
  );

  const onOpen = useCallback((line: Line) => {
    setSelectedId(line.id);
    setEditingId((id) => (id === line.id ? null : line.id));
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
        {total > 0 ? (
          <div className="flag-nav" role="group" aria-label="Lines to check">
            <span className="flag-count" aria-live="polite">
              <span className="flag-dot" aria-hidden="true" />
              {position.index ? (
                <>
                  <strong className="nums">{position.index}</strong> of <strong className="nums">{total}</strong> to check
                </>
              ) : (
                <>
                  <strong className="nums">{total}</strong> {total === 1 ? "line" : "lines"} to check
                </>
              )}
            </span>
            <button type="button" className="icon-btn" onClick={() => moveFlag(-1)} aria-label="Previous line to check (K)" title="Previous (K)">
              <ChevronUp size={20} />
            </button>
            <button type="button" className="icon-btn" onClick={() => moveFlag(1)} aria-label="Next line to check (J)" title="Next (J)">
              <ChevronDown size={20} />
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => moveFlag(1)}>
              {position.index ? "Next" : "Start checking"}
            </button>
          </div>
        ) : (
          <div className="flag-nav is-clear">
            <span className="flag-count">
              <Check size={18} strokeWidth={3} aria-hidden="true" /> Every line checked
            </span>
            <button type="button" className="btn btn-primary btn-sm" onClick={onDone}>
              Share with the cast <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="review-tools">
          <SectionNav sections={sections} idPrefix="section-" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowCharacters(true)}>
            <Users size={16} aria-hidden="true" /> {script.characters.length}
            <span className="hide-sm">{script.characters.length === 1 ? " character" : " characters"}</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm source-toggle"
            aria-pressed={sourceOpen}
            onClick={() => setSourceOpen((o) => !o)}
          >
            <FileText size={16} aria-hidden="true" /> Original
          </button>
        </div>
      </div>

      <div className="review-body">
        <div className="review-main">
          {total > 0 && !selected && (
            <p className="review-intro">
              We weren't sure about {plural(total, "line")}. They're highlighted below. Tap <Check size={14} strokeWidth={3} aria-label="the tick" /> if a
              line is right, or tap the line to fix it. <span className="muted">Keys: J and K move, Enter approves, E edits.</span>
            </p>
          )}
          {recordingStarted && (
            <div className="notice notice-warn">
              <AlertTriangle size={18} aria-hidden="true" />
              <p>Recording has started. Changing a recorded line keeps its old take until someone records it again.</p>
            </div>
          )}

          <MergeSuggestions
            productionId={production.id}
            characters={script.characters}
            busy={busy}
            onMerge={(from, into) => actions.run(() => scriptApi.mergeCharacter(from.id, into.id))}
          />

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
                actions={actions}
                renderEditor={(line) => (
                  <LineEditor
                    key={line.id}
                    productionId={production.id}
                    line={line}
                    nextLine={lines[lines.indexOf(line) + 1] ?? null}
                    characters={script.characters}
                    nearby={nearbySpeakers(line)}
                    actions={actions}
                    onApprove={() => approve(line)}
                    onFixed={() => afterFix(line)}
                    onClose={() => setEditingId(null)}
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
  actions,
  renderEditor,
}: {
  section: Section;
  lines: Line[];
  characters: Map<string, Character>;
  selectedId: string | null;
  editingId: string | null;
  onOpen: (line: Line) => void;
  onApprove: (line: Line) => void;
  onLineKey: (e: KeyboardEvent, line: Line) => void;
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
        {lines.map((line) => (
          <li key={line.id} id={`line-${line.id}`} className="script-line-item">
            <ScriptLine
              line={line}
              characterName={line.characterId ? characters.get(line.characterId)?.name ?? null : null}
              selected={line.id === selectedId}
              open={line.id === editingId}
              onOpen={onOpen}
              onApprove={onApprove}
              onKey={onLineKey}
            />
            {line.id === editingId && renderEditor(line)}
          </li>
        ))}
      </ol>
    </section>
  );
}

const ScriptLine = memo(function ScriptLine({
  line,
  characterName,
  selected,
  open,
  onOpen,
  onApprove,
  onKey,
}: {
  line: Line;
  characterName: string | null;
  selected: boolean;
  open: boolean;
  onOpen: (line: Line) => void;
  onApprove: (line: Line) => void;
  onKey: (e: KeyboardEvent, line: Line) => void;
}) {
  const classes = ["script-row", `kind-${line.kind}`, line.flagged && "is-flagged", selected && "is-selected", open && "is-open"]
    .filter(Boolean)
    .join(" ");
  const reasonId = `reason-${line.id}`;
  return (
    <div className={classes}>
      <button
        type="button"
        className="script-line"
        onClick={() => onOpen(line)}
        onKeyDown={(e) => onKey(e, line)}
        aria-expanded={open}
        aria-describedby={line.flagged ? reasonId : undefined}
      >
        {line.kind === "dialogue" &&
          (characterName ? <CharacterName name={characterName} className="script-speaker" /> : <span className="character-name script-speaker missing">Who says this?</span>)}
        <span className="script-text">{line.text || " "}</span>
        {line.flagged && (
          <span className="flag-reason" id={reasonId}>
            <AlertTriangle size={12} aria-hidden="true" /> {line.flagReason ?? "Not sure about this one"}
            <span className="sr-only">. Press Enter if it's right, or E to edit.</span>
          </span>
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
