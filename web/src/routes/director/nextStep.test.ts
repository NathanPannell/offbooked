import { describe, expect, it } from "vitest";
import type { Production } from "../../api/types";
import { nextStep } from "./nextStep";

const production = (over: Partial<Production> = {}, progress: Partial<Production["progress"]> = {}): Production => ({
  id: "p",
  title: "Hamlet",
  performanceStartsOn: null,
  performanceEndsOn: "2027-10-20",
  contentDeletesOn: "2027-10-27",
  createdAt: "2026-10-01T00:00:00Z",
  archived: false,
  scriptStatus: "ready",
  ...over,
  progress: { linesTotal: 100, linesRecorded: 0, actorsTotal: 0, actorsDone: 0, ...progress },
});

describe("nextStep", () => {
  it("starts with the script", () => {
    expect(nextStep(production({ scriptStatus: "none" }))).toMatchObject({ action: "Add the script", tab: "script", step: 0 });
    expect(nextStep(production({ scriptStatus: "parsing" }))).toMatchObject({ tab: "script" });
    expect(nextStep(production({ scriptStatus: "failed" }))).toMatchObject({ action: "Try the script again" });
  });

  it("once the script is read, the cast link, then progress, then listening", () => {
    expect(nextStep(production())).toMatchObject({ action: "Share the cast link", tab: "cast", step: 1 });
    expect(nextStep(production({}, { actorsTotal: 2 }))).toMatchObject({ status: "100 lines to go", action: "Open the cast", tab: "cast" });
    expect(nextStep(production({}, { actorsTotal: 2, linesRecorded: 99 }))).toMatchObject({ status: "1 line to go", action: "Open the cast" });
    expect(nextStep(production({}, { actorsTotal: 2, linesRecorded: 100 }))).toMatchObject({
      action: "Listen through the play",
      tab: "play",
      step: 2,
      done: true,
    });
  });

  it("counts the director's own recordings: no cast yet, but lines recorded", () => {
    expect(nextStep(production({}, { linesRecorded: 10 }))).toMatchObject({ status: "90 lines to go", tab: "cast" });
    expect(nextStep(production({}, { linesRecorded: 100 }))).toMatchObject({ tab: "play", done: true });
  });
});
