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
  flagged: boolean; flagReason: string | null;   // parser uncertainty, shown in the review UI
}
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
| POST | `/api/lines/:id/split` | `{ at }` (character offset) | `{ lines: [Line, Line] }` |
| POST | `/api/lines/:id/merge-next` | | `{ line }` |
| POST | `/api/lines/:id/section-break` | `{ title, act?, scene? }` | `{ sections }`. Starts a new section at this line. |
| PATCH | `/api/sections/:id` | `{ title }` | `{ section }` |
| POST | `/api/productions/:id/characters` | `{ name }` | `{ character }` |
| PATCH | `/api/characters/:id` | `{ name }` | `{ character }` |
| POST | `/api/characters/:id/merge` | `{ intoId }` | `{ characters }`. Moves lines and aliases to `intoId`, removes this one. |
| POST | `/api/lines/:id/resolve` | | `{ line }`. Clears `flagged`. |

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
  render: Render;
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
