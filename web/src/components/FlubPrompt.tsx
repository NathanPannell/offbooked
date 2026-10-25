import { ArrowLeft, Check } from "lucide-react";
import { useEffect, useRef } from "react";

/**
 * "Did you mean to say something else?", on the line card of a take the wrong-line check flagged.
 * Left: read it again (counting down to doing it by itself, when `secondsLeft` is set). Right: keep
 * the take, that's what was said. Never an offer to keep it for another line.
 */
export function FlubPrompt({ secondsLeft, onRetake, onKeep }: { secondsLeft: number | null; onRetake: () => void; onKeep: () => void }) {
  const keepRef = useRef<HTMLButtonElement>(null);
  // Focus the safe choice, so a keyboard or screen reader lands in the prompt without starting the mic.
  useEffect(() => keepRef.current?.focus({ preventScroll: true }), []);
  return (
    <div className="flub-prompt" role="group" aria-labelledby="flub-question">
      <p id="flub-question" className="flub-question">
        Did you mean to say something else?
      </p>
      <div className="flub-actions">
        <button type="button" className="btn btn-secondary flub-btn flub-retake" onClick={onRetake}>
          <ArrowLeft size={22} aria-hidden="true" />
          <span>
            No, I'll read it again
            {secondsLeft !== null && (
              <span className="flub-countdown nums" aria-live="polite">
                {secondsLeft > 0 ? `Starting in ${secondsLeft}` : "Starting…"}
              </span>
            )}
          </span>
        </button>
        <button ref={keepRef} type="button" className="btn btn-primary flub-btn flub-keep" onClick={onKeep}>
          <Check size={22} aria-hidden="true" />
          <span>Yep, that's what I said</span>
        </button>
      </div>
    </div>
  );
}
