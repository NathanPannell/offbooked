import { CONTACT_EMAIL } from "./lib/contact";
import { FAQ } from "./routes/landing/content";

// The marketing pages' <head>: titles, descriptions, link previews and structured data. The
// pre-render (scripts/prerender.mjs) writes these into each page's HTML, and the pages set the
// title again when the app moves between them.

export const SITE_URL = "https://offbooked.com";
export const SITE_NAME = "Offbooked";
export const OG_IMAGE = `${SITE_URL}/og.png`;

export interface PageMeta {
  path: string;
  title: string;
  description: string;
  /** The file the pre-render writes, inside dist/. */
  file: string;
}

export const PAGES: PageMeta[] = [
  {
    path: "/",
    file: "index.html",
    title: "Offbooked: run lines with your cast, not a robot",
    description:
      "Share your script with one link. Everyone records their own lines from their phone, no account needed, and the whole cast rehearses the play in each other's voices.",
  },
  {
    path: "/pricing",
    file: "pricing.html",
    title: "Pricing · Offbooked",
    description:
      "Offbooked is free during the public beta. After launch the director pays per production: C$79, or C$39 at the founder price, locked in for life. The cast is always free.",
  },
  {
    path: "/director",
    file: "director.html",
    title: "For directors · Offbooked",
    description:
      "Get your cast off book between rehearsals. Upload the script, share one link, and your actors record their lines and run the play in each other's voices. Free during the beta.",
  },
  {
    path: "/privacy",
    file: "privacy.html",
    title: "Privacy policy · Offbooked",
    description:
      "What Offbooked collects, who processes it and when it's deleted: scripts and recordings go 7 days after the final performance, and we never train AI on your voice or script.",
  },
  {
    path: "/terms",
    file: "terms.html",
    title: "Terms of use · Offbooked",
    description: "The terms for using Offbooked, the rehearsal tool where your cast record their lines and listen through the play together.",
  },
];

export const pageFor = (path: string): PageMeta | undefined => PAGES.find((p) => p.path === path);

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Inside <script type="application/ld+json">, "</" would end the script early.
const jsonForScript = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** Structured data for the landing page: the app, who makes it and the FAQ. */
export function structuredData(): object[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      description: PAGES[0]!.description,
      applicationCategory: "EducationalApplication",
      operatingSystem: "Web browser (iPhone, Android, laptops and Chromebooks)",
      image: OG_IMAGE,
      offers: { "@type": "Offer", price: "0", priceCurrency: "CAD", description: "Free during the public beta" },
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/favicon.svg`,
      email: CONTACT_EMAIL,
      address: { "@type": "PostalAddress", addressLocality: "Victoria", addressRegion: "BC", addressCountry: "CA" },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];
}

/** Every SEO tag for a page's <head>, as HTML. */
export function headTags(page: PageMeta): string {
  const url = `${SITE_URL}${page.path}`;
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);
  const tags = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${OG_IMAGE}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="Offbooked: hear your script read by your real cast">`,
    `<meta property="og:locale" content="en_CA">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${OG_IMAGE}">`,
  ];
  if (page.path === "/") for (const data of structuredData()) tags.push(`<script type="application/ld+json">${jsonForScript(data)}</script>`);
  return tags.join("\n  ");
}
