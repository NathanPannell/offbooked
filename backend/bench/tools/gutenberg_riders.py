"""Golden for Project Gutenberg #994, Riders to the Sea (plain-text fixture).

Usage: python -I gutenberg_riders.py <pg994-images.html> <fixture_dir>

Built from Gutenberg's HTML of the same release as source.txt. Rules:
  - The play starts after the "SCENE." heading; O'Brien's introduction, the
    contents, title block and PERSONS/first-cast list are front matter.
  - The opening setting paragraph and every [bracketed] paragraph are stage
    directions (one each).
  - A speech is a <p> whose first line is the cue ("NORA."). Every italic run
    inside a speech is a direction: a leading delivery note ("_In a low
    voice._--") or a bracketed one ("[_To Nora_]"). They are removed, with
    their brackets and the em dash that follows a delivery note, and counted.
  - A paragraph without a cue after a direction continues the previous
    speech ("Shall I open it now?").
  - sections = [] (one act, no scene divisions).
"""
import os
import re
import sys

from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from benchlib import MARK, GoldenBuilder, collapse  # noqa: E402

CUE = re.compile(r"^([A-Z][A-Z ]+)\.$")


def speech_text(nodes_html: str) -> tuple[str, int]:
    frag = BeautifulSoup(nodes_html, "lxml")
    count = 0
    for i in frag.find_all("i"):
        i.replace_with(MARK)
        count += 1
    text = frag.get_text()
    text = re.sub(r"\[\s*" + MARK + r"\s*\]", MARK, text)
    text = re.sub(MARK + r"\s*—", MARK, text)
    text = re.sub(r"\s*" + MARK + r"\s*(?=[,.;:!?])", "", text)
    text = text.replace(MARK, " ")
    return collapse(text), count


def main() -> None:
    html, fixture = sys.argv[1], sys.argv[2]
    soup = BeautifulSoup(open(html, encoding="utf-8").read(), "lxml")
    start = next(h for h in soup.find_all("h3") if collapse(h.get_text()) == "SCENE.")
    gb = GoldenBuilder("Riders to the Sea")
    for el in start.find_all_next(["p", "pre"]):
        if el.find_parent("footer"):
            break
        if el.name == "pre" or not collapse(el.get_text()):
            continue
        parts = re.split(r"<br\s*/?>", el.decode_contents(), maxsplit=1)
        first = collapse(BeautifulSoup(parts[0], "lxml").get_text())
        m = CUE.match(first)
        if m and len(parts) == 2:
            text, n = speech_text(parts[1])
            gb.stage(n)
            gb.speech(m.group(1), text, cue=first)
            continue
        whole = collapse(el.get_text())
        if whole.startswith("[") or "right" in (el.get("class") or []) or not gb.speeches:
            gb.stage()
        else:
            text, n = speech_text(el.decode_contents())
            gb.stage(n)
            gb.merge_into_previous(text)
    gb.write(fixture)


if __name__ == "__main__":
    main()
