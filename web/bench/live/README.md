# Live tracking fixtures

`src/stt/fixtures/live-takes.json` holds the takes that `src/stt/liveReplay.test.ts` replays through the live logic (`src/stt/replay.ts`) to count false ends and measure how soon after the last word a hands-free take ends. Each take is a spoken line with its 20 ms mic levels and every pass the speech model made over it, paced and windowed as `useLiveTake` paces them, at desktop speed and with latencies 3× and 5× longer.

Re-record them when the pass schedule or the model changes (not when only the matching or the pauses change: the replay covers those):

1. Speak the lines (Windows, SAPI voices): `powershell -File bench/live/make-live-tts.ps1 -Out <workspace>/.claude/tmp/live/spoken`
2. Make the takes: `node bench/live/make-live-fixtures.mjs <workspace>/.claude/tmp/live/spoken <workspace>/.claude/tmp/live/takes`
3. With `npm run dev` running, run the model over them: `node bench/live/record-passes.mjs <workspace>/.claude/tmp/live/takes src/stt/fixtures/live-takes.json 1,3,5`, then `npx prettier --write src/stt/fixtures`
4. `REPLAY_REPORT=1 npx vitest run src/stt/liveReplay.test.ts --silent=false` prints every take.

Keep the audio out of the repo; only the levels and passes are committed.
