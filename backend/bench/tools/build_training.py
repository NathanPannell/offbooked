"""Rebuild the training fixtures in backend/bench/fixtures from their sources.

Usage (Windows, from the repository root):
  python -I backend/bench/tools/build_training.py --downloads <dir> [--screenplain <exe>] [--only <slug>]

  --downloads    where fetched files go, one fresh sub-directory per file
                 (outside the repository, e.g. ../.codex/bench-downloads).
                 A sub-directory that already holds the file is reused.
  --screenplain  screenplain executable for the screenplay fixture
                 (pip install "screenplain[PDF]" in a venv).

Steps per fixture: fetch the source and the structured file, prepare
source.<ext> (copy, or convert with Microsoft Word / screenplain), run the
golden generator, write meta.json, then run verify.py. Nothing downloaded is
executed; archives are only unzipped.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile

TOOLS = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(TOOLS)
FIXTURES = os.path.join(BENCH, "fixtures")
PY = [sys.executable, "-I"]

FOLGER_LICENSE = "CC BY-NC 3.0 Unported (Folger Shakespeare, Folger Shakespeare Library); internal testing only"
PG_LICENSE = "Public domain in the USA; Project Gutenberg License applies to the file (trademark terms)"


def fetch(url: str, downloads: str, name: str, filename: str | None = None) -> str:
    out = os.path.join(downloads, name)
    meta = os.path.join(out, "download.json")
    if not os.path.exists(meta):
        cmd = PY + [os.path.join(TOOLS, "fetch.py"), url, downloads, name] + ([filename] if filename else [])
        subprocess.run(cmd, check=True)
    info = json.load(open(meta, encoding="utf-8"))
    return os.path.join(out, info["file"])


def unzip_one(zip_path: str, member_suffix: str, dest: str) -> str:
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.endswith(member_suffix) and "__MACOSX" not in n)
        target = os.path.join(dest, os.path.basename(name))
        with z.open(name) as src, open(target, "wb") as dst:
            shutil.copyfileobj(src, dst)
    return target


def word_convert(src: str, out: str) -> None:
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                    os.path.join(TOOLS, "word_convert.ps1"), src, out], check=True)


def sha256(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def run(script: str, *args: str) -> None:
    subprocess.run(PY + [os.path.join(TOOLS, script), *args], check=True)


def write_meta(fixture: str, **meta) -> None:
    sys.path.insert(0, TOOLS)
    from benchlib import write_meta as wm

    wm(fixture, **meta)


def build(slug: str, dl: str, screenplain: str | None) -> None:
    fx = os.path.join(FIXTURES, slug)
    os.makedirs(fx, exist_ok=True)
    work = os.path.join(dl, "_work", slug)
    os.makedirs(work, exist_ok=True)

    if slug == "folger-hamlet-pdf":
        pdf = fetch("https://flgr.sh/txtfssHampdf", dl, "folger-hamlet-pdf")
        xml = unzip_one(fetch("https://flgr.sh/txtfssHamxml", dl, "folger-hamlet-xml"), "Ham.xml", work)
        shutil.copyfile(pdf, os.path.join(fx, "source.pdf"))
        run("folger_tei.py", xml, fx)
        write_meta(
            fx, title="Hamlet", author="William Shakespeare", format="pdf",
            sourceUrl="https://folger-main-site-assets.s3.amazonaws.com/uploads/2022/11/hamlet_PDF_FolgerShakespeare.pdf",
            license=FOLGER_LICENSE,
            description=(
                "The production failure. Folger Shakespeare PDF (Chrome/Skia print, 144 letter pages): ~8 pages of "
                "front matter (contents, director's note, textual introduction, synopsis, Characters in the Play); "
                "every line prefixed 'FTLN 0001'; through-line numbers every 5 lines at the right margin; running "
                "header 'page Hamlet ACT 1. SC. 1'; speaker names in caps, inline ('BARNARDO Who's there?') for "
                "single-line speeches and on their own line above verse; delivery directions after the cue "
                "('POLONIUS, aside'); editorial brackets drawn as images (missing from the text layer); the text "
                "layer lists FTLN numbers and cues out of reading order unless sorted by position."),
            goldenMethod=(
                "folger_tei.py on the same edition's TEI (Ham.xml, v0.9.2.2, from hamlet_XML_FolgerShakespeare.zip). "
                "One speech per <sp>; text = w/c/pc tokens with <stage>, <app>/<rdg>, <fw>, <pb> removed; <q> gets "
                "curly quotes as Folger's stylesheet renders them; cue = <speaker> text as printed. One speaker-less "
                "<sp> (a crowd noise quoted inside a direction, 4.5.176) is not a speech. stageDirectionCount = <stage> "
                "elements in <body>. Checked with verify.py (1136/1137 speeches found >=95% verbatim in the PDF text "
                "layer, cue found before 1135) and by hand: first 30, last 10, 20 random, characters, sections."),
            sourceSha256=sha256(pdf),
        )
    elif slug == "folger-twelfth-night-docx":
        doc = fetch("https://flgr.sh/txtfssTN_docln", dl, "folger-tn-docln")
        xml = unzip_one(fetch("https://flgr.sh/txtfssTN_xml", dl, "folger-tn-xml"), "TN.xml", work)
        word_convert(doc, os.path.join(fx, "source.docx"))
        run("folger_tei.py", xml, fx)
        write_meta(
            fx, title="Twelfth Night", author="William Shakespeare", format="docx",
            sourceUrl="https://folger-main-site-assets.s3.amazonaws.com/uploads/2022/11/twelfth-night_DOC-LN_FolgerShakespeare.doc",
            license=FOLGER_LICENSE,
            description=(
                "Folger 'Word (with line numbers)' download. Folger only publishes legacy .doc, so it was opened in "
                "Microsoft Word and saved as .docx (word_convert.ps1); content unchanged. Front matter (director's "
                "note, textual introduction, synopsis, characters) before ACT 1; cue on its own paragraph in caps "
                "before verse, inline with two spaces before short prose ('ORSINO  What, Curio?'); every fifth line "
                "ends with a tab and its line number ('...sweet sound\\t5'); songs (Feste) and letters read aloud."),
            goldenMethod=(
                "folger_tei.py on the same edition's TEI (TN.xml from twelfth-night_XML_FolgerShakespeare.zip), same "
                "rules as folger-hamlet-pdf. verify.py: 925/926 speeches >=95% verbatim in the DOCX text, cue found "
                "before every aligned speech; spot-checked by hand."),
            sourceSha256=sha256(doc), sourceNote="sha256 is of the downloaded .doc; source.docx is Word's conversion",
        )
    elif slug == "gutenberg-earnest-txt":
        txt = fetch("https://www.gutenberg.org/cache/epub/844/pg844.txt", dl, "gutenberg-844-txt")
        html = fetch("https://www.gutenberg.org/cache/epub/844/pg844-images.html", dl, "gutenberg-844-html")
        shutil.copyfile(txt, os.path.join(fx, "source.txt"))
        run("gutenberg_earnest.py", html, fx)
        write_meta(
            fx, title="The Importance of Being Earnest", author="Oscar Wilde", format="txt",
            sourceUrl="https://www.gutenberg.org/cache/epub/844/pg844.txt", license=PG_LICENSE,
            description=(
                "Project Gutenberg #844 plain text, UTF-8 with BOM and CRLF line endings, hard-wrapped at ~72 "
                "columns. Gutenberg header and licence; cast list and first-cast list; 'FIRST ACT' style headings "
                "with 'SCENE' and a setting paragraph; cue alone on its line in caps with a period ('ALGERNON.'); "
                "[bracketed] directions inline and as paragraphs; _underscore_ italics, including inside directions "
                "('[Languidly_._]'); 'ACT DROP' / 'TABLEAU' endings; two joint cues 'GWENDOLEN and CECILY "
                "[Speaking together.]'."),
            goldenMethod=(
                "gutenberg_earnest.py on Gutenberg's HTML of the same release (cue paragraphs 'NAME.<br>'). Bracketed "
                "text removed and counted; a direction paragraph followed by words continues the previous speech. "
                "Italic underscores are not part of the golden text. verify.py: 879/879 speeches >=95% verbatim in "
                "source.txt; spot-checked by hand."),
            sourceSha256=sha256(txt),
        )
    elif slug == "psu-she-stoops-pdf":
        pdf = fetch("http://web.archive.org/web/20140925210343id_/http://www2.hn.psu.edu/faculty/jmanis/goldsmith/She_Stoops_to_Conquer6x9.pdf",
                    dl, "psu-she-stoops-pdf", "She_Stoops_to_Conquer6x9.pdf")
        html = fetch("https://www.gutenberg.org/cache/epub/383/pg383-images.html", dl, "gutenberg-383-html")
        shutil.copyfile(pdf, os.path.join(fx, "source.pdf"))
        run("gutenberg_stoops.py", html, fx)
        write_meta(
            fx, title="She Stoops to Conquer", author="Oliver Goldsmith", format="pdf",
            sourceUrl="http://www2.hn.psu.edu/faculty/jmanis/goldsmith/She_Stoops_to_Conquer6x9.pdf (Wayback Machine copy of 2014-09-25; the Penn State site is offline)",
            license="Public domain text; Penn State Electronic Classics Series file, 'furnished free' (cover and notice pages copyright PSU)",
            description=(
                "Penn State Electronic Classics Series PDF (PageMaker, 6x9 in, 116 pages). Cover, PSU notice page, "
                "dedication to Johnson, Garrick's prologue set as prose, dramatis personae with the first cast on "
                "alternate lines. Speaker cues inline in caps ('MRS. HARDCASTLE. I vow...'), drawn in fake bold: the "
                "text layer repeats each cue up to five times ('HARDCASTLEHARDCASTLEHARDCASTLE.'); words hyphenated "
                "across lines ('particu-lar'); alternating running heads ('Oliver Goldsmith' / 'She Stoops to "
                "Conquer') and page numbers; directions in (parentheses) and [brackets] inline, entrances on their "
                "own line; Tony's song set as verse."),
            goldenMethod=(
                "gutenberg_stoops.py on Project Gutenberg #383 HTML, the transcription the PSU file was typeset from "
                "(same text, same typography in the PDF text layer). Garrick's prologue is performed text and is one "
                "speech by 'PROLOGUE' (no cue is printed); dedication and dramatis personae excluded. Parenthesised "
                "and bracketed directions removed except the spoken '(ay, the hag)'. Checked: verify.py 802/843 "
                ">=95% verbatim (the rest are hyphenation splits), speaker sequence identical to the cues parsed "
                "from pdftotext output (842/842), and by hand."),
            sourceSha256=sha256(pdf),
        )
    elif slug == "chekhov-proposal-screenplay-pdf":
        if not screenplain:
            raise SystemExit("--screenplain is required for this fixture")
        html = fetch("https://www.gutenberg.org/cache/epub/7986/pg7986-images.html", dl, "gutenberg-7986-html")
        run("chekhov_proposal_screenplay.py", html, fx, screenplain, work)
        write_meta(
            fx, title="The Proposal", author="Anton Chekhov (tr. Julius West)", format="pdf",
            sourceUrl="https://www.gutenberg.org/cache/epub/7986/pg7986-images.html (text); PDF generated",
            license="Public domain (1916 translation); generated PDF has no added rights",
            description=(
                "GENERATED: no public-domain screenplay-format play PDF was found, so this was typeset from the "
                "Gutenberg text with screenplain 0.12 (Fountain to PDF, Courier 12pt, US letter). Title page; "
                "character cues centred in caps on their own line above an indented dialogue column; delivery "
                "directions as (parentheticals) on their own lines inside the dialogue block; actions full width; "
                "page numbers top right ('2.'); 'CURTAIN.' as a right-aligned transition."),
            goldenMethod=(
                "chekhov_proposal_screenplay.py parses the Gutenberg HTML once and writes both the Fountain file and "
                "golden.json from the same element list (speech text = dialogue lines, parentheticals and actions "
                "counted as directions). verify.py: 197/197 verbatim, cue before every speech."),
            sourceSha256=sha256(os.path.join(fx, "source.pdf")),
        )
    elif slug == "ia-duchess-of-malfi-pdf":
        pdf = fetch("https://archive.org/download/duchessofmalfipl00websuoft/duchessofmalfipl00websuoft.pdf", dl, "ia-malfi-pdf")
        html = fetch("https://www.gutenberg.org/cache/epub/2232/pg2232-images.html", dl, "gutenberg-2232-html")
        shutil.copyfile(pdf, os.path.join(fx, "source.pdf"))
        run("ia_malfi.py", os.path.join(fx, "source.pdf"), html, fx)
        write_meta(
            fx, title="The Duchess of Malfi", author="John Webster", format="pdf",
            sourceUrl="https://archive.org/details/duchessofmalfipl00websuoft",
            license="Public domain (Temple Dramatists edition, J. M. Dent 1900); scan by University of Toronto via Internet Archive",
            description=(
                "Internet Archive scan with an OCR text layer (184 small pages, 8 MB). Title, preface with "
                "footnotes, dramatis personae, glossary at the end. Running heads 'ACT I. SC. I. The Duchess of "
                "Malfi' OCR'd as 'ACT i. sc. «.'; marginal line numbers every fifth line, often misread ('no' for "
                "110, '1 1 1', '5°'); page numbers; scan noise from the gutter ('\\\\', '^', 'iC', '•'); abbreviated "
                "cues inline ('Bos.', 'Duch.') with OCR variants ('Duck.', 'Cart.', 'Can.', 'Trd.'); brackets OCR'd "
                "as '\\\\', '{', '^'; 'SCENE' and its numeral on separate lines; two songs set as verse after a "
                "direction; widespread OCR errors (\"I '11\" for I'll, '1' for '!')."),
            goldenMethod=(
                "ia_malfi.py: format-specific extraction from this PDF's own text layer (word positions via "
                "PyMuPDF): drops running heads, page numbers and margin numbers by position, segments speeches at "
                "known cue prefixes, removes bracketed directions, rejoins hyphenated words, and scrubs a short list "
                "of margin debris. Text keeps the OCR errors (a parser cannot fix them). Speaker sequence "
                "cross-checked against Project Gutenberg #2232 (different edition, full names): all differences "
                "reviewed by hand and are edition differences, which follow the PDF; ambiguous OCR'd cues resolved "
                "from the alignment. Songs: CHURCHMEN (3.4 ditty), MADMAN (4.2 song). Sections follow Temple "
                "(ACT I has one scene). verify.py 1130/1132 aligned; spot-checked by hand."),
            sourceSha256=sha256(pdf),
        )
    elif slug == "gutenberg-dolls-house-docx":
        html = fetch("https://www.gutenberg.org/cache/epub/2542/pg2542-images.html", dl, "gutenberg-2542-html")
        word_convert(html, os.path.join(fx, "source.docx"))
        run("gutenberg_dollshouse.py", html, fx)
        write_meta(
            fx, title="A Doll's House", author="Henrik Ibsen (tr. R. Farquharson Sharp)", format="docx",
            sourceUrl="https://www.gutenberg.org/cache/epub/2542/pg2542-images.html (converted)",
            license=PG_LICENSE,
            description=(
                "CONVERTED: no downloadable DOCX of a public-domain non-Shakespeare play was found, so Gutenberg's "
                "HTML was opened in Microsoft Word and saved as .docx (word_convert.ps1). Keeps the Gutenberg "
                "header, contents table, dramatis personae and licence. Each speech is one paragraph with the cue "
                "('NORA.') and the speech separated by a soft line break; [bracketed] italic directions inline and "
                "as paragraphs; the opening direction spans two paragraphs; 'DOCTOR RANK.' once for 'RANK.'."),
            goldenMethod=(
                "gutenberg_dollshouse.py on the same HTML that was converted. verify.py: 1290/1292 >=95% verbatim "
                "in the DOCX text; spot-checked by hand."),
            sourceSha256=sha256(html), sourceNote="sha256 is of the downloaded HTML; source.docx is Word's conversion",
        )
    elif slug == "gutenberg-riders-to-the-sea-txt":
        txt = fetch("https://www.gutenberg.org/cache/epub/994/pg994.txt", dl, "gutenberg-994-txt")
        html = fetch("https://www.gutenberg.org/cache/epub/994/pg994-images.html", dl, "gutenberg-994-html")
        shutil.copyfile(txt, os.path.join(fx, "source.txt"))
        run("gutenberg_riders.py", html, fx)
        write_meta(
            fx, title="Riders to the Sea", author="J. M. Synge", format="txt",
            sourceUrl="https://www.gutenberg.org/cache/epub/994/pg994.txt", license=PG_LICENSE,
            description=(
                "Project Gutenberg #994 plain text (CRLF). Gutenberg header, contents, a two-page introduction by "
                "E. J. O'Brien, PERSONS list with first cast run together on wrapped lines. One act, many "
                "directions: cue alone on its line ('NORA.'), delivery directions in _underscores_ before an em "
                "dash ('_In a low voice._--Where is she?'), [_bracketed_] directions as paragraphs and inline; "
                "dialogue resumes after a direction without repeating the cue; a joint cue 'CATHLEEN AND NORA.'."),
            goldenMethod=(
                "gutenberg_riders.py on Gutenberg's HTML of the same release: every italic run inside a speech is a "
                "direction (removed with its brackets or trailing em dash, counted); cue-less paragraphs after a "
                "direction continue the previous speech. verify.py 122/122 verbatim; spot-checked by hand."),
            sourceSha256=sha256(txt),
        )
    else:
        raise SystemExit(f"unknown fixture {slug}")
    subprocess.run(PY + [os.path.join(TOOLS, "verify.py"), fx, "--quiet"], check=True)


SLUGS = [
    "folger-hamlet-pdf", "folger-twelfth-night-docx", "gutenberg-earnest-txt", "psu-she-stoops-pdf",
    "chekhov-proposal-screenplay-pdf", "ia-duchess-of-malfi-pdf", "gutenberg-dolls-house-docx",
    "gutenberg-riders-to-the-sea-txt",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--downloads", required=True)
    ap.add_argument("--screenplain")
    ap.add_argument("--only")
    args = ap.parse_args()
    os.makedirs(args.downloads, exist_ok=True)
    for slug in SLUGS:
        if args.only and slug != args.only:
            continue
        print(f"== {slug}")
        build(slug, os.path.abspath(args.downloads), args.screenplain)


if __name__ == "__main__":
    main()
