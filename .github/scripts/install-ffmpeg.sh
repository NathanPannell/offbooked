#!/usr/bin/env bash
# Puts ffmpeg and ffprobe on PATH for a CI job: from the actions/cache copy in ~/ffmpeg when there is
# one, else the pinned static builds from $FFMPEG_RELEASE, each checked against its SHA-256 and
# retried with backoff. Only if that keeps failing, Ubuntu's own package.
set -euo pipefail
dir="$HOME/ffmpeg"

fetch() { # name, sha256
  local gz="$RUNNER_TEMP/$1-linux-x64.gz"
  for attempt in 1 2 3; do
    if curl -fsSL --retry 2 --retry-all-errors --max-time 120 -o "$gz" "$FFMPEG_RELEASE/$1-linux-x64.gz" && echo "$2  $gz" | sha256sum -c --quiet -; then
      gunzip -c "$gz" > "$dir/$1" && chmod +x "$dir/$1"
      return 0
    fi
    echo "Attempt $attempt for $1: got $(stat -c %s "$gz" 2>/dev/null || echo 0) bytes, not the pinned build."
    sleep $((attempt * 10))
  done
  return 1
}

if [ ! -x "$dir/ffmpeg" ] || [ ! -x "$dir/ffprobe" ]; then
  mkdir -p "$dir"
  fetch ffmpeg "$FFMPEG_SHA256" && fetch ffprobe "$FFPROBE_SHA256" || rm -f "$dir/ffmpeg" "$dir/ffprobe"
fi
if [ -x "$dir/ffmpeg" ] && [ -x "$dir/ffprobe" ]; then
  sudo ln -sf "$dir/ffmpeg" /usr/local/bin/ffmpeg
  sudo ln -sf "$dir/ffprobe" /usr/local/bin/ffprobe
else
  echo "::warning::The pinned ffmpeg builds couldn't be fetched; installing Ubuntu's package instead."
  sudo apt-get update && sudo apt-get install -y --no-install-recommends ffmpeg
fi
ffmpeg -hide_banner -version | head -1
