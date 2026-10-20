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
  /** A label for shared lines ("ANGELO, ESCALUS", "ALL"), never a part to take. Missing on older servers. */
  group?: boolean;
  /** ALL, BOTH, EVERYONE…: who says each line comes from the scene. */
  everyone?: boolean;
  /** A named group's characters, in order. */
  memberIds?: string[];
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
  /** A shared line: every character who says it, in order. Null (or missing) when only `characterId` does. */
  voiceIds?: string[] | null;
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
  /** Who recorded it: a cast member or the director, by first name. */
  recordedBy: RecordedBy;
  /** You recorded it (the invite's cast member, or the signed-in director). */
  mine: boolean;
}

export interface RecordedBy {
  kind: "actor" | "director";
  name: string;
}

/** A part's label: whoever recorded most of its lines, and how many others recorded the rest. */
export interface TopRecorder {
  name: string;
  others: number;
}

/** Where a line's audio comes from when listening: a cast member's take, the director's, a synthetic voice, or nothing yet. */
export type AudioSource = "actor" | "director" | "tts" | "none";

export type ScriptStatus = "none" | "parsing" | "ready" | "failed";

export interface Production {
  id: string;
  title: string;
  /** First and final performance, YYYY-MM-DD. Every production has a final date. */
  performanceStartsOn: string | null;
  performanceEndsOn: string | null;
  /** The day the script and recordings are deleted for good: the final performance + 7 days. */
  contentDeletesOn: string | null;
  createdAt: string;
  archived: boolean;
  scriptStatus: ScriptStatus;
  progress: { linesTotal: number; linesRecorded: number; actorsTotal: number; actorsDone: number };
}

export type CastStatus = "not_opened" | "opened" | "in_progress" | "done";

/** One speaking character on the director's call sheet. Lines count as recorded whoever recorded them. */
export interface CallSheetCharacter {
  id: string;
  name: string;
  lineCount: number;
  linesRecorded: number;
  /** Who recorded most of its lines ("Robin + 2"), or null before anyone has. */
  topRecorder: TopRecorder | null;
  /** The director has recorded some of its lines: one of "My roles". */
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
  /** A take: when each spoken word starts, in ms of the clip as served, one per spoken piece of `lineTokens(text)` in order. Absent when unknown. */
  wordStartsMs?: number[];
  /** A take: the stretches of the clip with speech in them, in ms of the clip as served. Absent for synthesized clips. */
  speech?: { startMs: number; endMs: number }[];
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
  characters: PartCard[];
}

export interface SectionLine {
  line: Line;
  characterName: string;
  take: Take | null;
  audioSource: AudioSource;
  cue: Cue | null;
  /** A shared line: who says it with the character in view, and their takes. */
  together?: Together[];
  /** The voice a take is for, on a shared line in a character's studio. */
  voiceId?: string | null;
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

/** Someone else who says a shared line, and their current take. */
export interface Together {
  characterId: string;
  characterName: string;
  audioUrl: string | null;
  audioSource: "actor" | "director" | "none";
}

export interface ActorLine {
  line: Line;
  sectionTitle: string;
  cue: Cue | null;
  directions: string[];
  take: Take | null;
  /** A shared line: the others who say it. Empty (or missing) for a line of one's own. */
  together?: Together[];
  /**
   * What plays now when it isn't the actor's own take: another cast member's or the director's. The
   * line counts as recorded; the actor can record over it. Null when the actor has a take, or the
   * line is still the computer voice.
   */
  current?: { source: "actor" | "director"; by: string; recordedBy: RecordedBy; mine: false; audioUrl: string } | null;
}

/** A part on the cast link, or one an actor can pick up. Parts aren't owned: anyone can pick any. */
export interface PartCard {
  id: string;
  name: string;
  lineCount: number;
  /** Lines with a take by anyone. */
  linesRecorded: number;
  /** Lines nobody has recorded yet (still the computer voice). */
  linesNeeded: number;
  /** Who recorded most of its lines, or null before anyone has. */
  topRecorder: TopRecorder | null;
}
