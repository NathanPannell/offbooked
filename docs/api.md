# Offbooked MVP API contract

The backend (`backend/`, Railway, `https://api.offbooked.com`) and the web app (`web/`, Vercel, `https://offbooked.com`) are built against this file. If you change a shape, change it here too.

## Conventions

- JSON over HTTPS, all routes under `/api`. Errors: `{ "error": { "code": "not_found", "message": "Human readable" } }` with a matching HTTP status.
- IDs are UUID strings. Timestamps are ISO 8601 strings. Field names are camelCase.
- Auth is header based, not cookies (the web app and API are on different origins):
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
  id: string; title: string; createdAt: string; archived: boolean;
  performanceStartsOn: string | null;        // YYYY-MM-DD, first performance (optional)
  performanceEndsOn: string | null;          // YYYY-MM-DD, final performance; every production has one
  contentDeletesOn: string | null;           // read-only: performanceEndsOn + 7 days (see "Content retention")
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
| POST | `/api/auth/request` | `{ email, next? }` | `204`. Sends a sign-in link `${APP_URL}/auth/verify?token=…&next=…` (single use, 15 min). `next` is where the app goes after signing in; only a path inside the director app (`/app`, `/app/…`, `/app?…`) is kept, anything else is dropped without an error. When `EMAIL_DRIVER=log`, the response is `200 { devLink }` instead so local testing works. |
| POST | `/api/auth/verify` | `{ token }` | `{ sessionToken, user: { id, email, name } }` (session lasts 30 days) |
| GET | `/api/me` | | `{ user }` |
| PATCH | `/api/me` | `{ name }` | `{ user }`. The director's name shows on invites ("Sam invited you"). Until it is set, the cast sees the part of the email before the @, capitalised (`sam.ortiz@…` is "Sam Ortiz"); the cast never sees the email address. |
| POST | `/api/auth/logout` | | `204` |

## Productions and script (director)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/productions` | | `{ productions: Production[] }` (not archived) |
| POST | `/api/productions` | `{ title, performanceStartsOn?, performanceEndsOn? }` | `{ production }`. Without `performanceEndsOn` the final date is the start date, or one year from today when neither is given. |
| GET | `/api/productions/:id` | | `{ production }` |
| PATCH | `/api/productions/:id` | `{ title?, performanceStartsOn?, performanceEndsOn? }` | `{ production }`. `performanceStartsOn: null` clears the start; `performanceEndsOn` can't be cleared. Changing the final date reschedules deletion. |
| POST | `/api/productions/:id/archive` | | `204`. Hides it and revokes its invites. Nothing is deleted then; content is still deleted on `contentDeletesOn`. |
| POST | `/api/productions/:id/script` | `multipart/form-data` with a `file` field (PDF, Word `.docx` or plain text, ≤ 20 MB; the type is detected from the bytes) **or** JSON `{ text }` | `202 { scriptStatus: "parsing" }`. Parsing runs in the background. Replacing a script with recordings is refused (409); a production whose content was deleted is 410 `content_deleted`. |
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

### Performance dates and validation

`performanceStartsOn` and `performanceEndsOn` are `YYYY-MM-DD` calendar dates. `POST` and `PATCH` return 400 `bad_request` (with a message to show as it is) when a date isn't real (`2026-02-30`), the start is after the final date, `performanceEndsOn` is `null` on `PATCH`, or a new final date is more than 6 days ago (UTC), so its deletion would be less than about 12 hours off. An unchanged final date is not re-checked. Once a production's content is due, changing its final date is 409 `content_due`.

### Content retention

**Deletion is irreversible.** At 12:00 UTC on `contentDeletesOn` (the final performance + 7 days) the server deletes the production's script content and recordings:

- Storage: everything under `productions/<id>/`: takes as uploaded, normalized FLACs and stream `.m4a`s, shared-line mixes, the uploaded script file and renders.
- Rows: scripts (with their raw text), sections, characters, lines, takes, renders, take mixes, practice runs and part assignments.
- Cast details: a cast member's name, first name and phone are cleared unless they left an email (`POST /api/invite/contact`); details tied to an email are kept, and so is a director's own cast row.
- Kept: the production row as an archived tombstone (title kept, `content_deleted_at` set), the actor rows (so their links answer 410 "This production has wrapped" instead of looking forged), notification records, and TTS clips, which are shared across productions by hash.

