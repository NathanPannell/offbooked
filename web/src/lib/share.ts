export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

export interface ShareContent {
  title?: string;
  /** The message. The URL is appended when copying. */
  text: string;
  url?: string;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Safari and non-secure contexts: fall back to a hidden textarea.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok: boolean;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** Opens the native share sheet where there is one, otherwise copies the message and link. */
export async function shareOrCopy(content: ShareContent): Promise<ShareOutcome> {
  const data: ShareData = { title: content.title, text: content.text, url: content.url };
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  const coarse = window.matchMedia?.("(pointer: coarse)").matches;
  if (nav.share && coarse && (!nav.canShare || nav.canShare(data))) {
    try {
      await nav.share(data);
      return "shared";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    }
  }
  const full = content.url ? `${content.text}\n${content.url}` : content.text;
  return (await copyText(full)) ? "copied" : "failed";
}
