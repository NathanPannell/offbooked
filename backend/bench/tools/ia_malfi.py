"""Golden for the Internet Archive scan of The Duchess of Malfi (Temple
Dramatists, J. M. Dent 1900, ed. C. Vaughan; IA item
duchessofmalfipl00websuoft).

Usage:
  python -I ia_malfi.py <ia.pdf> <pg2232-images.html> <fixture_dir> [--debug <file>]

The PDF is a scanned book with an OCR text layer (Internet Archive). There is
no structured file of this edition, so the golden is extracted from the PDF's
own text layer with rules written for this exact file, and then cross-checked
speech by speech against Project Gutenberg #2232 (a different edition of the
same play, with full character names):

  - Pages 27-168 (PDF index 26-167) hold the play. The preface (with its
    footnotes), dramatis personae and the glossary after the play are
    excluded.
  - Running heads ("ACT I. SC. I.  The Duchess of Malfi"), page numbers,
    marginal line numbers (every fifth line, often OCR'd as "no", "I j",
    "1 1 1") and gutter noise from the scan ("\\", "^", "iC") are removed by
    position: line numbers are number-like tokens separated from the verse by
    a wide gap; gutter noise is a one- or two-character token at the far
    left followed by a wide gap.
  - A speech starts at a line whose first token is a speaker prefix. Prefixes
    are the edition's abbreviations as OCR'd ("Bos.", "Duch.", "Duck.",
    "Cari.", "Cart.", "Can." ...); OCR-garbled spellings stay as aliases.
    "Can." is ambiguous (Cariola or Cardinal) and is resolved from the
    Gutenberg alignment.
  - Stage directions: lines starting "Enter"/"Re-enter"/"Exeunt"/"Exit", the
    location line under a scene heading, and bracketed directions (OCR'd
    "[", "\\", "{") which run to the end of the line, plus their wrapped
    continuation lines. Each counts once. "[aside]" after a prefix too.
  - The two songs are performed text: the ditty in 3.4 is sung "by divers
    churchmen" (speaker CHURCHMEN) and the song in 4.2 "by a Madman"
    (speaker MADMAN).
  - Text is the OCR text as printed in the layer (OCR errors are kept: a
    parser cannot fix them), with whitespace collapsed and words hyphenated
    across lines rejoined (the hyphen is kept when Gutenberg spells the word
    with one).
  - Sections: Temple's acts and scenes (ACT I has one scene; this differs
    from Gutenberg's scene division).
"""
from __future__ import annotations

import collections
import difflib
import os
import re
import sys

import fitz
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from benchlib import GoldenBuilder, collapse, norm_tokens  # noqa: E402

FIRST_PAGE, LAST_PAGE = 26, 167

