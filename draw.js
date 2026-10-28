// Drawing pad for a passage: pen, straight line and text, black on white.
// Strokes are stored in logical units (W x H) so a drawing looks the same at any window size:
//   {type: 'pen', points: [[x, y], ...]} · {type: 'line', a: [x, y], b: [x, y]} · {type: 'text', at: [x, y], text, angle?}
// Used by app/index.html (editable) and share/index2.html (read-only).
const Draw = (() => {
  const W = 1200, H = 800, FONT = 24;
  let el, canvas, ctx, input = null;
  let strokes = [], onChange = () => {}, readOnly = false, tool = 'pen', current = null;
  let selected = -1, drag = null;   // text being moved or rotated

  function build() {
    const style = document.createElement('style');
    style.textContent = `
      #draw { position: fixed; inset: 0; z-index: 102; display: none; flex-direction: column; align-items: center;
              box-sizing: border-box; padding: 16px; background: #fff; color: #000; font-family: sans-serif; }
      #draw.open { display: flex; }
      #draw .draw-bar { display: flex; align-items: center; gap: 8px; width: 100%; margin-bottom: 12px; }
      #draw button { padding: 4px 10px; border: 1px solid #000; background: #fff; color: #000; font: inherit; cursor: pointer; }
      #draw button.on { background: #000; color: #fff; }
      #draw .draw-quote { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-family: serif; font-style: italic; }
      #draw .draw-hint { font-size: 12px; }
      #draw canvas { border: 1px solid #000; touch-action: none; cursor: crosshair; }
      #draw.readonly canvas { cursor: default; }
      #draw .draw-text { position: fixed; margin: 0; padding: 0; border: 0; outline: 1px dashed #000;
                         background: transparent; color: #000; font-family: sans-serif; }`;
    document.head.appendChild(style);
    el = document.createElement('div');
    el.id = 'draw';
    el.innerHTML = `<div class="draw-bar">
        <button type="button" data-tool="pen">Pen</button>
        <button type="button" data-tool="line">Line</button>
        <button type="button" data-tool="text">Text</button>
        <span class="draw-quote"></span>
        <span class="draw-hint">D to close · ⌘Z undo</span>
      </div>
      <canvas></canvas>`;
    document.body.appendChild(el);
    canvas = el.querySelector('canvas');
    ctx = canvas.getContext('2d');
    el.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    addEventListener('resize', () => isOpen() && fit());
  }

  function setTool(t) {
    commitText();
    tool = t; selected = -1;
    canvas.style.cursor = '';
    if (ctx) redraw();
    el.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  }

  function scale() { return canvas.getBoundingClientRect().width / W; }
  function fit() {
    // largest size that keeps the W x H shape on screen
    const bar = el.querySelector('.draw-bar').offsetHeight;
    const s = Math.min((innerWidth - 34) / W, (innerHeight - bar - 46) / H);
    const dpr = devicePixelRatio || 1;
    canvas.style.width = W * s + 'px'; canvas.style.height = H * s + 'px';
    canvas.width = Math.round(W * s * dpr); canvas.height = Math.round(H * s * dpr);
    ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
    redraw();
  }

  // text boxes: `at` is the top-left before rotation; `angle` (radians) turns the text about its centre
  const HANDLE = 30, PAD = 6;
  function box(st) {
    ctx.font = `${FONT}px sans-serif`;
    const w = ctx.measureText(st.text).width, h = FONT;
    return { w, h, cx: st.at[0] + w / 2, cy: st.at[1] + h / 2, angle: st.angle || 0 };
  }
  function local(st, p) {
    // point p in the text's own (unrotated) frame, origin at its centre
    const b = box(st), dx = p[0] - b.cx, dy = p[1] - b.cy, c = Math.cos(-b.angle), s = Math.sin(-b.angle);
    return [dx * c - dy * s, dx * s + dy * c, b];
  }
  function hitText(p) {
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (strokes[i].type !== 'text') continue;
      const [x, y, b] = local(strokes[i], p);
      if (Math.abs(x) <= b.w / 2 + PAD && Math.abs(y) <= b.h / 2 + PAD) return i;
    }
    return -1;
  }
  function hitHandle(p) {
    if (selected < 0 || !strokes[selected]) return false;
    const [x, y, b] = local(strokes[selected], p);
    return Math.hypot(x, y + b.h / 2 + PAD + HANDLE) <= 12;
  }

  function redraw() {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = ctx.fillStyle = '#000';
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const st of current ? [...strokes, current] : strokes) {
      if (st.type === 'text') {
        const b = box(st);
        ctx.save(); ctx.translate(b.cx, b.cy); ctx.rotate(b.angle);
        ctx.textBaseline = 'middle'; ctx.fillText(st.text, -b.w / 2, 0);
        ctx.restore();
        continue;
      }
      const pts = st.type === 'pen' ? st.points : [st.a, st.b];
      ctx.beginPath();
      ctx.moveTo(...pts[0]);
      for (const q of pts.slice(1)) ctx.lineTo(...q);
      if (pts.length === 1) ctx.lineTo(...pts[0]);   // a single click leaves a dot
      ctx.stroke();
    }
    if (selected >= 0 && strokes[selected] && !readOnly) {
      // dashed box, plus a circle above it to drag for rotating
      const b = box(strokes[selected]), top = -b.h / 2 - PAD;
      ctx.save(); ctx.translate(b.cx, b.cy); ctx.rotate(b.angle); ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]); ctx.strokeRect(-b.w / 2 - PAD, top, b.w + 2 * PAD, b.h + 2 * PAD); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(0, top - HANDLE + 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, top - HANDLE, 7, 0, 2 * Math.PI); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  // undo keeps snapshots of the strokes taken before each change
  const history = [];
  function remember() { history.push(JSON.stringify(strokes)); }
  function changed() { redraw(); onChange(); }

  function pt(e) {
    const r = canvas.getBoundingClientRect();
    return [Math.round((e.clientX - r.left) / r.width * W), Math.round((e.clientY - r.top) / r.height * H)];
  }
  function down(e) {
    if (readOnly || e.button !== 0) return;
    const p = pt(e);
    if (tool === 'text') {
      e.preventDefault();
      if (hitHandle(p)) drag = { mode: 'rotate', moved: false };
      else if (hitText(p) >= 0) {
        commitText();
        selected = hitText(p);
        const at = strokes[selected].at;
        drag = { mode: 'move', off: [p[0] - at[0], p[1] - at[1]], moved: false };
      } else { selected = -1; redraw(); return placeText(e); }
      remember();
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      redraw();
      return;
    }
    try { canvas.setPointerCapture(e.pointerId); } catch {}   // keep the stroke going if the pointer leaves the canvas
    current = tool === 'pen' ? { type: 'pen', points: [p] } : { type: 'line', a: p, b: p };
    redraw();
  }
  function move(e) {
    const p = pt(e);
    if (drag) {
      const st = strokes[selected];
      if (drag.mode === 'move') st.at = [p[0] - drag.off[0], p[1] - drag.off[1]];
      else {
        const b = box(st);
        let a = Math.atan2(p[1] - b.cy, p[0] - b.cx) + Math.PI / 2;
        const step = Math.PI / 12;   // snap to 15° steps when close
        if (Math.abs(a - Math.round(a / step) * step) < 0.05) a = Math.round(a / step) * step;
        st.angle = +a.toFixed(4);
      }
      drag.moved = true;
      return redraw();
    }
    if (tool === 'text' && !readOnly) canvas.style.cursor = hitHandle(p) ? 'grab' : hitText(p) >= 0 ? 'move' : 'text';
    if (!current) return;
    if (current.type === 'line') current.b = p;
    else if (String(p) !== String(current.points[current.points.length - 1])) current.points.push(p);
    redraw();
  }
  function up() {
    if (drag) {
      if (drag.moved) changed(); else history.pop();
      drag = null;
      return;
    }
    if (!current) return;
    remember();
    strokes.push(current);
    current = null;
    changed();
  }

  function placeText(e) {
    commitText();
    const at = pt(e), s = scale();
    input = document.createElement('input');
    input.className = 'draw-text';
    input.style.left = e.clientX + 'px'; input.style.top = (e.clientY - FONT * s / 2) + 'px';
    input.style.fontSize = FONT * s + 'px'; input.style.width = Math.max(120, (W - at[0]) * s - 8) + 'px';
    input.dataset.at = [at[0], at[1] - FONT / 2];
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();   // typing never triggers reader keys
      if (ev.key === 'Enter') commitText();
      else if (ev.key === 'Escape') { input.remove(); input = null; }
    });
    input.addEventListener('blur', () => setTimeout(commitText));
    el.appendChild(input);
    input.focus({ preventScroll: true });   // without preventScroll the page behind jumps to the bottom
  }
  function commitText() {
    if (!input) return;
    const text = input.value.trim(), at = input.dataset.at.split(',').map(Number);
    input.remove(); input = null;
    if (!text) return;
    remember();
    strokes.push({ type: 'text', at, text });
    selected = strokes.length - 1;   // ready to move or rotate
    changed();
  }

  function undo() {
    if (readOnly || !history.length) return;
    strokes.splice(0, strokes.length, ...JSON.parse(history.pop()));
    selected = -1;
    changed();
  }
  function deleteSelected() {
    if (readOnly || selected < 0 || !strokes[selected]) return;
    remember();
    strokes.splice(selected, 1);
    selected = -1;
    changed();
  }

  function open(opts) {
    if (!el) build();
    strokes = opts.strokes; onChange = opts.onChange || (() => {}); readOnly = !!opts.readOnly;
    history.length = 0; selected = -1; drag = null;
    el.querySelector('.draw-quote').textContent = opts.quote ? `“${opts.quote}”` : '';
    el.querySelectorAll('[data-tool]').forEach(b => b.style.display = readOnly ? 'none' : '');
    el.querySelector('.draw-hint').textContent = readOnly ? 'D to close'
      : 'D to close · ⌘Z undo · Text: drag to move, drag ○ to rotate, Delete removes';
    el.classList.toggle('readonly', readOnly);
    el.classList.add('open');
    setTool('pen');
    fit();
  }
  function close() { commitText(); current = null; drag = null; selected = -1; el.classList.remove('open'); }
  function isOpen() { return !!el && el.classList.contains('open'); }

  return { open, close, isOpen, undo, deleteSelected };
})();
