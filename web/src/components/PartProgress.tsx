import { plural } from "../lib/format";
import { ProgressBar } from "./ProgressBar";

/** How far along one part is: a bar, then its lines, how many are recorded and how many aren't yet. */
export function PartProgress({ total, recorded, label = "Lines recorded" }: { total: number; recorded: number; label?: string }) {
  const left = Math.max(0, total - recorded);
  return (
    <div className="part-progress">
      <ProgressBar value={recorded} max={total} label={label} className="progress-part" />
      <p className="part-progress-counts small nums" aria-live="polite">
        <span>{plural(total, "line")}</span>
        <span className="part-progress-done">
          <span className="dot" aria-hidden="true" /> {recorded} recorded
        </span>
        <span className="part-progress-left">
          <span className="dot" aria-hidden="true" /> {left} not yet recorded
        </span>
      </p>
    </div>
  );
}
