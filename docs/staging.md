# Staging

https://staging.offbooked.com is where the owner checks frontend changes before they go to production. It is the web app (`web/`) only. There is no staging backend yet: **staging calls the production API and database.**

## Approval flow

1. A change is delivered as usual: a PR into `staging`, the local gate green, squash-merged (see "Delivery" in `AGENTS.md`).
2. Vercel builds the merge commit and serves it at https://staging.offbooked.com, usually within two or three minutes.
3. The `Staging web` workflow (`.github/workflows/staging-web.yml`) runs on the same push. It waits until `https://staging.offbooked.com/revision.txt` is the merge commit, loads `/`, `/privacy`, `/terms`, `/signin` and `/app`, checks the `noindex` header, and checks the API answers a preflight from the staging origin. The deliver pipeline's post-merge step is this run (for the latest `staging` commit; a newer merge cancels an older run) passing and the site loading. Until the production API is deployed with the staging origin in `CORS_ORIGINS` (staged on Railway without a deploy on 2026-10-27), the API check fails on every run; the rest still shows whether the build went live.
4. The owner tries the change on staging, on a desktop and a phone.
5. Only when the owner asks, a PR from `staging` to `main` is opened, the full CI gate runs, and it is merged with the owner's approval. A push to `main` deploys production (web on Vercel, the backend on Railway when `backend/` changed).

Everything on `staging` goes out together in that release, so check every change merged since the last release, not only the newest.

## What staging touches

The staging build's `VITE_API_URL` is `https://api.offbooked.com`, the production backend. So on staging:

- Signing in sends a real email and creates a real session for a real account. The link lands back on staging because production lists `https://staging.offbooked.com` in `EXTRA_APP_URLS`.
- Setting up a production, uploading a script, recording takes and joining a cast write to the production database and storage, and count toward production rate limits and Claude usage.
- Cast and join links shown on staging point at https://offbooked.com (the backend builds them from `APP_URL`).

Use a test director account and a test production, and archive it when done. Don't share staging links with real casts.

Staging is public but unlisted: Vercel's deployment protection skips custom domains, and every response there carries `X-Robots-Tag: noindex, nofollow`.

## How it is set up

| Piece | Where |
| --- | --- |
| Branch deploys | `web/vercel.json`: `git.deploymentEnabled` allows `main` and `staging`; `ignoreCommand` builds only those two |
| Domain | Vercel project `offbooked`, domain `staging.offbooked.com` tied to git branch `staging` |
| DNS and TLS | Vercel DNS: the `*` ALIAS record covers the subdomain; Vercel issues the certificate |
| API URL | Vercel env `VITE_API_URL`, target Preview, git branch `staging` |
| Backend | Railway `production`: `CORS_ORIGINS` and `EXTRA_APP_URLS` include `https://staging.offbooked.com` |
| Check | `.github/workflows/staging-web.yml`, no secrets |

## Swapping in a staging backend

1. Clone the Railway service into a `staging` environment, on its own Neon branch that scales to zero (no health check or poll that touches the database). `AGENTS.md` allows only `production`, `dev` and `dev-<head branch>` today, so add a long-lived `staging` branch to that rule first.
2. Give it `APP_URL=https://staging.offbooked.com` and `CORS_ORIGINS=https://staging.offbooked.com`.
3. Change `VITE_API_URL` (Preview, branch `staging`) on Vercel to its URL, and the `API` value in `staging-web.yml`.
4. Redeploy `staging` on Vercel, and take `https://staging.offbooked.com` out of production's `CORS_ORIGINS` and `EXTRA_APP_URLS`.
