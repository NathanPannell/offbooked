import { Plus } from "lucide-react";
import { useState } from "react";
import type { ActorApi } from "../../api/actor";
import { errorMessage } from "../../api/client";
import type { FreePart } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import { useToast } from "../../components/Toast";
import { plural } from "../../lib/format";
import { useResource } from "../../lib/useResource";

/**
 * Free parts the actor can pick up to record more lines: ones nobody has, including a part the
 * director took away from someone (its recorded lines keep playing; the rest are the computer voice).
 */
export function PickUpParts({
  api,
  onPicked,
  intro = "These parts are free. Pick one up and its lines join yours.",
}: {
  api: ActorApi;
  onPicked: (characters: { id: string; name: string }[]) => void;
  intro?: string;
}) {
  const toast = useToast();
  const parts = useResource(() => api.parts().then((r) => r.parts), "free-parts");
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

  if (parts.loading) return <p className="small muted">Finding free parts…</p>;
  if (parts.error) return <p className="small field-error">{errorMessage(parts.error)}</p>;
  const free: FreePart[] = parts.data ?? [];
  if (free.length === 0) return <p className="small muted">Every part has someone. Nothing to pick up right now.</p>;

  return (
    <div className="pick-up">
      <p className="small muted">{intro}</p>
      <ul className="pick-up-list">
        {free.map((p) => (
          <li key={p.id}>
            <label className="checkbox pick-up-part">
              <input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} />
              <span className="grow">
                <CharacterName name={p.name} />
                <span className="small muted">
                  {" "}
                  · {p.linesNeeded === p.lineCount ? plural(p.lineCount, "line") : `${p.linesNeeded} of ${plural(p.lineCount, "line")} still need a voice`}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || chosen.size === 0} onClick={() => void pick()}>
        <Plus size={16} aria-hidden="true" /> {busy ? "Adding…" : chosen.size > 1 ? `Pick up ${chosen.size} parts` : "Pick up this part"}
      </button>
    </div>
  );
}
