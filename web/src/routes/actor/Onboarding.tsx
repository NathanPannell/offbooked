import { ArrowLeft, ArrowRight, Headphones, Mic, Users } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Brand } from "../../components/Brand";
import { InAppBanner } from "../../components/InAppBanner";
import { readStorage, writeStorage } from "../../lib/storage";

const SEEN_KEY = "offbooked.onboarded";

/** Whether this device has been through (or skipped) the intro. */
export const onboardingSeen = () => readStorage(SEEN_KEY) === "1";
export const markOnboardingSeen = () => writeStorage(SEEN_KEY, "1");

interface Slide {
  icon: ReactNode;
  title: string;
  body: ReactNode;
}

/**
 * A short, optional intro for someone opening an invite: three screens on how Offbooked works, with
 * Skip always one tap away. Seen once per device; anyone who knows it skips straight to their part.
 */
export function Onboarding({
  productionTitle,
  directorName,
  finishLabel = "Pick my part",
  onDone,
}: {
  productionTitle: string;
  directorName: string;
  /** The last screen's button. */
  finishLabel?: string;
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const touchX = useRef<number | null>(null);

  const slides: Slide[] = [
    {
      icon: <Users size={30} strokeWidth={1.6} />,
      title: "Your cast, recorded from anywhere",
      body: (
        <>
          <p>
            {directorName} is putting together a read-through of <em>{productionTitle}</em>. Everyone records their own lines on their phone, whenever suits
            them.
          </p>
          <p>No app to install and no account. This link is all you need, so keep it handy.</p>
        </>
      ),
    },
    {
      icon: <Mic size={30} strokeWidth={1.6} />,
      title: "Read your lines, hands-free",
      body: (
        <>
          <p>Pick your part, tap record and say your line. Offbooked hears when you've finished and moves on to the next one.</p>
          <p>Listen back, redo or delete any take. Want to hear your cue first? Turn on Hear partners, with headphones in.</p>
        </>
      ),
    },
    {
      icon: <Headphones size={30} strokeWidth={1.6} />,
      title: "Hear the whole play come together",
      body: (
        <>
          <p>
            Your takes join everyone else's, so you can listen through the whole play. Lines nobody has recorded yet play in a computer voice until someone
            does.
          </p>
          <p>Practise your part against it any time, and pick up another part if you have time for more.</p>
        </>
      ),
    },
  ];
  const last = index === slides.length - 1;
  const slide = slides[index]!;

  const finish = () => {
    markOnboardingSeen();
    onDone();
  };
  const go = (next: number) => setIndex(Math.max(0, Math.min(slides.length - 1, next)));

  // Move focus to the new screen's heading so screen readers announce it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(index + 1);
      else if (e.key === "ArrowLeft") go(index - 1);
      else if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <main
      className="onboarding"
      onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const start = touchX.current;
        const end = e.changedTouches[0]?.clientX;
        touchX.current = null;
        if (start === null || end === undefined || Math.abs(end - start) < 50) return;
        go(index + (end < start ? 1 : -1));
      }}
    >
      <InAppBanner />
      <header className="onboarding-head">
        <Brand to={null} />
        <button type="button" className="btn btn-ghost btn-sm onboarding-skip" onClick={finish}>
          Skip intro
        </button>
      </header>

      <section className="onboarding-slide" key={index} aria-roledescription="slide" aria-label={`${index + 1} of ${slides.length}`}>
        <span className="onboarding-icon" aria-hidden="true">
          {slide.icon}
        </span>
        <p className="eyebrow">
          {index + 1} of {slides.length}
        </p>
        <h1 className="display" ref={headingRef} tabIndex={-1}>
          {slide.title}
        </h1>
        <div className="onboarding-body">{slide.body}</div>
      </section>

      <footer className="onboarding-foot">
        <div className="onboarding-dots" role="group" aria-label="Intro screens">
          {slides.map((s, i) => (
            <button
              key={s.title}
              type="button"
              className={`onboarding-dot${i === index ? " is-on" : ""}`}
              aria-label={`Screen ${i + 1}: ${s.title}`}
              aria-current={i === index ? "step" : undefined}
              onClick={() => go(i)}
            />
          ))}
        </div>
        <div className="onboarding-actions">
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => (last ? finish() : go(index + 1))}>
            {last ? finishLabel : "Next"} <ArrowRight size={18} aria-hidden="true" />
          </button>
          {index > 0 && (
            <button type="button" className="btn btn-ghost" onClick={() => go(index - 1)}>
              <ArrowLeft size={18} aria-hidden="true" /> Back
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}
