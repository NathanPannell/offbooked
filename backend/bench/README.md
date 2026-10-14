# Script parser benchmark

Real, freely licensed play scripts with hand-checked golden output, for measuring the script parser (`backend/src/parse/`). The goldens were produced **without** that parser: from structured markup of the same text (Folger TEI XML, Project Gutenberg HTML), or by a format-specific extraction script written for one file, and then checked by hand.

## Layout

```
bench/
  fixtures/<slug>/
    source.pdf | source.docx | source.txt   the file a director would upload
    meta.json                               where it came from and what is hard about it
    golden.json                             the expected parse
  tools/                                    fetch, generators, verifier (Python 3.13)
```

There is also a **holdout set** of 5 fixtures in the same layout at `../.codex/holdout/` (outside the repository). It is kept for a final "works first try" run. Don't open it, tune against it, or copy anything from it while working on the parser. Its build scripts live next to it, not here.

`source.*` files are byte-for-byte what was downloaded, or what the documented conversion produced. `.gitattributes` marks them `-text`, so Git keeps CRLF line endings and BOMs.

## Training fixtures

| slug | format | what makes it hard | speeches |
| --- | --- | --- | --- |
| `folger-hamlet-pdf` | pdf | The production failure. Folger PDF with ~8 pages of front matter, `FTLN 0001` before every line, margin line numbers, running heads. Cues are inline for one-line speeches and on their own line otherwise. The text layer is out of reading order unless it is sorted by position. | 1137 |
| `folger-twelfth-night-docx` | docx | Folger "Word with line numbers" (legacy .doc saved as .docx by Word). Front matter, a tab and line number at the end of every fifth line, cues on their own paragraph or inline after two spaces, songs. | 926 |
| `gutenberg-earnest-txt` | txt | Gutenberg plain text, CRLF and BOM, hard-wrapped. Licence header, cast lists, cue on its own line (`ALGERNON.`), `[bracketed]` directions, `_underscore_` italics, joint cues. | 879 |
| `psu-she-stoops-pdf` | pdf | Penn State Electronic Classics (PageMaker). Fake-bold cues repeated in the text layer (`HARDCASTLEHARDCASTLE.`), hyphenation across lines, alternating running heads, a prologue with no cue, a song. | 843 |
| `chekhov-proposal-screenplay-pdf` | pdf | Generated with screenplain (Fountain). Centered cues, parentheticals on their own lines, Courier, page numbers, title page. | 197 |
| `ia-duchess-of-malfi-pdf` | pdf | Internet Archive scan with OCR text. Preface with footnotes, glossary, misread margin line numbers and running heads, gutter noise, abbreviated and OCR-garbled cues (`Duck.`, `Cart.`), songs. | 1132 |
| `gutenberg-dolls-house-docx` | docx | Gutenberg HTML saved as .docx by Word. Licence and contents table, cue and speech in one paragraph split by a soft line break, italic `[brackets]`. | 1292 |
| `gutenberg-riders-to-the-sea-txt` | txt | One act with many directions. Introduction, cast run together on wrapped lines, `_In a low voice._--` delivery notes, dialogue that continues after a direction without repeating the cue. | 122 |

Each `meta.json` gives the full layout notes, source URL, licence, SHA-256 of the download, and the golden method.

## golden.json

```json
{
  "title": "Hamlet",
  "characters": [{ "name": "HAMLET", "aliases": [] }],
  "sections": [{ "act": "1", "scene": "1" }],
  "speeches": [{ "speaker": "BARNARDO", "text": "Who’s there?" }],
  "stageDirectionCount": 273
}
```

- **speeches**: every speech in play order, one entry per speaker cue. `speaker` is the canonical character name. `text` has no cue, line numbers, page furniture or stage directions. Line breaks become single spaces. Verse and songs are kept. When a direction interrupts a speech and the same speaker goes on without a new cue, it is still one speech.
- **characters**: every speaking character, in order of first speech. `aliases` lists the other cue spellings used in this file: abbreviations (`Bos.`), short forms (`Ammos` for `Ammos Fiodorovich`), OCR misreadings (`Duck.` for `Duch.`), and descriptive labels used before a character is named. A trailing period on a cue that otherwise matches the name is not counted as an alias.
- **Group and joint cues** (`ALL`, `BOTH`, `BARNARDO/MARCELLUS`, `GWENDOLEN and CECILY`) stay as written and appear in `characters` under that name.
- **Performed text is dialogue**: prologues, epilogues, choruses and songs are speeches. When no cue is printed, the speaker is the one the text names, e.g. `PROLOGUE` in She Stoops (spoken by Mr. Woodward), and `CHURCHMEN` and `MADMAN` for the songs in Malfi. Material that is not performed is excluded: title pages, dedications, introductions, synopses, cast lists, notes, footnotes, glossaries, licences, and Shaw-style prose sequels.
- **sections**: acts and scenes in order. Use `[]` when the play has no divisions and acts only when the acts have no numbered scenes. `scene` is the scene number within its act.
- **stageDirectionCount**: an approximate count of directions. That covers stand-alone direction paragraphs and lines, each inline bracketed or parenthesised direction, settings, and `Curtain`. For the Folger fixtures it is the number of `<stage>` elements. Score it with a tolerance.
- **Text fidelity**: typography follows the source file's text layer (curly quotes, em dashes, `. . .`). OCR errors in the Malfi scan are kept, because a parser cannot fix them. Scorers should normalise Unicode, quotes, dashes and whitespace, and compare speech text with a similarity measure rather than exact equality.

