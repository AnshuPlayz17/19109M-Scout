// Strategy whiteboard: draw on the field with pen, marker, pencil and eraser, and drag robot
// tokens around. Works with Apple Pencil (pressure, palm rejection), fingers and a mouse.
// Strokes are stored as field fractions (0..1), so the drawing survives resizing and rotation,
// and saved on this device.

const TOOLS = {
  pen: { width: [2, 3.5, 6], alpha: 1, pressure: 0.75 },
  marker: { width: [12, 20, 30], alpha: 0.38, pressure: 0 },
  pencil: { width: [1.2, 2, 3.2], alpha: 0.8, pressure: 0.9 },
  eraser: { width: [14, 28, 48], alpha: 1, pressure: 0 },
};
export const COLORS = [["#f5f5f5", "White"], ["#1c1d21", "Black"], ["#e5484d", "Red"], ["#3e7bff", "Blue"], ["#f2c94c", "Yellow"], ["#3ccf73", "Green"]];


/**
 * Builds the board once; the app keeps the same element across redraws so the drawing and
 * any stroke in progress aren't lost when live data arrives.
 * `h` and `icon` are the app's element helpers. `onIdle` runs after each stroke or drag ends.
 * `field` is the field picture and `key` where the drawing is saved (one board per game).
 */
