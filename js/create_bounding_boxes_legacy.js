// Create Bounding Boxes for node 1.0 - canvas editor (LiteGraph DOM widget)
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "CreateBoundingBoxesLegacy";
const MAX_PALETTE = 5;
const MIN_NODE_W = 560;
const MIN_NODE_H = 780;
const MIN_EDITOR_H = 470;
const DEFAULT_COLORS = ["#E6194B", "#3CB44B", "#4363D8", "#F58231", "#911EB4", "#42D4F4", "#F032E6", "#BFEF45"];
const NEUTRAL = "#8c8c8c";
const HANDLE_PX = 6;
const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function toHex6(c) {
  if (typeof c !== "string") return NEUTRAL;
  let s = c.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split("").map((ch) => ch + ch).join("");
  return /^[0-9a-fA-F]{6}$/.test(s) ? "#" + s.toLowerCase() : NEUTRAL;
}
function hexToRgb(h) {
  const s = toHex6(h).slice(1);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function readableColor([r, g, b]) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const t = lum > 140 ? 0.35 : 0.7;
  return `rgb(${[r, g, b].map((c) => Math.round(c + (255 - c) * t)).join(",")})`;
}
function normBox(b) {
  const m = b && typeof b.metadata === "object" && b.metadata ? b.metadata : {};
  return {
    x: Math.round(+b?.x || 0),
    y: Math.round(+b?.y || 0),
    width: Math.round(+b?.width || 0),
    height: Math.round(+b?.height || 0),
    metadata: {
      type: m.type === "text" ? "text" : "obj",
      text: typeof m.text === "string" ? m.text : "",
      desc: typeof m.desc === "string" ? m.desc : "",
      palette: Array.isArray(m.palette) ? m.palette.filter((c) => typeof c === "string").map(toHex6).slice(0, MAX_PALETTE) : [],
    },
  };
}
function parseBoxes(str) {
  try {
    const v = JSON.parse(str || "[]");
    return Array.isArray(v) ? v.filter((b) => b && typeof b === "object").map(normBox) : [];
  } catch {
    return [];
  }
}
function handlesOf(b) {
  const x1 = b.x, y1 = b.y, x2 = b.x + b.width, y2 = b.y + b.height, xm = (x1 + x2) / 2, ym = (y1 + y2) / 2;
  return { nw: [x1, y1], n: [xm, y1], ne: [x2, y1], e: [x2, ym], se: [x2, y2], s: [xm, y2], sw: [x1, y2], w: [x1, ym] };
}


// ---------------------------------------------------------------------------
// Resolution Selector 연동: width/height 입력이 코어 ResolutionSelector 의
// width/height 출력에 연결돼 있을 때만, 그 노드의 위젯 값으로 해상도를 미리 계산한다.
// (코어 계산식: 총 픽셀 = MP * 1024^2, 각 변을 비율에 맞춰 구한 뒤 multiple 배수로 반올림)
// ---------------------------------------------------------------------------
const RESOLUTION_SELECTOR = "ResolutionSelector";

