import { Check, CircleAlert, MicOff } from "lucide-react";
import type { SttResult } from "../api/types";
import { scoreLabel, verdict, VERDICT_MESSAGE, type Verdict } from "../stt/score";

const ICON: Record<Verdict, typeof Check> = { complete: Check, partial: CircleAlert, unattempted: MicOff };

/** Chip colour for a verdict. */
export const VERDICT_CHIP: Record<Verdict, string> = { complete: "chip-good", partial: "chip-check", unattempted: "chip-bad" };

/** Whether a take sounded complete. Tapping it toggles the word-by-word breakdown. */
export function AccuracyChip({ result, expanded, onToggle }: { result: SttResult; expanded: boolean; onToggle: () => void }) {
  const v = verdict(result);
  const Icon = ICON[v];
  return (
    <button type="button" className={`chip ${VERDICT_CHIP[v]}`} aria-expanded={expanded} onClick={onToggle} title={VERDICT_MESSAGE[v]}>
      <Icon size={14} aria-hidden="true" />
      {scoreLabel(result)}
      <span className="sr-only">. {VERDICT_MESSAGE[v]} Show details.</span>
    </button>
  );
}