export function createBoard({ h, icon, onIdle, field: fieldImage = "field.webp", key = "19109m.board", starts = [0.38, 0.62] }) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } })();
  let strokes = saved.strokes || [], redo = [];
  let tokens = saved.tokens || null; // [{ id, x, y, color, label }]
  let tool = saved.tool || "pen", color = saved.color || COLORS[0][0], size = saved.size ?? 1, showTokens = saved.showTokens ?? true;
  let current = null, drag = null, sawPen = false, busy = false;
  const save = () => { try { localStorage.setItem(key, JSON.stringify({ strokes, tokens, tool, color, size, showTokens })); } catch {} };

  const img = h("img", { src: fieldImage, alt: "", draggable: "false" });
  const ink = h("canvas", { class: "ink" });
  const live = h("canvas", { class: "live" });
  const tokenLayer = h("div", { class: "tokens" });
  const field = h("div", { class: "wb-field", role: "img", "aria-label": "Field whiteboard" }, img, ink, live, tokenLayer);

  // ---- drawing
  const px = () => ink.width; // the canvas is square
  const widthAt = (s, p) => {
    const t = TOOLS[s.tool], base = t.width[s.size] * (px() / 700);
    return t.pressure ? base * (1 - t.pressure + t.pressure * 2 * (p ?? 0.5)) : base;
  };
  function strokePath(ctx, s, from = 0) {
    const n = px(), pts = s.points;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = s.tool === "eraser" ? "#000" : s.color;
    if (pts.length === 1) {
      ctx.beginPath(); ctx.fillStyle = ctx.strokeStyle;
      ctx.arc(pts[0][0] * n, pts[0][1] * n, widthAt(s, pts[0][2]) / 2, 0, Math.PI * 2); ctx.fill(); return;
    }
    // Smooth curve through the midpoints, each piece as wide as the pressure there.
    for (let i = Math.max(1, from); i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], prev = pts[i - 2] || a;
      const m0 = [(prev[0] + a[0]) / 2, (prev[1] + a[1]) / 2], m1 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      ctx.beginPath(); ctx.lineWidth = widthAt(s, (a[2] + b[2]) / 2);
      ctx.moveTo(m0[0] * n, m0[1] * n); ctx.quadraticCurveTo(a[0] * n, a[1] * n, m1[0] * n, m1[1] * n); ctx.stroke();
    }
  }
  const scratch = document.createElement("canvas");
  function paint(ctx, s) {
    if (s.tool === "marker") {
      // Draw the whole stroke solid, then lay it down see-through, so overlaps don't darken.
      scratch.width = scratch.height = px();
      const sc = scratch.getContext("2d"); strokePath(sc, s);
      ctx.save(); ctx.globalAlpha = TOOLS.marker.alpha; ctx.drawImage(scratch, 0, 0); ctx.restore();
      return;
    }
    ctx.save();
    if (s.tool === "eraser") ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = TOOLS[s.tool].alpha;
    strokePath(ctx, s);
    ctx.restore();
  }
  function redraw() {
    const ctx = ink.getContext("2d");
    ctx.clearRect(0, 0, ink.width, ink.height);
    for (const s of strokes) paint(ctx, s);
  }
  const fit = () => {
    const n = Math.round(field.clientWidth * (devicePixelRatio || 1));
    if (!n || n === ink.width) return;
    ink.width = ink.height = live.width = live.height = n;
    redraw(); drawTokens();
  };
  new ResizeObserver(fit).observe(field);

  // Keep getting moves even if the pencil slides off the field (fine to skip if the browser says no).
  const capture = e => { try { field.setPointerCapture(e.pointerId); } catch {} };
  const at = e => { const r = field.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const round3 = v => Math.round(v * 1000) / 1000;
  const point = e => { const [x, y] = at(e); return [round3(x), round3(y), e.pointerType === "pen" ? round3(e.pressure || 0.5) : 0.5]; };
  // Draw the newest bit of the stroke: straight onto the ink for pen, pencil and eraser;
  // on the live layer for the marker (it's redrawn see-through when the stroke ends).
  function extend() {
    const s = current;
    if (s.tool === "marker") {
      const ctx = live.getContext("2d"); ctx.clearRect(0, 0, live.width, live.height);
      ctx.save(); ctx.globalAlpha = TOOLS.marker.alpha; scratch.width = scratch.height = px(); strokePath(scratch.getContext("2d"), s); ctx.drawImage(scratch, 0, 0); ctx.restore();
      return;
    }
    const ctx = ink.getContext("2d");
    ctx.save();
    if (s.tool === "eraser") ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = TOOLS[s.tool].alpha;
    strokePath(ctx, s, Math.max(1, s.points.length - 2));
    ctx.restore();
  }

  field.addEventListener("pointerdown", e => {
    if (e.pointerType === "pen") sawPen = true;
    const tok = e.target.closest(".token");
    if (tok) { // drag a robot
      e.preventDefault(); capture(e); busy = true;
      const t = tokens.find(x => x.id === tok.dataset.id), [x, y] = at(e);
      drag = { id: e.pointerId, t, dx: t.x - x, dy: t.y - y, el: tok };
      tok.classList.add("lifted");
      return;
    }
    if (sawPen && e.pointerType === "touch") return; // palm rejection once a pencil is in use
    if (e.button > 0 || current) return;
    e.preventDefault(); capture(e); busy = true;
    current = { id: e.pointerId, tool, color, size, points: [point(e)] };
    extend();
  });
  field.addEventListener("pointermove", e => {
    if (drag && e.pointerId === drag.id) {
      const [x, y] = at(e);
      drag.t.x = Math.min(1, Math.max(0, x + drag.dx)); drag.t.y = Math.min(1, Math.max(0, y + drag.dy));
      drag.el.style.left = `${drag.t.x * 100}%`; drag.el.style.top = `${drag.t.y * 100}%`;
      return;
    }
    if (!current || e.pointerId !== current.id) return;
    const all = e.getCoalescedEvents?.(); // every sample since the last frame (smoother pencil lines)
    for (const ev of all?.length ? all : [e]) {
      const p = point(ev), last = current.points[current.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.0015) continue;
      current.points.push(p);
    }
    extend();
  });
  const end = e => {
    if (drag && e.pointerId === drag.id) { drag.el.classList.remove("lifted"); drag = null; save(); busy = false; onIdle?.(); return; }
    if (!current || e.pointerId !== current.id) return;
    strokes.push(current); redo = []; current = null;
    live.getContext("2d").clearRect(0, 0, live.width, live.height);
    redraw(); save(); syncButtons(); busy = false; onIdle?.();
  };
  field.addEventListener("pointerup", end);
  field.addEventListener("pointercancel", end);

  // ---- robot tokens: our alliance and theirs, an 18" robot to scale
  function drawTokens() {
    tokenLayer.hidden = !showTokens;
    tokenLayer.replaceChildren(...(tokens || []).map(t => h("div", { class: `token ${t.color}`, "data-id": t.id, style: `left:${t.x * 100}%;top:${t.y * 100}%` },
      h("span", {}, t.label))));
  }
  /** Names the four robots after the next match (us and partner, then the opponents). */
  function setTeams({ us, partner, opponents, color: ours }) {
    const them = ours === "red" ? "blue" : "red";
    const want = [[`a1`, us, ours], [`a2`, partner || "Partner", ours], [`o1`, opponents?.[0] || "Opp 1", them], [`o2`, opponents?.[1] || "Opp 2", them]];
    const [y1, y2] = starts; // where robots start along each alliance wall (clear of anything drawn there)
    const home = { red: [[0.12, y2], [0.12, y1]], blue: [[0.88, y1], [0.88, y2]] };
    if (!tokens) tokens = want.map(([id, label, c], i) => ({ id, label, color: c, x: home[c][i % 2][0], y: home[c][i % 2][1] }));
    else for (const [id, label, c] of want) { const t = tokens.find(x => x.id === id); if (t) { t.label = label; t.color = c; } }
    drawTokens();
  }

  // ---- toolbar
  const btn = (label, ic, onclick, cls = "") => h("button", { type: "button", class: `wb-btn ${cls}`, "aria-label": label, title: label, onclick }, icon(ic), h("span", {}, label));
  const toolBtns = Object.keys(TOOLS).map(k => h("button", { type: "button", class: "wb-tool", "data-tool": k, "aria-label": k[0].toUpperCase() + k.slice(1), title: k[0].toUpperCase() + k.slice(1),
    onclick: () => { tool = k; save(); syncButtons(); } }, toolIcon(k)));
  const swatches = COLORS.map(([c, name]) => h("button", { type: "button", class: "wb-swatch", style: `--c:${c}`, "aria-label": name, title: name, onclick: () => { color = c; if (tool === "eraser") tool = "pen"; save(); syncButtons(); } }));
  const sizes = [0, 1, 2].map(i => h("button", { type: "button", class: "wb-size", "aria-label": ["Thin", "Medium", "Thick"][i], title: ["Thin", "Medium", "Thick"][i], onclick: () => { size = i; save(); syncButtons(); } }, h("i", { style: `--d:${[4, 8, 13][i]}px` })));
  const undoB = btn("Undo", "undo", () => { if (!strokes.length) return; redo.push(strokes.pop()); redraw(); save(); syncButtons(); });
  const redoB = btn("Redo", "redo", () => { if (!redo.length) return; strokes.push(redo.pop()); redraw(); save(); syncButtons(); });
  const clearB = btn("Clear", "trash", () => { if (!strokes.length || !confirm("Clear the whole drawing?")) return; redo = strokes.slice().reverse(); strokes = []; redraw(); save(); syncButtons(); });
  const robotsB = btn("Robots", "robot", () => { showTokens = !showTokens; save(); drawTokens(); syncButtons(); });
  const saveB = btn("Save image", "download", () => exportImage());
  function syncButtons() {
    toolBtns.forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.tool === tool)); if (b.dataset.tool !== "eraser") b.style.setProperty("--ink", color); });
    swatches.forEach((b, i) => b.setAttribute("aria-pressed", String(tool !== "eraser" && COLORS[i][0] === color)));
    sizes.forEach((b, i) => b.setAttribute("aria-pressed", String(i === size)));
    undoB.disabled = !strokes.length; redoB.disabled = !redo.length; clearB.disabled = !strokes.length;
    robotsB.setAttribute("aria-pressed", String(showTokens));
    field.dataset.tool = tool;
  }
  async function exportImage() {
    const n = 1500, c = document.createElement("canvas"); c.width = c.height = n;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, n, n); ctx.drawImage(ink, 0, 0, n, n);
    if (showTokens) for (const t of tokens || []) {
      const s = n * 0.125, x = t.x * n - s / 2, y = t.y * n - s / 2;
      ctx.fillStyle = t.color === "red" ? "rgba(229,72,77,0.85)" : "rgba(62,123,255,0.85)"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.roundRect(x, y, s, s, 14); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.font = `700 ${Math.min(44, s / (String(t.label).length * 0.55))}px "Barlow Semi Condensed", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(t.label, t.x * n, t.y * n);
    }
    const blob = await new Promise(r => c.toBlob(r, "image/png"));
    const file = new File([blob], "strategy.png", { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: "Strategy" }); return; } catch (err) { if (err.name === "AbortError") return; } }
    const a = h("a", { href: URL.createObjectURL(blob), download: "strategy.png" }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const bar = h("div", { class: "wb-bar", role: "toolbar", "aria-label": "Drawing tools" },
    h("div", { class: "wb-group tools" }, toolBtns),
    h("div", { class: "wb-group swatches" }, swatches),
    h("div", { class: "wb-group sizes" }, sizes),
    h("div", { class: "wb-group acts" }, undoB, redoB, robotsB, clearB, saveB));
  const el = h("div", { class: "wb" }, h("div", { class: "wb-stage" }, field), bar);
  syncButtons(); drawTokens();
  return { el, setTeams, busy: () => busy };

  function toolIcon(k) {
    // Drawn like the tools in a notes app: tip at the top, coloured band for the ink.
    const tips = {
      pen: '<path d="M12 2l3 6v13H9V8z" fill="var(--tool)"/><path d="M12 2l3 6H9z" fill="currentColor"/><rect x="9" y="11" width="6" height="2" fill="var(--ink)"/>',
      marker: '<path d="M9.5 2h5l1 7v12h-7V9z" fill="var(--tool)"/><path d="M9.5 2h5v4h-5z" fill="var(--ink)"/>',
      pencil: '<path d="M12 2l3 7v12H9V9z" fill="var(--tool)"/><path d="M12 2l3 7H9z" fill="#e3c08d"/><path d="M12 2l1.1 2.6h-2.2z" fill="var(--ink)"/>',
      eraser: '<rect x="8.5" y="4" width="7" height="17" rx="1.5" fill="var(--tool)"/><rect x="8.5" y="4" width="7" height="5" rx="1.5" fill="#f2a7a9"/>',
    };
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.innerHTML = tips[k];
    return s;
  }
}
