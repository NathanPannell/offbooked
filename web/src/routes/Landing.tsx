import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { FAQ, SOCIAL_PROOF } from "./landing/content";
import { Demo } from "./landing/Demo";
import { MarketingLayout, useCta } from "./landing/MarketingLayout";
import { RecorderDemo } from "./landing/RecorderDemo";

// One headline, one line under it, one button; then the two demos do the talking. Every section
// earns its place by moving a visitor towards signing up: keep the words to a minimum.
export function Landing() {
  const cta = useCta();

  return (
    <MarketingLayout path="/">
      <header className="mk-hero">
        <h1 className="mk-hero-title">
          Run lines with <span className="mk-marker">your cast</span>, not a robot.
        </h1>
        <p className="mk-hero-lede">Share your script with one link. Everyone records their own lines, no account needed.</p>
        <Link className="btn btn-primary mk-pill" to={cta.to}>
          {cta.label} <ArrowRight size={20} aria-hidden="true" />
        </Link>
        <p className="mk-social small">{SOCIAL_PROOF}</p>
      </header>

      <section className="mk-section mk-showcase" id="demo" aria-labelledby="demo-title">
        <div className="mk-showcase-copy">
          <h2 id="demo-title" className="mk-title">
            The whole scene, in your cast's voices.
          </h2>
          <p className="muted">Press play: each line in the voice of the castmate who recorded it.</p>
        </div>
        <Demo />
      </section>

      <section className="mk-section mk-showcase" id="record" aria-labelledby="record-title">
        <div className="mk-showcase-copy">
          <h2 id="record-title" className="mk-title">
            Hands-free recording.
          </h2>
          <p className="muted">Say the line. It moves to the next one for you.</p>
        </div>
        <RecorderDemo />
      </section>

      <section className="mk-section mk-faq-section" id="faq" aria-labelledby="faq-title">
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
        <Link className="btn btn-primary mk-pill" to={cta.to}>
          {cta.label} <ArrowRight size={20} aria-hidden="true" />
        </Link>
      </section>
    </MarketingLayout>
  );
}
