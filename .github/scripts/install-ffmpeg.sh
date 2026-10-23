#!/usr/bin/env bash
# Puts ffmpeg and ffprobe on PATH for a CI job: from the actions/cache copy in ~/ffmpeg when there is
# one, else the pinned static build ($FFMPEG_URL), checked against $FFMPEG_SHA256 and retried with
# backoff (the host sometimes answers a runner with something else). Only if that keeps failing,
# Ubuntu's own package.
set -euo pipefail
dir="$HOME/ffmpeg"
if [ ! -x "$dir/ffmpeg" ] || [ ! -x "$dir/ffprobe" ]; then
  mkdir -p "$dir"
  archive="$RUNNER_TEMP/ffmpeg.tar.xz"
  for attempt in 1 2 3 4; do
    if curl -fsSL --retry 2 --retry-all-errors --max-time 120 -o "$archive" "$FFMPEG_URL" && echo "$FFMPEG_SHA256  $archive" | sha256sum -c --quiet -; then
      tar -xJf "$archive" -C "$dir" --strip-components=1 --wildcards '*/ffmpeg' '*/ffprobe'
      break
    fi
    echo "Attempt $attempt: got $(stat -c %s "$archive" 2>/dev/null || echo 0) bytes ($(file -b "$archive" 2>/dev/null || echo nothing)), not the pinned build."
    head -c 300 "$archive" 2>/dev/null | tr -c '[:print:]\n' '?' || true
    echo
    sleep $((attempt * 15))
  done
fi
if [ -x "$dir/ffmpeg" ] && [ -x "$dir/ffprobe" ]; then
  sudo ln -sf "$dir/ffmpeg" /usr/local/bin/ffmpeg
  sudo ln -sf "$dir/ffprobe" /usr/local/bin/ffprobe
else
  echo "::warning::The pinned ffmpeg build couldn't be fetched; installing Ubuntu's package instead."
  rm -rf "$dir"
  sudo apt-get update && sudo apt-get install -y --no-install-recommends ffmpeg
fi
ffmpeg -hide_banner -version | head -1
