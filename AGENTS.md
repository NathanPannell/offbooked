# Offbooked

Remote line recording and run-through playback for theatre casts. A director uploads a script, shares one link per actor, each actor records their lines on their phone, and the server stitches everything into a lyrics-style run-through. The MVP backlog is in GitHub issues; #1 lists every credential and decision.

## Layout

- `backend/`: Node 24 + Fastify API and, later, the ffmpeg render worker. TypeScript runs through Node's type stripping, so there is no build step. `tsc` is for typechecking only.
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

## Backend hosting (Railway)

- Workspace `eee14ab1-1ec2-442b-a659-9af6d97ba0c2`, project `offbooked` (`08b6cf6f-a52b-441d-81f2-bdb5621029df`).
- Environment `production` (`409aeebb-d5ed-4e8c-ae02-fb6403bb81d1`), service `api` (`63b9f8b1-d6d8-4ae6-8b4f-85ce3830259a`).
- URL: https://api-production-c2bf5.up.railway.app
- The service has no Railway Git integration. Deploys run from GitHub Actions on push to `main` with `railway up`. The workflow sets `APP_REVISION` to the commit and waits until `/health` reports it.
- GitHub environment `production` holds the secret `RAILWAY_API_TOKEN` (the workspace token from the Windows user environment) and the variables `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`, `API_URL`.
- To deploy by hand, run `railway up --ci -p <project> -e <environment> -s <service>` with `RAILWAY_API_TOKEN` set from the Windows user environment. Never print the token.

## Product rules that shape the code

- Actor invite links are shared by the director (copy link or the native share sheet). The app does not email or text invites or reminders.
- Email (Resend) is only for completion notifications: an actor finished all their lines, the cast is complete, the run-through is ready.
- Recordings are kept forever for now. Nothing deletes audio objects, including re-records and production deletion.
- Actors have no accounts. Their invite token is their only credential and is scoped to their own lines plus cue context.
