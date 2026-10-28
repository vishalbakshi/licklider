// Build the essay from the reader's own copy of the PDF, in the browser.
// A port of tools/extract.swift (text lines) and tools/build.py (blocks), using pdf.js.
// Figure positions come from figures.json (crop boxes only); fixups.json patches the few
// characters where pdf.js reads the text differently from macOS, so offsets in
// annotations.json land on the same words as in the local reader.

// ---------- text lines, shaped like tools/extract.swift's layout.json ----------
async function extractPages(pdf) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const lines = [];
    let cur = [];
    const flush = () => {
      const its = cur.filter(i => i.str);
      cur = [];
      const t = its.map(i => i.str).join('');
      if (!t.trim()) return;
      const vis = its.filter(i => i.str.trim());
      let top = Infinity, bottom = -Infinity, right = -Infinity;
      for (const i of vis) {
        // PDFKit's line boxes: the font's ascent/descent, or 0.75/0.25 em for fonts that report less
        const st = tc.styles[i.fontName];
        const [asc, desc] = st.ascent >= 0.7 ? [st.ascent, st.descent] : [0.75, -0.25];
        const s = i.transform[3], base = vp.height - i.transform[5];
        top = Math.min(top, base - asc * s); bottom = Math.max(bottom, base - desc * s);
        right = Math.max(right, i.transform[4] + i.width);
      }
      const x = vis[0].transform[4];
      lines.push({ t: t.trim(), x, top, w: right - x, h: bottom - top, size: Math.max(...vis.map(i => i.transform[3])) });
    };
    for (const it of tc.items) { cur.push(it); if (it.hasEOL) flush(); }
    flush();
    pages.push({ page: n, width: vp.width, height: vp.height, lines, pdfPage: page });
  }
  return pages;
}

// ---------- blocks, a line-for-line port of tools/build.py ----------
const pyRound = v => { const f = Math.floor(v), d = v - f; return d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f; };  // round half to even
const isLower = c => !!c && c === c.toLowerCase() && c !== c.toUpperCase();

function joinLines(lines) {
  let out = '';
  for (let t of lines) {
    t = t.trim();
    if (!out) out = t;
    else if (/[A-Za-z]-$/.test(out) && isLower(t[0])) out = out.slice(0, -1) + t;   // de-hyphenate "suf-" + "ficient"
    else if ((out.endsWith('—') || out.endsWith('-')) && !out.endsWith(' -')) out += t;   // em-dash at line end: no space
    else out += ' ' + t;
  }
  return out.replaceAll('­', '').replace(/\s+/g, ' ');
}

const PRONOUNS = { he: 'they', him: 'them', his: 'their', himself: 'themself' };
// verbs that follow "he" in this essay, and their plural forms for "they"
const VERBS = { represents: 'represent', likes: 'like', seats: 'seat', dials: 'dial', calls: 'call',
  has: 'have', communicates: 'communicate', requests: 'request', uses: 'use', is: 'are', was: 'were' };
function neutralize(text, nouns = true) {
  // swap masculine pronouns and men/man for gender-neutral words, and fix the verb right after "they"
  text = text.replace(/\b(?:he|him|his|himself)\b/gi, w => {
    const r = PRONOUNS[w.toLowerCase()];
    return w[0] === w[0].toUpperCase() ? r[0].toUpperCase() + r.slice(1) : r;
  });
  text = text.replace(new RegExp(`\\b([Tt]hey(?: then| \\(or it\\))?) (${Object.keys(VERBS).join('|')})\\b`, 'g'), (m, a, v) => `${a} ${VERBS[v]}`);
  if (nouns) text = text.replace(/\b([Mm])(en|an)\b/g, (m, c, e) => (c === 'M' ? 'P' : 'p') + (e === 'en' ? 'eople' : 'erson'));
  return text;
}

function mergeSameBaseline(lines) {
  // some scanned lines come out as two pieces at the same height; rejoin them left to right
  lines = [...lines].sort((a, b) => a.top - b.top);
  const rows = [];
  for (const l of lines) {
    if (rows.length && Math.abs(rows[rows.length - 1][0].top - l.top) < 3) rows[rows.length - 1].push(l);
    else rows.push([l]);
  }
  return rows.map(row => {
    row.sort((a, b) => a.x - b.x);
    const first = { ...row[0] };
    if (row.length > 1) {
      first.t = row.map(r => r.t.trim()).join(' ');
      first.w = row[row.length - 1].x + row[row.length - 1].w - first.x;
    }
    return first;
  });
}

