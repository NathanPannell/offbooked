// The link a cast member sends their director: who sent it and which show, carried in the URL, so
// the page can greet the director without a backend. Anyone can write these words into a link, so
// what the page shows is short plain text, and never reads as a web address, a phone number or us.

const MAX_NAME = 40;
const MAX_SHOW = 60;

export interface DirectorLink {
  from: string;
  show: string;
}

const MAX_DIGITS = 6;

// Tested with combining marks removed, so an invisible one can't hide "evil.com".
const looksUnsafe = (text: string): boolean => {
  const bare = text.normalize("NFD").replace(/\p{M}/gu, "");
  if (/\.\p{L}/u.test(bare) || /\s\.\s*\p{L}/u.test(bare) || /\d+\.\d+\.\d+/u.test(bare)) return true; // an address
  if ((bare.match(/\p{Nd}/gu) ?? []).length > MAX_DIGITS) return true; // a phone number
  return bare
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/[^\p{L}]/gu, "")
    .includes("offbooked");
};

const clean = (raw: string | null, max: number): string => {
  const text = (raw ?? "")
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[^\p{L}\p{M}\p{N} '’\-&,.:!?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return looksUnsafe(text) ? "" : text;
};

/** Ends a sentence on a title, which may already have its own punctuation. */
const stop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

export const cleanLink = (from: string | null, show: string | null): DirectorLink => ({ from: clean(from, MAX_NAME), show: clean(show, MAX_SHOW) });

export const readDirectorLink = (search: string): DirectorLink => {
  const params = new URLSearchParams(search);
  return cleanLink(params.get("from"), params.get("show"));
};

/** The address to send. Empty fields stay out of it. */
export function directorUrl(origin: string, { from, show }: DirectorLink): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (show) params.set("show", show);
  const query = params.toString();
  return `${origin}/director${query ? `?${query}` : ""}`;
}

/** The line above the page's headline, or null on a plain visit. */
export function greeting({ from, show }: DirectorLink): string | null {
  if (from && show) return stop(`${from} sent you this for ${show}`);
  if (from) return `${from}, from your cast, sent you this.`;
  if (show) return `Sent with ${show} in mind.`;
  return null;
}

/** The message the cast member sends with the link. */
export function directorMessage(link: DirectorLink, url: string): string {
  const opening = stop(`Found something that could help us get off book${link.show ? ` for ${link.show}` : ""}`);
  const signoff = link.from ? `\n\n${link.from}` : "";
  return `${opening} We each record our lines on our phones, then the whole cast can run the scenes in each other's voices between rehearsals. No accounts for the cast, and it's free right now. Worth two minutes?\n\n${url}${signoff}`;
}
