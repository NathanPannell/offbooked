# Offbooked MVP API contract

The backend (`backend/`, Railway, `https://api.offbooked.com`) and the web app (`web/`, Vercel, `https://offbooked.com`) are built against this file. If you change a shape, change it here too.

## Conventions

- JSON over HTTPS, all routes under `/api`. Errors: `{ "error": { "code": "not_found", "message": "Human readable" } }` with a matching HTTP status.
- IDs are UUID strings. Timestamps are ISO 8601 strings. Field names are camelCase.
- Auth is header based, not cookies (the web app and API are on different origins, and previews live on `*.vercel.app`):
  - Director: `Authorization: Bearer <sessionToken>`.
  - Actor: `Authorization: Invite <inviteToken>`.
- CORS: allow origins from `CORS_ORIGINS` (comma list, `*` wildcards in a host allowed), the methods used here, and the headers `Authorization, Content-Type, X-Take-Id, X-Duration-Ms`.
- Audio URLs returned by the API are short-lived signed URLs (about 1 hour) that a plain `<audio src>` can load without headers. They must support HTTP `Range` requests (Safari needs this to play or seek). Send `Cross-Origin-Resource-Policy: cross-origin` on audio responses.
- Rate limits return 429 with `error.code = "rate_limited"`.

## Core types

```ts
type LineKind = "dialogue" | "stage_direction" | "heading";

interface Section { id: string; seq: number; act: string | null; scene: string | null; title: string }   // title e.g. "Act 1, Scene 2"
interface Character { id: string; name: string; aliases: string[]; lineCount: number }
interface Line {
  id: string; seq: number; sectionId: string; kind: LineKind;
  characterId: string | null;            // required for dialogue, null otherwise
  text: string;
  flagged: boolean;                      // the parser wants the director to check this line
  flagCode: FlagCode | null;             // set when flagged; the review UI shows FLAG_LABELS[flagCode]
  flagReason: string | null;             // optional short detail, e.g. "Cued KING, assigned to CLAUDIUS"
}
type FlagCode = "speaker" | "missed_cue" | "direction" | "text" | "heading" | "backup";
interface Take {
  id: string; lineId: string; audioUrl: string; durationMs: number; createdAt: string;
  stt: { transcript: string; accuracy: number; ops: WordOp[] } | null;   // accuracy 0..1, from on-device STT
}
interface WordOp { op: "ok" | "sub" | "del" | "ins"; expected?: string; heard?: string }

interface Production {
  id: string; title: string; performanceDate: string | null; createdAt: string; archived: boolean;
  scriptStatus: "none" | "parsing" | "ready" | "failed";
  progress: { linesTotal: number; linesRecorded: number; actorsTotal: number; actorsDone: number };
}

interface CastMember {
  id: string; name: string; email: string | null; phone: string | null;
  characterIds: string[];
  inviteUrl: string;                         // `${APP_URL}/i/${token}`, always available to the director
  status: "not_opened" | "opened" | "in_progress" | "done";
  linesTotal: number; linesRecorded: number;
  firstName: string | null; lastActiveAt: string | null; nudgedAt: string | null;
  avgAccuracy: number | null;                // mean STT accuracy over current takes that have one
}

interface Render {
  status: "none" | "queued" | "rendering" | "ready" | "failed";
  audioUrl: string | null; durationMs: number | null; createdAt: string | null;
  stale: boolean;                            // a newer take exists than this render includes
  timing: TimingEntry[];                     // one per dialogue line, in seq order
}
interface TimingEntry { lineId: string; startMs: number; endMs: number; recorded: boolean }
```

