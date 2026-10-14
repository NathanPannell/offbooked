import { describe, expect, it } from "vitest";
import type { Production } from "../../api/types";
import { nextStep } from "./nextStep";

const production = (over: Partial<Production> = {}, progress: Partial<Production["progress"]> = {}): Production => ({
  id: "p",
  title: "Hamlet",
  performanceDate: null,
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

  it("asks for a check while lines are flagged, until recording starts", () => {
    expect(nextStep(production(), 3)).toMatchObject({ status: "3 lines to check", tab: "script" });
    expect(nextStep(production({}, { actorsTotal: 2, linesRecorded: 4 }), 3)).toMatchObject({ tab: "cast" });
  });

  it("then the cast link, then progress, then listening", () => {
    expect(nextStep(production())).toMatchObject({ action: "Share the cast link", tab: "cast", step: 1 });
    expect(nextStep(production({}, { actorsTotal: 2 }))).toMatchObject({ status: "100 lines to go", action: "Check who's joined" });
    expect(nextStep(production({}, { actorsTotal: 2, linesRecorded: 99 }))).toMatchObject({ status: "1 line to go", action: "See who's recorded" });
    expect(nextStep(production({}, { actorsTotal: 2, linesRecorded: 100 }))).toMatchObject({ tab: "play", step: 2, done: true });
  });
});
