import { ArrowRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { session } from "../../api/client";
import { Brand } from "../../components/Brand";
import { CONTACT_EMAIL, mailto } from "../../lib/contact";
import { pageFor, SITE_NAME } from "../../seo";
import { CTA_LABEL } from "./content";

/**
 * Where the site's call to action goes. Signed out (and in the pre-rendered HTML, so the first
 * render matches it) it signs up for the beta; once the page knows there's a session, it opens the app.
 */
export function useCta(): { to: string; label: string } {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(!!session.get()), []);
  return signedIn ? { to: "/app", label: "Your productions" } : { to: "/signin", label: CTA_LABEL };
}

// The page a visit lands on keeps the scroll position the browser restores (a reload, Back); moving
// to another marketing page inside the app starts it at the top.
let landed = false;

/** The marketing pages' frame: the top bar and the footer, with the page's title kept in the tab. */
export function MarketingLayout({ path, children, navCta = true }: { path: string; children: ReactNode; navCta?: boolean }) {
  const cta = useCta();
  useEffect(() => {
    const page = pageFor(path);
    if (page) document.title = page.title;
    if (landed && !window.location.hash) window.scrollTo(0, 0);
    landed = true;
    return () => {
      document.title = SITE_NAME;
    };
  }, [path]);

  return (
    <div className="mk">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="mk-nav" aria-label="Main">
        <Brand to="/" />
        <div className="mk-nav-links">
          <a href="/#demo">Demo</a>
          <Link to="/pricing">Pricing</Link>
          <a href="/#faq">FAQ</a>
        </div>
        {navCta && (
          <Link className="btn btn-primary mk-nav-cta" to={cta.to}>
            {cta.to === "/app" ? cta.label : "Try free"} <ArrowRight size={16} aria-hidden="true" />
          </Link>
        )}
      </nav>
      <main id="main">{children}</main>
      <footer className="mk-footer">
        <div className="mk-footer-brand">
          <Brand to="/" />
          <p className="small muted">Made in Victoria, BC.</p>
        </div>
        <ul className="mk-footer-links">
          <li>
            <Link to="/pricing">Pricing</Link>
          </li>
          <li>
            <Link to="/director">For directors</Link>
          </li>
          <li>
            <a href={mailto("Offbooked")}>{CONTACT_EMAIL}</a>
          </li>
          <li>
            <Link to="/privacy">Privacy policy</Link>
          </li>
          <li>
            <Link to="/terms">Terms of use</Link>
          </li>
          <li>
            <Link to="/signin">Sign in</Link>
          </li>
        </ul>
        <p className="mk-footer-small small muted">© 2026 Offbooked</p>
      </footer>
    </div>
  );
}
