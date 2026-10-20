import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MicError } from "../audio/recorder";
import { MicTestView, type MicTestState } from "./MicSettings";

// The first-run mic check replaces the record button until it is done or skipped, so there must
// always be a way out: Skip whatever the check is doing, its errors included, or, once it has
// played someone back, "Sounds good" (which ends it, so Skip goes).
const clip = { heardVoice: true, durationMs: 1800, levels: [0.1, 0.6, 0.4] };
const heard: MicTestState = { status: "heard", clip };
const states: MicTestState[] = [
  { status: "idle" },
  { status: "listening" },
  { status: "playing", clip },
  { status: "heard", clip: { ...clip, heardVoice: false } },
  ...(["denied", "no-mic", "busy", "insecure", "unsupported", "unknown"] as const).map((kind) => ({
    status: "error" as const,
    error: new MicError(kind, "x"),
  })),
];

const render = (state: MicTestState) =>
  renderToStaticMarkup(
    createElement(MicTestView, {
      state,
      analyser: null,
      onRun: () => {},
      onReset: () => {},
      startLabel: "Check my mic",
      primary: true,
      aside: createElement("button", { type: "button", className: "mic-test-skip" }, "Skip"),
      doneAction: () => createElement("button", { type: "button", className: "btn btn-primary" }, "Sounds good"),
    }),
  );

describe("the mic check", () => {
  const name = (s: MicTestState) =>
    s.status === "error" ? `error (${s.error.kind})` : s.status === "heard" ? (s.clip.heardVoice ? "heard" : "heard, too quiet") : s.status;

  it.each(states.map((s) => [name(s), s] as const))("offers Skip while %s", (_name, state) => {
    expect(render(state)).toContain(">Skip</button>");
  });

  it("starts with one tap, and ends with just Sounds good and a quiet Try again", () => {
    expect(render({ status: "idle" })).toContain("Check my mic");
    const done = render(heard);
    expect(done).toContain("Sounds good");
    expect(done).toContain("Try again");
    expect(done).not.toContain(">Skip</button>");
    expect(done).not.toContain("very quiet");
    const quiet = render({ status: "heard", clip: { ...clip, heardVoice: false } });
    expect(quiet).toContain("very quiet");
    expect(quiet).toContain("Sounds good");
  });

  it("shows the one filled button at a time", () => {
    for (const state of [...states, heard]) expect(render(state).match(/btn-primary/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