Cast and join links return 410 `invite_expired` afterwards, and the production drops out of `GET /api/productions`. The job is idempotent: a failure leaves `content_deleted_at` unset and the next pass finishes it. A take upload, normalization, mix, render or script upload that finishes after the deletion sweeps the folder again and fails (a take or script upload with 410 `content_deleted`).

## Cast (director)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/productions/:id/cast` | | `{ cast: CastMember[], uncastCharacterIds: string[] }` |
| POST | `/api/productions/:id/cast` | `{ name, email?, phone?, characterIds }` | `{ member: CastMember }` |
| PATCH | `/api/cast/:actorId` | `{ name?, email?, phone?, characterIds? }` | `{ member }` |
| POST | `/api/cast/:actorId/reset-link` | | `{ member }` with a new `inviteUrl`. The old link stops working. |
| POST | `/api/cast/:actorId/nudged` | | `{ member }`. Records that the director shared a reminder. The app sends nothing. |

Invite tokens are derived, not stored: `token = base64url(actorId bytes) + "." + tokenVersion + "." + HMAC-SHA256(INVITE_TOKEN_SECRET, actorId + ":" + tokenVersion)` truncated to 22 chars. Resetting bumps `tokenVersion`. They are valid until the production's content is deleted (12:00 UTC on `contentDeletesOn`; 120 days after creation if there is no final date), and revoked when the production is archived.

## Actor (invite token)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/invite` | | `{ production: { id, title, directorName }, actor: { id, name, firstName }, characters: { id, name }[], linesTotal, linesRecorded, hasEmail }`. Expired or revoked links return 410 with `{ error, directorName, productionTitle }`. |
| POST | `/api/invite/start` | `{ firstName }` | `204`. Sets `firstName` and `openedAt`. |
| GET | `/api/invite/lines` | | `{ sections: Section[], lines: ActorLine[] }` |
| PUT | `/api/invite/lines/:lineId/take` | raw audio body (`audio/webm`, `audio/mp4`, `audio/ogg`, `audio/wav`; ≤ 8 MB), headers `X-Take-Id` (client UUID, idempotency key) and `X-Duration-Ms` | `{ take: Take, linesRecorded, linesTotal }`. A repeated `X-Take-Id` returns the same take. The new take becomes current; old takes are kept until the production's content is deleted. |
| POST | `/api/invite/takes/:takeId/stt` | `{ transcript, accuracy, ops }` | `204` |
| POST | `/api/invite/contact` | `{ email }` | `204`. Email used only for the ready-to-listen-through email. |
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
- Output AAC in `.m4a` plus the `timing` array, stored with a content hash of (take IDs + line order + settings). Renders are kept until the production's content is deleted.
- When a render finishes with every cast line recorded, the notifications below fire.

## Notifications (Resend, completion only)

- To the director: "{firstName or name} finished all {n} lines" when an actor's last line lands, and "Cast complete — run-through ready" when the full-cast render finishes.
- To actors with an email: "The run-through for {title} is ready", linking to `${APP_URL}/i/{token}/play`.
- Each sends once (unique on kind + production + actor). With `EMAIL_DRIVER=log` emails are logged, not sent. Nothing ever emails invites or reminders.

## Web routes

- `/`: landing page with director sign-in.
- `/signin?next=`, `/auth/verify?token=&next=`: after signing in the app goes to `next` when it is a path inside `/app`, else to `/app`.
- `/app`: productions list (with none yet, it opens `/app/new`). `/app/new`. `/app/account`: email, name (what the cast calls you) and sign out. `/app/p/:id` (tabs: Script, Cast & progress, Run-through).
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

type AudioSource = "actor" | "director" | "tts" | "none"; // "director" was "standin" before 2026-10-20
// TimingEntry gains `source: AudioSource` (`recorded` stays: true for a cast member's or the director's take).
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
| GET | `/api/join/:token` | none | `{ production: { id, title, directorName }, characters: PartCard[] }` (see "Open parts" below), sorted by line count. 409 `script_not_ready` while parsing; 410 when archived; 404 for a bad or reset link. |
| POST | `/api/join/:token/claim` | none | `{ characterIds: string[], firstName }`, or `{ listen: true, firstName? }` for someone who only wants to listen through → `{ inviteToken, inviteUrl }`. Creates a cast member who has picked those characters (none for a listener), then the web app goes straight to `/i/<inviteToken>` (a listener to `/i/<inviteToken>/play`). Parts aren't owned: any part can be picked, however many others have picked it. Store the invite token per join link in localStorage, so reopening the cast link on the same device goes back to that actor's recording screen. |

