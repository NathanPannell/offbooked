import { Link } from "react-router";
import { session } from "../api/client";

export function Landing() {
  const signedIn = !!session.get();
  return (
    <main className="landing">
      <nav className="landing-nav" aria-label="Main">
        <div className="brand-text">Offbooked</div>
        <Link className="btn btn-secondary btn-sm" to={signedIn ? "/app" : "/signin"}>
          {signedIn ? "Your productions" : "Directors: sign in"}
        </Link>
      </nav>
      <h1>Run lines with your whole cast, on your own time.</h1>
      <p className="lede">
        Each actor gets a link, records their lines from their phone in a few minutes, and everyone gets the full play
        back as one run-through, with gaps where you speak your part.
      </p>

      <section className="landing-script" aria-label="Example run-through">
        <p className="line past">
          <span className="who">Horatio</span>Hail to your lordship.
        </p>
        <p className="line past">
          <span className="who">Hamlet</span>I am glad to see you well.
        </p>
        <p className="line now">
          <span className="who">Horatio</span>The same, my lord, and your poor servant ever.
        </p>
        <p className="line gap">
          <span className="who">Hamlet · your line</span>Sir, my good friend; I'll change that name with you.
        </p>
        <p className="line next">
          <span className="who">Marcellus</span>My good lord—
        </p>
      </section>

      <h2>How it works</h2>
      <ol>
        <li>
          <strong>The director uploads the script.</strong>Offbooked sorts it into characters, scenes and lines.
        </li>
        <li>
          <strong>Everyone gets their own link.</strong>No accounts and no app to install. Open it, tap record, say your
          line.
        </li>
        <li>
          <strong>The cast hears the whole play.</strong>Every take is stitched into one run-through, synced to the
          script like song lyrics.
        </li>
      </ol>

      <div className="landing-cta">
        <p>Directing a show?</p>
        <Link className="btn btn-primary" to={signedIn ? "/app" : "/signin"}>
          {signedIn ? "Open your productions" : "Sign in to start a production"}
        </Link>
      </div>

      <footer>Offbooked is in early development.</footer>
    </main>
  );
}
