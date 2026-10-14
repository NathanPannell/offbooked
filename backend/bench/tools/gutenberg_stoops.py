"""Golden for She Stoops to Conquer (Penn State Electronic Classics PDF).

Usage: python -I gutenberg_stoops.py <pg383-images.html> <fixture_dir>

The Penn State Electronic Classics Series PDF was typeset from the Project
Gutenberg transcription (#383), so the golden is built from Gutenberg's HTML
of the same text and then checked against the PDF with verify.py.

Rules:
  - Garrick's prologue is performed text: its verse is one speech by
    "PROLOGUE" (the PDF prints the heading "PROLOGUE, BY DAVID GARRICK, ESQ."
    and "Enter Mr. Woodward ..."; there is no speaker cue). The entrance is a
    stage direction. The dedication to Johnson, the dramatis personae and the
    Gutenberg licence are front matter. The edition has no epilogue.
  - A speech is a <p> that starts with a known cue ("MRS. HARDCASTLE. ...";
    one cue lacks its period: "FIRST FELLOW Now, ...").
  - Parenthesised and bracketed text inside speeches is a stage direction
    ("(Aside.)", "[Exeunt.]"), removed and counted. Exception: "(ay, the
    hag)" is part of the letter Tony's mother reads aloud.
  - Other paragraphs are stage directions (entrances, "SCENE--...",
    "SONG."), one each. Tony's song (<pre> after "SONG.") and a paragraph
    that starts with a direction and goes on speaking continue the previous
    speech.
  - Typography is kept: the PDF's text layer has the same em dashes and
    curly quotes as Gutenberg's HTML (pdftotext's ASCII output is misleading).
  - Sections: acts only (scene changes inside acts are unnumbered "SCENE
    changes." directions).
"""
import os
import re
import sys

from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from benchlib import GoldenBuilder, collapse, strip_bracketed  # noqa: E402

CUES = [
    "MARLOW", "HARDCASTLE", "HASTINGS", "TONY", "MISS HARDCASTLE", "MRS. HARDCASTLE",
    "MISS NEVILLE", "SIR CHARLES", "DIGGORY", "LANDLORD", "SERVANT", "MAID", "OMNES",
    "FIRST FELLOW", "SECOND FELLOW", "THIRD FELLOW", "FOURTH FELLOW", "FIRST SERVANT",
    "SECOND SERVANT", "THIRD SERVANT", "ROGER", "JEREMY",
]
CUE_RE = re.compile(
    r"^(" + "|".join(re.escape(c) for c in sorted(CUES, key=len, reverse=True)) + r")(\.?) (.*)$", re.S
)
ACTS = {"FIRST": "1", "SECOND": "2", "THIRD": "3", "FOURTH": "4", "FIFTH": "5"}
KEEP = "(ay, the hag)"
KEEP_TOKEN = "KEEPSPOKENPARENTHESIS"  # shields KEEP from the parenthesis rule


def clean(text: str) -> tuple[str, int]:
    text = text.replace(KEEP, KEEP_TOKEN)
    text, n1 = strip_bracketed(text)
    text, n2 = strip_bracketed(text, "(", ")")
    return text.replace(KEEP_TOKEN, KEEP), n1 + n2


def main() -> None:
    html, fixture = sys.argv[1], sys.argv[2]
    soup = BeautifulSoup(open(html, encoding="utf-8").read(), "lxml")
    gb = GoldenBuilder("She Stoops to Conquer")
    started = False
    prologue = False
    for el in soup.body.find_all(["h2", "p", "pre"]):
        if el.find_parent(["header", "footer"]):
            continue
        if el.name == "h2":
            words = collapse(el.get_text(" ")).rstrip(".,").split()
            prologue = words == ["PROLOGUE"]
            if words[:2] == ["ACT", "THE"]:
                started = True
                gb.section(act=ACTS[words[2]])
            elif started:
                break
            continue
        if prologue:
            if el.name == "pre":
                gb.speech("PROLOGUE", el.get_text())
            elif collapse(el.get_text()).startswith("Enter"):
                gb.stage()
            continue
        if not started:
            continue
        if el.name == "pre":
            gb.merge_into_previous(el.get_text())
            continue
        text = collapse(el.get_text(" "))
        if not text:
            continue
        m = CUE_RE.match(text)
        if m:
            body, n = clean(m.group(3))
            gb.stage(n)
            gb.speech(m.group(1), body, cue=m.group(1) + m.group(2))
            continue
        body, n = clean(text)
        if body and n:
            gb.stage(n)
            gb.merge_into_previous(body)
        else:
            gb.stage(max(n, 1))
    gb.write(fixture)


if __name__ == "__main__":
    main()
