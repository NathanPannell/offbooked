"""Download one file into a fresh, empty directory and record where it came from.

Usage:
  python -I fetch.py <url> <downloads-root> <name>

Creates <downloads-root>/<name>/ (refuses if it already exists and is non-empty),
saves the response body there under the URL's final file name, and writes
download.json with the URL, final URL, size and sha256. Nothing downloaded is
ever executed or imported.
"""
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

UA = "offbooked-bench/1.0"  # generic; never put personal identifiers in requests


def main() -> None:
    url, root, name = sys.argv[1], sys.argv[2], sys.argv[3]
    out = os.path.join(root, name)
    if os.path.isdir(out) and os.listdir(out):
        sys.exit(f"refusing: {out} exists and is not empty")
    os.makedirs(out, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as resp:
        final = resp.geturl()
        body = resp.read()
    fname = os.path.basename(urllib.parse.urlparse(final).path) or "download.bin"
    fname = urllib.parse.unquote(fname)
    if len(sys.argv) > 4:
        fname = sys.argv[4]
    path = os.path.join(out, fname)
    with open(path, "wb") as f:
        f.write(body)
    meta = {
        "url": url,
        "finalUrl": final,
        "file": fname,
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(os.path.join(out, "download.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