function buildBlocks(pages, figBoxes) {
  const blocks = [];
  let openPara = null;     // paragraph that may continue onto the next page
  const heldFigs = [];     // full-width figures waiting for the paragraph they interrupt to end
  const flush = () => {
    if (openPara) blocks.push({ kind: 'p', text: joinLines(openPara.lines), page: openPara.page });
    openPara = null;
    blocks.push(...heldFigs.splice(0));
  };

  // page 1: cover sheet -> title + meta
  blocks.push({ kind: 'title', text: 'The Computer as a Communication Device' });
  blocks.push({ kind: 'meta', text: 'J.C.R. Licklider and Robert W. Taylor' });
  blocks.push({ kind: 'meta', text: 'Reprinted from Science and Technology, April 1968' });

  for (const pg of pages.slice(1)) {
    const pno = pg.page;
    // drop page numbers (short numeric lines near the bottom)
    let lines = pg.lines.filter(l => !(/^\d{1,3}$/.test(l.t.trim()) && l.top > pg.height * 0.75));
    lines = mergeSameBaseline(lines);
    if (!lines.length) continue;
    const counts = new Map();
    for (const l of lines) { const k = pyRound(l.x); counts.set(k, (counts.get(k) || 0) + 1); }
    let margin = null, best = 0;
    for (const [k, c] of counts) if (c > best) { margin = k; best = c; }
    const colW = Math.max(...lines.map(l => l.w));
    const figs = [...(figBoxes[pno] || [])].sort((a, b) => a.top - b.top);
    const figQueue = [...figs];

    // caption lines: first line within 40pt below a full-width figure, then tightly spaced lines
    const captionOf = {};
    for (const f of figs) {
      if (f.right - f.left < 160) continue;   // margin doodle; its text is hand-drawn inside the image
      let prevBottom = f.bottom, limit = 40;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.top < f.bottom - 4) continue;
        if (l.top - prevBottom < limit) { captionOf[i] = f.file; prevBottom = l.top + l.h; limit = 8; }
        else break;
      }
    }

    const figBlocks = {};
    let prev = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // place any figure whose top sits above this line
      while (figQueue.length && figQueue[0].top <= l.top) {
        const f = figQueue.shift();
        const marginFig = f.right - f.left < 160;
        const fb = { kind: 'fig', file: f.file, caption: '', page: pno,
                     float: marginFig ? (f.left < margin ? 'left' : 'right') : null };
        figBlocks[f.file] = fb;
        if (marginFig || openPara === null) blocks.push(fb); else heldFigs.push(fb);
      }
      if (i in captionOf) {
        const fb = figBlocks[captionOf[i]];
        fb.caption = fb.caption ? joinLines([fb.caption, l.t]) : l.t.trim();
        prev = null;
        continue;
      }
      if (pno === pages.length && openPara && openPara.lines[0].startsWith('[') && !l.t.trimStart().startsWith('[')) {
        openPara.lines.push(l.t.trim());   // hanging-indent reference continuation
        prev = l;
        continue;
      }
      const gap = prev ? l.top - (prev.top + prev.h) : 0;
      const indented = l.x > margin + 8;
      const text = l.t.trim();
      const isHeading = (prev === null || gap > 12) && !indented && l.w < colW * 0.7
        && !/[.,;]$/.test(text) && text.length < 60
        && (i + 1 < lines.length && lines[i + 1].top - (l.top + l.h) > 6);
      if (pno === 2 && l.size > 14) { prev = l; continue; }   // article title repeated on page 2
      if (isHeading) { flush(); blocks.push({ kind: 'h', text, page: pno }); }
      else if (indented || openPara === null || gap > 10) { flush(); openPara = { lines: [text], page: pno }; }
      else openPara.lines.push(text);
      prev = l;
    }
    for (const f of figQueue) { flush(); blocks.push({ kind: 'fig', file: f.file, caption: '', page: pno, float: null }); }
  }
  flush();

  blocks.forEach((b, i) => {
    b.id = 'b' + i;
    if (b.kind === 'p') b.text = neutralize(b.text, !b.text.startsWith('['));   // cited titles stay as published
    else if (b.kind === 'fig') b.caption = neutralize(b.caption);
  });
  return blocks;
}

// ---------- the whole pipeline ----------
async function buildEssay(pdfData, figBoxes, fixups) {
  const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
  const pages = await extractPages(pdf);
  const blocks = buildBlocks(pages, figBoxes);
  // patch the characters pdf.js reads differently (positions only, no essay text)
  const byId = Object.fromEntries(blocks.map(b => [b.id, b]));
  for (const f of [...fixups].sort((a, b) => b.at - a.at)) {
    const b = byId[f.block], key = b.kind === 'fig' ? 'caption' : 'text';
    b[key] = b[key].slice(0, f.at) + f.ins + b[key].slice(f.at + f.del);
  }
  // crop figures from the reader's PDF at 3x, like extract.swift
  for (const b of blocks.filter(b => b.kind === 'fig')) {
    const box = figBoxes[b.page].find(f => f.file === b.file);
    const page = pages[b.page - 1].pdfPage, vp = page.getViewport({ scale: 3 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    // 'print' intent renders without requestAnimationFrame, so it doesn't stall in a background tab
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    const [x0, y0, x1, y1] = [box.left, box.top, box.right, box.bottom].map(v => Math.round(v * 3));
    const crop = document.createElement('canvas');
    crop.width = x1 - x0; crop.height = y1 - y0;
    crop.getContext('2d').drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    b.src = crop.toDataURL('image/png');
  }
  return blocks;
}
