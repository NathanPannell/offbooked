// The marketing site's words that are also data: the FAQ (shown on the page and sent as FAQPage
// structured data) and the pricing plans. Every claim here must be true of the app today. Keep
// the page short: answers of two short sentences at most.

export const SOCIAL_PROOF = "Used by casts in British Columbia and Nova Scotia for real productions.";

export interface Faq {
  q: string;
  a: string;
}

export const FAQ: Faq[] = [
  {
    q: "Do my cast need an app or account?",
    a: "No. They open your link in their phone's browser and start recording.",
  },
  {
    q: "What scripts work?",
    a: "PDF or Word files with real text, up to 300 pages. Scanned pages don't work yet.",
  },
  {
    q: "Does it work on Android?",
    a: "Yes. It works in the browser on iPhone, Android, laptops and Chromebooks.",
  },
  {
    q: "What happens after the show?",
    a: "Seven days after your final performance, the script and every recording are deleted for good.",
  },
  {
    q: "Is Offbooked the “Off Book!” app?",
    a: "No. Off Book! is a separate iPhone app; Offbooked runs in the browser from one link.",
  },
];

export interface Plan {
  name: string;
  price: string;
  per: string;
  line: string;
  /** Only the free beta can be chosen today; the others show what's coming. */
  available: boolean;
}

export const PLANS: Plan[] = [
  { name: "Free beta", price: "C$0", per: "in beta", line: "Everything, for every show.", available: true },
  { name: "Show Pass", price: "about C$29", per: "per production", line: "One flat price for the whole run.", available: false },
  { name: "Season", price: "Later", per: "for schools", line: "Several shows a year, by invoice.", available: false },
];
