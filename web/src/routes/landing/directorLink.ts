// The link a cast member sends their director: who sent it and which show, carried in the URL, so
// the page can greet the director without a backend. Anyone can write these words into a link, so
// what the page shows is short plain text and never something that reads as a web address.

const MAX_NAME = 40;
const MAX_SHOW = 60;

export interface DirectorLink {
  from: string;
  show: string;
}

const clean = (raw: string | null, max: number): string => {
  const text = (raw ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N} '’\-&,.!?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return /[\p{L}\p{N}]\.\p{L}{2,}/u.test(text) ? "" : text;
};

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
  if (from && show) return `${from}, from your ${show} cast, sent you this.`;
  if (from) return `${from}, from your cast, sent you this.`;
  if (show) return `For your ${show} cast.`;
  return null;
}

/** The message the cast member sends with the link. */
export function directorMessage(link: DirectorLink, url: string): string {
  const show = link.show ? ` for ${link.show}` : "";
  const signoff = link.from ? `\n\n${link.from}` : "";
  return `Found something that could help us get off book${show}. We each record our lines on our phones, then the whole cast can run the scenes in each other's voices between rehearsals. No accounts for the cast, and it's free right now. Worth two minutes?\n\n${url}${signoff}`;
}
