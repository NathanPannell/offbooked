import type { Production } from "../../api/types";

export type StepTab = "script" | "cast" | "play";

export interface NextStep {
  /** Where things stand, e.g. "Reading the script". */
  status: string;
  /** The call to action, e.g. "Share the cast link". */
  action: string;
  tab: StepTab;
  /** 0 script, 1 cast, 2 listen. */
  step: 0 | 1 | 2;
  done: boolean;
}

const lines = (n: number) => `${n.toLocaleString()} ${n === 1 ? "line" : "lines"}`;

/** The one thing to do next for a production. Once the script is read, that is sharing the cast link. */
export function nextStep(p: Production): NextStep {
  const { linesTotal, linesRecorded, actorsTotal } = p.progress;
  switch (p.scriptStatus) {
    case "none":
      return { status: "No script yet", action: "Add the script", tab: "script", step: 0, done: false };
    case "parsing":
      return { status: "Reading the script", action: "See how it's going", tab: "script", step: 0, done: false };
    case "failed":
      return { status: "The script didn't read", action: "Try the script again", tab: "script", step: 0, done: false };
  }
  if (linesTotal > 0 && linesRecorded >= linesTotal) {
    return { status: "Every line recorded", action: "Listen through the play", tab: "play", step: 2, done: true };
  }
  if (actorsTotal === 0 && linesRecorded === 0) return { status: "Script ready", action: "Share the cast link", tab: "cast", step: 1, done: false };
  return {
    status: `${lines(Math.max(0, linesTotal - linesRecorded))} to go`,
    action: "Open the cast",
    tab: "cast",
    step: 1,
    done: false,
  };
}
