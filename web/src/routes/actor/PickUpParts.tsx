import { Plus } from "lucide-react";
import { useState } from "react";
import type { ActorApi } from "../../api/actor";
import { errorMessage } from "../../api/client";
import type { PartCard } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import { useToast } from "../../components/Toast";
import { plural } from "../../lib/format";
import { recorderLabel } from "../../lib/recorders";
import { useResource } from "../../lib/useResource";

/**
 * "Record lines for another character": every part the actor hasn't picked, whoever else has.
 * Lines nobody has recorded play in the computer voice; the parts that need a voice come first.
 */
export function PickUpParts({ api, onPicked }: { api: ActorApi; onPicked: (characters: { id: string; name: string }[]) => void }) {
  const toast = useToast();
  const parts = useResource(() => api.parts().then((r) => r.parts), "pick-up-parts");
  const [chosen, setChosen] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setChosen((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pick = async () => {
    setBusy(true);
    try {
      const { characters } = await api.pickUp([...chosen]);
      onPicked(characters);
    } catch (err) {
      toast(errorMessage(err));
      setChosen(new Set());
      void parts.reload();
    } finally {
      setBusy(false);
    }
  };

  if (parts.loading) return <p className="small muted">Finding parts…</p>;
  if (parts.error) return <p className="small field-error">{errorMessage(parts.error)}</p>;
  const list: PartCard[] = parts.data ?? [];
  if (list.length === 0) return <p className="small muted">You have every part already.</p>;

  return (
    <div className="pick-up">
      <ul className="pick-up-list">
        {list.map((p) => {
          const by = recorderLabel(p.topRecorder);
          return (
            <li key={p.id}>
              <label className="checkbox pick-up-part">
                <input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="grow">
                  <CharacterName name={p.name} />
                  <span className="small muted">
                    {" "}
                    ·{" "}
                    {p.linesNeeded === p.lineCount
                      ? plural(p.lineCount, "line")
                      : p.linesNeeded === 0
                        ? `all ${plural(p.lineCount, "line")} recorded`
                        : `${p.linesNeeded} of ${plural(p.lineCount, "line")} still need a voice`}
                    {by && ` · ${by}`}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || chosen.size === 0} onClick={() => void pick()}>
        <Plus size={16} aria-hidden="true" />{" "}
        {busy ? "Adding…" : chosen.size > 1 ? `Record lines for ${chosen.size} characters` : "Record lines for this character"}
      </button>
    </div>
  );
}
