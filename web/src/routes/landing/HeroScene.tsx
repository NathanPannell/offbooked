import { Pause } from "lucide-react";
import { useEffect, useState } from "react";

const LINES = [
  { who: "FIRST WITCH", by: "Robin · recorded", text: "All hail, Macbeth! hail to thee, Thane of Glamis!" },
  { who: "SECOND WITCH", by: "Priya · recorded", text: "All hail, Macbeth! hail to thee, Thane of Cawdor!" },
  { who: "THIRD WITCH", by: "AI voice until Sam records", ai: true, text: "All hail, Macbeth, that shalt be king hereafter!" },
  { who: "BANQUO", by: "Your line", mine: true, text: "Good sir, why do you start; and seem to fear\nThings that do sound so fair?" },
];

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * The hero: a phone listening through Macbeth 1.3 as Banquo, each line with the castmate whose
 * voice plays (or the AI voice standing in), the words lighting up in turn. A picture, not audio.
 */
export function HeroScene() {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (reducedMotion()) {
      setBeat(LINES.length - 1);
      return;
    }
    const id = setInterval(() => setBeat((b) => (b + 1) % LINES.length), 3600);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mk-hero-scene" aria-hidden="true">
      <div className="mk-phone">
        <div className="mk-phone-notch" />
        <p className="mk-phone-title mono">Macbeth · Act 1, Scene 3</p>
        <p className="mk-phone-part">
          You're <strong>BANQUO</strong>
        </p>
        <ol className="mk-phone-lines">
          {LINES.map((line, i) => (
            <li key={i} className={`mk-phone-line ${i === beat ? "is-current" : i < beat ? "is-past" : ""} ${line.mine ? "is-mine" : ""}`}>
              <span className="mk-phone-who">
                {line.who} <span className={`mk-phone-by ${line.ai ? "is-ai" : ""}`}>{line.by}</span>
              </span>
              <span className="mk-phone-text" key={i === beat ? `on-${beat}` : "off"}>
                {line.text.split(/(\s+)/).map((w, j) =>
                  /\S/.test(w) ? (
                    <span key={j} style={i === beat ? { animationDelay: `${j * 110}ms` } : undefined}>
                      {w}
                    </span>
                  ) : (
                    w
                  ),
                )}
              </span>
              {line.mine && i === beat && <span className="mk-phone-gap" />}
            </li>
          ))}
        </ol>
        <div className="mk-phone-player">
          <span className="mk-phone-pause">
            <Pause size={16} fill="currentColor" />
          </span>
          <span className="mk-phone-mode">Pause, then read</span>
          <span className="mk-phone-speed mono">1×</span>
        </div>
      </div>
    </div>
  );
}
