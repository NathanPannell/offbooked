"""Golden for Project Gutenberg #844, The Importance of Being Earnest.

Usage: python -I gutenberg_earnest.py <pg844-images.html> <fixture_dir>

Built from Gutenberg's HTML edition of the same release as the plain-text
source (same transcription, same line content). In the HTML every speech is
a <p> whose first line is the cue ("ALGERNON.<br>"); two cues are written
"GWENDOLEN and CECILY [Speaking together.]". Bracketed text is a stage
direction: removed from speeches and counted. A paragraph that is not a cue
is a stage direction (setting, entrances, "ACT DROP", "TABLEAU"), except
"[Enter ...] He does!" style paragraphs whose trailing words continue the
previous speech. Only <div class="chapter"> (the three acts) is used, so the
cast list, first-cast list and Gutenberg licence are excluded.
"""
import os
import re
import sys

from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from benchlib import ORDINALS, GoldenBuilder, collapse, strip_bracketed  # noqa: E402

CUE = re.compile(r"^([A-Z][A-Z .’']+?)\.$")
TOGETHER = re.compile(r"^([A-Z]+ and [A-Z]+) (\[Speaking together\.\])(.*)$", re.S)


def main() -> None:
    html, fixture = sys.argv[1], sys.argv[2]
    soup = BeautifulSoup(open(html, encoding="utf-8").read(), "lxml")
    gb = GoldenBuilder("The Importance of Being Earnest")
    for div in soup.select("div.chapter"):
        act = ORDINALS[div.h2.get_text(" ", strip=True).split()[0]]
        gb.section(act=act)
        for el in div.find_all(["p", "h3"], recursive=False):
            if el.name == "h3":
                continue  # "SCENE" heading
            for br in el.find_all("br"):
                br.replace_with("\n")
            raw = el.get_text()
            lines = raw.strip().split("\n")
            m = CUE.match(lines[0].strip())
            if m:
                text, n = strip_bracketed(" ".join(lines[1:]))
                gb.stage(n)
                gb.speech(m.group(1), text, cue=m.group(1) + ".")
                continue
            t = TOGETHER.match(collapse(raw))
            if t:
                text, n = strip_bracketed(t.group(2) + t.group(3))
                gb.stage(n)
                gb.speech(t.group(1), text)
                continue
            text, n = strip_bracketed(collapse(raw))
            if text and n:
                # direction followed by more of the previous speaker's words
                gb.stage(n)
                gb.merge_into_previous(text)
            else:
                gb.stage(max(n, 1))
    gb.write(fixture)


if __name__ == "__main__":
    main()
