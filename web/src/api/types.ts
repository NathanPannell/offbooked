// Mirrors docs/api.md. Keep in sync with the contract.

export type LineKind = "dialogue" | "stage_direction" | "heading";

export interface Section {
  id: string;
  seq: number;
  act: string | null;
  scene: string | null;
  title: string;
}

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  lineCount: number;
}

export interface Line {
  id: string;
  seq: number;
  sectionId: string;
  kind: LineKind;
  characterId: string | null;
  text: string;
  flagged: boolean;
  flagReason: string | null;
}

export interface WordOp {
  op: "ok" | "sub" | "del" | "ins";
  expected?: string;
  heard?: string;
}

export interface SttResult {
  transcript: string;
  accuracy: number;
  ops: WordOp[];
}

export interface Take {
  id: string;
  lineId: string;
  audioUrl: string;
  durationMs: number;
  createdAt: string;
  stt: SttResult | null;
}

export type ScriptStatus = "none" | "parsing" | "ready" | "failed";

export interface Production {
  id: string;
  title: string;
  performanceDate: string | null;
  createdAt: string;
  archived: boolean;
  scriptStatus: ScriptStatus;
  progress: { linesTotal: number; linesRecorded: number; actorsTotal: number; actorsDone: number };
}

export type CastStatus = "not_opened" | "opened" | "in_progress" | "done";

export interface CastMember {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  characterIds: string[];
  inviteUrl: string;
  status: CastStatus;
  linesTotal: number;
  linesRecorded: number;
  firstName: string | null;
  lastActiveAt: string | null;
  nudgedAt: string | null;
  avgAccuracy: number | null;
}

export interface TimingEntry {
  lineId: string;
  startMs: number;
  endMs: number;
  recorded: boolean;
}

export interface Render {
  status: "none" | "queued" | "rendering" | "ready" | "failed";
  audioUrl: string | null;
  durationMs: number | null;
  createdAt: string | null;
  stale: boolean;
  timing: TimingEntry[];
}

export interface RunThrough {
  production: { id: string; title: string };
  sections: Section[];
  characters: Character[];
  lines: Line[];
  render: Render;
  myCharacterIds: string[];
}

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface Script {
  status: ScriptStatus;
  error: string | null;
  sections: Section[];
  characters: Character[];
  lines: Line[];
  flaggedCount: number;
}

export interface Invite {
  production: { id: string; title: string; directorName: string };
  actor: { id: string; name: string; firstName: string | null };
  characters: { id: string; name: string }[];
  linesTotal: number;
  linesRecorded: number;
  hasEmail: boolean;
}

export interface ActorLine {
  line: Line;
  sectionTitle: string;
  cue: { characterName: string; text: string; audioUrl: string | null } | null;
  directions: string[];
  take: Take | null;
}

export interface PracticeResult extends SttResult {
  lineId: string;
}
