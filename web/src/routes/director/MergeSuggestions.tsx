import { Merge, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Character } from "../../api/types";
import { CharacterName } from "../../components/CharacterName";
import { suggestMerges } from "./duplicateCharacters";

const dismissKey = (productionId: string) => `offbooked:merge-dismissed:${productionId}`;

function loadDismissed(productionId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(dismissKey(productionId)) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** One-tap merges for characters the parser split in two ("MACBETH (ASIDE)" and "MACBETH"). */
export function MergeSuggestions({
  productionId,
  characters,
  busy,
  onMerge,
}: {
  productionId: string;
  characters: Character[];
  busy: boolean;
  onMerge: (from: Character, into: Character) => Promise<boolean>;
}) {
  const [dismissed, setDismissed] = useState(() => loadDismissed(productionId));
  const suggestions = useMemo(() => suggestMerges(characters).filter((s) => !dismissed.has(`${s.from.id}>${s.into.id}`)), [characters, dismissed]);
  if (!suggestions.length) return null;

  const dismiss = (key: string) => {
    const next = new Set(dismissed).add(key);
    setDismissed(next);
    try {
      localStorage.setItem(dismissKey(productionId), JSON.stringify([...next]));
    } catch {
      // Private mode: the suggestion comes back next visit, which is fine.
    }
  };

  return (
    <section className="notice notice-accent merge-suggestions" aria-labelledby="merge-suggestions-title">
      <Merge size={20} aria-hidden="true" />
      <div className="stack grow">
        <strong id="merge-suggestions-title">{suggestions.length === 1 ? "Same character?" : `${suggestions.length} characters look like duplicates`}</strong>
        <ul className="merge-list">
          {suggestions.map((s) => {
            const key = `${s.from.id}>${s.into.id}`;
            return (
              <li key={key} className="merge-row">
                <span className="grow">
                  <CharacterName name={s.from.name} /> <span className="small muted">({s.from.lineCount} {s.from.lineCount === 1 ? "line" : "lines"})</span> looks like{" "}
                  <CharacterName name={s.into.name} />
                </span>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void onMerge(s.from, s.into)}>
                  Merge into {s.into.name}
                </button>
                <button type="button" className="icon-btn" aria-label={`Keep ${s.from.name} separate`} onClick={() => dismiss(key)}>
                  <X size={16} />
                </button>
              </li>
            );
          })}
        </ul>
        <p className="small muted">Merging moves every line to the character you keep, and adds the other name as an alias.</p>
      </div>
    </section>
  );
}
