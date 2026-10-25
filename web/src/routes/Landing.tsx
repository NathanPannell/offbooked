import { ArrowRight, AudioLines, Check, Link2, ListChecks, Mic, MonitorSmartphone, Play, Trash2, UserRoundPen, type LucideIcon } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router";
import { CONTACT_EMAIL, mailto } from "../lib/contact";
import { FAQ, PLANS, SOCIAL_PROOF } from "./landing/content";
import { Demo, type DemoHandle } from "./landing/Demo";
import { MarketingLayout, useCta } from "./landing/MarketingLayout";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

// Keep the page short: a visitor should take it in at a glance (about 350 words in all).
const PROOF = ["No app needed", "Free for your cast", "Deletes after closing"];

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Link2, title: "One link for the cast", text: "No app, no accounts." },
  { icon: ListChecks, title: "See who's recorded", text: "Every part, and how much is in." },
  { icon: Mic, title: "Read in for anyone", text: "Your recordings fill the gaps." },
  { icon: AudioLines, title: "Hands-free recording", text: "It moves to the next line for you." },
  { icon: UserRoundPen, title: "Pause, then read", text: "A gap to say your line out loud." },
  { icon: MonitorSmartphone, title: "Works on any phone", text: "iPhone, Android, laptops and Chromebooks." },
];

const TIMELINE = ["Rehearsals", "Final performance", "+7 days", "Gone"];

