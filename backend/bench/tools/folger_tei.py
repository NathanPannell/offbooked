"""Build golden.json from a Folger Shakespeare TEI XML file.

Usage:
  python -I folger_tei.py <play.xml> <fixture_dir> [--straight-quotes]

Rules (Folger TEI, "Text released without textual notes"):
  - Only <body> is used; <front> (director's note, textual introduction,
    synopsis) and the cast list in the header are front matter.
  - One speech per <sp>. Cue = the <speaker> text as printed (w/c/pc text, so
    "BARNARDO/MARCELLUS" and "FIRST PLAYER" stay as written). An <sp> without
    a <speaker> (an offstage noise quoted inside a stage direction) is not a
    speech.
  - Speech text = w/c/pc text inside the <sp>, skipping <stage>, <speaker>,
    <app>/<rdg> (print variants), <fw> (running heads) and <pb>. Line breaks
    (<lb>, ftln <milestone>) become spaces. <q> gets curly quotes and <gap>
    becomes an ellipsis, as Folger's own stylesheet (fdt.xsl) renders them.
  - stageDirectionCount = number of <stage> elements in <body>.
  - Sections: div1[@type=act] / div2[@type=scene].
  - --straight-quotes converts curly quotes to ASCII, for files whose text
    layer uses straight quotes (the Folger PDFs).
"""
from __future__ import annotations

import os
import sys

from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from benchlib import GoldenBuilder, collapse, fix_space_before_punct, straight_quotes  # noqa: E402

TEI = "{http://www.tei-c.org/ns/1.0}"
SKIP = {"stage", "speaker", "app", "rdg", "fw", "pb", "note", "anchor", "ptr"}
BREAK = {"lb", "milestone"}


def local(el) -> str:
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


def text_of(el, depth_q: int = 0) -> str:
    """Render the spoken text inside el (an <sp> or a descendant)."""
    out: list[str] = []
    for child in el:
        name = local(child)
        if not name or name in SKIP:
            continue
        if name in ("w", "c", "pc"):
            if child.find(f"{TEI}gap") is not None:
                out.append("…")
            else:
                out.append(child.text or "")
                # nested markup inside w (rare: hi, foreign)
                if len(child):
                    out.append(text_of(child, depth_q))
        elif name in BREAK:
            out.append(" ")
        elif name == "gap":
            out.append("…")
        elif name == "q":
            open_q, close_q = ("“", "”") if depth_q % 2 == 0 else ("‘", "’")
            inner = collapse(text_of(child, depth_q + 1))
            out.append(open_q + inner + close_q)
        else:
            out.append(text_of(child, depth_q))
    return "".join(out)


def cue_of(speaker) -> str:
    parts = []
    for el in speaker.iter():
        if local(el) in ("w", "c", "pc"):
            parts.append(el.text or "")
    return collapse("".join(parts))


def main() -> None:
    xml_path, fixture = sys.argv[1], sys.argv[2]
    straight = "--straight-quotes" in sys.argv
    doc = etree.parse(xml_path)
    title = collapse("".join(doc.find(f".//{TEI}titleStmt/{TEI}title").itertext()))
    body = doc.find(f".//{TEI}body")
    gb = GoldenBuilder(title)

    act = None
    for el in body.iter():
        name = local(el)
        if name == "div1":
            t = el.get("type")
            if t == "act":
                act = el.get("n")
            else:
                print(f"note: div1 type {t!r} n={el.get('n')}")
                act = None
                gb.section(scene=el.get("type").capitalize())
        elif name == "div2":
            t = el.get("type")
            if t == "scene":
                gb.section(act=act, scene=el.get("n"))
            else:
                print(f"note: div2 type {t!r}")
                gb.section(act=act, scene=t.capitalize())
        elif name == "stage":
            gb.stage()
        elif name == "sp":
            speaker = el.find(f"{TEI}speaker")
            if speaker is None:
                continue
            cue = cue_of(speaker)
            text = fix_space_before_punct(collapse(text_of(el)))
            if straight:
                text = straight_quotes(text)
            gb.speech(cue, text)
    gb.write(fixture)


if __name__ == "__main__":
    main()