## The director's takes and TTS

Until 2026-10-20 a director's take was a "stand-in" that never counted. Since then it is an ordinary take (see "Open parts" below); this section is updated to match.

- Every dialogue line always has audio in the run-through, in this order: the latest take (by anyone in the cast or the director), otherwise a TTS voice. Each character gets a consistent synthetic voice, and different characters get different voices where possible.
- The director (or anyone they share the director account with) can record a take for any line:
  - `PUT /api/lines/:lineId/take` (director auth): same body, headers and response as the actor take upload.
  - `GET /api/productions/:id/sections/:sectionId/lines` (director): `{ section, lines: { line: Line, characterName: string, take: Take \| null, audioSource: AudioSource, cue: ActorLine["cue"] }[] }` for recording a whole scene, partner by partner.
- Whoever records a line last makes the current take; older takes are kept.
- Takes carry `recordedBy: { kind: "actor" | "director", name }` and `mine` (see "Open parts").

### The director's takes and TTS: details as built

- The director's upload response's `linesRecorded`/`linesTotal` are production progress, counting every take.
- `ActorLine.take` is the actor's own latest take, never someone else's (that is `current`).
- A cue whose TTS clip is still being synthesized comes back with `audioUrl: null, audioSource: "none"` (the lines endpoints wait up to `TTS_CUE_WAIT_MS`, default 2.5 s); it fills in on the next fetch.
- `GET` run-through may queue a render (first open, or when stale with nothing queued).
- The director's takes count as recordings for the "script can't be replaced once recorded" rule.
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
  source: AudioSource;      // "actor" | "director" | "tts" | "none"
  ready: boolean;           // false while the clip is still being made: ask again
}

