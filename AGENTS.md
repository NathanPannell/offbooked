# Offbooked

Remote line recording and run-through playback for theatre casts. A director uploads a script, shares one link per actor, each actor records their lines on their phone, and the server stitches everything into a lyrics-style run-through. The MVP backlog is in GitHub issues; #1 lists every credential and decision.

## Layout

- `backend/`: Node 24 + Fastify API and, later, the ffmpeg render worker. TypeScript runs through Node's type stripping, so there is no build step. `tsc` is for typechecking only.
- `web/`: the Vite + React app at offbooked.com (landing, director app, actor recording, run-through player, on-device accuracy check). See "Web" below.
- `railway.json`: Railway build and health check config for the backend.
- `.github/workflows/`: `ci.yml` (typecheck and tests), `deploy-backend.yml` (deploys `main` to Railway).

## Commands

```bash
cd backend
npm install
npm run dev        # http://localhost:8080/health
npm test
npm run typecheck
```

`/health` returns 503 when ffmpeg is not on `PATH`, so locally it is only 200 if ffmpeg is installed.

## Backend

- Contract: `docs/api.md`. Code: `src/routes/*` (HTTP), `src/parse/*` (PDF text, heuristic parser, Claude chunks, validation), `src/render/*` (ffmpeg pipeline and in-process queue), `src/storage/*` (`local` or `s3`), `src/email/*` (Resend or log). SQL migrations live in `backend/migrations/NNN_name.sql` and run at startup.
- Scripts: `npm run dev` (loads `backend/.env`), `npm test` (DB tests run in a throwaway schema on `DATABASE_URL` and are skipped without it), `npm run typecheck`, `npm run seed` (demo director `director@example.test`, Hamlet 1.2, four actors, tone takes and a render; prints the sign-in link and invite URLs; `npm run seed -- --reset` archives the old demo and makes a new one).
- Env: `DATABASE_URL`, `SESSION_SECRET`, `INVITE_TOKEN_SECRET` (required); `APP_URL`, `API_URL` (base for local file URLs and the email unsubscribe link), `CORS_ORIGINS` (comma list, `*` matches one host label); `ANTHROPIC_API_KEY` (optional; without it the heuristic parser is used); `EMAIL_DRIVER` (`log` or `resend`, defaults to `resend` when `RESEND_API_KEY` is set), `RESEND_API_KEY`, `EMAIL_FROM`; `STORAGE_DRIVER` (`local` with `STORAGE_DIR`, or `s3` with `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`); `RENDER_DEBOUNCE_MS` (default 15000); `PORT`, `APP_REVISION`.
- Script parsing uses Claude Haiku only (`PARSE_MODEL = "claude-haiku-5-5"` in `src/parse/llm.ts`), in chunks of about 12,000 characters. Never switch to a larger model. A chunk whose output fails validation is retried once with Haiku, then parsed by the heuristic parser with its lines flagged.
- Neon ignores a plain `search_path` startup parameter; `createSql` passes it through `options` instead.

## Backend hosting (Railway)

- Workspace `eee14ab1-1ec2-442b-a659-9af6d97ba0c2`, project `offbooked` (`08b6cf6f-a52b-441d-81f2-bdb5621029df`).
- Environment `production` (`409aeebb-d5ed-4e8c-ae02-fb6403bb81d1`), service `api` (`63b9f8b1-d6d8-4ae6-8b4f-85ce3830259a`).
- URL: https://api.offbooked.com (custom domain, CNAME in Vercel DNS). Railway's own URL https://api-production-c2bf5.up.railway.app also works.
- The service has no Railway Git integration. Deploys run from GitHub Actions on push to `main` with `railway up`. The workflow sets `APP_REVISION` to the commit and waits until `/health` reports it.
- GitHub environment `production` holds the secret `RAILWAY_API_TOKEN` (the workspace token from the Windows user environment) and the variables `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`, `API_URL`.
- To deploy by hand, run `railway up --ci -p <project> -e <environment> -s <service>` with `RAILWAY_API_TOKEN` set from the Windows user environment. Never print the token.

## Web hosting (Vercel) and DNS

- `offbooked.com` was bought through Vercel and uses Vercel DNS, in team `nathanpannells-projects` (`team_CJ0RWNsNJK6vDQy2raakV6cZ`). The Vercel MCP connector cannot see this team; use `VERCEL_TOKEN` from the Windows user environment.
- Vercel project `offbooked` (`prj_6C9NIcC5InImQXSAZWflMJhYFJYx`), root directory `web`, Git-linked to this repo. A push to `main` deploys production; PR branches get preview deployments.
- Domains: `offbooked.com` (production), `www.offbooked.com` redirects to it with a 308.
- DNS records for the backend: `api` CNAME to Railway's target and the `_railway-verify.api` TXT record. Don't remove them.

## Web

Vite + React 19 + TypeScript + React Router in `web/`, plain CSS with tokens in `src/styles/tokens.css`. Code against `docs/api.md` through the typed client in `src/api/`.

```bash
cd web
npm install
npm run dev        # http://localhost:5173, API at VITE_API_URL
npm test           # Vitest: scoring, timing map, upload queue, browser detection
npm run typecheck
npm run build      # tsc, then vite build to dist/ (what Vercel runs)
```

- Env: `VITE_API_URL` (dev default `http://localhost:8080`, production builds default to `https://api.offbooked.com`). `VITE_STT_MODEL` picks the on-device speech model: `moonshine-tiny` (default), `whisper-tiny.en`, or `off`.
- Routes: `/` landing, `/signin`, `/auth/verify?token=`, `/app` productions, `/app/new`, `/app/p/:id?tab=script|cast|play`, `/i/:token` actor welcome, recording and wrapped, `/i/:token/play` run-through (`?mode=mine` opens my-part mode).
- The director session token lives in localStorage (`offbooked.session`). Actor calls use the token from the URL.
- Takes are written to IndexedDB before upload and retried with backoff (`src/upload/`), keyed by a client UUID sent as `X-Take-Id`.
- On-device accuracy (`src/stt/`, see `docs/on-device-stt.md`): transformers.js runs in a module worker that is created only after the first take uploads, and is disposed when the recording or practice screen closes. No COOP/COEP headers.
- `web/vercel.json` rewrites every non-asset path to `index.html`. The mic is only requested from a record tap, never on load.

## Product rules that shape the code

- Actor invite links are shared by the director (copy link or the native share sheet). The app does not email or text invites or reminders.
- Email (Resend) is only for completion notifications: an actor finished all their lines, the cast is complete, the run-through is ready.
- Recordings are kept forever for now. Nothing deletes audio objects, including re-records and production deletion.
- Actors have no accounts. Their invite token is their only credential and is scoped to their own lines plus cue context.