## Director auth

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/api/auth/request` | `{ email }` | `204`. Sends a sign-in link `${APP_URL}/auth/verify?token=…` (single use, 15 min). When `EMAIL_DRIVER=log`, the response is `200 { devLink }` instead so local testing works. |
| POST | `/api/auth/verify` | `{ token }` | `{ sessionToken, user: { id, email, name } }` (session lasts 30 days) |
| GET | `/api/me` | | `{ user }` |
| PATCH | `/api/me` | `{ name }` | `{ user }`. The director's name shows on invites ("Sam invited you"). |
| POST | `/api/auth/logout` | | `204` |

## Productions and script (director)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/productions` | | `{ productions: Production[] }` (not archived) |
| POST | `/api/productions` | `{ title, performanceDate? }` | `{ production }` |
| GET | `/api/productions/:id` | | `{ production }` |
| PATCH | `/api/productions/:id` | `{ title?, performanceDate? }` | `{ production }` |
| POST | `/api/productions/:id/archive` | | `204`. Hides it and revokes its invites. Nothing is deleted. |
| POST | `/api/productions/:id/script` | `multipart/form-data` with a `file` field (PDF, Word `.docx` or plain text, ≤ 20 MB; the type is detected from the bytes) **or** JSON `{ text }` | `202 { scriptStatus: "parsing" }`. Parsing runs in the background. Replacing a script with recordings is refused (409). |
| GET | `/api/productions/:id/script` | | `{ status, error, sections: Section[], characters: Character[], lines: Line[], flaggedCount }` |
| PATCH | `/api/lines/:id` | `{ characterId?, kind?, text? }` | `{ line }` |
| POST | `/api/lines/:id/split` | `{ at, second? }` (character offset; `second: { kind, characterId, flagged, flagCode, flagReason, sourceLine, sourcePage }` restores a joined line exactly when undoing a join) | `{ lines: [Line, Line] }` |
| POST | `/api/lines/:id/merge-next` | | `{ line }` |
| POST | `/api/lines/:id/section-break` | `{ title, act?, scene? }` | `{ sections }`. Starts a new section at this line. |
| PATCH | `/api/sections/:id` | `{ title }` | `{ section }` |
| POST | `/api/productions/:id/characters` | `{ name }` | `{ character }` |
| PATCH | `/api/characters/:id` | `{ name }` | `{ character }` |
| POST | `/api/characters/:id/merge` | `{ intoId }` | `{ characters }`. Moves lines and aliases to `intoId`, removes this one. |
| POST | `/api/lines/:id/resolve` | | `{ line }`. Clears `flagged`, `flagCode` and `flagReason`, as do `PATCH`, joins and merges. |

## Cast (director)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/productions/:id/cast` | | `{ cast: CastMember[], uncastCharacterIds: string[] }` |
| POST | `/api/productions/:id/cast` | `{ name, email?, phone?, characterIds }` | `{ member: CastMember }` |
| PATCH | `/api/cast/:actorId` | `{ name?, email?, phone?, characterIds? }` | `{ member }` |
| POST | `/api/cast/:actorId/reset-link` | | `{ member }` with a new `inviteUrl`. The old link stops working. |
| POST | `/api/cast/:actorId/nudged` | | `{ member }`. Records that the director shared a reminder. The app sends nothing. |

Invite tokens are derived, not stored: `token = base64url(actorId bytes) + "." + tokenVersion + "." + HMAC-SHA256(INVITE_TOKEN_SECRET, actorId + ":" + tokenVersion)` truncated to 22 chars. Resetting bumps `tokenVersion`. They are valid until `performanceDate + 14 days` (or 120 days after creation if there is no date), and revoked when the production is archived.

## Actor (invite token)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/invite` | | `{ production: { id, title, directorName }, actor: { id, name, firstName }, characters: { id, name }[], linesTotal, linesRecorded, hasEmail }`. Expired or revoked links return 410 with `{ error, directorName, productionTitle }`. |
| POST | `/api/invite/start` | `{ firstName }` | `204`. Sets `firstName` and `openedAt`. |
| GET | `/api/invite/lines` | | `{ sections: Section[], lines: ActorLine[] }` |
| PUT | `/api/invite/lines/:lineId/take` | raw audio body (`audio/webm`, `audio/mp4`, `audio/ogg`, `audio/wav`; ≤ 8 MB), headers `X-Take-Id` (client UUID, idempotency key) and `X-Duration-Ms` | `{ take: Take, linesRecorded, linesTotal }`. A repeated `X-Take-Id` returns the same take. The new take becomes current; old takes are kept forever. |
| POST | `/api/invite/takes/:takeId/stt` | `{ transcript, accuracy, ops }` | `204` |
| POST | `/api/invite/contact` | `{ email }` | `204`. Email used only for the run-through-ready email. |
| GET | `/api/invite/runthrough` | | `RunThrough` with `myCharacterIds` set |
| POST | `/api/invite/practice` | `{ mode: "my_part", results: { lineId, transcript, accuracy, ops }[] }` | `{ practice: { id, avgAccuracy, createdAt } }` |

```ts
interface ActorLine {
  line: Line;                       // one of this actor's dialogue lines
  sectionTitle: string;
  cue: { characterName: string; text: string; audioUrl: string | null } | null;   // previous dialogue line by someone else
  directions: string[];             // stage directions between the cue and this line
  take: Take | null;                // current take
}
```

