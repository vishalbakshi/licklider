"""Turn layout.json (from extract.swift) into app/paper.json: an ordered list of blocks.

Block kinds: title, meta, h (section heading), p (paragraph), fig (image + caption).
Run: python3 -I tools/build.py <layout.json> <figure-dir> <app-dir>
"""
import json
import os
import re
import shutil
import sys
from collections import Counter

layout_path, fig_src, app_dir = sys.argv[1:4]
pages = json.load(open(layout_path))
os.makedirs(os.path.join(app_dir, "figures"), exist_ok=True)


def join_lines(lines):
    out = ""
    for t in lines:
        t = t.strip()
        if not out:
            out = t
        elif re.search(r"[A-Za-z]-$", out) and t[:1].islower():
            out = out[:-1] + t          # de-hyphenate "suf-" + "ficient"
        elif out.endswith(("—", "-")) and not out.endswith(" -"):
            out += t                    # em-dash at line end: no space
        else:
            out += " " + t
    out = out.replace("­", "")
    return re.sub(r"\s+", " ", out)


PRONOUNS = {"he": "they", "him": "them", "his": "their", "himself": "themself"}
# verbs that follow "he" in this essay, and their plural forms for "they"
VERBS = {"represents": "represent", "likes": "like", "seats": "seat", "dials": "dial", "calls": "call",
         "has": "have", "communicates": "communicate", "requests": "request", "uses": "use", "is": "are", "was": "were"}


def neutralize(text, nouns=True):
    """Swap masculine pronouns and men/man for gender-neutral words, and fix the verb right after "they"."""
    def swap(m):
        w = m.group(0)
        r = PRONOUNS[w.lower()]
        return r.capitalize() if w[0].isupper() else r
    text = re.sub(r"\b(?:he|him|his|himself)\b", swap, text, flags=re.I)
    # men -> people, man -> person, man-computer -> person-computer
    if nouns:
        text = re.sub(r"\b([Mm])(en|an)\b",
                      lambda m: ("P" if m.group(1) == "M" else "p") + ("eople" if m.group(2) == "en" else "erson"), text)
    return re.sub(r"\b([Tt]hey(?: then| \(or it\))?) (" + "|".join(VERBS) + r")\b",
                  lambda m: f"{m.group(1)} {VERBS[m.group(2)]}", text)


blocks = []
open_para = None    # paragraph that may continue onto the next page
held_figs = []      # full-width figures waiting for the paragraph they interrupt to end


def flush():
    global open_para
    if open_para:
        blocks.append({"kind": "p", "text": join_lines(open_para["lines"]), "page": open_para["page"]})
    open_para = None
    blocks.extend(held_figs)
    held_figs.clear()


def merge_same_baseline(lines):
    """Some scanned lines come out as two selections at the same height; rejoin them left to right."""
    lines = sorted(lines, key=lambda l: l["top"])
    rows = []
    for l in lines:
        if rows and abs(rows[-1][0]["top"] - l["top"]) < 3:
            rows[-1].append(l)
        else:
            rows.append([l])
    merged = []
    for row in rows:
        row.sort(key=lambda l: l["x"])
        first = dict(row[0])
        if len(row) > 1:
            first["t"] = " ".join(r["t"].strip() for r in row)
            first["w"] = row[-1]["x"] + row[-1]["w"] - first["x"]
        merged.append(first)
    return merged


# --- page 1: cover sheet -> title + meta
cover = [l["t"].strip() for l in pages[0]["lines"]]
blocks.append({"kind": "title", "text": "The Computer as a Communication Device"})
blocks.append({"kind": "meta", "text": "J.C.R. Licklider and Robert W. Taylor"})
blocks.append({"kind": "meta", "text": "Reprinted from Science and Technology, April 1968"})

for pg in pages[1:]:
    pno = pg["page"]
    # drop page numbers (short numeric lines near the bottom)
    lines = [l for l in pg["lines"] if not (re.fullmatch(r"\d{1,3}", l["t"].strip()) and l["top"] > pg["height"] * 0.75)]
    lines = merge_same_baseline(lines)
    if not lines:
        continue
    margin = Counter(round(l["x"]) for l in lines).most_common(1)[0][0]
    col_w = max(l["w"] for l in lines)
    figs = sorted(pg["figures"], key=lambda f: f["top"])
    fig_queue = list(figs)

    # caption lines: first line within 40pt below a full-width figure, then tightly spaced lines
    caption_of = {}
    for f in figs:
        if f["right"] - f["left"] < 160:   # margin doodle; its text is hand-drawn inside the image
            continue
        prev_bottom, limit = f["bottom"], 40
        for i, l in enumerate(lines):
            if l["top"] < f["bottom"] - 4:
                continue
            if l["top"] - prev_bottom < limit:
                caption_of[i] = f["file"]
                prev_bottom, limit = l["top"] + l["h"], 8
            else:
                break

    fig_blocks = {}
    prev = None
    for i, l in enumerate(lines):
        # place any figure whose top sits above this line
        while fig_queue and fig_queue[0]["top"] <= l["top"]:
            f = fig_queue.pop(0)
            margin_fig = f["right"] - f["left"] < 160
            fb = {"kind": "fig", "file": f["file"], "caption": "", "page": pno,
                  "float": ("left" if f["left"] < margin else "right") if margin_fig else None}
            fig_blocks[f["file"]] = fb
            if margin_fig or open_para is None:
                blocks.append(fb)
            else:
                held_figs.append(fb)
        if i in caption_of:
            fb = fig_blocks[caption_of[i]]
            fb["caption"] = join_lines([fb["caption"], l["t"]]) if fb["caption"] else l["t"].strip()
            prev = None
            continue
        if pno == len(pages) and open_para and open_para["lines"][0].startswith("[") and not l["t"].lstrip().startswith("["):
            open_para["lines"].append(l["t"].strip())   # hanging-indent reference continuation
            prev = l
            continue

        gap = l["top"] - (prev["top"] + prev["h"]) if prev else 0
        indented = l["x"] > margin + 8
        text = l["t"].strip()
        is_heading = (
            (prev is None or gap > 12)
            and not indented
            and l["w"] < col_w * 0.7
            and not text.endswith((".", ",", ";"))
            and len(text) < 60
            and (i + 1 < len(lines) and lines[i + 1]["top"] - (l["top"] + l["h"]) > 6)
        )
        if pno == 2 and l["size"] > 14:
            prev = l
            continue  # article title repeated on page 2
        if is_heading:
            flush()
            blocks.append({"kind": "h", "text": text, "page": pno})
        elif indented or open_para is None or gap > 10:
            flush()
            open_para = {"lines": [text], "page": pno}
        else:
            open_para["lines"].append(text)
        prev = l
    for f in fig_queue:
        flush()
        blocks.append({"kind": "fig", "file": f["file"], "caption": "", "page": pno, "float": None})

flush()

for i, b in enumerate(blocks):
    b["id"] = f"b{i}"
    if b["kind"] == "p":
        b["text"] = neutralize(b["text"], nouns=not b["text"].startswith("["))   # cited titles stay as published
    elif b["kind"] == "fig":
        b["caption"] = neutralize(b["caption"])
    if b["kind"] == "fig":
        shutil.copy(os.path.join(fig_src, b["file"]), os.path.join(app_dir, "figures", b["file"]))

json.dump(blocks, open(os.path.join(app_dir, "paper.json"), "w"), indent=1, ensure_ascii=False)
print(len(blocks), "blocks;", Counter(b["kind"] for b in blocks))
