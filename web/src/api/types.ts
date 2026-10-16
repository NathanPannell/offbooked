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

/** Why the parser flagged a line (null: no particular reason given). */
export type FlagCode = "speaker" | "missed_cue" | "direction" | "text" | "heading" | "backup";

export interface Line {
  id: string;
  seq: number;
  sectionId: string;
  kind: LineKind;
  characterId: string | null;
  text: string;
  flagged: boolean;
  flagReason: string | null;
  /** What to check on a flagged line; older parses and servers leave it out. */
  flagCode?: FlagCode | null;
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

/** One speaking character on the director's call sheet. Progress counts the cast's own takes only. */
export interface CallSheetCharacter {
  id: string;
  name: string;
  lineCount: number;
  linesRecorded: number;
  /** First name of whoever took the part, or null while it's free. */
  takenBy: string | null;
  /** The director took it to record themselves. */
  mine: boolean;
}

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
  /** Where each dialogue line's audio comes from, by line ID. Missing on older servers. */
  sources?: Record<string, AudioSource>;
  myCharacterIds: string[];
}

/** One line's audio for line-by-line playback (GET …/lines/:lineId/audio). */
export interface LineAudio {
  lineId: string;
  /** A small .m4a, or null for a silent line (or one still being made). */
  audioUrl: string | null;
  /** The clip's length; for a silent line, how long to stay silent. */
  durationMs: number;
  source: AudioSource;
  /** False while the clip is still being made: ask again. */
  ready: boolean;
  /** A synthesized clip: when each printed line (and narrated [direction]) is said. Absent for takes. */
  segments?: SpokenSegment[];
}

/** One spoken stretch of a clip, in ms of the clip as served. `text` is what was said. */
export interface SpokenSegment {
  startMs: number;
  endMs: number;
  text: string;
  narrator: boolean;
}

/** Line audio calls, scoped to a director's production or an actor's invite. */
export interface LineAudioApi {
  line: (lineId: string, opts?: { prefetch?: boolean; signal?: AbortSignal }) => Promise<LineAudio>;
  warm: (lineIds: string[]) => Promise<{ lines: LineAudio[] }>;
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
