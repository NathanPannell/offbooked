import { Link } from "react-router";
import { CONTACT_EMAIL, mailto } from "../lib/contact";
import { MarketingLayout } from "./landing/MarketingLayout";

/**
 * The privacy policy. It describes what the code does (see AGENTS.md: retention, account deletion,
 * email, on-device speech, script parsing, TTS), so change it whenever that changes.
 */
export function Privacy() {
  const email = <a href={mailto("Offbooked privacy")}>{CONTACT_EMAIL}</a>;
  return (
    <MarketingLayout path="/privacy">
      <article className="mk-legal">
        <p className="eyebrow">Privacy policy</p>
        <h1 className="display">Your script, your voices, your cast</h1>
        <p className="muted">Last updated 25 October 2026</p>

        <p>
          Offbooked (offbooked.com and the Offbooked iOS app) is a rehearsal tool: a director, teacher or stage manager uploads a script, the cast record their
          lines from their phones, and everyone listens through the play. It is made by Nathan Pannell in Victoria, British Columbia, Canada. This policy says
          what we collect, why, who helps us run the service and when it is deleted. Questions go to {email}.
        </p>

        <h2>The short version</h2>
        <ul>
          <li>A show's script and recordings are deleted automatically 7 days after its final performance.</li>
          <li>You can delete your account at any time, and everything in it goes.</li>
          <li>Cast members don't make accounts. A name is all we ask for.</li>
          <li>We never train AI on your voice or your script, and we don't sell or share your data for advertising.</li>
          <li>We email only to sign you in, to confirm an address, or to say a castmate has finished or the play is ready. No marketing.</li>
          <li>Speech recognition runs on your phone. The microphone only opens when you tap record.</li>
        </ul>

        <h2>What we collect</h2>
        <h3>If you set up productions</h3>
        <ul>
          <li>
            Your email address, to send you sign-in links (there are no passwords), and the name you choose to show your cast. The cast never see your email.
          </li>
          <li>
            Each production's title, performance dates and the script file you upload, with the scenes, characters and lines read from it and any edits you
            make.
          </li>
          <li>Recordings you make yourself, for example when you read in for a part.</li>
        </ul>
        <h3>If you're in a cast</h3>
        <ul>
          <li>The name you type when you join, and which parts you picked.</li>
          <li>
            Your recordings, with when each word started (worked out on your phone, so the words light up in time) and how much of the line your phone heard.
          </li>
          <li>An email address only if you choose to add one, which we confirm with a link before using it.</li>
        </ul>
        <p>
          If you join only to listen, we store no name at all. Your invite link is your only credential, so keep it to yourself the way you would a door code.
        </p>
        <h3>Technical information</h3>
        <ul>
          <li>
            IP addresses, used briefly to stop abuse (for example, too many sign-in attempts). These counters are deleted within two days, and our servers keep
            short-lived technical logs.
          </li>
          <li>
            On your device, the app stores your sign-in session, your preferences and the speech recognition model, and keeps each recording until it has
            uploaded. We use no advertising or analytics cookies and no tracking.
          </li>
        </ul>

        <h2>How we use it</h2>
        <p>
          Only to run Offbooked for you and your cast: reading the script into lines, storing and playing recordings, filling lines nobody has recorded yet with
          a synthesized voice, sending the emails described above, and keeping the service secure. We never use your recordings or script to train AI models,
          ours or anyone else's.
        </p>

        <h2>Speech, voices and AI</h2>
        <ul>
          <li>
            <strong>Speech recognition runs on your device.</strong> While you record, a small speech model in your browser follows along so the app can move to
            your next line. The words it hears stay on your phone; only when each word started and how much of the line it heard go up with the recording, which
            is uploaded so your cast can hear it.
          </li>
          <li>
            <strong>Reading the script.</strong> To find the scenes, characters and lines, the script's text is sent to Anthropic's Claude API. Anthropic
            processes it on our behalf under its commercial terms, which don't allow it to train its models on that text.
          </li>
          <li>
            <strong>Synthesized voices run on our own server.</strong> Lines nobody has recorded yet, and stage directions, are read by Piper, an open-source
            text-to-speech engine we host ourselves. The text isn't sent to any voice provider, and no one's voice is cloned.
          </li>
        </ul>

        <h2>Who helps us run Offbooked</h2>
        <p>These providers process data only to provide their service to us:</p>
        <ul>
          <li>Vercel hosts the website.</li>
          <li>Railway runs our server, including the synthesized voices.</li>
          <li>Neon hosts our database.</li>
          <li>Cloudflare R2 stores script files and recordings.</li>
          <li>Resend sends our emails.</li>
          <li>Anthropic reads scripts into lines, as described above.</li>
          <li>Google Fonts serves the site's typefaces, so your browser contacts Google when it loads a page.</li>
        </ul>
        <p>Some of these providers store data outside Canada, including in the United States.</p>

        <h2>When it's deleted</h2>
        <ul>
          <li>
            <strong>7 days after the final performance</strong>, at noon UTC, a production's script, every recording (re-records and deleted takes included),
            every line and every synthesized clip only it used are deleted for good. Cast members' names are cleared then too, unless they verified an email,
            and so is any address still waiting for confirmation. Invite links stop working at the same moment. Only the production's title is kept, so links to
            it can say it has ended.
          </li>
          <li>
            <strong>Deleting a recording</strong> in the app hides it straight away; it is deleted for good with everything else after the show.
          </li>
          <li>
            <strong>Deleting your account</strong> (your account page, then “Delete my account”) signs you out everywhere, removes your email and name, and
            deletes every production you set up with its scripts, recordings and cast details, at once.
          </li>
          <li>Sign-in links expire after 15 minutes, and sessions after 30 days.</li>
        </ul>

        <h2>Young people in a cast</h2>
        <p>
          Offbooked is used by school and youth casts. Cast members need no account and give only a name (a first name is fine) and their recordings. A cast
          member can add an email, but never has to. If you run a school or youth production, you decide who gets the cast link.
        </p>

        <h2>Your choices and rights</h2>
        <p>
          You can see and change your name and email in the app, delete recordings and delete your account. To ask for a copy of your data, a correction or
          deletion, or anything else about your privacy, email {email}. We'll answer within 30 days. If you're in a cast, your director can also delete your
          recordings or the whole production.
        </p>

        <h2>Changes</h2>
        <p>
          If we change how we handle your data, we'll update this page and the date at the top. See also our <Link to="/terms">terms of use</Link>.
        </p>
      </article>
    </MarketingLayout>
  );
}