# OCR'd speaker prefix -> canonical name (None = resolve by alignment)
CUES = {
    "Bos.": "BOSOLA", "Bts.": "BOSOLA",
    "Ant.": "ANTONIO", "-Ant.": "ANTONIO",
    "Ferd.": "FERDINAND", "Trd.": None,
    "Card.": "CARDINAL", "Card,": "CARDINAL", "Can'.": None,
    "Duch.": "DUCHESS", "Duck.": "DUCHESS", "Ducji.": "DUCHESS", "Duck,": "DUCHESS",
    "Duch.'": "DUCHESS", "Ditch.": "DUCHESS",
    "Julia.": "JULIA", "Julia,": "JULIA",
    "Delio.": "DELIO", "Delia.": "DELIO", "Delta.": "DELIO", "Ddio.": "DELIO",
    "Del.": "DELIO", "Delio:": "DELIO",
    "Pes.": "PESCARA", "Mai.": "MALATESTI", "Mal.": "MALATESTI",
    "Cari.": "CARIOLA", "Cart.": "CARIOLA", "Carl.": "CARIOLA",
    "Can.": None,
    "Cast.": "CASTRUCCIO", "Serv.": "SERVANT", "Servants.": "SERVANTS",
    "Rod.": "RODERIGO", "Sil.": "SILVIO", "SiL": "SILVIO", "Stl.": "SILVIO",
    "Doc.": "DOCTOR", "Echo.": "ECHO", "Gris.": "GRISOLAN",
}
MULTI = {
    ("Old", "Lady."): "OLD LADY",
    ("First", "Serv."): "FIRST SERVANT", ("Second", "Serv."): "SECOND SERVANT",
    ("First", "Off."): "FIRST OFFICER", ("Sec.", "Off."): "SECOND OFFICER",
    ("Third", "Off."): "THIRD OFFICER", ("Fourth", "Off."): "FOURTH OFFICER",
    ("First", "Pil."): "FIRST PILGRIM", ("First", "PiL"): "FIRST PILGRIM",
    ("First", "Pit."): "FIRST PILGRIM", ("Sec.", "Pil."): "SECOND PILGRIM",
    ("Sec.", "PiL"): "SECOND PILGRIM",
    ("First", "Madman."): "FIRST MADMAN", ("First", "Maaman."): "FIRST MADMAN",
    ("Second", "Madman."): "SECOND MADMAN", ("Third", "Madman."): "THIRD MADMAN",
    ("Fourth", "Madman."): "FOURTH MADMAN",
    ("First", "Execut."): "FIRST EXECUTIONER",
    ("Rod.", "Gris."): "RODERIGO AND GRISOLAN",
}
SD_START = re.compile(r"^(Enter|Re-enter|Exeunt|Exit|Enter,|Enter\^)\b")
NUMBERISH = re.compile(r"^[0-9IlOoSsZzj|]{1,3}[.,]?$")
ROMAN = {"I": "1", "II": "2", "III": "3", "IV": "4", "V": "5", "VI": "6", "HI": "3", "in": "3"}


def page_lines(doc, pno):
    words = doc[pno].get_text("words")
    lines = collections.OrderedDict()
    for w in words:
        lines.setdefault((w[5], w[6]), []).append(w)
    out = []
    for ws in lines.values():
        ws = sorted(ws, key=lambda w: w[0])
        out.append({"page": pno, "x0": ws[0][0], "y0": min(w[1] for w in ws),
                    "toks": [(w[4], w[0], w[2]) for w in ws]})
    return out


def strip_margins(toks):
    """Remove gutter noise at the left and line numbers at the right."""
    toks = list(toks)
    # trailing line numbers: number-like tokens after a wide gap ("45 1" too)
    removed = False
    while len(toks) >= 2:
        t, x0, _ = toks[-1]
        gap = x0 - toks[-2][2]
        num = NUMBERISH.match(t) or re.fullmatch(r"[0-9°]{1,3}[a-z°]?", t)
        digits = any(ch.isdigit() for ch in t) or "°" in t
        if num and (gap > 14 or (digits and gap > 3) or removed):
            toks.pop()
            removed = True
        else:
            break
    # a line number glued to the last word ("on75under", "him.60")
    if toks:
        t, x0, x1 = toks[-1]
        m = re.fullmatch(r"(.*[a-z.,;:!?'])(\d{2,3})", t)
        if m:
            toks[-1] = (m.group(1), x0, x1)
    # gutter noise
    while len(toks) >= 2:
        t, x0, x1 = toks[0]
        gap = toks[1][1] - x1
        if len(t) <= 2 and t not in ("I", "O", "A", "a", "Ay", "No", "To", "Is", "In", "My", "We", "He", "Be", "If", "So", "Do", "Go", "Oh", "Of", "On", "Or", "As", "At", "By", "It", "Me", "Up", "Us") and gap > 6 and not t.isalpha() or t in ("iC", "\\", "^", "|", "*", "•", "\\(", "/", "'/-", "^/", "\\S", "j", "y", "i", "-"):
            if gap > 4:
                toks.pop(0)
                continue
        break
    return toks


def is_header(line, first_on_page):
    text = " ".join(t for t, _, _ in line["toks"])
    return line["y0"] < 30 and ("Malf" in text or "Duchess" in text or text.startswith("ACT "))


AMBIGUOUS = {"Can.": ("CARIOLA", "CARDINAL"), "Can'.": ("CARIOLA", "CARDINAL"),
             "Trd.": ("FERDINAND", "CARDINAL")}


