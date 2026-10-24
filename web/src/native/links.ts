/**
 * Where a link that opened the app should land. Universal links (https://offbooked.com/join/…,
 * the cast and sign-in links people already share and get by email) and offbooked://join/… both
 * map to the page's path inside the app. Anything else is ignored. The paths match the ones in
 * public/.well-known/apple-app-site-association.
 */
const APP_HOSTS = new Set(["offbooked.com", "www.offbooked.com"]);
const APP_PATHS = [/^\/join\/[^/]+\/?$/, /^\/i\/[^/]+(\/play)?\/?$/, /^\/auth\/verify\/?$/, /^\/signin\/?$/, /^\/app(\/.*)?$/];

export function appPathFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  let path: string;
  if (url.protocol === "https:" && APP_HOSTS.has(url.hostname.toLowerCase())) {
    path = url.pathname;
  } else if (url.protocol === "offbooked:") {
    // offbooked://join/abc parses with "join" as the host.
    path = `/${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } else {
    return null;
  }
  if (!APP_PATHS.some((re) => re.test(path))) return null;
  return path + url.search + url.hash;
}
