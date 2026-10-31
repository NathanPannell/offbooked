import { ArrowRight, Check, Copy, Mail, Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import { Demo } from "./landing/Demo";
import { cleanLink, directorMessage, directorUrl, greeting, readDirectorLink, type DirectorLink } from "./landing/directorLink";
import { DIRECTOR_FAQ } from "./landing/content";
import { MarketingLayout, useCta } from "./landing/MarketingLayout";

const STEPS = [
  { title: "You upload the script.", line: "A PDF or .docx file. Offbooked finds every part." },
  { title: "You share one link.", line: "Actors pick their part and record on their phone. No account, no app." },
  { title: "Everyone runs the play.", line: "Each line in the voice of the castmate who recorded it, whoever missed rehearsal." },
];

/**
 * The page for directors, and the link a cast member sends one. The pre-rendered page is the plain
 * pitch; the greeting from the link's address arrives after hydration, so the first render matches it.
 */
export function Director() {
  const cta = useCta();
  const [link, setLink] = useState<DirectorLink>({ from: "", show: "" });
  const { search } = useLocation();
  useEffect(() => setLink(readDirectorLink(search)), [search]);
  const hello = greeting(link);

  return (
    <MarketingLayout path="/director">
      <header className="mk-hero">
        {hello && <p className="mk-note">{hello}</p>}
        <h1 className="mk-hero-title">
          Get your cast off book, <span className="mk-marker">between rehearsals</span>.
        </h1>
        <p className="mk-hero-lede">
          Upload the script and share one link. Your actors record their lines on their phones, then run the whole play in each other's voices.
        </p>
        <Link className="btn btn-primary mk-pill" to={cta.to}>
          {cta.label} <ArrowRight size={20} aria-hidden="true" />
        </Link>
      </header>

      <section className="mk-section mk-faq-section" aria-labelledby="steps-title">
        <h2 id="steps-title" className="mk-title mk-intro">
          Three steps, and only two are yours.
        </h2>
        <ol className="mk-steps">
          {STEPS.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p className="muted">{step.line}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mk-section mk-showcase" id="demo" aria-labelledby="demo-title">
        <div className="mk-showcase-copy">
          <h2 id="demo-title" className="mk-title">
            See how it plays, line by line.
          </h2>
          <p className="muted">With your cast recorded, each line plays in the voice of the castmate who said it.</p>
        </div>
        <Demo />
      </section>

      <section className="mk-section mk-faq-section" id="faq" aria-labelledby="faq-title">
        <h2 id="faq-title" className="mk-title mk-intro">
          What directors ask
        </h2>
        <div className="mk-faq">
          {DIRECTOR_FAQ.map((item) => (
            <details key={item.q} className="mk-faq-item">
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      {!hello && <SendToDirector />}

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

/** For someone in a cast: their name and the show make the link, with a note card that updates as they type. */
function SendToDirector() {
  const [from, setFrom] = useState("");
  const [show, setShow] = useState("");
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [origin, setOrigin] = useState("https://offbooked.com");
  useEffect(() => {
    setCanShare(typeof navigator.share === "function");
    setOrigin(window.location.origin);
    // The web fonts move the page after the browser has jumped to the link's #send.
    if (window.location.hash === "#send") void document.fonts.ready.then(() => document.getElementById("send")?.scrollIntoView());
  }, []);

  const link = useMemo(() => cleanLink(from, show), [from, show]);
  const url = directorUrl(origin, link);
  const message = directorMessage(link, url);
  const mailHref = `mailto:?subject=${encodeURIComponent(link.show ? `Running lines for ${link.show}` : "Running lines")}&body=${encodeURIComponent(message)}`;

  const edit = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    set(event.target.value);
    setCopied(null);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  const share = async () => {
    try {
      await navigator.share({ title: "Offbooked", text: message });
    } catch {
      // Closing the share sheet isn't an error, and the copy button is right beside it.
    }
  };

  return (
    <section className="mk-section mk-send" id="send" aria-labelledby="send-title">
      <div className="mk-showcase-copy">
        <h2 id="send-title" className="mk-title">
          In the cast? Send this to your director.
        </h2>
        <p className="muted">Add your name and the show, and the page greets them with both.</p>
      </div>
      <div className="mk-send-grid">
        <div className="mk-send-form">
          <label className="field">
            <span>Your first name</span>
            <input className="input" value={from} onChange={edit(setFrom)} maxLength={40} autoComplete="given-name" placeholder="Maya" />
          </label>
          <label className="field">
            <span>The show</span>
            <input className="input" value={show} onChange={edit(setShow)} maxLength={60} autoComplete="off" placeholder="Macbeth" />
          </label>
        </div>
        <figure className="mk-ticket" aria-label="Your note to the director">
          <figcaption className="eyebrow">A note for the director</figcaption>
          <p className="mk-ticket-show">{link.show || "Your next show"}</p>
          <p className="mk-ticket-from">{link.from ? `from ${link.from}` : "from someone in your cast"}</p>
          <p className="mk-ticket-url small">{url.replace(/^https?:\/\//, "").split("?")[0]}</p>
        </figure>
      </div>
      <div className="mk-send-actions">
        {canShare && (
          <button type="button" className="btn btn-primary" onClick={share}>
            <Share2 size={16} aria-hidden="true" /> Share
          </button>
        )}
        <button type="button" className={`btn ${canShare ? "btn-secondary" : "btn-primary"}`} onClick={copy}>
          {copied === "done" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{" "}
          {copied === "done" ? "Copied" : "Copy the message"}
        </button>
        <a className="btn btn-secondary" href={mailHref}>
          <Mail size={16} aria-hidden="true" /> Email it
        </a>
      </div>
      <p className="small muted mk-send-status" role="status">
        {copied === "failed" ? `Your browser blocked copying. The link is ${url}` : ""}
      </p>
    </section>
  );
}
