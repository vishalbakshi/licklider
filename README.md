# Licklider reader

A reader for J.C.R. Licklider and Robert W. Taylor's 1968 essay "The Computer as a Communication Device", with my highlights, notes, questions to Claude, and drawings on top.

The essay itself is not in this repo. You download the PDF from [internetat50.com](https://internetat50.com/references/Licklider_Taylor_The-Computer-As-A-Communications-Device.pdf), and the essay is built from your copy.

This copy uses gender-neutral wording (he → they, men → people, and so on). The 1968 original uses masculine words.

## Read my annotations

Open http://vishalbakshi.com/licklider/ and drop the PDF on the page. It is read-only: you can open my chats and drawings, pop passages out, and filter by kind, but you can't add anything.

## Run your own copy

The full reader in `local/` lets you highlight, take notes, ask Claude about passages, and draw. It only works with this one PDF.

You need:

- a Mac (the PDF is read with macOS's PDFKit through Swift, which comes with Xcode or its command line tools)
- Python 3
- [Claude Code](https://claude.com/claude-code), installed and logged in. Questions run through the `claude` command, so they use your own Claude account. No API key is needed.

Then:

```bash
git clone https://github.com/vishalbakshi/licklider
cd licklider/local
tools/rebuild.sh
python3 server.py
```

`tools/rebuild.sh` downloads the PDF and builds the essay text and figures. Then open http://localhost:8770.

You start with my annotations. They are in `local/annotations.json`, and the "delete all" link at the top right clears them if you want a blank copy.

## Keys

Select some text, then press:

| Key | What it does |
|---|---|
| A | Ask Claude about the passage (cyan) |
| N | Write a note (navy). In a note's chat, click Ask to send a question along with your notes. |
| H | Highlight (yellow) |
| U | Underline |
| P | Pop the passage out full screen. P again closes it. |
| D | Open a drawing pad with a pen, a straight line tool and text. D again closes it. |
| X | Clear the marks on the selection |

⌘ or Shift with A, N, P, H or U shows only the paragraphs with that kind of mark. Use Shift for H and N, because the browser keeps ⌘H and ⌘N. The buttons on the left do the same.

Claude can search the web when a question needs current information.