Actors can only see their own lines and the single cue line before each, until the run-through endpoint, which shows the whole script.

## Run-through (director or actor)

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/api/productions/:id/runthrough` | director | `RunThrough` |
| GET | `/api/invite/runthrough` | actor | `RunThrough` |
| POST | `/api/productions/:id/render` | director | `202 { render }`. Forces a rebuild. |

```ts
interface RunThrough {
  production: { id: string; title: string };
  sections: Section[];
  characters: Character[];
  lines: Line[];                    // all lines, including stage directions (shown dimmed, not timed)
  render: Render;                   // the stitched file; the player now plays line by line (see the end)
  sources: Record<string, AudioSource>; // by dialogue line ID
  myCharacterIds: string[];         // empty for the director
}
```

## Render pipeline (server)

- Triggered automatically, debounced by about 15 seconds after takes land, and on demand. One job per production at a time, run in-process on Railway, with ffmpeg on `PATH`.
- Per current take: decode, trim leading and trailing silence, apply `loudnorm` (I=-16), resample to 48 kHz mono. Cache each normalized take by take ID so only new takes are processed again.
- Concatenate dialogue lines in `seq` order. Gaps are 350 ms between lines in a section and 1200 ms at a section change. An unrecorded line becomes silence of `clamp(words × 380 ms, 1200, 8000)` with `recorded: false` in timing.
- Output AAC in `.m4a` plus the `timing` array, stored with a content hash of (take IDs + line order + settings). Renders are never deleted.
- When a render finishes with every cast line recorded, the notifications below fire.

## Notifications (Resend, completion only)

- To the director: "{firstName or name} finished all {n} lines" when an actor's last line lands, and "Cast complete — run-through ready" when the full-cast render finishes.
- To actors with an email: "The run-through for {title} is ready", linking to `${APP_URL}/i/{token}/play`.
- Each sends once (unique on kind + production + actor). With `EMAIL_DRIVER=log` emails are logged, not sent. Nothing ever emails invites or reminders.

## Web routes

- `/`: landing page with director sign-in.
- `/signin`, `/auth/verify?token=`
- `/app`: productions list. `/app/new`. `/app/p/:id` (tabs: Script, Cast & progress, Run-through).
- `/i/:token`: actor welcome, then recording, then wrapped. `/i/:token/play`: run-through for the actor.

---

# Additions (2026-10-14): cast link, review in context, parse progress, stand-ins and TTS

These extend the contract above. Where they differ from it, these win.

## Changed types

```ts
interface Line {
  // …all existing fields, plus:
  sourceLine: number | null;  // 1-based line in the prepared source text (see /script/source)
  page: number | null;        // PDF page the line came from; null for DOCX and plain text
}
// Line.text keeps the script's line breaks ("\n") and relative indentation as printed. Render it
// with `white-space: pre-wrap`. Never assume it is a single line.

interface ParseProgress {
  stage?: "reading" | "labelling" | "saving";
  pages?: number | null;      // PDF page count once the file has been read
  chunksDone?: number; chunksTotal?: number;
  linesDone?: number; linesTotal?: number;   // source lines labelled so far / in total
  scenes?: number;            // act and scene headings found so far
  speeches?: number;          // speeches found so far
}
// GET /api/productions/:id/script gains `progress: ParseProgress | null` (non-null while status is "parsing").
// Poll it every ~1.5 s while parsing. All parts are labelled in parallel, so progress jumps in bursts.

type AudioSource = "actor" | "standin" | "tts" | "none";
// TimingEntry gains `source: AudioSource` (`recorded` stays: true for actor or standin).
// ActorLine.cue gains `audioSource: AudioSource` (cue audio is a take when one exists, else TTS).
```

## Review in context (director)

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/productions/:id/script/source?line=N&context=40` | `{ kind: "pdf" \| "docx" \| "text", pageCount: number \| null, from: number, lines: { n: number, text: string, page: number \| null }[] }`: the prepared source text around line N (page-break marker lines are omitted). |
| GET | `/api/productions/:id/script/file` | The original uploaded file (PDF, DOCX or text) with its content type, for rendering the page next to the script (pdf.js for PDFs). Director auth header. |

