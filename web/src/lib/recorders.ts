import type { TopRecorder } from "../api/types";

/** A part's label from who recorded it: "Robin", or "Robin + 2" when others recorded some lines too. */
export function recorderLabel(top: TopRecorder | null): string | null {
  if (!top) return null;
  return top.others > 0 ? `${top.name} + ${top.others}` : top.name;
}

/** The same label read out in full, for screen readers: "recorded mostly by Robin and 2 others". */
export function recorderDescription(top: TopRecorder | null): string {
  if (!top) return "not recorded yet";
  if (top.others === 0) return `recorded by ${top.name}`;
  return `recorded mostly by ${top.name} and ${top.others === 1 ? "1 other" : `${top.others} others`}`;
}
