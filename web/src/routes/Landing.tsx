import { ArrowRight, Check, Mic, Play, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { session } from "../api/client";
import { Brand } from "../components/Brand";
import { Demo, type DemoHandle } from "./landing/Demo";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const FAQ: { q: string; a: string }[] = [
  {
    q: "Does the cast need an account?",
    a: "No. Your cast opens one link, picks their character, types a first name and starts recording. Only whoever sets up the production signs in, with a link we email you. No passwords.",
  },
  {
    q: "Do I have to be the director?",
    a: "No. Anyone with the script can set up a production: a director, a stage manager, or an actor who wants the whole cast running lines.",
  },
  {
    q: "What scripts work?",
    a: "PDFs with real text in them, Word .docx files and plain text, up to 20 MB. You can also paste the script straight in. Scanned pages without a text layer don't work yet. We keep your line breaks and indentation, so verse and lyrics stay as written.",
  },
  {
    q: "Is it free?",
    a: "Yes, while Offbooked is in beta.",
  },
  {
    q: "Are the recordings private to my cast?",
    a: "Yes. Nothing is public. Recordings only play through your production's own links, for your cast and you. Seven days after your final performance date, the script and every recording are deleted.",
  },
  {
    q: "Does it work on iPhone?",
    a: "Yes, in Safari, and in Chrome on Android and computers. No app to install. If someone opens the link inside Instagram or Messenger, we'll nudge them to open it in their real browser, because those often block the microphone.",
  },
];

export function Landing() {
  const signedIn = !!session.get();
  // One call to action everywhere on the page, so the corner, the hero and the closing band agree.
  const cta = signedIn ? { to: "/app", label: "Your productions" } : { to: "/signin", label: "Get off book together" };
  const demo = useRef<DemoHandle>(null);

  const hearDemo = () => {
    document.getElementById("demo")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    demo.current?.play();
  };

  return (
    <div className="landing">
      <nav className="landing-nav" aria-label="Main">
        <Brand to="/" />
        <Link className="btn btn-primary" to={cta.to}>
          {cta.label} <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </nav>

      <header className="hero">
        <div className="hero-copy">
          <p className="mono hero-strip">Free while in beta · Works on any phone · No app</p>
          <h1 className="hero-title">
            Run lines with your <span className="marker">whole cast.</span> No rehearsal room required.
          </h1>
          <p className="hero-lede">
            Upload the script, send one link, and everyone records their lines from their phone in a few minutes. Then the whole play comes back as one
            run-through, with gaps where you speak.
          </p>
          <div className="hero-ctas">
            <Link className="btn btn-primary btn-lg" to={cta.to}>
              {cta.label} <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
        </div>
        <HeroScene />
      </header>

      <section className="landing-section demo-section" id="demo" aria-labelledby="demo-title">
        <div className="section-intro">
          <p className="eyebrow">The run-through</p>
          <h2 id="demo-title" className="section-title">
            Press play. You're Hamlet.
          </h2>
          <p className="muted">This is what your cast hears: the scene, line by line, like lyrics. Switch to “My part” and it stops for your lines.</p>
          <div>
            <button type="button" className="btn btn-secondary" onClick={hearDemo}>
              <Play size={17} fill="currentColor" aria-hidden="true" /> Hear a demo
            </button>
          </div>
        </div>
        <Demo ref={demo} />
      </section>

      <section className="landing-section" aria-labelledby="acts-title">
        <div className="section-intro">
          <p className="eyebrow">How it works</p>
          <h2 id="acts-title" className="section-title">
            A play in three acts
          </h2>
        </div>
        <ol className="acts">
          <li className="act">
            <p className="act-label mono">Act I</p>
            <h3>Upload your script.</h3>
            <p className="muted">PDF, Word or plain text. Offbooked finds every scene, character and line, and shows you the few it wasn't sure about.</p>
            <ActParse />
          </li>
          <li className="act">
            <p className="act-label mono">Act II</p>
            <h3>Send one link to the cast.</h3>
            <p className="muted">Everyone taps their part, types a first name and records. Two parts? Pick both.</p>
            <ActCastLink />
          </li>
          <li className="act">
            <p className="act-label mono">Act III</p>
            <h3>Hear the whole play.</h3>
            <p className="muted">Every take is stitched into one run-through. Practise your part with gaps where you speak.</p>
            <ActGap />
          </li>
        </ol>
      </section>

      <section className="landing-section loop-section" aria-labelledby="loop-title">
        <div className="section-intro">
          <p className="eyebrow">The rehearsal loop</p>
          <h2 id="loop-title" className="section-title">
            It sounds like a play from day one
          </h2>
          <p className="muted">Nobody waits for the slowest recorder. Every line always has a voice, and it keeps getting better.</p>
        </div>
        <ol className="loop">
          <li className="loop-step">
            <span className="tag tag-tts">TTS</span>
            <h3>Day one, a computer voice reads every line.</h3>
            <p className="muted small">Upload the script and you can already hear the whole scene.</p>
          </li>
          <li className="loop-step">
            <span className="tag tag-standin">stand-in</span>
            <h3>You read in for scene partners.</h3>
            <p className="muted small">Record any line yourself, scene by scene, and it replaces the robot.</p>
          </li>
          <li className="loop-step">
            <span className="tag tag-actor">Sam</span>
            <h3>Actors replace them as they record.</h3>
            <p className="muted small">Each take drops into the run-through within seconds.</p>
          </li>
          <li className="loop-step">
            <span className="tag tag-score">94% word-perfect</span>
            <h3>“Practise my part” checks your words.</h3>
            <p className="muted small">Say your lines into the gaps and see which words slipped, right on your phone.</p>
          </li>
        </ol>
      </section>

      <section className="landing-section who-section" aria-labelledby="who-title">
        <div className="section-intro">
          <p className="eyebrow">Who it's for</p>
          <h2 id="who-title" className="section-title">
            Anyone with lines to learn
          </h2>
        </div>
        <ul className="who">
          <li>
            <strong>Directors</strong> who want the cast off book before the first stagger-through.
          </li>
          <li>
            <strong>Drama teachers</strong> with thirty students, one script and two rehearsals a week.
          </li>
          <li>
            <strong>Community theatre</strong> casts who rehearse around jobs, kids and night shifts.
          </li>
          <li>
            <strong>Actors drilling solo</strong> on the bus, with every cue in the right voice.
          </li>
        </ul>
      </section>

      <section className="landing-section faq-section" aria-labelledby="faq-title">
        <div className="section-intro">
          <p className="eyebrow">Questions</p>
          <h2 id="faq-title" className="section-title">
            Fair questions
          </h2>
        </div>
        <div className="faq">
          {FAQ.map((item) => (
            <details key={item.q} className="faq-item">
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="cta-band" aria-labelledby="cta-title">
        <h2 id="cta-title" className="display">
          Places, everyone.
        </h2>
        <p>Add your script tonight, drop one link in the cast chat, and wake up to a run-through.</p>
        <Link className="btn btn-primary btn-lg" to={cta.to}>
          {cta.label} <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </section>

      <footer className="landing-footer">
        <Brand to="/" />
        <p>Made for casts, crews and whoever is holding the book. Offbooked is in early development, so tell us what breaks.</p>
        <p className="mono">Break a leg.</p>
      </footer>
    </div>
  );
}

/** The hero: an actor's recording screen next to the run-through, with lines lighting up in turn. */
function HeroScene() {
  const [beat, setBeat] = useState(1);
  useEffect(() => {
    if (reducedMotion()) return;
    const id = setInterval(() => setBeat((b) => (b + 1) % 4), 2200);
    return () => clearInterval(id);
  }, []);
  const lyrics = [
    { who: "Horatio", text: "Hail to your lordship." },
    { who: "Hamlet", text: "I am glad to see you well.", you: true },
    { who: "Horatio", text: "The same, my lord, and your poor servant ever." },
    { who: "Hamlet", text: "Sir, my good friend; I'll change that name with you.", you: true },
  ];
  return (
    <div className="hero-scene" aria-hidden="true">
      <svg className="hero-spot" viewBox="0 0 400 400">
        <path d="M200 0 60 400h280z" fill="var(--marker)" opacity="0.35" />
      </svg>
      <div className="phone">
        <div className="phone-notch" />
        <p className="phone-title mono">Hamlet · Act 1, Sc. 2</p>
        <p className="phone-progress">
          You're <strong>HAMLET</strong> · 7 of 23
        </p>
        <div className="phone-bar">
          <span />
        </div>
        <div className="phone-card">
          <p className="phone-cue">
            <span className="phone-who">Horatio</span> The same, my lord, and your poor servant ever.
          </p>
          <p className="phone-line">Sir, my good friend; I'll change that name with you.</p>
        </div>
        <div className="phone-rec">
          <span className="phone-rec-btn">
            <Mic size={26} />
          </span>
          <span className="phone-rec-hint">Tap, say your line, tap to stop</span>
        </div>
      </div>
      <div className="hero-lyrics raised">
        <p className="mono hero-lyrics-label">Run-through</p>
        {lyrics.map((l, i) => (
          <p key={i} className={`hero-lyric ${i === beat ? "is-current" : i < beat ? "is-past" : ""} ${l.you ? "is-you" : ""}`}>
            <span className="hero-lyric-who">
              {l.who}
              {l.you && i === beat && <em> · your line</em>}
            </span>
            {l.text}
          </p>
        ))}
      </div>
      <span className="hero-badge">
        <Check size={14} strokeWidth={3} /> Saved
      </span>
    </div>
  );
}

/** Act I: the live count while a script is read. */
function ActParse() {
  return (
    <div className="act-ui" aria-hidden="true">
      <p className="mono act-ui-label">Reading your script</p>
      <div className="progress act-progress">
        <span />
      </div>
      <p className="mono act-ui-counts">97 pages · 2,340 of 5,190 lines · 14 scenes</p>
    </div>
  );
}

/** Act II: the cast link, with parts claimed. */
function ActCastLink() {
  return (
    <div className="act-ui" aria-hidden="true">
      <div className="act-link">
        <span className="mono">offbooked.com/join/k3x9…</span>
        <span className="act-share">
          <Share2 size={13} /> Share
        </span>
      </div>
      <ul className="act-roles">
        <li className="is-taken">
          <strong>HAMLET</strong> <span>Taken by Sam</span>
        </li>
        <li className="is-picked">
          <strong>OPHELIA</strong> <span>58 lines</span>
        </li>
        <li>
          <strong>HORATIO</strong> <span>41 lines</span>
        </li>
      </ul>
    </div>
  );
}

/** Act III: your line, as a gap to speak into. */
function ActGap() {
  return (
    <div className="act-ui" aria-hidden="true">
      <p className="act-lyric is-past">
        <span>Polonius</span>What do you read, my lord?
      </p>
      <p className="act-lyric is-current">
        <span>
          Hamlet <em>· your line</em>
        </span>
        Words, words, words.
      </p>
      <div className="gap-meter act-gap">
        <span />
      </div>
    </div>
  );
}