## One cast link (whole cast)

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/api/productions/:id/join-link` | director | `{ joinUrl }` (`${APP_URL}/join/<token>`) |
| POST | `/api/productions/:id/join-link/reset` | director | `{ joinUrl }`: the old link stops working |
| GET | `/api/join/:token` | none | `{ production: { id, title, directorName }, characters: { id, name, lineCount, takenBy: string \| null }[] }`, sorted by line count. 409 `script_not_ready` while parsing; 410 when archived; 404 for a bad or reset link. |
| POST | `/api/join/:token/claim` | none | `{ characterIds: string[], firstName }` → `{ inviteToken, inviteUrl }`. Creates a cast member who owns those characters, then the web app goes straight to `/i/<inviteToken>`. 409 `character_taken` if someone got there first. Store the invite token per join link in localStorage, so reopening the cast link on the same device goes back to that actor's recording screen. |

## Stand-ins and TTS (backend agent fills these in; shapes are fixed here)

- Every dialogue line always has audio in the run-through, in this order: the latest take (by the cast actor or a stand-in), otherwise a TTS voice. Each character gets a consistent synthetic voice, and different characters get different voices where possible.
- The director (or anyone they share the director account with) can record a stand-in take for any line:
  - `PUT /api/lines/:lineId/take` (director auth): same body, headers and response as the actor take upload.
  - `GET /api/productions/:id/sections/:sectionId/lines` (director): `{ section, lines: { line: Line, characterName: string, take: Take \| null, audioSource: AudioSource, cue: ActorLine["cue"] }[] }` for recording a whole scene, partner by partner.
- When an actor later records their own line it becomes the current take; older takes are kept.
- Takes gain `recordedBy: "actor" | "standin"`.

### Stand-ins and TTS: details as built

- The stand-in upload response's `linesRecorded`/`linesTotal` are production progress, counting actor takes only (stand-ins never count as an actor's progress or trigger "finished" emails).
- `ActorLine.take` is the actor's own latest take, never a stand-in.
- A cue whose TTS clip is still being synthesized comes back with `audioUrl: null, audioSource: "none"` (the lines endpoints wait up to `TTS_CUE_WAIT_MS`, default 2.5 s); it fills in on the next fetch.
- `GET` run-through may queue a render (first open, or when stale with nothing queued).
- Stand-in takes count as recordings for the "script can't be replaced once recorded" rule.
- `/health` reports `tts: "piper <version>" | null` and never fails because of it; without Piper, unrecorded lines render as silence (`source: "none"`).

# Additions (2026-10-14): line-by-line playback

The run-through player plays each dialogue line's own clip in turn instead of one stitched render, so the first line plays about a second after pressing play rather than after the whole play is synthesized and stitched. The stitched render still builds in the background (it shares every clip) and stays in `RunThrough.render`.

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/api/productions/:id/lines/:lineId/audio` | director (own production) | `LineAudio`. Waits up to 20 s for a clip still being made. `?prefetch=1` asks at prefetch priority instead of play priority. |
| GET | `/api/invite/lines/:lineId/audio` | actor | Same, for any dialogue line in the actor's production (the run-through shows them the whole script). |
| POST | `/api/productions/:id/lines/audio/warm` | director | `{ lineIds: string[] }` (at most 30, in playback order) → `{ lines: LineAudio[] }` at once: ready clips have URLs, the rest are queued at prefetch priority with `ready: false`. |
| POST | `/api/invite/lines/audio/warm` | actor | Same. |

Lines that aren't dialogue lines of that production are 404 on GET and left out of a warm response. Bad `lineIds` are 400.

```ts
interface LineAudio {
  lineId: string;
  audioUrl: string | null;  // signed .m4a (AAC, 48 kHz mono); null for a silent line or one not ready yet
  durationMs: number;       // the clip's length; for a silent line, the render's placeholder silence
  source: AudioSource;      // "actor" | "standin" | "tts" | "none"
  ready: boolean;           // false while the clip is still being made: ask again
}

interface RunThrough {
  // ...as before, plus:
  sources: Record<string, AudioSource>; // each dialogue line's source, without making anything
}
```

