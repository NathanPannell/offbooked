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
  /** 1-based line in the prepared source text (see script/source). Null for older parses. */
  sourceLine?: number | null;
  /** PDF page the line came from. Null for DOCX, plain text and older parses. */
  page?: number | null;
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
  /** Who recorded it. Missing on older servers, where every take is the actor's. */
  recordedBy?: "actor" | "standin";
}

/** Where a line's audio comes from in the run-through: a cast take, a stand-in take, a synthetic voice, or nothing yet. */
export type AudioSource = "actor" | "standin" | "tts" | "none";

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
  /** Missing on older servers: derive it from `recorded`. */
  source?: AudioSource;
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
  /** Non-null while status is "parsing". */
  progress?: ParseProgress | null;
}

export interface ParseProgress {
  stage?: "reading" | "labelling" | "saving";
  pages?: number | null;
  chunksDone?: number;
  chunksTotal?: number;
  linesDone?: number;
  linesTotal?: number;
  scenes?: number;
  speeches?: number;
}

export interface ScriptSource {
  kind: "pdf" | "docx" | "text";
  pageCount: number | null;
  from: number;
  lines: { n: number; text: string; page: number | null }[];
}

export interface JoinInfo {
  production: { id: string; title: string; directorName: string };
  characters: { id: string; name: string; lineCount: number; takenBy: string | null }[];
}

export interface SectionLine {
  line: Line;
  characterName: string;
  take: Take | null;
  audioSource: AudioSource;
  cue: Cue | null;
}

export interface Invite {
  production: { id: string; title: string; directorName: string };
  actor: { id: string; name: string; firstName: string | null };
  characters: { id: string; name: string }[];
  linesTotal: number;
  linesRecorded: number;
  hasEmail: boolean;
}

export interface Cue {
  characterName: string;
  text: string;
  audioUrl: string | null;
  /** Missing on older servers: a take when there is audio. */
  audioSource?: AudioSource;
}

export interface ActorLine {
  line: Line;
  sectionTitle: string;
  cue: Cue | null;
  directions: string[];
  take: Take | null;
}

export interface PracticeResult extends SttResult {
  lineId: string;
}
