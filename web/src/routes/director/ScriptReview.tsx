import { AlertTriangle, ArrowRight, Pencil, RefreshCw, Undo2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { errorMessage } from "../../api/client";
import { script as scriptApi } from "../../api/director";
import type { Character, Line, Production, Script, Section } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import { Dialog } from "../../components/Dialog";
import { SectionNav } from "../../components/SectionNav";
import { useToast } from "../../components/Toast";
import { plural } from "../../lib/format";
import { CharactersPanel } from "./CharactersPanel";
import { MergeSuggestions } from "./MergeSuggestions";
import { LineEditor } from "./LineEditor";

export interface ReviewActions {
  /** Runs a change, refreshes the script, and offers `undo` when given. */
  run: (change: () => Promise<unknown>, undo?: { label: string; run: () => Promise<unknown> }) => Promise<boolean>;
  busy: boolean;
}

export function ScriptReview({
  production,
  script,
  reload,
  onReplace,
  onDone,
}: {
  production: Production;
  script: Script;
  reload: () => Promise<void>;
  onReplace: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [view, setView] = useState<"flagged" | "all">(script.flaggedCount > 0 ? "flagged" : "all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renamingSection, setRenamingSection] = useState<Section | null>(null);
  const [showCharacters, setShowCharacters] = useState(false);
  const [undo, setUndo] = useState<{ label: string; run: () => Promise<unknown> } | null>(null);
  const [busy, setBusy] = useState(false);

  const characters = useMemo(() => new Map(script.characters.map((c) => [c.id, c])), [script.characters]);
  const sections = useMemo(() => [...script.sections].sort((a, b) => a.seq - b.seq), [script.sections]);
  const lines = useMemo(() => [...script.lines].sort((a, b) => a.seq - b.seq), [script.lines]);
  const flagged = lines.filter((l) => l.flagged);
  const editing = lines.find((l) => l.id === editingId) ?? null;
  const editingNext = editing ? lines[lines.indexOf(editing) + 1] ?? null : null;
  const recordingStarted = production.progress.linesRecorded > 0;

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
    if (await actions.run(action.run)) toast("Undone");
  };

  const sectionTitle = (id: string) => sections.find((s) => s.id === id)?.title ?? "";

  return (
    <div className="review">
      <div className="review-toolbar">
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={view === "flagged"} onClick={() => setView("flagged")}>
            Needs a look{flagged.length > 0 && <span className="count">{flagged.length}</span>}
          </button>
          <button type="button" aria-pressed={view === "all"} onClick={() => setView("all")}>
            Whole script
          </button>
        </div>
        <div className="row">
          {view === "all" && <SectionNav sections={sections} />}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowCharacters(true)}>
            <Users size={16} aria-hidden="true" /> {plural(script.characters.length, "character")}
          </button>
        </div>
      </div>

      {recordingStarted && (
        <div className="notice notice-warn">
          <AlertTriangle size={20} aria-hidden="true" />
          <p>
            Recording has started. Recordings stay attached to their line, so changing a recorded line's text or speaker
            keeps the old take until the actor re-records it.
          </p>
        </div>
      )}

      <MergeSuggestions
        productionId={production.id}
        characters={script.characters}
        busy={busy}
        onMerge={(from, into) => actions.run(() => scriptApi.mergeCharacter(from.id, into.id))}
      />

      {view === "flagged" ? (
        flagged.length === 0 ? (
          <div className="card empty-flagged stack">
            <h2>Nothing flagged</h2>
            <p className="muted">
              The parser is confident about every line. Skim the whole script once, then move on to casting.
            </p>
            <div className="row">
              <button type="button" className="btn btn-secondary" onClick={() => setView("all")}>
                Skim the script
              </button>
              <button type="button" className="btn btn-primary" onClick={onDone}>
                Cast the show <ArrowRight size={18} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <p className="flag-count" aria-live="polite">
              <strong>{plural(flagged.length, "line")} need a look.</strong>{" "}
              <span className="muted">Tap a line to fix it, or mark it as right.</span>
            </p>
            <ol className="script-lines">
              {flagged.map((line) => (
                <li key={line.id}>
                  <p className="eyebrow">{sectionTitle(line.sectionId)}</p>
                  <ScriptLine line={line} character={line.characterId ? characters.get(line.characterId) : undefined} onOpen={() => setEditingId(line.id)} />
                </li>
              ))}
            </ol>
          </div>
        )
      ) : (
        <div className="script-sections">
          {sections.map((section) => (
            <section key={section.id} id={`section-${section.id}`} className="script-section">
              <div className="section-head">
                <h3>{section.title}</h3>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Rename ${section.title}`}
                  onClick={() => setRenamingSection(section)}
                >
                  <Pencil size={16} />
                </button>
              </div>
              <ol className="script-lines">
                {lines
                  .filter((l) => l.sectionId === section.id)
                  .map((line) => (
                    <li key={line.id}>
                      <ScriptLine
                        line={line}
                        character={line.characterId ? characters.get(line.characterId) : undefined}
                        onOpen={() => setEditingId(line.id)}
                      />
                    </li>
                  ))}
              </ol>
            </section>
          ))}
        </div>
      )}

      <div className="review-footer">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onReplace} disabled={recordingStarted}>
          <RefreshCw size={16} aria-hidden="true" /> Replace script
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Cast the show <ArrowRight size={18} aria-hidden="true" />
        </button>
      </div>

      {undo && (
        <div className="undo-bar" role="status">
          <span>{undo.label}</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={runUndo} disabled={busy}>
            <Undo2 size={16} aria-hidden="true" /> Undo
          </button>
        </div>
      )}

      <Dialog open={!!editing} onClose={() => setEditingId(null)} title="Fix this line">
        {editing && (
          <LineEditor
            key={editing.id}
            productionId={production.id}
            line={editing}
            nextLine={editingNext}
            characters={script.characters}
            actions={actions}
            onClose={() => setEditingId(null)}
          />
        )}
      </Dialog>

      <Dialog open={showCharacters} onClose={() => setShowCharacters(false)} title="Characters">
        <CharactersPanel productionId={production.id} characters={script.characters} actions={actions} />
      </Dialog>

      <Dialog open={!!renamingSection} onClose={() => setRenamingSection(null)} title="Rename section">
        {renamingSection && (
          <RenameSection
            section={renamingSection}
            onSave={async (title) => {
              const previous = renamingSection.title;
              const ok = await actions.run(() => scriptApi.renameSection(renamingSection.id, title), {
                label: `Renamed to “${title}”`,
                run: () => scriptApi.renameSection(renamingSection.id, previous),
              });
              if (ok) setRenamingSection(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function ScriptLine({ line, character, onOpen }: { line: Line; character?: Character; onOpen: () => void }) {
  return (
    <button type="button" className={`script-line kind-${line.kind} ${line.flagged ? "is-flagged" : ""}`} onClick={onOpen}>
      {line.kind === "dialogue" &&
        (character ? <CharacterName name={character.name} /> : <span className="character-name missing">No character</span>)}
      <span className="script-line-text">{line.text}</span>
      {line.flagged && line.flagReason && (
        <span className="flag-reason">
          <AlertTriangle size={14} aria-hidden="true" /> {line.flagReason}
        </span>
      )}
    </button>
  );
}

function RenameSection({ section, onSave }: { section: Section; onSave: (title: string) => void }) {
  const [title, setTitle] = useState(section.title);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(title.trim());
      }}
    >
      <label className="field">
        <span>Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      <button className="btn btn-primary" disabled={!title.trim()}>
        Save
      </button>
    </form>
  );
}
