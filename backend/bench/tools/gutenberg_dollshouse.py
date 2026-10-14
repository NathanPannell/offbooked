"""Golden for A Doll's House (Project Gutenberg #2542, tr. R. Farquharson Sharp).

Usage: python -I gutenberg_dollshouse.py <pg2542-images.html> <fixture_dir>

source.docx is Gutenberg's HTML of the same release opened in Microsoft Word
and saved as .docx (word_convert.ps1), so it still carries the Gutenberg
header, contents, dramatis personae and licence. The golden is built from
the same HTML:
  - Only <div class="chapter"> blocks headed "ACT I/II/III" are used.
  - A speech is a <p class="drama"> whose first line is the cue ("NORA.",
    "DOCTOR RANK." is an alias of RANK, "THE CHILDREN." of CHILDREN).
  - [Bracketed] text is a direction: removed from speeches and counted.
    A direction paragraph whose bracket closes in the next paragraph (the
    opening scene description) counts once.
  - sections: acts only.
"""
import os
import re
import sys

from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from benchlib import ORDINALS, GoldenBuilder, collapse, strip_bracketed  # noqa: E402

CUE = re.compile(r"^([A-Z][A-Z .]+?)\.$")
ALIASES = {"DOCTOR RANK": "RANK", "THE CHILDREN": "CHILDREN"}


def main() -> None:
    html, fixture = sys.argv[1], sys.argv[2]
    soup = BeautifulSoup(open(html, encoding="utf-8").read(), "lxml")
    gb = GoldenBuilder("A Doll's House")
    for div in soup.select("div.chapter"):
        head = collapse(div.h2.get_text(" "))
        if not head.startswith("ACT "):
            continue
        gb.section(act=ORDINALS[head.split()[1]])
        open_bracket = False
        for el in div.find_all("p", recursive=False):
            for br in el.find_all("br"):
                br.replace_with("\n")
            raw = el.get_text().strip()
            lines = raw.split("\n")
            m = CUE.match(lines[0].strip())
            if "drama" in (el.get("class") or []) and m:
                text, n = strip_bracketed(" ".join(lines[1:]))
                gb.stage(n)
                cue = m.group(1)
                gb.speech(ALIASES.get(cue, cue), text, cue=cue)
                continue
            text = collapse(raw)
            if open_bracket:
                open_bracket = "]" not in text
                continue  # second half of a direction already counted
            if text.startswith("[") and "]" not in text:
                open_bracket = True
                gb.stage()
                continue
            rest, n = strip_bracketed(text)
            if rest and gb.speeches:
                gb.stage(n)
                gb.merge_into_previous(rest)
            else:
                gb.stage(max(n, 1))
    gb.write(fixture)


if __name__ == "__main__":
    main()
