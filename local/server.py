"""Local reader for Licklider & Taylor (1968) with highlight-to-ask.

Serves app/ on http://localhost:8770 and answers questions by running the
`claude` CLI in print mode, so it uses your Claude Code login (no API key).

    tools/rebuild.sh             # first time: download the PDF and build app/paper.json + figures
    python3 server.py            # then open http://localhost:8770
    CLAUDE_MODEL=sonnet python3 server.py

Your asks, notes, highlights, underlines and pop-outs are saved in annotations.json
as character offsets into the built essay (no essay text), so they come back after a rebuild.
"""
import json
import os
import shutil
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(ROOT, "app")
DATA = os.path.join(ROOT, "data")   # scratch dir the claude CLI runs in
THREADS = os.path.join(ROOT, "annotations.json")
PORT = int(os.environ.get("PORT", 8770))
MODEL = os.environ.get("CLAUDE_MODEL")  # e.g. "sonnet"; default = your Claude Code default
WEB_TOOLS = "WebSearch,WebFetch"
CLAUDE = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")

os.makedirs(DATA, exist_ok=True)
save_lock = threading.Lock()


def paper_text():
    blocks = json.load(open(os.path.join(APP, "paper.json")))
    out = []
    for b in blocks:
        if b["kind"] == "title":
            out.append("# " + b["text"])
        elif b["kind"] == "h":
            out.append("## " + b["text"])
        elif b["kind"] == "fig":
            if b["caption"]:
                out.append(f"[Figure: {b['caption']}]")
        else:
            out.append(b["text"])
    return "\n\n".join(out)


SYSTEM = f"""You are a reading companion inside a local reader for J.C.R. Licklider and Robert W. Taylor's 1968 essay "The Computer as a Communication Device".

The reader highlights a passage and asks about it. Write ~90% caveman: short words, short clipped sentences, drop most articles and filler. But keep enough small words ("the", "is", "because", "but") that each sentence reads smooth on first pass; clarity beats purity. No preamble, no restating question, no pleasantries. Example style: "Claim very bold. In 1968 no ARPANET yet, only a few time-sharing sites. Licklider was funding the network anyway. Bet paid off, but slower than 'few years.'"
Facts must still be right: history (ARPA, IPTO, time-sharing, ARPANET, Engelbart demo), links to today. Say "guess" when guessing. You can search the web and fetch pages: do it when the reader asks you to or when the answer needs current or specific facts you aren't sure of, and name the sources you used. Usually 1-4 lines. Longer only if reader ask. Plain text; bullet list only if truly list.

In this copy the wording is gender-neutral (he/him/his became they/them/their, men/man became people/person, "man-computer" became "person-computer"; cited titles unchanged); the 1968 original uses masculine words. Quote this copy's wording.

The full text of the essay follows.

<essay>
{paper_text()}
</essay>"""


def build_prompt(req):
    parts = [f"Highlighted passage:\n\"\"\"\n{req['quote']}\n\"\"\""]
    if req.get("context"):
        parts.append(f"Surrounding paragraph(s):\n\"\"\"\n{req['context']}\n\"\"\"")
    history = req.get("messages", [])
    if len(history) > 1:
        who = {"user": "Reader", "note": "Reader's note", "assistant": "You"}
        convo = "\n\n".join(f"{who.get(m['role'], 'Reader')}: {m['content']}" for m in history[:-1])
        parts.append(f"The reader's notes and conversation so far about this passage:\n{convo}")
    parts.append(f"Reader's question: {history[-1]['content']}")
    return "\n\n".join(parts)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=APP, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def read_json(self):
        n = int(self.headers.get("Content-Length", 0))
        if n > 5_000_000:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(n) or b"null")

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/threads":
            try:
                return self.send_json(json.load(open(THREADS)))
            except FileNotFoundError:
                return self.send_json([])
        return super().do_GET()

    def do_PUT(self):
        if self.path != "/api/threads":
            return self.send_error(404)
        # the page rebuilds quote and context from the essay, so keep the file free of essay text
        threads = [{k: v for k, v in t.items() if k not in ("quote", "context")} for t in self.read_json()]
        with save_lock:
            tmp = THREADS + ".tmp"
            json.dump(threads, open(tmp, "w"), indent=1, ensure_ascii=False)
            os.replace(tmp, THREADS)
        self.send_json({"ok": True})

    def do_POST(self):
        if self.path != "/api/ask":
            return self.send_error(404)
        req = self.read_json()
        # web search and page fetching only: no shell, no file access
        cmd = [CLAUDE, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
               "--no-session-persistence", "--tools", WEB_TOOLS, "--allowedTools", WEB_TOOLS, "--system-prompt", SYSTEM]
        if MODEL:
            cmd += ["--model", MODEL]

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()

        proc = subprocess.Popen(cmd, cwd=DATA, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, bufsize=1)
        proc.stdin.write(build_prompt(req))
        proc.stdin.close()
        streamed = False
        try:
            for line in proc.stdout:
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                text = None
                if ev.get("type") == "stream_event":
                    e = ev.get("event", {})
                    if e.get("type") == "content_block_delta" and e.get("delta", {}).get("type") == "text_delta":
                        text = e["delta"]["text"]
                    elif e.get("type") == "content_block_start" and e.get("content_block", {}).get("type") == "text" and streamed:
                        text = "\n\n"   # text before and after a web search: keep them as separate paragraphs
                elif ev.get("type") == "result" and not streamed:
                    text = ev.get("result") or ""
                if text:
                    streamed = True
                    self.wfile.write(text.encode())
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            proc.kill()  # reader closed the tooltip mid-answer
            return
        proc.wait()
        if not streamed:
            err = proc.stderr.read().strip()[-800:] or f"claude exited with code {proc.returncode}"
            self.wfile.write(f"\n\n**Error from claude CLI:** {err}".encode())


if __name__ == "__main__":
    print(f"Reading at http://localhost:{PORT}  (claude: {CLAUDE}{', model ' + MODEL if MODEL else ''})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
