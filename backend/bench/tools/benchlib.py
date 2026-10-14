"""Shared helpers for building golden.json files.

Generators collect speeches, sections and stage directions with GoldenBuilder,
then call write() which derives the character list, validates the result and
writes golden.json. Nothing here imports or calls the app's parser
(backend/src/parse/).
"""
from __future__ import annotations

import json
import os
import re
import unicodedata

_WS = re.compile(r"\s+")
_STRAIGHT = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"'})


def collapse(text: str) -> str:
    """Collapse all runs of whitespace (including newlines) to one space."""
    text = text.replace(" ", " ").replace("­", "")
    return _WS.sub(" ", text).strip()


def straight_quotes(text: str) -> str:
    return text.translate(_STRAIGHT)


def fix_space_before_punct(text: str) -> str:
    """Remove spaces left before closing punctuation by tag-stripping."""
    return re.sub(r" +([,.;:!?)\]])", r"\1", text)


class GoldenBuilder:
    def __init__(self, title: str):
        self.title = title
        self.sections: list[dict] = []
        self.speeches: list[dict] = []
        self.stage_directions = 0
        # canonical name -> ordered list of cue spellings seen in the file
        self._cues: dict[str, list[str]] = {}

    def section(self, act: str | None = None, scene: str | None = None) -> None:
        entry: dict = {}
        if act is not None:
            entry["act"] = str(act)
        if scene is not None:
            entry["scene"] = str(scene)
        if not entry:
            raise ValueError("section needs an act or a scene")
        self.sections.append(entry)

    def stage(self, n: int = 1) -> None:
        self.stage_directions += n

    def speech(self, speaker: str, text: str, cue: str | None = None) -> None:
        """Add one speech. speaker is the canonical name, cue the spelling in the file."""
        speaker = collapse(speaker)
        # a direction removed from the start can leave its trailing "." behind
        text = collapse(text).lstrip(".,;: ")
        if not speaker:
            raise ValueError(f"empty speaker for text {text[:60]!r}")
        if not text:
            raise ValueError(f"empty text for speaker {speaker!r}")
        cues = self._cues.setdefault(speaker, [])
        cue = collapse(cue) if cue is not None else speaker
        if cue.rstrip(".:") == speaker:
            cue = speaker  # "ALGERNON." is the same spelling, not an alias
        if cue not in cues:
            cues.append(cue)
        self.speeches.append({"speaker": speaker, "text": text})

    def merge_into_previous(self, text: str) -> None:
        """Continue the previous speech (same cue split by a page or direction)."""
        text = collapse(text).lstrip(".,;: ")
        if text:
            prev = self.speeches[-1]
            prev["text"] = collapse(prev["text"] + " " + text)

    def characters(self) -> list[dict]:
        out = []
        for name, cues in self._cues.items():
            aliases = [c for c in cues if c != name]
            out.append({"name": name, "aliases": aliases})
        return out

    def to_json(self) -> dict:
        return {
            "title": self.title,
            "characters": self.characters(),
            "sections": self.sections,
            "speeches": self.speeches,
            "stageDirectionCount": self.stage_directions,
        }

    def write(self, fixture_dir: str) -> dict:
        data = self.to_json()
        validate(data)
        path = os.path.join(fixture_dir, "golden.json")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(
            f"wrote {path}: {len(data['speeches'])} speeches, "
            f"{len(data['characters'])} characters, {len(data['sections'])} sections, "
            f"{data['stageDirectionCount']} stage directions"
        )
        return data


def validate(data: dict) -> None:
    assert isinstance(data["title"], str) and data["title"]
    names = {c["name"] for c in data["characters"]}
    for i, s in enumerate(data["speeches"]):
        assert s["speaker"] in names, f"speech {i} speaker {s['speaker']!r} not in characters"
        assert s["text"] and s["text"] == collapse(s["text"]), f"speech {i} text not collapsed"
        assert "\n" not in s["text"]
        for bad in ("FTLN", "�"):
            assert bad not in s["text"], f"speech {i} contains {bad!r}: {s['text'][:80]}"
    for sec in data["sections"]:
        assert set(sec) <= {"act", "scene"} and sec
    assert isinstance(data["stageDirectionCount"], int)


def write_meta(fixture_dir: str, **meta) -> None:
    keys = ["title", "author", "format", "sourceUrl", "license", "description", "goldenMethod"]
    missing = [k for k in keys if not meta.get(k)]
    if missing:
        raise ValueError(f"meta missing {missing}")
    ordered = {k: meta[k] for k in keys}
    for k, v in meta.items():
        if k not in ordered:
            ordered[k] = v
    with open(os.path.join(fixture_dir, "meta.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(ordered, f, ensure_ascii=False, indent=2)
        f.write("\n")


def norm_tokens(text: str) -> list[str]:
    """Lowercase word tokens for fuzzy comparison (accents and punctuation dropped)."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = straight_quotes(text).lower().replace("'", "")
    return re.findall(r"[a-z0-9]+", text)


MARK = "\u2063"  # invisible separator, never in sources
_BRACKET = re.compile(r"\[[^\[\]]*\]")


def strip_bracketed(text: str, opener: str = "[", closer: str = "]") -> tuple[str, int]:
    """Remove bracketed stage directions; return (text, number removed)."""
    if opener == "[":
        pattern = _BRACKET
    else:
        o, c = re.escape(opener), re.escape(closer)
        pattern = re.compile(o + r"[^" + o + c + r"]*" + c)
    count = 0
    while True:
        text, n = pattern.subn(MARK, text)
        if not n:
            break
        count += n
    # "Good bye. [She goes]." -> "Good bye." (the period after the bracket is
    # the direction's own)
    text = re.sub(r"([.!?])\s*" + MARK + r"\s*\.", r"\1" + MARK, text)
    # "Cecily! [Embraces her.]." -> no stray space before the punctuation
    text = re.sub(r"\s*" + MARK + r"\s*(?=[,.;:!?])", "", text)
    text = text.replace(MARK, " ")
    return collapse(text), count


ORDINALS = {
    "FIRST": "1", "SECOND": "2", "THIRD": "3", "FOURTH": "4", "FIFTH": "5",
    "ONE": "1", "TWO": "2", "THREE": "3", "FOUR": "4", "FIVE": "5",
    "I": "1", "II": "2", "III": "3", "IV": "4", "V": "5", "VI": "6", "VII": "7",
    "VIII": "8", "IX": "9", "X": "10",
}
