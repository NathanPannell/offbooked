import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { ParseProgress } from "../../api/types";
import { useTweenedNumbers } from "../../lib/useTween";
import { describeProgress, displayFraction, estimateLabelMs, PARSE_STAGES } from "./parseProgress";
import { readingLine } from "./setup";

/**
 * Live progress while the script is read: the file in the heading, a friendly line for the stage
 * it is really at, a bar over lines labelled, and counts that tick up.
 */
export function ParseProgressView({
  progress,
  fileName,
  eyebrow,
  headingLevel = 2,
}: {
  progress: ParseProgress | null | undefined;
  fileName?: string | null;
  eyebrow?: string;
  headingLevel?: 1 | 2;
}) {
  const tweened = useTweenedNumbers({
    linesDone: progress?.linesDone ?? 0,
    scenes: progress?.scenes ?? 0,
    speeches: progress?.speeches ?? 0,
  });
  const view = describeProgress({ ...progress, ...(progress?.linesTotal ? tweened : { scenes: tweened.scenes, speeches: tweened.speeches }) });
  // Keep the bar moving between server updates (the model thinks before its first rows arrive).
  const labelling = view.stage === 1 && view.fraction !== null;
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!labelling) return;
    setStartedAt((s) => s ?? Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [labelling]);
  const fraction =
    labelling && startedAt !== null ? displayFraction(view.fraction!, now - startedAt, estimateLabelMs(progress?.linesTotal ?? 0)) : view.fraction;
  const percent = fraction === null ? null : Math.round(fraction * 100);

  // The friendly line moves on every few seconds and starts over when the real stage changes.
  const [stageSince, setStageSince] = useState(() => ({ stage: view.stage, at: Date.now() }));
  const [tick, setTick] = useState(() => Date.now());
  if (stageSince.stage !== view.stage) setStageSince({ stage: view.stage, at: tick });
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const line = readingLine(view.stage, Math.max(0, tick - stageSince.at));
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <section className="parse raised" aria-labelledby="parse-title">
      <div className="parse-head">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <Heading id="parse-title" className="display parse-title" tabIndex={-1}>
          {fileName ? `Reading ${fileName}` : "Reading your script"}
        </Heading>
        <p key={line} className="parse-line" aria-hidden="true">
          {line}
        </p>
        <p className="muted small">It usually takes a minute or two. You can leave this page: it keeps going without you.</p>
      </div>

      <ol className="parse-stages">
        {PARSE_STAGES.map((label, i) => {
          const state = i < view.stage ? "done" : i === view.stage ? "now" : "next";
          return (
            <li key={label} className={`parse-stage is-${state}`} aria-current={state === "now" ? "step" : undefined}>
              <span className="parse-stage-dot" aria-hidden="true">
                {state === "done" ? <Check size={12} strokeWidth={3} /> : null}
              </span>
              {label}
            </li>
          );
        })}
      </ol>

      <div
        className={`progress parse-bar ${percent === null ? "progress-indeterminate" : ""}`}
        role="progressbar"
        aria-label="Reading the script"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={view.counts.join(", ") || "Starting"}
      >
        <span style={percent === null ? undefined : { width: `${Math.max(3, percent)}%` }} />
      </div>

      {/* Counts only once there are some; before that the friendly line says what is happening. */}
      {view.counts.length > 0 && (
        <p className="parse-counts mono nums" aria-hidden="true">
          {view.counts.join(" · ")}
        </p>
      )}
    </section>
  );
}
