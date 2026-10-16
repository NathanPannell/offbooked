import { ListTree } from "lucide-react";
import type { Section } from "../api/types";

/**
 * Jump-to-scene picker. Hidden when the script has a single section (unless `label` narrows the
 * list on purpose). `label` replaces an option's text, e.g. the scene with who is in it;
 * `placeholder` replaces "Jump to scene…".
 */
export function SectionNav({
  sections,
  onJump,
  idPrefix = "section-",
  label,
  placeholder = "Jump to scene…",
  always = false,
}: {
  sections: Section[];
  onJump?: (id: string) => void;
  idPrefix?: string;
  label?: (s: Section) => string;
  placeholder?: string;
  /** Show even with one section (a filtered list). */
  always?: boolean;
}) {
  if (sections.length === 0 || (sections.length < 2 && !always)) return null;
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
        <option value="">{placeholder}</option>
        {sections.map((s) => (
          <option key={s.id} value={s.id}>
            {label ? label(s) : s.title}
          </option>
        ))}
      </select>
    </label>
  );
}