interface RunThrough {
  // ...as before, plus:
  sources: Record<string, AudioSource>; // each dialogue line's source, without making anything
}
```

- Source rules match the render: the current take's normalized audio (normalized on first use and cached with the render's normalized FLAC, as `takes.stream_key`), else the TTS clip (same voice and cache key as the render; every clip now gets its `.m4a` alongside the FLAC), else silence of `clamp(words × 380 ms, 1200, 8000)`.
- TTS synthesis runs by priority: play (a GET) before prefetch (`?prefetch=1`, warm, the actor lines page's cue wait) before cue warm-ups before the render. Background work (cues, renders) uses at most `TTS_CONCURRENCY - 1` slots, so a listener's line waits for at most one clip in progress. Concurrent requests for one clip share one synthesis, at the most urgent priority asked.
- The client plays gaps itself: 350 ms between lines in a section, 1200 ms at a section change.

### Run-through v2 (2026-10-15)

- Stage directions play too, read by the narrator: one reserved TTS voice (`NARRATOR_VOICE_ID`, VCTK p225) that no character is ever given. The line-audio GET and warm accept `stage_direction` line ids as well as dialogue (headings are still 404 / left out), and `RunThrough.sources` lists directions. A direction is spoken without its brackets; one with nothing to say comes back `{ audioUrl: null, durationMs: 0, source: "none" }`. Takes never apply to directions.
- `[Bracketed]` directions inside a dialogue line are not read at all: the character's TTS voice leaves them out (as before; an unclosed `[` now runs to the end of its line), and a recorded take is played as recorded.
- A GET with `?prefetch=1` now waits at most 8 s (a play GET still waits 20 s); the player asks for a prefetched line again from the next line instead of retrying.
- Takes are cut to their speech when normalized (`render/trim.ts`): leading and trailing silence and room noise go, with 120 ms kept before the first sound and 200 ms after the last; nothing inside the speech is cut. `LineAudio.durationMs` is the trimmed length. Takes normalized before this are trimmed again on first use (the normalized key now ends in `.t2.flac`/`.t2.m4a`), and `RENDER_SETTINGS.version` is 3, so renders made before are stale.

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
| GET | `/api/productions/:id/call-sheet` | director (own production) | `{ characters: { id, name, lineCount, linesRecorded, topRecorder: { name, others } \| null, mine: boolean }[], lines: { total, recorded } }`: every character with dialogue, biggest parts first. `lines` counts the script's dialogue lines once each (the production's `progress`); a shared line is under each part that says it, so the parts add up to more. Changed 2026-10-20, see "Open parts". |

- `POST /api/productions/:id/record-as` (the director's own cast member) was removed on 2026-10-20: the director records any part in its studio (`PUT /api/lines/:id/take`). Its old takes became director takes (migration `014_open_parts.sql`).

### Shared lines, deleting takes, studios and renaming (2026-10-17)

A line several characters say together ("ANGELO, ESCALUS", "ALL", "BOTH") is a **shared line**. Its character is a **group**: a character named after two or more others (by name or alias, split on `,` `&` `/` `+` `and`), or an ALL-style name (`ALL`, `BOTH`, `EVERYONE`, `OMNES`, `TOGETHER`, `ALL THREE`…). Groups are never parts: the call sheet and the cast link leave them out. `sync_shared_lines` (migration `011_shared_lines.sql`) recomputes groups and voices after any change to a production's characters or lines.

- `Character` gains `group: boolean`, `everyone: boolean` (ALL-style) and `memberIds: string[]` (a named group's characters, in order).
- `Line` gains `voiceIds: string[] | null`: who says a shared line, in order; null for a line of one voice (`characterId`). A named group's lines get its members. An ALL line first gets everyone who speaks in its scene, then Claude Haiku reads the scene (entrances, exits, who is addressed) and narrows it to who is on stage; a director's pick replaces either.
- `PATCH /api/lines/:id` takes `voiceIds`: two or more characters make (or reuse) the group named after them (`"HAMLET, QUEEN"`) and set the line's character to it; one makes it that character's line; on an ALL line the list replaces the guess, and `null` puts the guess back.
- Each voice is recorded separately. A take on a shared line records which character it voices (`takes.character_id`). The line plays every voice's current take mixed into one clip (`render/mix.ts`, cached in `take_mixes`), in line-by-line playback and the stitched render. Progress counts a shared line for each voice that has a take (anyone's); the production counts it once every voice is in.
- `GET /api/invite/lines` items gain `together: { characterId, characterName, audioUrl, audioSource }[]`: the others who say a shared line and their current takes (null `audioUrl` until recorded). `take` is the actor's own latest take.
- `PUT /api/lines/:id/take?characterId=` (director): on a shared line, the voice it records (default its first voice).

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| DELETE | `/api/invite/takes/:takeId` | invite (own takes) | `{ linesRecorded, linesTotal }`. Deletes the take: the line falls back to its newest remaining take, else TTS. 404 for someone else's take. |
| POST | `/api/invite/takes/:takeId/restore` | invite (own takes) | `{ linesRecorded, linesTotal }`. Undo for the delete. |
| DELETE | `/api/takes/:id` | director (own production) | 204. Deletes any take in the production, the director's or the cast's. |
| POST | `/api/takes/:id/restore` | director (own production) | 204. Undo. |
| PATCH | `/api/invite/me` | invite | `{ name }` → `{ actor: { id, name, firstName } }`. The actor fixes their name; `firstName` is its first word. |
| GET | `/api/productions/:id/characters/:characterId/lines` | director (own production) | `{ character: { id, name }, sections, lines: SectionLine[] }`: a character's studio, every line they say (shared ones too), each like a scene's line plus `together` and `voiceId` (set on shared lines). |

- Deleting a take only hides it (`takes.deleted_at`). Like every recording, its audio is kept, and restore brings it back.

### No script review (2026-10-17)

The parse is taken as read: there is no review step. Lines are saved unflagged, so `flagged` is always `false`, `flagCode` and `flagReason` are always `null` and `flaggedCount` is `0`. The fields, `POST /api/lines/:id/resolve` and the `flagged`/`flagCode`/`flagReason` inputs stay for compatibility. Migration `012_no_review.sql` cleared existing flags. The parser still works out flags internally (`flags.ts`); they are not stored.

### Taking over a part, picking up more, recording over placeholders (2026-10-17)

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/api/invite/parts` | invite | `{ parts: PartCard[] }`: every part the actor hasn't picked (no groups), most lines needing a voice first. Changed 2026-10-20, see "Open parts". |
| POST | `/api/invite/parts` | invite | `{ characterIds }` → `{ characters: { id, name }[] }` (all the actor's parts now). Never 409s since 2026-10-20; picking a part twice is harmless. |

- `GET /api/invite/lines` items gain `current`: what plays now on the line when it isn't the actor's own take. Its shape changed on 2026-10-20, see "Open parts". `take` is only the actor's own take, on every line.
- `POST /api/productions/:id/characters/:characterId/unassign` was removed on 2026-10-20: parts aren't owned, so there is nothing to take away.
- The recorder counts a line as done once it has any take (the actor's own, another cast member's or the director's), which the actor can record over; only the computer voice still needs them.
- Scoring leaves stage directions out of the words to say: anything in `[brackets]`, and a `(parenthesised)` direction that opens or closes the line.

### Long takes in parts (2026-10-18)

Takes have no practical length limit (the server refuses only past 65 minutes; the app stops a take left running for an hour). A take bigger than one request (8 MB) is sent as byte ranges of the same file: each request carries `X-Take-Parts: n` (2–12) and `X-Take-Part: i` (0-based), with the same `X-Take-Id`, `Content-Type` and `X-Duration-Ms`. Until every part is in, the answer is `{ partial: true, parts, missing: number[] }`; the request that completes it answers like a one-request upload. Parts wait in the server's temp folder (not storage) and are joined into the exact recorded file. A part sent after the take is saved returns the take. The web app sends takes over 6 MB in parts and resends any part reported missing.

### Open parts (2026-10-20)

Parts aren't owned. Anyone can pick any part (on the cast link or with "pick up more lines") and record any line, and the director's takes are ordinary takes. Picking a part only says what you mean to record; it never takes it from anyone. A cast member who opens the cast link on a new phone just picks their part again. Migration `014_open_parts.sql` drops the one-actor-per-character rule, renames stand-in takes to `recorded_by = 'director'` (and turns takes recorded through the old `record-as` cast member into director takes), and replaces `voice_take` with a three-argument version that counts every take.

```ts
interface RecordedBy {
  kind: "actor" | "director";
  name: string;            // a first name: the cast member's, or the director's as the cast sees it
}

// Every take object (Take) in GET /api/invite/lines, the director's section and character lines, and
// both take upload responses: `recordedBy` (was the string "actor" | "standin") and
mine: boolean;             // the caller recorded it: the invite's cast member, or the signed-in director

// GET /api/invite/lines `current`, when another person's take plays on the actor's line:
current: { source: "actor" | "director"; by: string; recordedBy: RecordedBy; mine: false; audioUrl: string } | null;

interface TopRecorder {
  name: string;            // whoever recorded the most of the part's lines (counting the takes that play now)
  others: number;          // how many other people recorded the rest; ties go to whoever recorded first
}

interface PartCard {       // GET /api/join/:token characters, GET /api/invite/parts parts
  id: string;
  name: string;
  lineCount: number;
  linesRecorded: number;   // lines with a take by anyone
  linesNeeded: number;     // lineCount - linesRecorded
  topRecorder: TopRecorder | null;
}

// GET /api/productions/:id/call-sheet characters:
{ id, name, lineCount, linesRecorded, topRecorder: TopRecorder | null, mine: boolean } // mine: the director recorded some of its lines
```

- Progress counts takes by anyone: a line is recorded once each voice has a take. That covers production and cast-member progress, the call sheet, the cast status, the actor-done email (sent once per cast member, whoever finished their lines) and cast completion (every part someone picked has a take for every line). TTS never counts.
- `AudioSource` (`LineAudio.source`, `RunThrough.sources`, render timing, cue and `together` `audioSource`): `"standin"` is now `"director"`.
- Removed: `POST /api/productions/:id/record-as`, `POST /api/productions/:id/characters/:characterId/unassign`, call sheet `takenBy`, `actorId` and `sharedLines`, join card `takenBy`, and the `character_taken` error.
- A personal link (`/i/:token`) whose token doesn't check out is 401 "This link doesn't work. Ask your director for the cast link."
