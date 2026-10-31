// The marketing site's words that are also data: the FAQ (shown on the page and sent as FAQPage
// structured data) and the pricing plans. Every claim here must be true of the app today. Keep
// the page short: only questions that stop someone signing up, answers of two short sentences.

export const SOCIAL_PROOF = "Used by casts in British Columbia and Nova Scotia for real productions.";

/** The one call to action, for anyone signed out. */
export const CTA_LABEL = "Try free in public beta";

export interface Faq {
  q: string;
  a: string;
}

export const FAQ: Faq[] = [
  {
    q: "Do my actors need an account?",
    a: "No. They open your link in their phone's browser, pick their part and start recording.",
  },
  {
    q: "Is it free?",
    a: "Yes, everything is free during the public beta. Your cast never pay.",
  },
  {
    q: "What will it cost after the beta?",
    a: "The director pays C$79 per production, or C$39 at the founder price, locked in for life. Your cast is always free.",
  },
  {
    q: "Who can hear our recordings?",
    a: "Only people with your show's link, and we never train AI on them. Everything is deleted 7 days after your final performance.",
  },
  {
    q: "What devices does it work on?",
    a: "Any phone, tablet or laptop with a browser: iPhone, Android and Chromebooks included.",
  },
];

/** The director's page: the questions that stop a director trying it with their cast. */
export const DIRECTOR_FAQ: Faq[] = [
  {
    q: "How much of my time does it take?",
    a: "Upload the script and share the link. Your cast does the rest, and you can see who has recorded what.",
  },
  {
    q: "What if an actor never records?",
    a: "A computer voice reads their lines until they do, so everyone else can still run the scene.",
  },
  ...FAQ.filter((f) => f.q !== "What devices does it work on?"),
];

export interface Plan {
  name: string;
  /** What it costs at the founder price. */
  price: string;
  /** The full price, struck through beside the founder price. */
  was?: string;
  per: string;
  line: string;
  /** Free today. The paid plans show their launch price; nothing can be bought yet. */
  now: boolean;
}

export const PLANS: Plan[] = [
  { name: "Public beta", price: "C$0", per: "while in beta", line: "Every feature, for every show.", now: true },
  { name: "Show Pass", price: "C$39", was: "C$79", per: "per production", line: "One price for the whole run.", now: false },
  { name: "Season", price: "C$125", was: "C$249", per: "per year", line: "Several shows a year.", now: false },
];