export function Landing() {
  const cta = useCta();
  const demo = useRef<DemoHandle>(null);

  const seeDemo = () => {
    document.getElementById("demo")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    demo.current?.play();
  };

  return (
    <MarketingLayout path="/">
      <header className="mk-hero">
        <p className="eyebrow">For directors and drama teachers</p>
        <h1 className="mk-hero-title">
          Hear your script read by your <span className="mk-marker">real cast.</span>
        </h1>
        <p className="mk-hero-lede">Send one link. Your cast record their lines. Everyone rehearses in each other's voices.</p>
        <div className="mk-hero-ctas">
          <Link className="btn btn-primary btn-lg" to={cta.to}>
            {cta.label} <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <button type="button" className="btn btn-secondary btn-lg" onClick={seeDemo}>
            <Play size={17} fill="currentColor" aria-hidden="true" /> See the demo
          </button>
        </div>
        <ul className="mk-proof">
          {PROOF.map((p) => (
            <li key={p}>
              <Check size={15} strokeWidth={2.5} aria-hidden="true" /> {p}
            </li>
          ))}
        </ul>
        <p className="mk-social small">{SOCIAL_PROOF}</p>
      </header>

      <section className="mk-section" id="how" aria-labelledby="how-title">
        <div className="mk-intro">
          <p className="eyebrow">How it works</p>
          <h2 id="how-title" className="mk-title">
            Upload. Send one link. Run the play.
          </h2>
        </div>
        <ol className="mk-steps">
          <li className="mk-step">
            <p className="mk-step-n mono">1 · Upload</p>
            <h3>Upload a PDF or Word script. We find every line.</h3>
            <StepUpload />
          </li>
          <li className="mk-step">
            <p className="mk-step-n mono">2 · Send</p>
            <h3>Send one link. Everyone records from their phone.</h3>
            <StepLink />
          </li>
          <li className="mk-step">
            <p className="mk-step-n mono">3 · Run</p>
            <h3>Rehearse the whole play in your cast's voices.</h3>
            <StepRun />
          </li>
        </ol>
      </section>

      <section className="mk-section mk-demo-section" id="demo" aria-labelledby="demo-title">
        <h2 id="demo-title" className="mk-title">
          Press play. You're Lady Macbeth.
        </h2>
        <Demo ref={demo} />
      </section>

      <section className="mk-section" id="features" aria-labelledby="features-title">
        <h2 id="features-title" className="mk-title mk-intro">
          Built for the whole cast.
        </h2>
        <ul className="mk-features">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="mk-feature">
              <Icon size={20} className="mk-feature-icon" aria-hidden="true" />
              <h3>{title}</h3>
              <p className="small muted">{text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mk-section mk-privacy" id="privacy" aria-labelledby="privacy-title">
        <h2 id="privacy-title" className="mk-title mk-intro">
          Gone 7 days after closing night.
        </h2>
        <ol className="mk-timeline">
          {TIMELINE.map((step) => (
            <li key={step} className={step === "Gone" ? "is-gone" : undefined}>
              <span className="mk-timeline-dot">{step === "Gone" && <Trash2 size={13} aria-hidden="true" />}</span>
              <strong>{step}</strong>
            </li>
          ))}
        </ol>
        <p>
          We never train AI on your voice or script. <Link to="/privacy">Read the privacy policy</Link>
        </p>
      </section>

      <section className="mk-section" id="pricing" aria-labelledby="pricing-title">
        <h2 id="pricing-title" className="mk-title mk-intro">
          Free for your cast. Always.
        </h2>
        <ul className="mk-plans">
          {PLANS.map((plan) => (
            <li key={plan.name} className={`mk-plan ${plan.available ? "is-available raised" : "is-soon"}`} aria-disabled={!plan.available || undefined}>
              <div className="mk-plan-head">
                <h3>{plan.name}</h3>
                {!plan.available && <span className="mk-soon">Coming soon</span>}
              </div>
              <p className="mk-plan-price">
                <strong>{plan.price}</strong> <span className="muted">{plan.per}</span>
              </p>
              <p className="small muted">{plan.line}</p>
              {plan.available ? (
                <Link className="btn btn-primary" to={cta.to}>
                  {cta.to === "/app" ? cta.label : "Set up your show, free"}
                </Link>
              ) : (
                <button type="button" className="btn btn-secondary" disabled>
                  Coming soon
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="mk-plans-note small muted">
          Private beta: <a href={mailto("Offbooked access code")}>email {CONTACT_EMAIL}</a> for an access code.
        </p>
      </section>

      <section className="mk-section" id="faq" aria-labelledby="faq-title">
        <h2 id="faq-title" className="mk-title mk-intro">
          Questions
        </h2>
        <div className="mk-faq">
          {FAQ.map((item) => (
            <details key={item.q} className="mk-faq-item">
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mk-band" aria-labelledby="band-title">
        <h2 id="band-title" className="display">
          Places, everyone.
        </h2>
        <Link className="btn btn-primary btn-lg" to={cta.to}>
          {cta.label} <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </section>
    </MarketingLayout>
  );
}

/** Step 1: the script being read. */
function StepUpload() {
  return (
    <div className="mk-step-ui" aria-hidden="true">
      <p className="mono mk-step-ui-label">Reading macbeth.pdf</p>
      <div className="progress mk-step-progress">
        <span />
      </div>
      <p className="mono mk-step-ui-counts">28 scenes · 648 lines · 38 parts</p>
    </div>
  );
}

/** Step 2: one link, parts picked. */
function StepLink() {
  return (
    <div className="mk-step-ui" aria-hidden="true">
      <div className="mk-step-link">
        <Link2 size={14} />
        <span className="mono">offbooked.com/join/k3x9…</span>
      </div>
      <ul className="mk-step-roles">
        <li>
          <strong>MACBETH</strong> <span>Robin · 146 of 146</span>
        </li>
        <li>
          <strong>LADY MACBETH</strong> <span>Jess · 52 of 59</span>
        </li>
        <li>
          <strong>BANQUO</strong> <span className="muted">Not taken yet</span>
        </li>
      </ul>
    </div>
  );
}

/** Step 3: a pause for your line. */
function StepRun() {
  return (
    <div className="mk-step-ui" aria-hidden="true">
      <p className="mk-step-lyric is-past">
        <span>MACBETH</span>If we should fail?
      </p>
      <p className="mk-step-lyric is-current">
        <span>LADY MACBETH · your line</span>We fail? But screw your courage to the sticking-place, and we'll not fail.
      </p>
      <div className="mk-gap">
        <span style={{ width: "62%" }} />
      </div>
    </div>
  );
}
