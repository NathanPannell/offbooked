import {
  ArrowRight,
  AudioLines,
  BookOpenCheck,
  Check,
  Clock,
  EyeOff,
  FileText,
  Gauge,
  GraduationCap,
  Link2,
  ListChecks,
  Lock,
  Mic,
  MonitorSmartphone,
  Play,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  UserRoundPen,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router";
import { CONTACT_EMAIL, mailto } from "../lib/contact";
import { FAQ, PLANS, SOCIAL_PROOF } from "./landing/content";
import { Demo, type DemoHandle } from "./landing/Demo";
import { HeroScene } from "./landing/HeroScene";
import { MarketingLayout, useCta } from "./landing/MarketingLayout";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const PROOF = ["No app or accounts for the cast", "AI fills any line not yet recorded", "Deletes itself after closing night", "Free for your cast"];

const DIRECTORS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Clock, title: "Set up in about two minutes", text: "One screen: the title, your performance dates and the script. Then copy one link for the cast." },
  {
    icon: ListChecks,
    title: "See who has recorded what",
    text: "The call sheet shows every part, who is reading it and how many of its lines are in, so you know who to nudge.",
  },
  {
    icon: Mic,
    title: "Read in for anyone missing",
    text: "Your own recordings count. Cover a part until its actor records it, and theirs takes over.",
  },
  {
    icon: Users,
    title: "Anyone can record any part",
    text: "Understudies, doubling, a cast member on a new phone: everyone picks a part from the same link.",
  },
  {
    icon: GraduationCap,
    title: "Safe for student casts",
    text: "No accounts for the cast, your email address is never shown to them, and everything is deleted after the show.",
  },
  {
    icon: FileText,
    title: "Fix anything in place",
    text: "Split, join, retype or reassign a line, with the original page of your script beside it.",
  },
];