- Source rules match the render: the current take's normalized audio (normalized on first use and cached with the render's normalized FLAC, as `takes.stream_key`), else the TTS clip (same voice and cache key as the render; every clip now gets its `.m4a` alongside the FLAC), else silence of `clamp(words × 380 ms, 1200, 8000)`.
- TTS synthesis runs by priority: play (a GET) before prefetch (`?prefetch=1`, warm, the actor lines page's cue wait) before cue warm-ups before the render. Background work (cues, renders) uses at most `TTS_CONCURRENCY - 1` slots, so a listener's line waits for at most one clip in progress. Concurrent requests for one clip share one synthesis, at the most urgent priority asked.
- The client plays gaps itself: 350 ms between lines in a section, 1200 ms at a section change or an A–B jump back.

### Joining lines (2026-10-15)

- `POST /api/lines/:id/merge-previous` → `{ line }`: joins this line into the one above it. `merge-next` joins the next line into this one. Either way the upper line keeps its id, kind and speaker, the texts are joined with a newline, and the lower line must have no recordings (409 `has_recordings`).
- The parser keeps each speech as one dialogue line. A stage direction printed inside a speech, or on its cue line ("MACBETH, to the Servant"), stays in the line's text in square brackets, whatever the script used (parentheses, italics, underscores or nothing): `[to the Servant] Now go to the door… [Servant exits.] Was it not yesterday…`. Directions on their own line between speeches stay separate stage-direction lines. TTS skips bracketed text.

### Flag codes (2026-10-15)

Every flagged line has one standard `flagCode`; `flagReason` is an optional short detail and may be `null`. The labels live in `FLAG_LABELS` in `backend/src/parse/flags.ts`:

| `flagCode` | Label | Used for |
| --- | --- | --- |
| `speaker` | Confirm the speaker | Speaker inferred from the content rather than a cue, joint or garbled cues, a character who speaks only once, lines cued X assigned to Y, an unclear speaker after an exit |
| `missed_cue` | Check for a missed speaker | A very long speech that may hold two speakers, a speech split at a cue the parser missed |
| `direction` | Review stage direction | No speaker found so the text became a direction, a direction that may be dialogue or the other way round |
| `text` | Check the text against the original | Text that differs from or wasn't found in the source, skipped or unlabelled lines, stray numbers inside speech |
| `heading` | Check the scene heading | An act or scene number that was inferred |
| `backup` | Check this passage | Read by the backup (heuristic) parser |

A speech that carries on after a stage direction, page break or heading without a new cue keeps the previous speaker and is not flagged. Migration `006_flag_codes.sql` gave older flags a code by matching their text.

### Deleting and inserting lines (2026-10-15)

- `DELETE /api/lines/:id` → `{ line, afterLineId, removedSection }`: deletes a line with no recordings (409 `has_recordings` otherwise) and renumbers the lines after it. `line` is the deleted line as it was, `afterLineId` the line it sat after (null when it was first), and `removedSection` its scene (`Section`) when the line was the scene's only line and the scene went with it, else null. Together they are what undo needs.
- `POST /api/productions/:id/lines` with `{ afterLineId: string | null, sectionId?, newSection?: { title, act?, scene? }, kind, characterId?, text, flagged?, flagCode?, flagReason?, sourceLine?, sourcePage? }` → `{ line }`: inserts a line after `afterLineId` (null: at the start). It goes in `sectionId`, which must be the scene of the line before or after the place (400 otherwise); or in a new scene `newSection`, which can only start between two scenes; or, with neither, the scene of the line before (else the one after). A dialogue line without `characterId` gets a guessed speaker, as with `PATCH`. The web app uses it to undo a delete: `sectionId` is the deleted line's scene, or `newSection` from `removedSection`.

### Cast page: call sheet and recording a part yourself (2026-10-15)

The director's cast page shows the cast link, a read-only call sheet and a way to record a part yourself. It no longer assigns parts, makes per-actor links or collects emails and phones; the `/api/productions/:id/cast` and `/api/cast/:actorId/*` routes stay for now but the web app doesn't use them.

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/api/productions/:id/call-sheet` | director (own production) | `{ characters: { id, name, lineCount, linesRecorded, takenBy: string \| null, mine: boolean }[] }`: every character with dialogue, biggest parts first. `takenBy` is the first name of whoever took the part; `mine` is true for a part the director took with `record-as`. `linesRecorded` counts the cast's own takes only (not stand-ins or TTS). |
| POST | `/api/productions/:id/record-as` | director (own production) | `{ characterId }` → `{ inviteToken, inviteUrl }`. The director gets one cast member per production (`actors.director_user_id`), created on first use with their first name and already opened, so `/i/<inviteToken>` goes straight to recording. The character is added to that cast member unless it is already theirs. 409 `character_taken` if someone else has the part; 404 for a character outside the production; 400 for a missing or malformed id. |

- The director's cast member records ordinary actor takes (`recorded_by = 'actor'`), so they count as progress and the part can't be claimed through the cast link. No "finished all lines" email is sent for it.
