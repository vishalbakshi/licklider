"""Shift saved note offsets in data/threads.json after the essay text changes.

Notes are stored as character offsets into the rendered essay text. When
paper.json is rebuilt with different text, run this with the old paper.json:

    git show HEAD:app/paper.json > /tmp/old_paper.json
    python3 -I tools/remap_notes.py /tmp/old_paper.json app/paper.json data/threads.json
"""
import bisect
import difflib
import json
import shutil
import sys

old_path, new_path, notes_path = sys.argv[1:4]


def rendered_text(path):
    # same order and content as the text nodes index.html renders (UI-only notes excluded)
    return "".join(b.get("text") or b.get("caption") or "" for b in json.load(open(path)))


old, new = rendered_text(old_path), rendered_text(new_path)
ops = difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes()
starts = [o[1] for o in ops]


def remap(pos, is_end):
    i = max(0, bisect.bisect_right(starts, pos) - 1)
    tag, i1, i2, j1, j2 = ops[i]
    if tag == "equal":
        return j1 + (pos - i1)
    if pos == i1:
        return j1
    return j2 if is_end else j1  # inside a changed span: widen to cover it


shutil.copy(notes_path, notes_path + ".bak")
notes = json.load(open(notes_path))
for n in notes:
    n["start"], n["end"] = remap(n["start"], False), remap(n["end"], True)
    n["quote"] = " ".join(new[n["start"]:n["end"]].split())
json.dump(notes, open(notes_path, "w"), indent=1, ensure_ascii=False)
print(f"remapped {len(notes)} notes; backup at {notes_path}.bak")
