import { Check, CircleAlert, RotateCcw } from "lucide-react";
import type { SttResult } from "../api/types";
import { scoreLabel, verdict, VERDICT_MESSAGE, type Verdict } from "../stt/score";

const ICON: Record<Verdict, typeof Check> = { good: Check, check: CircleAlert, rerecord: RotateCcw };
const CLASS: Record<Verdict, string> = { good: "chip-good", check: "chip-check", rerecord: "chip-bad" };

/** Accuracy for a take. Tapping it toggles the word-by-word breakdown. */
export function AccuracyChip({
  result,
  expanded,
  onToggle,
}: {
  result: SttResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  const v = verdict(result);
  const Icon = ICON[v];
  return (
    <button
      type="button"
      className={`chip ${CLASS[v]}`}
      aria-expanded={expanded}
      onClick={onToggle}
      title={VERDICT_MESSAGE[v]}
    >
      <Icon size={14} aria-hidden="true" />
      {scoreLabel(result)}
      <span className="sr-only">. {VERDICT_MESSAGE[v]}. Show details.</span>
    </button>
  );
}
