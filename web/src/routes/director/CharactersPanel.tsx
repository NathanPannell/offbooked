import { Merge, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { script as api } from "../../api/director";
import type { Character } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import type { ReviewActions } from "./ScriptReview";
import { suggestMerges } from "./duplicateCharacters";

/** Rename, merge and add characters. */
export function CharactersPanel({
  productionId,
  characters,
  actions,
}: {
  productionId: string;
  characters: Character[];
  actions: ReviewActions;
}) {
  const [editing, setEditing] = useState<{ id: string; mode: "rename" | "merge" } | null>(null);
  const [name, setName] = useState("");
  const [intoId, setIntoId] = useState("");
  const [newName, setNewName] = useState("");
  const { run, busy } = actions;
  const sorted = [...characters].sort((a, b) => a.name.localeCompare(b.name));
  const suggested = new Map(suggestMerges(characters).map((m) => [m.from.id, m.into.id]));

  const close = () => setEditing(null);

  return (
    <div className="stack characters-panel">
      <p className="small muted">Duplicates like “HAMLET” and “HAM.”, or “MACBETH” and “MACBETH (ASIDE)”, can be merged: every line moves to the one you keep.</p>
      <ul className="character-list">
        {sorted.map((c) => (
          <li key={c.id} className="character-row">
            {editing?.id === c.id && editing.mode === "rename" ? (
              <form
                className="row grow"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await run(() => api.renameCharacter(c.id, name.trim()), {
                    label: `Renamed to ${name.trim()}`,
                    run: () => api.renameCharacter(c.id, c.name),
                  });
                  if (ok) close();
                }}
              >
                <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label={`New name for ${c.name}`} />
                <button className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
                  Save
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={close}>
                  Cancel
                </button>
              </form>
            ) : editing?.id === c.id && editing.mode === "merge" ? (
              <form
                className="row grow"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await run(() => api.mergeCharacter(c.id, intoId))) close();
                }}
              >
                <span>Merge {c.name} into</span>
                <select className="input grow" value={intoId} onChange={(e) => setIntoId(e.target.value)} aria-label="Character to keep">
                  <option value="">Choose…</option>
                  {sorted
                    .filter((o) => o.id !== c.id)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                </select>
                <button className="btn btn-primary btn-sm" disabled={busy || !intoId}>
                  Merge
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={close}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <div className="grow">
                  <CharacterName name={c.name} />
                  <span className="small muted">
                    {" "}
                    · {c.lineCount} lines{c.aliases.length > 0 && ` · also ${c.aliases.join(", ")}`}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Rename ${c.name}`}
                  onClick={() => {
                    setName(c.name);
                    setEditing({ id: c.id, mode: "rename" });
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Merge ${c.name} into another character`}
                  onClick={() => {
                    setIntoId(suggested.get(c.id) ?? "");
                    setEditing({ id: c.id, mode: "merge" });
                  }}
                >
                  <Merge size={16} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api.createCharacter(productionId, newName.trim().toUpperCase()))) setNewName("");
        }}
      >
        <input className="input grow" placeholder="New character name" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New character name" />
        <button className="btn btn-secondary btn-sm" disabled={busy || !newName.trim()}>
          <Plus size={16} aria-hidden="true" /> Add
        </button>
      </form>
    </div>
  );
}
