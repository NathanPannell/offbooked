import { ChevronsDown, ChevronsUp } from "lucide-react";

/**
 * "My previous line" and "My next line", on a row of their own above the play controls, with which
 * of the listener's lines they are on. Shown only with a part picked (myLines.ts says where each
 * tap lands). At either end a button is aria-disabled rather than disabled, so it keeps focus.
 */
export function MyLineNav({
  number,
  total,
  onPrevious,
  onNext,
}: {
  /** Which of the listener's lines has been reached, from 1 (0: none yet). */
  number: number;
  total: number;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}) {
  return (
    <div className="my-line-nav">
      <button type="button" className="my-line-btn" onClick={onPrevious ?? undefined} aria-disabled={!onPrevious} aria-label="My previous line">
        <ChevronsUp size={18} aria-hidden="true" />
        <span className="rt-long">My previous line</span>
        <span className="rt-short">Previous</span>
      </button>
      <span className="my-line-count small muted">
        {number > 0 ? (
          <>
            Mine <strong>{number}</strong> of {total}
          </>
        ) : (
          `${total} ${total === 1 ? "line" : "lines"} of mine`
        )}
      </span>
      <button type="button" className="my-line-btn" onClick={onNext ?? undefined} aria-disabled={!onNext} aria-label="My next line">
        <span className="rt-long">My next line</span>
        <span className="rt-short">Next</span>
        <ChevronsDown size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