function pyRound(x) { // Python round() 와 같은 half-to-even
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
function widgetValue(n, name) {
  return n.widgets?.find((w) => w.name === name)?.value;
}
function calcResolution(sel) {
  const m = /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(String(widgetValue(sel, "aspect_ratio") ?? ""));
  const mp = parseFloat(widgetValue(sel, "megapixels"));
  if (!m || !(mp > 0)) return null;
  const mult = Math.max(1, Math.round(parseFloat(widgetValue(sel, "multiple")) || 8));
  const ratio = parseFloat(m[1]) / parseFloat(m[2]);
  const total = mp * 1024 * 1024;
  const snap = (v) => Math.max(mult, pyRound(v / mult) * mult);
  return { width: snap(Math.sqrt(total * ratio)), height: snap(Math.sqrt(total / ratio)) };
}
// node 의 inputName 입력이 ResolutionSelector 의 width/height 출력에서 왔다면 {sel, out} 반환
function resolutionSourceOf(node, inputName) {
  const g = node.graph;
  const inp = node.inputs?.find((i) => i.name === inputName);
  if (!g || !inp || inp.link == null) return null;
  let linkId = inp.link;
  for (let hop = 0; hop < 10; hop++) {
    const link = g.getLink ? g.getLink(linkId) : g.links instanceof Map ? g.links.get(linkId) : g.links?.[linkId];
    const origin = link && g.getNodeById(link.origin_id);
    if (!origin) return null;
    if ((origin.comfyClass || origin.type) === "Reroute") { // 구형 Reroute 노드 통과
      const next = origin.inputs?.[0]?.link;
      if (next == null) return null;
      linkId = next;
      continue;
    }
    if ((origin.comfyClass || origin.type) !== RESOLUTION_SELECTOR) return null;
    const out = origin.outputs?.[link.origin_slot]?.name;
    return out === "width" || out === "height" ? { sel: origin, out } : null;
  }
  return null;
}

function el(tag, style, props) {
  const e = document.createElement(tag);
  if (style) Object.assign(e.style, style);
  if (props) Object.assign(e, props);
  return e;
}

function hideWidget(w) {
  w.type = "hidden";
  w.hidden = true;
  w.computeSize = () => [0, -4];
  if (w.element) w.element.style.display = "none";
}

function setup(node) {
  const wOf = (name) => node.widgets?.find((w) => w.name === name);
  const wW = wOf("width"), wH = wOf("height"), wState = wOf("editor_state"), wLast = wOf("last_incoming");
  if (!wW || !wH || !wState || !wLast) return;
  hideWidget(wState);
  hideWidget(wLast);

  const getW = () => Math.max(1, +wW.value || 1024);
  const getH = () => Math.max(1, +wH.value || 1024);

  // ------------------------------------------------------------------ state
  let boxes = parseBoxes(wState.value);
  let sel = -1;
  let lastW = getW(), lastH = getH();
  let bgImg = null; // {img, w, h}
  let view = { s: 1, ox: 0, oy: 0 };
  let drag = null;

  // ------------------------------------------------------------------- DOM
  const css = {
    input: { background: "var(--comfy-input-bg, #222)", color: "var(--input-text, #ddd)", border: "1px solid var(--border-color, #444)", borderRadius: "4px", padding: "2px 6px", fontSize: "12px", boxSizing: "border-box", minWidth: "0" },
    btn: { background: "var(--comfy-input-bg, #222)", color: "var(--input-text, #ddd)", border: "1px solid var(--border-color, #444)", borderRadius: "4px", padding: "3px 9px", fontSize: "12px", cursor: "pointer" },
    label: { fontSize: "11px", opacity: "0.75", whiteSpace: "nowrap" },
  };
  const root = el("div", { display: "flex", flexDirection: "column", gap: "6px", width: "100%", height: "100%", boxSizing: "border-box", color: "var(--input-text, #ddd)", fontFamily: "sans-serif" });

  const toolbar = el("div", { display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" });
  const mkBtn = (text, title, fn) => {
    const b = el("button", css.btn, { textContent: text, title, type: "button" });
    b.addEventListener("click", fn);
    toolbar.appendChild(b);
    return b;
  };
  const btnDelete = mkBtn("Delete", "Delete selected box (Del)", () => deleteSel());
  const btnFwd = mkBtn("Forward", "Move selected box toward the foreground", () => reorder(+1));
  const btnBack = mkBtn("Backward", "Move selected box toward the background", () => reorder(-1));
  const btnFit = mkBtn("Match image size", "Set width/height from the background image (multiples of 16)", () => matchImageSize());
  const btnClear = mkBtn("Clear all", "Remove all boxes and re-initialize from the bboxes input on next run", () => clearAll());
  const hint = el("span", { ...css.label, marginLeft: "auto" }, { textContent: "Drag to draw · drag to move · handles to resize" });
  toolbar.appendChild(hint);

  const stage = el("div", { position: "relative", flex: "1 1 auto", minHeight: "220px", border: "1px solid var(--border-color, #444)", borderRadius: "4px", overflow: "hidden", background: "#1a1a1a" });
  const canvas = el("canvas", { position: "absolute", inset: "0", width: "100%", height: "100%", touchAction: "none", outline: "none" }, { tabIndex: 0 });
  stage.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  // properties panel
  const panel = el("div", { display: "flex", flexDirection: "column", gap: "5px", padding: "6px", border: "1px solid var(--border-color, #444)", borderRadius: "4px", flex: "0 0 auto" });
  const title = el("div", { fontSize: "12px", fontWeight: "600" });
  const row1 = el("div", { display: "flex", gap: "6px", alignItems: "center" });
  const selType = el("select", css.input);
  ["obj", "text"].forEach((t) => selType.appendChild(el("option", null, { value: t, textContent: t })));
  const inpText = el("input", { ...css.input, flex: "1 1 auto" }, { type: "text", placeholder: "Text to render" });
  row1.append(el("span", css.label, { textContent: "Type" }), selType, inpText);
  const txtDesc = el("textarea", { ...css.input, width: "100%", resize: "vertical", height: "52px", fontFamily: "inherit" }, { placeholder: "Description" });
  const row2 = el("div", { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" });
  const num = {};
  for (const k of ["x", "y", "width", "height"]) {
    num[k] = el("input", { ...css.input, width: "64px" }, { type: "number", step: "1" });
    row2.append(el("span", css.label, { textContent: k === "width" ? "w" : k === "height" ? "h" : k }), num[k]);
  }
  const row3 = el("div", { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" });
  const paletteBox = el("div", { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" });
  const btnAddColor = el("button", css.btn, { textContent: "+ color", type: "button", title: "Add a palette color (max 5)" });
  row3.append(el("span", css.label, { textContent: "Palette" }), paletteBox, btnAddColor);
  panel.append(title, row1, txtDesc, row2, row3);

  root.append(toolbar, stage, panel);

  // ---------------------------------------------------------------- commit
  function commit(redrawPanel = false) {
    wState.value = JSON.stringify(boxes);
    try { app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.(); } catch { /* noop */ }
    node.graph?.setDirtyCanvas?.(true, true);
    draw();
    if (redrawPanel) syncPanel(true);
  }

  // ----------------------------------------------------------- layout/draw
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return false;
    const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }
  function layout() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight, pad = 8;
    const W = getW(), H = getH();
    const s = Math.max(0.0001, Math.min((cw - pad * 2) / W, (ch - pad * 2) / H));
    view = { s, ox: (cw - W * s) / 2, oy: (ch - H * s) / 2 };
  }
  function wrapLines(text, maxW) {
    const out = [];
    for (const para of String(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? line + " " + word : word;
        if (line && ctx.measureText(test).width > maxW) { out.push(line); line = word; } else line = test;
      }
      out.push(line);
    }
    return out;
  }
  function draw() {
    if (!resizeCanvas()) return;
    layout();
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const W = getW(), H = getH(), { s, ox, oy } = view;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = "#202020";
    ctx.fillRect(ox, oy, W * s, H * s);
    if (bgImg) {
      ctx.drawImage(bgImg.img, ox, oy, W * s, H * s);
      ctx.fillStyle = "rgba(0,0,0,0.75)"; // preview 와 동일한 25% 밝기
      ctx.fillRect(ox, oy, W * s, H * s);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, W * s - 1, H * s - 1);

    const fs = clamp(Math.round(H * s / 64), 10, 16);
    boxes.forEach((b, i) => {
      const pal = b.metadata.palette;
      const col = pal.length ? toHex6(pal[0]) : NEUTRAL;
      const [r, g, bl] = hexToRgb(col);
      const x = ox + b.x * s, y = oy + b.y * s, w = b.width * s, h = b.height * s;
      ctx.fillStyle = `rgba(${r},${g},${bl},0.12)`;
      ctx.fillRect(x, y, w, h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = col;
      ctx.strokeRect(x, y, w, h);

      if (pal.length && w > 2) {
        const sh = Math.max(5, fs / 2), seg = w / Math.min(pal.length, MAX_PALETTE);
        pal.slice(0, MAX_PALETTE).forEach((c, p) => { ctx.fillStyle = toHex6(c); ctx.fillRect(x + p * seg, y, seg, sh); });
      }
      ctx.font = `${fs - 2}px sans-serif`;
      ctx.textBaseline = "top";
      const tag = String(i + 1).padStart(2, "0");
      const tw = ctx.measureText(tag).width;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, tw + 6, fs + 2);
      ctx.fillStyle = 0.299 * r + 0.587 * g + 0.114 * bl > 140 ? "#000" : "#fff";
      ctx.fillText(tag, x + 3, y + 2);

      let body = b.metadata.desc || "";
      if (b.metadata.type === "text" && b.metadata.text) body = `"${b.metadata.text}"` + (body ? " — " + body : "");
      if (body && w > 8) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        ctx.font = `${fs}px sans-serif`;
        ctx.fillStyle = readableColor([r, g, bl]);
        let ty = y + fs + 5;
        for (const line of wrapLines(body, w - 8)) {
          if (ty > y + h) break;
          ctx.fillText(line, x + 4, ty);
          ty += fs + 2;
        }
        ctx.restore();
      }
    });

    if (sel >= 0 && boxes[sel]) {
      const b = boxes[sel];
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(ox + b.x * s - 2, oy + b.y * s - 2, b.width * s + 4, b.height * s + 4);
      ctx.restore();
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#000";
      for (const [hx, hy] of Object.values(handlesOf(b))) {
        ctx.fillRect(ox + hx * s - HANDLE_PX / 2, oy + hy * s - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
        ctx.strokeRect(ox + hx * s - HANDLE_PX / 2, oy + hy * s - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
      }
    }
    if (!boxes.length) {
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Drag on the canvas to draw a bounding box", cw / 2, ch / 2);
      ctx.textAlign = "start";
    }
  }

  // ------------------------------------------------------------ pointer io
  function toImg(e) {
    const rect = canvas.getBoundingClientRect();
    const k = rect.width / (canvas.clientWidth || 1) || 1; // graph zoom 보정
    return [((e.clientX - rect.left) / k - view.ox) / view.s, ((e.clientY - rect.top) / k - view.oy) / view.s];
  }
  function hitHandle(px, py) {
    if (sel < 0 || !boxes[sel]) return null;
    const r = (HANDLE_PX + 3) / view.s;
    for (const [name, [hx, hy]] of Object.entries(handlesOf(boxes[sel]))) {
      if (Math.abs(px - hx) <= r && Math.abs(py - hy) <= r) return name;
    }
    return null;
  }
  function hitBox(px, py) {
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      if (px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height) return i;
    }
    return -1;
  }
  function rectFrom(x1, y1, x2, y2) {
    const W = getW(), H = getH();
    x1 = clamp(x1, 0, W); x2 = clamp(x2, 0, W); y1 = clamp(y1, 0, H); y2 = clamp(y2, 0, H);
    return { x: Math.round(Math.min(x1, x2)), y: Math.round(Math.min(y1, y2)), width: Math.round(Math.abs(x2 - x1)), height: Math.round(Math.abs(y2 - y1)) };
  }
  function newBox(rect) {
    return normBox({ ...rect, metadata: { type: "obj", text: "", desc: "", palette: [DEFAULT_COLORS[boxes.length % DEFAULT_COLORS.length]] } });
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    canvas.focus({ preventScroll: true });
    layout();
    const [px, py] = toImg(e);
    const handle = hitHandle(px, py);
    if (handle) {
      drag = { mode: "resize", handle, start: { ...boxes[sel] } };
    } else {
      const i = hitBox(px, py);
      if (i >= 0) {
        sel = i;
        drag = { mode: "move", sx: px, sy: py, start: { ...boxes[i] }, moved: false };
        syncPanel(true);
      } else {
        drag = { mode: "create", sx: px, sy: py, created: false };
      }
    }
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    const [px, py] = toImg(e);
    if (!drag) {
      const hnd = hitHandle(px, py);
      canvas.style.cursor = hnd ? CURSORS[hnd] : hitBox(px, py) >= 0 ? "move" : "crosshair";
      return;
    }
    const W = getW(), H = getH();
    if (drag.mode === "move") {
      const b = boxes[sel];
      b.x = Math.round(clamp(drag.start.x + (px - drag.sx), 0, W - b.width));
      b.y = Math.round(clamp(drag.start.y + (py - drag.sy), 0, H - b.height));
      drag.moved = true;
    } else if (drag.mode === "resize") {
      const s0 = drag.start, hd = drag.handle;
      let x1 = s0.x, y1 = s0.y, x2 = s0.x + s0.width, y2 = s0.y + s0.height;
      if (hd.includes("w")) x1 = px;
      if (hd.includes("e")) x2 = px;
      if (hd.includes("n")) y1 = py;
      if (hd.includes("s")) y2 = py;
      Object.assign(boxes[sel], rectFrom(x1, y1, x2, y2));
    } else if (drag.mode === "create") {
      if (!drag.created) {
        if (Math.hypot((px - drag.sx) * view.s, (py - drag.sy) * view.s) < 5) return;
        boxes.push(newBox(rectFrom(drag.sx, drag.sy, px, py)));
        sel = boxes.length - 1;
        drag.created = true;
      }
      Object.assign(boxes[sel], rectFrom(drag.sx, drag.sy, px, py));
    }
    wState.value = JSON.stringify(boxes);
    syncPanel(false);
    draw();
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (d.mode === "create" && !d.created) sel = -1; // 빈 곳 클릭 = 선택 해제
    if (d.mode === "create" && d.created && (boxes[sel].width < 2 || boxes[sel].height < 2)) { boxes.splice(sel, 1); sel = -1; }
    commit(true);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // Del / 방향키: ComfyUI 단축키(노드 삭제 등)보다 먼저 가로챈다
  const onKey = (e) => {
    if (document.activeElement !== canvas || sel < 0 || !boxes[sel]) return;
    const step = e.shiftKey ? 10 : 1;
    const b = boxes[sel];
    let handled = true;
    if (e.key === "Delete" || e.key === "Backspace") { deleteSel(); }
    else if (e.key === "ArrowLeft") b.x = clamp(b.x - step, 0, getW() - b.width);
    else if (e.key === "ArrowRight") b.x = clamp(b.x + step, 0, getW() - b.width);
    else if (e.key === "ArrowUp") b.y = clamp(b.y - step, 0, getH() - b.height);
    else if (e.key === "ArrowDown") b.y = clamp(b.y + step, 0, getH() - b.height);
    else handled = false;
    if (!handled) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key.startsWith("Arrow")) commit(true);
  };
  window.addEventListener("keydown", onKey, true);

  // ---------------------------------------------------------------- actions
  function deleteSel() {
    if (sel < 0) return;
    boxes.splice(sel, 1);
    sel = Math.min(sel, boxes.length - 1);
    commit(true);
  }
  function reorder(dir) {
    const j = sel + dir;
    if (sel < 0 || j < 0 || j >= boxes.length) return;
    [boxes[sel], boxes[j]] = [boxes[j], boxes[sel]];
    sel = j;
    commit(true);
  }
  function clearAll() {
    boxes = [];
    sel = -1;
    wLast.value = "[]"; // 다음 실행 때 bboxes 입력으로 다시 초기화
    commit(true);
  }
  function matchImageSize() {
    if (!bgImg) return;
    const q = (v) => clamp(Math.round(v / 16) * 16, 64, 16384);
    wW.value = q(bgImg.w);
    wH.value = q(bgImg.h);
    checkDims();
  }
  function checkDims() {
    const W = getW(), H = getH();
    if (W === lastW && H === lastH) return;
    const fx = W / lastW, fy = H / lastH;
    boxes = boxes.map((b) => ({ ...b, x: Math.round(b.x * fx), y: Math.round(b.y * fy), width: Math.round(b.width * fx), height: Math.round(b.height * fy) }));
    lastW = W; lastH = H;
    commit(true);
  }

  // ------------------------------------------------------- properties panel
  function setDisabled(on) {
    panel.style.opacity = on ? "0.45" : "1";
    panel.style.pointerEvents = on ? "none" : "auto";
  }
  function rebuildPalette(b) {
    paletteBox.replaceChildren();
    b.metadata.palette.forEach((c, idx) => {
      const wrap = el("span", { display: "inline-flex", alignItems: "center", gap: "2px" });
      const ci = el("input", { width: "28px", height: "22px", padding: "0", border: "1px solid var(--border-color, #444)", background: "none", cursor: "pointer" }, { type: "color", value: toHex6(c) });
      ci.addEventListener("input", () => { b.metadata.palette[idx] = ci.value; commit(false); });
      const rm = el("button", { ...css.btn, padding: "0 5px" }, { textContent: "×", type: "button", title: "Remove color" });
      rm.addEventListener("click", () => { b.metadata.palette.splice(idx, 1); commit(true); });
      wrap.append(ci, rm);
      paletteBox.appendChild(wrap);
    });
    btnAddColor.style.display = b.metadata.palette.length >= MAX_PALETTE ? "none" : "";
  }
  function syncPanel(full) {
    const b = boxes[sel];
    const has = !!b;
    setDisabled(!has);
    btnDelete.disabled = btnFwd.disabled = btnBack.disabled = !has;
    btnFit.disabled = !bgImg;
    btnFit.style.opacity = bgImg ? "1" : "0.45";
    if (!has) {
      title.textContent = "No box selected";
      inpText.style.display = "none";
      return;
    }
    title.textContent = `Box ${String(sel + 1).padStart(2, "0")} of ${boxes.length}  (later = foreground)`;
    for (const k of ["x", "y", "width", "height"]) if (document.activeElement !== num[k]) num[k].value = b[k];
    if (!full) return;
    selType.value = b.metadata.type;
    inpText.style.display = b.metadata.type === "text" ? "" : "none";
    if (document.activeElement !== inpText) inpText.value = b.metadata.text;
    if (document.activeElement !== txtDesc) txtDesc.value = b.metadata.desc;
    rebuildPalette(b);
  }
  selType.addEventListener("change", () => { if (!boxes[sel]) return; boxes[sel].metadata.type = selType.value; commit(true); });
  inpText.addEventListener("input", () => { if (boxes[sel]) { boxes[sel].metadata.text = inpText.value; commit(false); } });
  txtDesc.addEventListener("input", () => { if (boxes[sel]) { boxes[sel].metadata.desc = txtDesc.value; commit(false); } });
  btnAddColor.addEventListener("click", () => {
    const b = boxes[sel];
    if (!b || b.metadata.palette.length >= MAX_PALETTE) return;
    b.metadata.palette.push(DEFAULT_COLORS[(sel + b.metadata.palette.length) % DEFAULT_COLORS.length].toLowerCase());
    commit(true);
  });
  for (const k of ["x", "y", "width", "height"]) {
    num[k].addEventListener("input", () => {
      const b = boxes[sel];
      if (!b || num[k].value === "") return;
      const W = getW(), H = getH();
      const v = Math.round(+num[k].value) || 0;
      if (k === "x") b.x = clamp(v, 0, W - 1);
      if (k === "y") b.y = clamp(v, 0, H - 1);
      if (k === "width") b.width = clamp(v, 0, W - b.x);
      if (k === "height") b.height = clamp(v, 0, H - b.y);
      commit(false);
    });
    num[k].addEventListener("change", () => syncPanel(false));
  }

  // ----------------------------------------------------------- DOM widget
  const domWidget = node.addDOMWidget("bbox_editor", "bbox_editor", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => MIN_EDITOR_H,
    getMaxHeight: () => Number.MAX_SAFE_INTEGER,
  });
  if (domWidget) {
    // 고정 높이(computeSize) 대신 가변 레이아웃: 노드를 키우면 남는 높이를 에디터가 가져간다
    delete domWidget.computeSize;
    domWidget.computeLayoutSize = () => ({ minHeight: MIN_EDITOR_H, minWidth: 0, maxHeight: Number.MAX_SAFE_INTEGER });
  }
  node.setSize([Math.max(node.size[0], MIN_NODE_W), Math.max(node.size[1], MIN_NODE_H)]);

  const ro = new ResizeObserver(() => draw());
  ro.observe(stage);

  // 연결된 ResolutionSelector 값으로 width/height 위젯을 갱신 (연결돼 있을 때만)
  let linkedInfo = "";
  function syncFromResolutionSelector() {
    const parts = [];
    for (const [name, widget] of [["width", wW], ["height", wH]]) {
      const src = resolutionSourceOf(node, name);
      if (!src) continue;
      const res = calcResolution(src.sel);
      if (!res) continue;
      const v = clamp(res[src.out], 64, 16384);
      if (+widget.value !== v) widget.value = v;
      parts.push(name);
    }
    const info = parts.length ? `${parts.join("/")} ← Resolution Selector (${getW()}×${getH()})` : "";
    if (info !== linkedInfo) {
      linkedInfo = info;
      hint.textContent = info || "Drag to draw · drag to move · handles to resize";
    }
  }

  // ---------------------------------------------------------- node hooks
  const origConfigure = node.onConfigure;
  node.onConfigure = function () {
    const r = origConfigure?.apply(this, arguments);
    boxes = parseBoxes(wState.value);
    lastW = getW(); lastH = getH();
    sel = -1;
    syncPanel(true);
    draw();
    return r;
  };

  const origFg = node.onDrawForeground;
  node.onDrawForeground = function () {
    const r = origFg?.apply(this, arguments);
    syncFromResolutionSelector();
    checkDims(); // width/height 위젯(또는 링크) 변경 감지
    return r;
  };

  const origExecuted = node.onExecuted;
  node.onExecuted = function (msg) {
    const r = origExecuted?.apply(this, arguments);
    // 배경 이미지
    const bg = msg?.bbox_bg?.[0];
    if (bg) {
      const img = new Image();
      img.onload = () => { bgImg = { img, w: bg.orig_width || img.naturalWidth, h: bg.orig_height || img.naturalHeight }; syncPanel(false); draw(); };
      img.src = api.apiURL(`/view?filename=${encodeURIComponent(bg.filename)}&type=${bg.type}&subfolder=${encodeURIComponent(bg.subfolder || "")}&rand=${Date.now()}`);
    } else if (bgImg) {
      bgImg = null; syncPanel(false); draw();
    }
    // 업스트림 bboxes 가 새 값이면 캔버스를 초기화 (이후 사용자 편집이 우선)
    const inc = msg?.input_bboxes;
    if (Array.isArray(inc) && inc.length) {
      const key = JSON.stringify(inc);
      if (key !== wLast.value) {
        boxes = inc.map(normBox);
        sel = -1;
        wLast.value = key;
        commit(true);
      }
    }
    return r;
  };

  const origRemoved = node.onRemoved;
  node.onRemoved = function () {
    window.removeEventListener("keydown", onKey, true);
    ro.disconnect();
    return origRemoved?.apply(this, arguments);
  };

  syncPanel(true);
  requestAnimationFrame(draw);
}

app.registerExtension({
  name: "Comfy.CreateBoundingBoxesLegacy",
  nodeCreated(node) {
    if (node.comfyClass === NODE_NAME) setup(node);
  },
});
