import { Link } from "react-router";
import { CONTACT_EMAIL, mailto } from "../lib/contact";
import { MarketingLayout } from "./landing/MarketingLayout";

/** The terms of use: plain and short, for a free private beta. */
export function Terms() {
  const email = <a href={mailto("Offbooked terms")}>{CONTACT_EMAIL}</a>;
  return (
    <MarketingLayout path="/terms">
      <article className="mk-legal">
        <p className="eyebrow">Terms of use</p>
        <h1 className="display">The house rules</h1>
        <p className="muted">Last updated 25 October 2026</p>

        <p>
          These terms cover your use of Offbooked (offbooked.com and the Offbooked iOS app), made by Nathan Pannell in Victoria, British Columbia, Canada. By
          setting up a production, joining a cast or otherwise using Offbooked, you agree to them. If you don't agree, please don't use it.
        </p>

        <h2>The beta</h2>
        <p>
          Offbooked is in private beta and free to use. Setting up productions needs an access code, which we give out by email; cast members never need one.
          Features may change while we build it, and we may limit or end the beta. If paid plans arrive, we'll say so on the site before anything is charged,
          and nothing you've set up becomes paid without you choosing it.
        </p>

        <h2>Your account and your cast</h2>
        <ul>
          <li>The person who sets up a production is responsible for it, including who they share its cast link with.</li>
          <li>
            Cast and invite links work like keys: anyone with the link can join the cast. Share them only with your company, and make a new cast link if one
            gets out.
          </li>
          <li>Keep access to the email address you sign in with: sign-in links are sent there.</li>
        </ul>

        <h2>Your content</h2>
        <p>
          Scripts, recordings and everything else you or your cast add stay yours. You give us permission to store, process and play them only to run Offbooked
          for your production: reading the script into lines, playing recordings to your cast, and filling unrecorded lines with a synthesized voice. We never
          use them to train AI, and we delete them as our <Link to="/privacy">privacy policy</Link> describes, 7 days after your final performance.
        </p>
        <p>
          You must have the right to use the script you upload, for example under the licence for your production. Offbooked keeps each production private to
          its cast, but it's your job to follow your licence's rules about copies and recordings.
        </p>

        <h2>Fair use</h2>
        <p>Please don't use Offbooked to:</p>
        <ul>
          <li>upload anything unlawful, or anything you have no right to share with your cast;</li>
          <li>record or share someone's voice without their agreement;</li>
          <li>harass anyone, or try to get into productions, accounts or data that aren't yours;</li>
          <li>overload, probe or reverse engineer the service, or get around its limits or the beta access code.</li>
        </ul>
        <p>We may suspend or remove accounts or productions that break these rules.</p>

        <h2>No guarantees</h2>
        <p>
          We work hard to keep Offbooked running and your recordings safe, but it is provided as it is, without warranties of any kind, especially during the
          beta. Script reading, speech recognition and synthesized voices can make mistakes. Keep your own copy of anything you can't afford to lose, and
          remember that a show's content is deleted after its final performance.
        </p>

        <h2>Liability</h2>
        <p>
          As far as the law allows, we aren't liable for indirect or consequential losses, or for lost data, and our total liability to you for anything to do
          with Offbooked is limited to what you paid us in the 12 months before the claim (during the free beta, nothing). Nothing in these terms limits rights
          you have under consumer law that can't be limited.
        </p>

        <h2>Ending things</h2>
        <p>
          You can stop using Offbooked and delete your account at any time from your account page. We may change these terms; if a change matters, we'll update
          this page and the date at the top before it applies. These terms are governed by the laws of British Columbia and the federal laws of Canada that
          apply there.
        </p>

        <h2>Contact</h2>
        <p>Questions about these terms go to {email}.</p>
      </article>
    </MarketingLayout>
  );
}
