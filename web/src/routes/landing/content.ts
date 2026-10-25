import { CONTACT_EMAIL } from "../../lib/contact";

// The marketing site's words that are also data: the FAQ (shown on the page and sent as FAQPage
// structured data) and the pricing plans. Every claim here must be true of the app today.

export const SOCIAL_PROOF = "Used by casts in British Columbia and Nova Scotia for real productions.";

export interface Faq {
  q: string;
  a: string;
}

export const FAQ: Faq[] = [
  {
    q: "Do my cast need an account or an app?",
    a: "No. Your cast open one link in the browser on their phone, pick their part, type a name and start recording. Only the person who sets up the show signs in, with a link we email them. There are no passwords.",
  },
  {
    q: "What scripts work?",
    a: "PDFs with real text in them and Word .docx files, up to 20 MB and 300 pages. Scanned pages (a photo or scan of a script with no text layer) don't work yet. Line breaks and indentation are kept, so verse and lyrics stay as written, and you can fix any line in place with the original page beside it.",
  },
  {
    q: "What if someone never records?",
    a: "Their lines are read by an AI voice, a different one for each character, so the play is fully voiced from the day you upload it. Anyone can also record those lines in the meantime, you included, and the newest recording is the one that plays.",
  },
  {
    q: "Can two people record the same part?",
    a: "Yes. Anyone can record any part, so understudies, doubling and a director reading in all just work. The newest recording of each line plays, and older takes are kept until the show's content is deleted.",
  },
  {
    q: "Does it work on Android?",
    a: "Yes. Offbooked works in Chrome on Android, Safari on iPhone and any up-to-date browser on a laptop or Chromebook. There's nothing to install.",
  },
  {
    q: "What happens to our recordings after the show?",
    a: "Seven days after your final performance, the script, every recording and every line are deleted for good, automatically. Cast members' names are cleared too, unless they chose to verify an email. You can also delete your account at any time, and everything in it goes at once.",
  },
  {
    q: "Is Offbooked the “Off Book!” app?",
    a: "No. Off Book! is a separate iPhone app from a different developer. Offbooked runs in the browser at offbooked.com, and your whole cast joins from one link without installing anything.",
  },
  {
    q: "Is my script private?",
    a: "Yes. Nothing is public: recordings only play through your production's own links. To find the characters and lines, the script's text is read by Anthropic's Claude, which doesn't train on it, and we never train AI on your voice or your script.",
  },
  {
    q: "What does it cost?",
    a: "Nothing during the private beta, for you or your cast. Later there will be a flat Show Pass of about C$29 per production, never priced per word or minute, and your cast will always be free.",
  },
  {
    q: "How do I get access?",
    a: `Offbooked is in private beta. Email ${CONTACT_EMAIL} for an access code and enter it after you sign in. Your cast never need a code: they just open the link you send them.`,
  },
];

export interface Plan {
  name: string;
  price: string;
  per: string;
  blurb: string;
  features: string[];
  /** Only the free beta can be chosen today; the others show what's coming. */
  available: boolean;
}

export const PLANS: Plan[] = [
  {
    name: "Free beta",
    price: "C$0",
    per: "while in beta",
    blurb: "Everything Offbooked does, for every production you set up during the private beta.",
    features: ["The whole script", "Unlimited cast and recordings", "AI voices for lines not yet recorded", "Deletes itself after closing night"],
    available: true,
  },
  {
    name: "Show Pass",
    price: "about C$29",
    per: "per production",
    blurb: "One flat price for the whole run of a show. For a cast of 15, that's under C$2 an actor.",
    features: ["The whole script", "Unlimited cast and recordings", "Until closing night"],
    available: false,
  },
  {
    name: "Season",
    price: "Later",
    per: "for schools and companies",
    blurb: "Several shows a year, paid by invoice or purchase order.",
    features: ["Every show in your season", "One bill for the year"],
    available: false,
  },
];