## Tools

Requirements: Python 3.13 with `pymupdf`, `lxml`, `beautifulsoup4` and `python-docx`. Conversions also need Windows with Microsoft Word (`word_convert.ps1`) and, for the screenplay fixture, `screenplain[PDF]` in a virtualenv.

| file | purpose |
| --- | --- |
| `fetch.py` | Downloads one URL into a fresh directory and records the URL, size and SHA-256 in `download.json`. Nothing downloaded is executed. |
| `benchlib.py` | `GoldenBuilder` (collects speeches, sections and directions, derives characters, validates, writes `golden.json`), plus bracket stripping and `write_meta`. |
| `folger_tei.py` | Folger TEI XML to golden (Hamlet, Twelfth Night). |
| `gutenberg_earnest.py`, `gutenberg_stoops.py`, `gutenberg_dollshouse.py`, `gutenberg_riders.py` | Gutenberg HTML to golden, one script per file because each transcription marks speeches differently. |
| `chekhov_proposal_screenplay.py` | Builds the Fountain screenplay, renders it with screenplain, and writes the golden from the same element list. |
| `ia_malfi.py` | Format-specific extraction from the Malfi scan's OCR text layer, cross-checked against Gutenberg #2232. |
| `word_convert.ps1` | Opens a file in Word with macros disabled and saves it as .docx. |
| `verify.py` | Checks a golden against its source file (see below). |
| `build_training.py` | Rebuilds every training fixture: fetch, prepare the source, generate, write meta, verify. |

```bash
# from the repository root (Windows)
python -I backend/bench/tools/build_training.py --downloads ../.codex/bench-downloads \
  --screenplain ../.codex/bench-venv/Scripts/screenplain.exe
python -I backend/bench/tools/verify.py backend/bench/fixtures/folger-hamlet-pdf --sample
```

### How the goldens were checked

`verify.py` extracts the source text independently of the app: PyMuPDF with positional sorting for PDF, python-docx for DOCX, raw text for TXT. It then:

1. aligns every golden speech, in order, to the source's word stream and reports how many are found at least 95% verbatim;
2. checks that one of the speaker's cue spellings appears just before each speech;
3. lists long stretches of source text inside the play that no speech accounts for, so a missing speech would show up there (in practice they are long directions and footnotes);
4. with `--sample`, prints the first 30, the last 10 and 20 random speeches next to the source text they matched, plus the character and section lists.

Every fixture was regenerated until that output and a manual read of the sample (and of the character and section lists against the source) agreed. The numbers are in each `meta.json`. Speeches that fall below 95% are short lines split by a direction, or OCR differences in the Malfi scan.

## Running the benchmark

From `backend/` with `ANTHROPIC_API_KEY` in `.env` (it calls the real parser, Claude Haiku 5.5):

```bash
node --env-file-if-exists=.env bench/run.ts --label "what changed"
node --env-file-if-exists=.env bench/run.ts --only folger-hamlet-pdf
node --env-file-if-exists=.env bench/run.ts --dir ../../.codex/holdout2
```

Each fixture is extracted, parsed and scored with `bench/score.ts`, which aligns the predicted dialogue to the golden word by word:

| Metric | Meaning | Pass bar |
| --- | --- | --- |
| Speaker | golden words credited to the right character | ≥ 98.5% |
| Speech | golden speeches recalled ≥ 90% with the right speaker | ≥ 97% |
| Recall | golden dialogue words found in predicted dialogue | ≥ 98.5% |
| Precision | predicted dialogue words that are golden dialogue | ≥ 98.5% |
| Names | right-speaker words whose name is the golden name or an alias | ≥ 95% |

A fixture also fails on spurious, missing or merged characters, or if its act/scene list differs from the golden. Every run appends one record per fixture to `results/history.jsonl` and rewrites `results/latest.md` for a full training run. The prediction and its speaker errors and extra lines are written to `.data/bench/<slug>.pred.json` and `.errors.txt` (gitignored) for debugging.

Model output varies from run to run, so judge a change on more than one run. A full training run takes about 6 minutes and costs a few cents.
