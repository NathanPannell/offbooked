import { ListTree } from "lucide-react";
import type { Section } from "../api/types";

/** Jump-to-scene picker. Hidden when the script has a single section. */
export function SectionNav({ sections, onJump, idPrefix = "section-" }: { sections: Section[]; onJump?: (id: string) => void; idPrefix?: string }) {
  if (sections.length < 2) return null;
  return (
    <label className="section-nav">
      <ListTree size={18} aria-hidden="true" />
      <span className="sr-only">Jump to scene</span>
      <select
        className="input"
        value=""
        onChange={(e) => {
          const id = e.target.value;
          if (!id) return;
          if (onJump) onJump(id);
          else document.getElementById(idPrefix + id)?.scrollIntoView({ block: "start", behavior: "smooth" });
        }}
      >
        <option value="">Jump to scene…</option>
        {sections.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
    </label>
  );
}
