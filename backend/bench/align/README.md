# Aligner bench

Measures the server's word alignment (`src/align/`) on takes shaped like hands-free recordings, with
the truth known word by word. The fixtures are made on Windows (SAPI's two English voices); the
audio isn't kept in the repository.

```bash
cd backend
# 1. Speak the utterances (Windows; each word's position comes from SAPI's own progress events).
node bench/align/specs.mjs <work>/specs.json
powershell -NoProfile -ExecutionPolicy Bypass -File bench/align/say.ps1 -Specs <work>/specs.json -Out <work>/spoken
# 2. Build the takes: room noise and breaths around each line, plain, with a beat, a cue read aloud
#    before it, an "um" before it, a restart, an "Okay." after it; takes of the wrong line; one of no
#    speech. --noisy also writes <work>/takes-noisy (heavy room noise, echo, 24 kb/s Opus).
node bench/align/make-takes.mjs <work>/spoken <work>/takes --noisy
# 3. Score it (the model from the Dockerfile's ALIGN_REV; see AGENTS.md). --before compares an older
#    backend/src that still has realign.ts (e.g. `git archive 515cd0e backend/src`), fed the phone's
#    word starts on time and late, and its loudness cut.
node bench/align/run.mjs <work>/takes --model <model_q4.onnx> --before <old>/backend/src
```

`run.mjs` prints, per scenario, how much each cut keeps before the line's first word and after its
last (negative: speech clipped), the word start error (median/p90/max), how many lines were found
and how many takes of another line or of none were wrongly "found", and the model's time per second
of audio. The results as of 2026-10-25 are in the pull request that added the aligner.
