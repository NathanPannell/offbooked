import type { WordOp } from "../api/types";
import { annotateLine } from "../stt/score";

/** The line as written, with missed words struck through, changed words marked and extra words shown. */
export function WordDiff({ text, ops, transcript }: { text: string; ops: WordOp[]; transcript: string }) {
  const annotated = annotateLine(text, ops);
  return (
    <div className="word-diff">
      <p className="word-diff-line">
        {annotated
          ? [
              ...annotated.leading.map((w, i) => (
                <ins key={`lead-${i}`} className="wd-extra" title="Extra word">
                  {w}
                </ins>
              )),
              ...annotated.words.flatMap((word, i) => [
                word.state === "missed" ? (
                  <del key={i} className="wd-missed" title="Missed">
                    {word.text}
                  </del>
                ) : word.state === "changed" ? (
                  <mark key={i} className="wd-changed" title={`Heard “${word.heard}”`}>
                    {word.text}
                    <span className="wd-heard"> {word.heard}</span>
                  </mark>
                ) : (
                  <span key={i}>{word.text}</span>
                ),
                ...word.extra.map((w, j) => (
                  <ins key={`${i}-x${j}`} className="wd-extra" title="Extra word">
                    {w}
                  </ins>
                )),
              ]),
            ].flatMap((node, i) => (i === 0 ? [node] : [" ", node]))
          : ops.map((op, i) => (
              <span key={i}>
                {i > 0 && " "}
                {op.op === "ok" ? (
                  op.expected
                ) : op.op === "del" ? (
                  <del className="wd-missed">{op.expected}</del>
                ) : op.op === "ins" ? (
                  <ins className="wd-extra">{op.heard}</ins>
                ) : (
                  <mark className="wd-changed">
                    {op.expected}
                    <span className="wd-heard"> {op.heard}</span>
                  </mark>
                )}
              </span>
            ))}
      </p>
      <p className="word-diff-heard">
        <span className="eyebrow">We heard</span> {transcript ? `“${transcript}”` : "nothing we could make out"}
      </p>
      <p className="word-diff-legend small muted">
        <del className="wd-missed">missed</del> <mark className="wd-changed">changed</mark>{" "}
        <ins className="wd-extra">extra</ins>
      </p>
    </div>
  );
}