def cue_of(toks):
    if len(toks) >= 2 and re.fullmatch(r"[^A-Za-z]{1,2}|[a-z]", toks[0][0]) and cue_of(toks[1:])[0] is not False:
        canon, raw, n = cue_of(toks[1:])
        return canon, raw, n + 1  # gutter noise before the prefix ("v Ferd.")
    if len(toks) >= 2 and (toks[0][0], toks[1][0]) in MULTI:
        return MULTI[(toks[0][0], toks[1][0])], f"{toks[0][0]} {toks[1][0]}", 2
    t = toks[0][0]
    if t in CUES:
        return CUES[t], t, 1
    return False, None, 0


def gutenberg(html):
    soup = BeautifulSoup(open(html, encoding="utf-8").read(), "lxml")
    for a in soup.find_all("a", class_="pginternal"):
        a.decompose()
    text = "\n".join(p.get_text() for p in soup.find_all("pre"))
    speeches = []
    cue = r"^  \[?([A-Z][A-Z' ]+[A-Z](?:, [A-Z][A-Z' ]+[A-Z])*)\.\]?(?=\s)"
    for m in re.finditer(cue + r"(.*?)(?=" + cue + r"|^\s*SCENE|^\s*ACT|\Z)", text, re.M | re.S):
        body = re.sub(r"\[[^\]]*\]", " ", m.group(2))
        speeches.append((m.group(1).replace(", ", " AND "), collapse(body)))
    return speeches


