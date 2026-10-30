# Goals

What Offbooked is working towards right now. A daily status routine reads this file from `origin/staging`, so keep it current: tick a goal off in the same PR as the work that finishes it, and add new goals here.

- Code features live in GitHub issues. Each goal links its issues instead of copying them.
- Non-code goals (accounts, store listings, sales) are tracked here as checklists.
- Each goal says who it's waiting on: **Nathan** (needs his accounts, money or a decision) or **agent**.

_Last reviewed: 2026-10-30._

## 1. The mobile app in both stores

The iOS app is built on GitHub's macOS runners (`docs/mobile.md`); there is no Android app yet.

- [ ] Apple Developer Program enrollment. **Nathan.**
- [ ] App Store Connect app record and the TestFlight secrets listed in `docs/mobile.md`. **Nathan.**
- [ ] First TestFlight build, real-device check, then App Review. **Agent**, after the secrets.
- [ ] Android app on Google Play: #102.
- [ ] Store listings (both stores): screenshots, description, privacy details. **Agent** drafts, **Nathan** enters.

## 2. Billing with Stripe

Pricing (decided 2026-10-25): Show Pass C$79 per production, Season C$249/yr for up to 3 productions, founder rate 50% off for life. One free trial production per director, locked 14 days after creation unless paid. The cast is always free.

- [ ] Stripe account set up and verified. **Nathan.**
- [ ] Stripe Checkout, plans and the trial lock: #69.
- [x] Landing FAQ and pricing page show the real prices (C$79 and C$249, founder C$39 and C$125, in `web/src/routes/landing/content.ts`).
- [ ] Going live with payments. **Nathan** approves.

## 3. Customers: sell the product

Target: Victoria productions and drama programs first, then post the wins on LinkedIn.

- [ ] A list of 20 Victoria-area productions, community theatres and school drama programs with a contact for each.
- [ ] Outreach message and a "send this to your director" link on the landing page.
- [ ] A real cast recording of Macbeth 2.2 by local actors for the landing demo.
- [ ] First paying production.
- [ ] LinkedIn post about the first production that used it.

## Product polish in flight

- Playback: #96, #97, #98.
- First-recording speed target: #26.
