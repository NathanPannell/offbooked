"""Generate a screenplay-format PDF of Chekhov's The Proposal, and its golden.

Usage:
  python -I chekhov_proposal_screenplay.py <pg7986-images.html> <fixture_dir> <screenplain-exe> <work_dir>

No genuinely public-domain play in screenplay layout was found, so this
fixture is generated. Source text: Julius West's 1916 translation of "The
Proposal" from Project Gutenberg #7986 (Plays by Anton Chekhov, Second
Series). The play is parsed once into a list of elements; the same list is
written out as a Fountain screenplay (rendered to PDF by screenplain, a real
Fountain-to-PDF formatter) and as golden.json, so the two cannot disagree.

Mapping:
  - Bracketed directions inside a speech become parenthetical lines inside
    the dialogue block ("(Aside)"), except a direction that ends the speech,
    which becomes an action line after it. Both count as stage directions.
  - Stand-alone bracketed paragraphs and the setting become action lines.
  - "Curtain." becomes a right-aligned transition.
  - The cast list is not printed; the title page is front matter.
  - Character cues are centered caps ("NATALYA STEPANOVNA"); sections = []
    (a one-act with no scene divisions).
"""
import os
import re
import subprocess
import sys

from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from benchlib import GoldenBuilder, collapse  # noqa: E402

CUE = re.compile(r"^(CHUBUKOV|LOMOV|NATALYA STEPANOVNA)\. (.*)$", re.S)
PART = re.compile(r"(\[[^\]]*\])")


def play_paragraphs(html: str) -> list[str]:
    soup = BeautifulSoup(open(html, encoding="utf-8").read(), "lxml")
    h2 = next(h for h in soup.find_all("h2") if collapse(h.get_text()) == "THE PROPOSAL")
    out = []
    for el in h2.find_all_next(["h2", "p"]):
        if el.name == "h2":
            break
        text = collapse(el.get_text(" "))
        if text:
            out.append(text)
    return out


def main() -> None:
    html, fixture, screenplain, work = sys.argv[1:5]
    os.makedirs(work, exist_ok=True)
    paras = play_paragraphs(html)
    # elements: ("action", text) | ("speech", cue, [("line"|"paren", text)]) | ("transition", text)
    elements = []
    for p in paras:
        m = CUE.match(p)
        if m:
            parts = []
            for chunk in PART.split(m.group(2)):
                chunk = collapse(chunk)
                if not chunk:
                    continue
                if chunk.startswith("["):
                    parts.append(("paren", chunk[1:-1].strip()))
                else:
                    parts.append(("line", chunk))
            tail = None
            if parts and parts[-1][0] == "paren":
                tail = parts.pop()[1]
            elements.append(("speech", m.group(1), parts))
            if tail:
                elements.append(("action", tail))
        elif p == "Curtain.":
            elements.append(("transition", "CURTAIN."))
        elif p.startswith("[") and p.endswith("]"):
            elements.append(("action", p[1:-1].strip()))
        else:
            elements.append(("action", p))

    # Fountain
    lines = [
        "Title: THE PROPOSAL",
        "Credit: A Jest in One Act by",
        "Author: Anton Chekhov",
        "Source: Translated by Julius West (1916), Project Gutenberg #7986. Public domain.",
        "",
    ]
    for el in elements:
        if el[0] == "action":
            text = el[1]
            # Fountain treats an all-caps line as a cue; force action with "!".
            if text.upper() == text:
                text = "!" + text
            lines += [text, ""]
        elif el[0] == "transition":
            lines += [">" + el[1], ""]
        else:
            _, cue, parts = el
            lines.append(cue)
            for kind, text in parts:
                lines.append(f"({text})" if kind == "paren" else text)
            lines.append("")
    fountain = os.path.join(work, "the-proposal.fountain")
    with open(fountain, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    pdf = os.path.join(fixture, "source.pdf")
    subprocess.run([screenplain, "--format", "pdf", fountain, pdf], check=True)

    gb = GoldenBuilder("The Proposal")
    for el in elements:
        if el[0] in ("action", "transition"):
            gb.stage()
        else:
            _, cue, parts = el
            gb.stage(sum(1 for k, _ in parts if k == "paren"))
            text = " ".join(t for k, t in parts if k == "line")
            gb.speech(cue, text)
    gb.write(fixture)


if __name__ == "__main__":
    main()