def main() -> None:
    pdf, html, fixture = sys.argv[1], sys.argv[2], sys.argv[3]
    debug = open(sys.argv[sys.argv.index("--debug") + 1], "w", encoding="utf-8") if "--debug" in sys.argv else None
    doc = fitz.open(pdf)
    gut = gutenberg(html)
    gut_words = set(w for _, t in gut for w in re.findall(r"[\w'-]+", t.lower()))

    items = []  # ("act", n) ("scene", n) ("sd",) ("cue", canonical, raw, text) ("text", text) ("song", speaker)
    in_sd = False
    after_scene_heading = False
    block_end = None
    song = None
    for pno in range(FIRST_PAGE, LAST_PAGE + 1):
        lines = page_lines(doc, pno)
        for i, line in enumerate(lines):
            if is_header(line, i == 0):
                continue
            toks = strip_margins(line["toks"])
            if not toks:
                continue
            words = [t for t, _, _ in toks]
            text = " ".join(words)
            x0 = line["x0"]

            def log(kind, body=text):
                if debug:
                    debug.write(f"{pno:3d} {x0:5.1f} {kind:5s}{body}\n")

            if re.fullmatch(r"[0-9IlOoSs|]{1,4}", text) or re.fullmatch(r"[\W\d_]{1,4}", text) \
                    or text == "THE DUCHESS OF MALFI":
                continue  # page number, stray mark, title
            m_act = re.fullmatch(r"ACT\s+([IVXH]+|in)", text)
            # "SCENE" and its numeral are separate OCR lines; scenes are counted
            m_sc = re.fullmatch(r"SCENE(\s+[IVXH]+)?", text)
            if m_act:
                items.append(("act", ROMAN[m_act.group(1)]))
                in_sd = False
                continue
            if m_sc:
                items.append(("scene", None))
                in_sd, after_scene_heading = False, True
                continue
            # long directions this file prints without a usable end marker
            if block_end:
                log("SDB")
                if text.endswith(block_end):
                    block_end = None
                continue
            hit = next((b for b in SD_BLOCKS if b[0] == pno and text.startswith(b[1])), None)
            if hit:
                items.append(("sd",))
                block_end = None if text.endswith(hit[2]) else hit[2]
                song = hit[3]
                in_sd = False
                log("SDB")
                continue
            canon, raw, n = cue_of(toks)
            if canon is not False:
                song = None
                in_sd = after_scene_heading = False
                rest = words[n:]
                if rest and re.match(r"^[\[\\{(][Aa]side", rest[0]):
                    items.append(("sd",))  # "Julia, [aside.]"
                    rest = rest[1:]
                body, in_sd, nsd = split_sd(rest)
                items.extend([("sd",)] * nsd)
                items.append(("cue", canon, raw, body, pno))
                log("CUE", f"{raw} | {body}{' | SD' if nsd else ''}")
                continue
            if song:
                items.append(("song", song, text, pno))
                log("SONG")
                continue
            if in_sd:
                # wrapped continuation of a direction that has not ended yet
                body, in_sd = continue_sd(words)
                if body:
                    items.append(("text", body, pno))
                log("SD+", f"{text}{' | TXT ' + body if body else ''}")
                continue
            if SD_START.match(text):
                items.append(("sd",))
                in_sd = not re.search(r"[.!?]\W*$", text)
                after_scene_heading = False
                log("SD")
                continue
            if after_scene_heading:
                if items[-1] != ("loc",):  # a wrapped location line counts once
                    items.append(("sd",))
                    items.append(("loc",))
                log("LOC")
                continue
            body, in_sd, nsd = split_sd(words)
            if body:
                items.append(("text", body, pno))
            items.extend([("sd",)] * nsd)
            log("TXT", f"{body}{' | SD' if nsd else ''}")

    # Build speeches
    speeches = []  # [canon, raw, [text lines], page]
    sections = []
    stage = 0
    act, scene_no = None, 0
    for it in items:
        if it[0] == "act":
            act, scene_no = it[1], 0
        elif it[0] == "scene":
            scene_no += 1
            sections.append((act, str(scene_no)))
        elif it[0] == "sd":
            stage += 1
        elif it[0] == "cue":
            speeches.append([it[1], it[2], [it[3]] if it[3] else [], it[4]])
        elif it[0] == "song":
            if speeches and speeches[-1][1] is None and speeches[-1][0] == it[1]:
                speeches[-1][2].append(it[2])
            else:
                speeches.append([it[1], None, [it[2]], it[3]])
        elif it[0] == "text":
            if speeches:
                speeches[-1][2].append(it[1])

    # Resolve ambiguous prefixes and report differences against Gutenberg.
    pdf_seq = [s[0] for s in speeches]
    gut_seq = [g[0] for g in gut]
    sm = difflib.SequenceMatcher(None, [x or "?" for x in pdf_seq], gut_seq, autojunk=False)
    anchor = {}
    for b in sm.get_matching_blocks():
        for k in range(b.size):
            anchor[b.a + k] = b.b + k
    for i, s in enumerate(speeches):
        if s[0] is not None or s[1] is None:
            continue
        near = [anchor[k] for k in range(i, -1, -1) if k in anchor][:1] or [0]
        j0 = near[0]
        mine = set(norm_tokens(" ".join(s[2])))
        best = max(
            (g for g in gut[max(0, j0 - 3):j0 + 6] if g[0] in AMBIGUOUS[s[1]]),
            key=lambda g: len(mine & set(norm_tokens(g[1]))) / (len(mine) or 1),
            default=None,
        )
        if best:
            s[0] = best[0]
    for s in speeches:
        if s[0] is None:
            raise SystemExit(f"unresolved prefix {s[1]} on page {s[3]}: {' '.join(s[2])[:60]}")
    pdf_seq = [s[0] for s in speeches]
    sm = difflib.SequenceMatcher(None, pdf_seq, gut_seq, autojunk=False)
    diffs = [op for op in sm.get_opcodes() if op[0] != "equal"]
    print(f"PDF speeches {len(pdf_seq)}, Gutenberg speeches {len(gut_seq)}, differing runs {len(diffs)}")
    for tag, i1, i2, j1, j2 in diffs:
        print(f"  {tag} pdf[{i1}:{i2}] {[(s[0], s[3], ' '.join(s[2])[:40]) for s in speeches[i1:i2]]}")
        print(f"       gut[{j1}:{j2}] {[(g[0], g[1][:40]) for g in gut[j1:j2]]}")

    gb = GoldenBuilder("The Duchess of Malfi")
    for a, sc in sections:
        gb.section(act=a, scene=sc)
    gb.stage(stage)
    for canon, raw, lines, _ in speeches:
        text, n = scrub(join_lines(lines, gut_words))
        gb.stage(n)
        gb.speech(canon, text, cue=raw)
    gb.write(fixture)