const ACTORS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: AudioLines,
    title: "Hands-free recording",
    text: "The app follows along as you speak and moves to your next line by itself. A beat in the middle of a line won't cut you off.",
  },
  {
    icon: UserRoundPen,
    title: "Pause, then read",
    text: "Listen through the play with a pause sized to each of your lines, so you say it out loud before you hear it.",
  },
  {
    icon: BookOpenCheck,
    title: "Words light up as they're said",
    text: "Your lines are highlighted and your cues underlined. Jump to any scene.",
  },
  { icon: Gauge, title: "Any speed", text: "Run a scene at half speed to 4×, with voices at their normal pitch." },
  { icon: Sun, title: "Screen stays on", text: "Prop your phone on the music stand: it stays awake while you read along." },
  {
    icon: ShieldCheck,
    title: "Safe on bad Wi-Fi",
    text: "Every take is saved on your phone first and uploaded when there's signal, even through a dropped connection.",
  },
];

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
        <div className="mk-hero-copy">
          <p className="eyebrow">For directors, drama teachers and stage managers</p>
          <h1 className="mk-hero-title">
            Hear your script read by your <span className="mk-marker">real cast.</span>
          </h1>
          <p className="mk-hero-lede">
            Upload the script and send one link. Everyone records their lines from their phone, then the whole cast rehearses the play in each other's voices,
            with gaps for your own lines.
          </p>
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
        </div>
        <HeroScene />
      </header>

      <section className="mk-problem" aria-label="The problem">
        <p>
          You can't get the whole cast in a room every night.
          <br />
          <span className="muted">Running lines alone with a robot isn't the same as hearing your scene partner.</span>
        </p>
      </section>

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
            <h3>Upload the script you already have.</h3>
            <p className="muted">
              A PDF or Word file. Offbooked finds every scene, character, line and stage direction, usually in under a minute. Add your performance dates and
              that's the setup.
            </p>
            <StepUpload />
          </li>
          <li className="mk-step">
            <p className="mk-step-n mono">2 · Send</p>
            <h3>Send one link to the whole cast.</h3>
            <p className="muted">
              Drop it in the group chat. Everyone picks their part and records from their phone, hands-free. Nobody installs anything or makes an account.
            </p>
            <StepLink />
          </li>
          <li className="mk-step">
            <p className="mk-step-n mono">3 · Run</p>
            <h3>Run the whole play, anywhere.</h3>
            <p className="muted">
              Listen line by line in your castmates' own voices. Any line nobody has recorded yet is read by an AI voice, so the play is fully voiced from day
              one.
            </p>
            <StepRun />
          </li>
        </ol>
      </section>

      <section className="mk-section mk-demo-section" id="demo" aria-labelledby="demo-title">
        <div className="mk-intro">
          <p className="eyebrow">The demo</p>
          <h2 id="demo-title" className="mk-title">
            Press play. You're Lady Macbeth.
          </h2>
          <p className="muted">
            This is what your cast see and hear: the scene line by line, each line in the voice of the castmate who recorded it, with a pause for yours.
          </p>
        </div>
        <Demo ref={demo} />
      </section>

      <section className="mk-section" id="directors" aria-labelledby="directors-title">
        <div className="mk-intro">
          <p className="eyebrow">For directors and teachers</p>
          <h2 id="directors-title" className="mk-title">
            Get the whole cast off book before tech week.
          </h2>
          <p className="muted">You set it up once. Your cast do the rest from their phones, whenever they have ten minutes.</p>
        </div>
        <FeatureGrid items={DIRECTORS} />
      </section>

      <section className="mk-section" id="actors" aria-labelledby="actors-title">
        <div className="mk-intro">
          <p className="eyebrow">For actors</p>
          <h2 id="actors-title" className="mk-title">
            Practise with your scene partners, without them.
          </h2>
          <p className="muted">On the bus, on a walk, in the kitchen: the whole play in your cast's voices, with room for yours.</p>
        </div>
        <FeatureGrid items={ACTORS} />
      </section>

      <section className="mk-section mk-privacy" id="privacy" aria-labelledby="privacy-title">
        <div className="mk-intro">
          <p className="eyebrow">Privacy</p>
          <h2 id="privacy-title" className="mk-title">
            Built for the run of a show, then gone.
          </h2>
          <p className="muted">Scripts and recordings are deleted automatically 7 days after your final performance. Nobody has to remember to clean up.</p>
        </div>
        <ol className="mk-timeline" aria-label="What happens to your show's content">
          <li>
            <span className="mk-timeline-dot" />
            <strong>Rehearsals</strong>
            <span className="small muted">Your cast record and listen.</span>
          </li>
          <li>
            <span className="mk-timeline-dot" />
            <strong>Final performance</strong>
            <span className="small muted">The date you set up front.</span>
          </li>
          <li>
            <span className="mk-timeline-dot" />
            <strong>+7 days</strong>
            <span className="small muted">Time to grab anything you need.</span>
          </li>
          <li className="is-gone">
            <span className="mk-timeline-dot">
              <Trash2 size={13} aria-hidden="true" />
            </span>
            <strong>Gone</strong>
            <span className="small muted">Script, recordings and lines, for good.</span>
          </li>
        </ol>
        <ul className="mk-privacy-points">
          <li>
            <Lock size={18} aria-hidden="true" />
            <span>
              <strong>We never train AI on your voice or script.</strong> Recordings only play through your production's own links.
            </span>
          </li>
          <li>
            <Users size={18} aria-hidden="true" />
            <span>
              <strong>No accounts for the cast.</strong> A first name is enough. Names are cleared after the show unless someone verified their email.
            </span>
          </li>
          <li>
            <Smartphone size={18} aria-hidden="true" />
            <span>
              <strong>Speech recognition runs on the phone.</strong> The microphone only opens when you tap record.
            </span>
          </li>
          <li>
            <EyeOff size={18} aria-hidden="true" />
            <span>
              <strong>No marketing email.</strong> We only email to sign you in, to confirm an address, or to say a castmate has finished or the play is ready.
            </span>
          </li>
        </ul>
        <p className="small">
          <Link to="/privacy">Read the privacy policy</Link>
        </p>
      </section>

      <section className="mk-section" id="pricing" aria-labelledby="pricing-title">
        <div className="mk-intro">
          <p className="eyebrow">Pricing</p>
          <h2 id="pricing-title" className="mk-title">
            Free for your cast. Always.
          </h2>
          <p className="muted">The person running the show pays, once per show. Never per word, minute or actor.</p>
        </div>
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
              <p className="small muted">{plan.blurb}</p>
              <ul className="mk-plan-features">
                {plan.features.map((f) => (
                  <li key={f}>
                    <Check size={14} strokeWidth={2.5} aria-hidden="true" /> {f}
                  </li>
                ))}
              </ul>
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
          Offbooked is in private beta. <a href={mailto("Offbooked access code")}>Email {CONTACT_EMAIL}</a> for an access code. Your cast never need one.
        </p>
      </section>

      <section className="mk-section" id="faq" aria-labelledby="faq-title">
        <div className="mk-intro">
          <p className="eyebrow">Questions</p>
          <h2 id="faq-title" className="mk-title">
            Fair questions
          </h2>
        </div>
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
        <p>Upload your script tonight, drop one link in the cast chat, and the whole play is ready to listen to. By opening night, it's all your cast.</p>
        <Link className="btn btn-primary btn-lg" to={cta.to}>
          {cta.label} <ArrowRight size={18} aria-hidden="true" />
        </Link>
        <p className="small mk-band-works">
          <MonitorSmartphone size={15} aria-hidden="true" /> Works on iPhone, Android, laptops and Chromebooks. No app needed.
        </p>
      </section>
    </MarketingLayout>
  );
}

function FeatureGrid({ items }: { items: { icon: LucideIcon; title: string; text: string }[] }) {
  return (
    <ul className="mk-features">
      {items.map(({ icon: Icon, title, text }) => (
        <li key={title} className="mk-feature">
          <Icon size={20} className="mk-feature-icon" aria-hidden="true" />
          <h3>{title}</h3>
          <p className="small muted">{text}</p>
        </li>
      ))}
    </ul>
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