SD_OPEN = re.compile(r"^[\[\\{][\\_\[]?[A-Z]|^[\[\\{][Aa]side|^\[[Tt]o\b")
SD_CLOSE = re.compile(r"[\]\\^}]$")


def split_sd(words):
    """Split bracketed directions out of a line: (dialogue, direction still open, count).

    Temple prints "[Exit." running to the end of the line, or "[Aside.]" /
    "[Exit Cardinal.]" closed and followed by more dialogue. The OCR renders
    the brackets as "[", "\\", "{", "]" or "^".
    """
    for k, w in enumerate(words):
        if not SD_OPEN.match(w):
            continue
        m = re.fullmatch(r"\[([A-Za-z']+)\][^\w]*", w)
        if m and m.group(1) not in ("Exit", "Exeunt", "Dies", "Aside", "Enter"):
            continue  # editorial insertion such as "[Are]"
        for j in range(k, len(words) - 1):
            nxt = words[j + 1]
            # "^" is also the OCR for commas in name lists ("Duchess^ Antonio^")
            if SD_CLOSE.search(words[j]) and re.match(r"^[A-Z'‘\"]", nxt) and not re.search(r"[\^,]$", nxt):
                after, still_open, n = split_sd(words[j + 1:])
                return collapse(" ".join(words[:k] + ([after] if after else []))), still_open, n + 1
        still_open = not re.search(r"[.!?][\]\\^]*$", words[-1])
        return collapse(" ".join(words[:k])), still_open, 1
    return collapse(" ".join(words)), False, 0


def continue_sd(words):
    """A line that continues an open direction: (dialogue after it, still open)."""
    for j in range(len(words) - 1):
        nxt = words[j + 1]
        if SD_CLOSE.search(words[j]) and re.match(r"^[A-Z'‘\"]", nxt) and not re.search(r"[\^,]$", nxt):
            after, still_open, _ = split_sd(words[j + 1:])
            return after, still_open
    return "", not re.search(r"[.!?][\]\\^]*$", words[-1])


# Margin debris the position rules cannot tell from text: marginal line numbers
# that the OCR split into several tokens ("45 1", "1 10", "1 1 c"), and scan
# marks from the gutter of the first pages. Applied to finished speech text.
SCRUB = [
    (r"(?<=\S) \d{1,3}(?: \d{1,3})*(?: c)?(?= [A-Z][a-z]|$)", ""),
    (r" \\ 1 6-$", ""),
    (r" '/- \.\*•- rtt(?= )", ""),
    (r" it /• t(?= And)", ""),
    (r"5jA\^V\*\*O(?=Though)", ""),
    (r" \* \^ \. #4\"$", ""),
    (r"(?<= )[|^•](?= |$)", ""),
    (r"(?<=giver\.) in$", ""),
    (r"(?<=[.!?;:]) no$", ""),
    (r" 5IQ$", ""),
    (r" J I \\(?= )", ""),
]


# Directions the line rules miss because the OCR glued or split the bracket.
SD_SCRUB = [r"\[Kneels\]", r"-?\.?—?\[aside\]", r"\[ Withdraws to the upper end of the apartment\.$"]


def scrub(text):
    """Return (clean text, number of directions removed)."""
    for pat, rep in SCRUB:
        text = re.sub(pat, rep, text)
    n = 0
    for pat in SD_SCRUB:
        text, k = re.subn(pat, " ", text)
        n += k
    return collapse(text), n


SD_BLOCKS = [
    # (page index, first words, last words, song speaker that follows)
    (100, "[Here the ceremony", "Two Pilgrims.", "CHURCHMEN"),
    (119, "Here by a Madman", "kind of music.", "MADMAN"),
]


def join_lines(lines, gut_words):
    out = ""
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        if out.endswith("-") and not out.endswith("--") and re.match(r"^[a-z]", ln):
            head = re.findall(r"[\w']+-$", out)
            tail = re.match(r"[\w']+", ln).group()
            joined_h = (head[0] + tail).lower() if head else ""
            if joined_h and joined_h in gut_words:
                out = out + ln  # keep the hyphen: Gutenberg spells it so
            else:
                out = out[:-1] + ln
        else:
            out = (out + " " + ln) if out else ln
    return collapse(out)


if __name__ == "__main__":
    main()
