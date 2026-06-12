#!/usr/bin/env node
// Phase 2 — HTML -> IR extractor
// Usage:
//   node extract.js <input.html> [--selector "<css>"] [--out <file.json>]
//
// Opens the HTML in headless Chromium, lets the browser do all layout, then
// walks the DOM reading getComputedStyle and emits IR JSON (see IR-SCHEMA.md).

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { selector: null, out: null, input: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selector") args.selector = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (!args.input) args.input = a;
  }
  return args;
}

// This function is serialized and executed INSIDE the browser page.
function walkInPage(selector) {
  const px = (v) => parseFloat(v) || 0;

  // Any CSS color token -> {r,g,b in 0..1, a}. Handles rgb/rgba, #hex,
  // color(srgb ..), and OKLCH/OKLab. Chromium serializes oklch-authored colors
  // back as oklch()/oklab() in computed style, so we decode them to sRGB here.
  const COLOR_RE = /(?:rgba?|oklch|oklab|color)\([^)]*\)|#[0-9a-fA-F]{3,8}/;
  function oklabToRGBA(L, a, b, alpha) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    const g2 = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
    const cl = (c) => Math.min(1, Math.max(0, c));
    return { r: cl(g2(r)), g: cl(g2(g)), b: cl(g2(bl)), a: alpha == null ? 1 : alpha };
  }
  const num = (t) => (t && t.indexOf("%") !== -1 ? parseFloat(t) / 100 : parseFloat(t));
  function toRGBA(str) {
    if (!str) return null;
    str = str.trim();
    let m;
    if ((m = str.match(/rgba?\(([^)]+)\)/i))) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
      return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
    }
    if ((m = str.match(/^#([0-9a-fA-F]{3,8})$/))) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
      return {
        r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255, a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    if ((m = str.match(/color\(\s*srgb\s+([^)]+)\)/i))) {
      const seg = m[1].split("/"); const p = seg[0].trim().split(/\s+/).map(parseFloat);
      return { r: p[0], g: p[1], b: p[2], a: seg[1] != null ? num(seg[1].trim()) : 1 };
    }
    if ((m = str.match(/okl(ch|ab)\(\s*([^)]+)\)/i))) {
      const isCh = m[1] === "ch", seg = m[2].split("/");
      const v = seg[0].trim().split(/\s+/).map(num);
      const alpha = seg[1] != null ? num(seg[1].trim()) : 1, L = v[0] || 0;
      if (isCh) { const hr = (v[2] || 0) * Math.PI / 180; return oklabToRGBA(L, (v[1] || 0) * Math.cos(hr), (v[1] || 0) * Math.sin(hr), alpha); }
      return oklabToRGBA(L, v[1] || 0, v[2] || 0, alpha);
    }
    return null;
  }
  function parseColor(str) {
    const c = toRGBA(str);
    if (!c || c.a === 0) return null; // fully transparent -> no paint
    return c;
  }

  // split a multi-value CSS string on commas that are NOT inside parens
  function splitTop(str) {
    const out = [];
    let depth = 0, cur = "";
    for (const ch of str) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  function parseShadows(str) {
    if (!str || str === "none") return [];
    return splitTop(str).map((part) => {
      const colorMatch = part.match(COLOR_RE);
      const color = colorMatch ? parseColor(colorMatch[0]) : { r: 0, g: 0, b: 0, a: 1 };
      const rest = (colorMatch ? part.replace(colorMatch[0], "") : part).trim();
      const inset = /inset/.test(rest);
      const nums = rest.replace("inset", "").trim().split(/\s+/).map(px);
      return {
        type: "shadow",
        inset,
        x: nums[0] || 0,
        y: nums[1] || 0,
        blur: nums[2] || 0,
        spread: nums[3] || 0,
        color: color || { r: 0, g: 0, b: 0, a: 1 },
      };
    }); // Phase 3.0: keep inset shadows too (mapped to INNER_SHADOW in plugin)
  }

  // ---- Gradient parsing (Phase 3.1 linear, 3.2 radial + conic) -----------
  // Parse a color token KEEPING alpha=0 (transparent stops matter in fades,
  // unlike parseColor which drops fully-transparent paints).
  function gradColor(str) {
    return toRGBA(str) || { r: 0, g: 0, b: 0, a: 1 };
  }

  // CSS gradient direction token -> angle in deg (0=up, clockwise).
  function dirToAngle(token) {
    token = token.trim();
    const deg = token.match(/^([\d.]+)deg$/);
    if (deg) return parseFloat(deg[1]);
    const turn = token.match(/^([\d.]+)turn$/);
    if (turn) return parseFloat(turn[1]) * 360;
    const rad = token.match(/^([\d.]+)rad$/);
    if (rad) return parseFloat(rad[1]) * 180 / Math.PI;
    if (/^to\b/.test(token)) {
      const top = token.includes("top"), bottom = token.includes("bottom");
      const left = token.includes("left"), right = token.includes("right");
      if (top && right) return 45;
      if (bottom && right) return 135;
      if (bottom && left) return 225;
      if (top && left) return 315;
      if (top) return 0;
      if (right) return 90;
      if (bottom) return 180;
      if (left) return 270;
    }
    return 180; // CSS default: to bottom
  }

  // Angle (deg) -> Figma gradientTransform [[a,c,e],[b,d,f]] (object 0..1 -> paint t).
  function angleToTransform(angleDeg) {
    const a = angleDeg * Math.PI / 180;
    const dx = Math.sin(a), dy = -Math.cos(a);
    const x0 = 0.5 - 0.5 * dx, y0 = 0.5 - 0.5 * dy;
    const A = dx, C = dy, E = -(A * x0 + C * y0);
    const B = -dy, D = dx, F = -(B * x0 + D * y0);
    return [[A, C, E], [B, D, F]];
  }

  // One position token -> 0..1.  mode "length": % or px (px normalized by the
  // gradient-line length `pxLen`).  mode "angle": deg/turn/rad/%.
  function normPos(tok, mode, pxLen) {
    const v = parseFloat(tok);
    if (tok.indexOf("%") !== -1) return v / 100;
    if (tok.indexOf("px") !== -1) return pxLen ? v / pxLen : 0;
    if (mode === "angle") {
      if (tok.indexOf("turn") !== -1) return v;
      if (tok.indexOf("rad") !== -1) return (v * 180 / Math.PI) / 360;
      if (tok.indexOf("deg") !== -1) return v / 360;
    }
    return v / 100;
  }

  // Shared color-stop parser. Each comma part = a color + 0..2 position tokens
  // ("color 0% 62%" is a hard stop = two stops same color). Missing positions
  // are evenly distributed; endpoints default to 0 / 1. pxLen = gradient-line
  // length in px, used to normalize px stops (linear only).
  function parseStops(parts, mode, pxLen) {
    const posRe = mode === "angle" ? /[\d.]+(?:deg|turn|rad|%)/g : /[\d.]+(?:px|%)/g;
    const stops = [];
    for (const part of parts) {
      const cm = part.match(COLOR_RE);
      if (!cm) continue;
      const col = gradColor(cm[0]);
      const toks = part.replace(cm[0], "").match(posRe) || [];
      if (!toks.length) stops.push({ pos: null, color: col });
      else for (const t of toks) stops.push({ pos: normPos(t, mode, pxLen), color: col });
    }
    if (stops.length < 2) return stops;
    if (stops[0].pos == null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 1;
    for (let k = 1; k < stops.length - 1; k++) {
      if (stops[k].pos != null) continue;
      let nx = k + 1; while (nx < stops.length && stops[nx].pos == null) nx++;
      const prev = stops[k - 1].pos, next = stops[nx] ? stops[nx].pos : 1;
      stops[k].pos = prev + (next - prev) / (nx - (k - 1));
    }
    return stops;
  }

  // "35% 40%" / "center" / "left top" -> {cx,cy} normalized 0..1.
  function parsePosition(str) {
    const map = { left: 0, right: 1, top: 0, bottom: 1, center: 0.5 };
    const toks = str.trim().split(/\s+/);
    let cx = 0.5, cy = 0.5;
    const val = (t) => t.indexOf("%") !== -1 ? parseFloat(t) / 100 : (map[t] != null ? map[t] : null);
    if (toks.length === 1) { const v = val(toks[0]); if (v != null) cx = v; }
    else {
      // x then y; keywords top/bottom force the y slot
      const a = toks[0], b = toks[1];
      if (a === "top" || a === "bottom") { cy = map[a]; if (val(b) != null) cx = val(b); }
      else { if (val(a) != null) cx = val(a); if (val(b) != null) cy = val(b); }
    }
    return { cx, cy };
  }

  // radial-gradient([shape size]? [at pos]?, stops) -> GRADIENT_RADIAL.
  // Default ellipse (box aspect = circle in normalized space), farthest-corner.
  function parseRadial(inner, rect) {
    const parts = splitTop(inner).map((s) => s.trim());
    let head = "", start = 0;
    if (parts.length && !COLOR_RE.test(parts[0])) { head = parts[0]; start = 1; }
    let cx = 0.5, cy = 0.5;
    const atM = head.match(/\bat\s+(.+)$/);
    if (atM) { const p = parsePosition(atM[1]); cx = p.cx; cy = p.cy; }
    const size = (atM ? head.slice(0, atM.index) : head).trim();
    const sx = [cx, 1 - cx], sy = [cy, 1 - cy];
    let Rx, Ry;
    const pxM = size.match(/([\d.]+)px(?:\s+([\d.]+)px)?/);
    const pctM = size.match(/([\d.]+)%(?:\s+([\d.]+)%)?/);
    if (pxM && rect && rect.width && rect.height) {
      Rx = parseFloat(pxM[1]) / rect.width;
      Ry = (pxM[2] ? parseFloat(pxM[2]) : parseFloat(pxM[1])) / rect.height;
    } else if (pctM) {
      // explicit ellipse radii as % of box (already normalized: 120% -> 1.2)
      Rx = parseFloat(pctM[1]) / 100;
      Ry = pctM[2] ? parseFloat(pctM[2]) / 100 : Rx;
    } else if (/closest-side/.test(size)) { Rx = Math.min.apply(null, sx); Ry = Math.min.apply(null, sy); }
    else if (/farthest-side/.test(size)) { Rx = Math.max.apply(null, sx); Ry = Math.max.apply(null, sy); }
    else if (/closest-corner/.test(size)) { Rx = Math.min.apply(null, sx) * Math.SQRT2; Ry = Math.min.apply(null, sy) * Math.SQRT2; }
    else { Rx = Math.max.apply(null, sx) * Math.SQRT2; Ry = Math.max.apply(null, sy) * Math.SQRT2; } // farthest-corner (default)
    if (!Rx) Rx = 0.5; if (!Ry) Ry = 0.5;
    const a = 0.5 / Rx, d = 0.5 / Ry;
    const transform = [[a, 0, 0.5 - a * cx], [0, d, 0.5 - d * cy]];
    const stops = parseStops(parts.slice(start), "length");
    return stops.length < 2 ? null : { type: "gradient", kind: "radial", stops, transform };
  }

  // conic-gradient([from <angle>]? [at pos]?, stops) -> GRADIENT_ANGULAR.
  // Figma angular starts at top, clockwise (matches CSS conic default).
  function parseConic(inner, rect) {
    const parts = splitTop(inner).map((s) => s.trim());
    let head = "", start = 0;
    if (parts.length && /\b(from|at)\b/.test(parts[0]) && !COLOR_RE.test(parts[0])) { head = parts[0]; start = 1; }
    let cx = 0.5, cy = 0.5, fromDeg = 0;
    const fm = head.match(/from\s+([\d.]+)(deg|turn|rad)/);
    if (fm) { const v = parseFloat(fm[1]); fromDeg = fm[2] === "turn" ? v * 360 : fm[2] === "rad" ? v * 180 / Math.PI : v; }
    const atM = head.match(/\bat\s+(.+)$/);
    if (atM) { const p = parsePosition(atM[1]); cx = p.cx; cy = p.cy; }
    const phi = fromDeg * Math.PI / 180;
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const a = cos, c = -sin, b = sin, d = cos;
    const transform = [[a, c, 0.5 - (a * cx + c * cy)], [b, d, 0.5 - (b * cx + d * cy)]];
    const stops = parseStops(parts.slice(start), "angle");
    return stops.length < 2 ? null : { type: "gradient", kind: "angular", stops, transform };
  }

  function parseGradients(bgImage, rect) {
    if (!bgImage || bgImage === "none") return [];
    const out = [];
    for (const raw of splitTop(bgImage)) {
      const layer = raw.trim();
      let g = null;
      let m = layer.match(/^(?:-webkit-|-moz-)?linear-gradient\((.*)\)$/);
      if (m) {
        const parts = splitTop(m[1]).map((s) => s.trim());
        let angle = 180, start = 0;
        if (parts.length && /^(to\b|[\d.]+(deg|rad|turn))/.test(parts[0])) { angle = dirToAngle(parts[0]); start = 1; }
        // gradient-line length in px (projection of the box onto the angle) — to normalize px stops
        const ar = angle * Math.PI / 180;
        const pxLen = rect ? Math.abs(rect.width * Math.sin(ar)) + Math.abs(rect.height * Math.cos(ar)) : 0;
        const stops = parseStops(parts.slice(start), "length", pxLen);
        if (stops.length >= 2) g = { type: "gradient", kind: "linear", stops, transform: angleToTransform(angle) };
      } else if ((m = layer.match(/^(?:-webkit-|-moz-)?radial-gradient\((.*)\)$/))) {
        g = parseRadial(m[1], rect);
      } else if ((m = layer.match(/^(?:-webkit-|-moz-)?conic-gradient\((.*)\)$/))) {
        g = parseConic(m[1], rect);
      }
      if (g) out.push(g);
    }
    return out;
  }

  const JUSTIFY = {
    "flex-start": "start", "start": "start", "left": "start",
    "center": "center",
    "flex-end": "end", "end": "end", "right": "end",
    "space-between": "space-between",
  };
  const ALIGN = {
    "stretch": "stretch", "normal": "stretch",
    "flex-start": "start", "start": "start",
    "center": "center",
    "flex-end": "end", "end": "end",
  };

  function styleOf(el, cs) {
    const style = {};

    // fills: solid background-color (bottom layer), then gradient layers on top
    const bg = parseColor(cs.backgroundColor);
    style.fills = bg ? [{ type: "solid", color: bg }] : [];
    const grads = parseGradients(cs.backgroundImage, el.getBoundingClientRect());
    if (grads.length) style.fills = style.fills.concat(grads);

    // radius
    const r = [
      px(cs.borderTopLeftRadius),
      px(cs.borderTopRightRadius),
      px(cs.borderBottomRightRadius),
      px(cs.borderBottomLeftRadius),
    ];
    if (r.some((v) => v > 0)) style.radius = r;

    // stroke (uniform border only in v1 — use top edge as representative)
    const bw = px(cs.borderTopWidth);
    const bc = parseColor(cs.borderTopColor);
    if (bw > 0 && bc) style.stroke = { color: bc, width: bw };

    // effects: drop/inner shadows + blurs
    const effects = parseShadows(cs.boxShadow);
    // backdrop-filter: blur() -> Figma BACKGROUND_BLUR (glass);  filter: blur() -> LAYER_BLUR
    let bm = (cs.backdropFilter || cs.webkitBackdropFilter || "").match(/blur\(([\d.]+)px\)/);
    if (bm) effects.push({ type: "background-blur", radius: parseFloat(bm[1]) });
    bm = (cs.filter || "").match(/blur\(([\d.]+)px\)/);
    if (bm) effects.push({ type: "layer-blur", radius: parseFloat(bm[1]) });
    if (effects.length) style.effects = effects;

    return style;
  }

  const EPS = 1.5; // px tolerance for layout comparisons

  // Decide sizing for ONE absolute axis (w or h) by MEASURING, not guessing.
  //   fill  = grows/stretches to parent on this axis
  //   fixed = has an explicit size larger than its own content (e.g. 48px box)
  //   hug   = sizes to its own content
  function axisSizing(opts) {
    // opts: { childSize, parentContent, ownContent, growsHere, stretchesHere, isLeaf }
    if (opts.growsHere) return "fill"; // flex-grow on parent's main axis
    if (opts.stretchesHere && Math.abs(opts.childSize - opts.parentContent) <= EPS) {
      return "fill"; // align-stretch actually filled the parent's cross size
    }
    // A leaf frame (no children) can't "hug" anything — hug would collapse it to
    // ~0 (and Figma then snaps empty auto-layout frames to its 100px default,
    // e.g. a 1px divider line ballooning). Pin its measured size instead.
    if (opts.isLeaf && opts.childSize > 0) return "fixed";
    if (opts.childSize > opts.ownContent + EPS) return "fixed"; // explicit extra size
    return "hug";
  }

  function sizing(cs, parentCtx, rect, ownContent, isLeaf) {
    if (!parentCtx) return { w: "fixed", h: "hug" }; // root width pinned so text wraps

    const grow = parseFloat(cs.flexGrow) || 0;
    const self = cs.alignSelf;
    const stretches = (self && self !== "auto") ? self === "stretch" : parentCtx.align === "stretch";

    // In a column parent: main=H (grow), cross=W (stretch).
    // In a row parent:    main=W (grow), cross=H (stretch).
    const parentRow = parentCtx.mode === "horizontal";

    const w = axisSizing({
      childSize: rect.width,
      parentContent: parentCtx.contentW,
      ownContent: ownContent.w,
      growsHere: parentRow && grow > 0,
      stretchesHere: !parentRow && stretches,
      isLeaf: isLeaf,
    });
    const h = axisSizing({
      childSize: rect.height,
      parentContent: parentCtx.contentH,
      ownContent: ownContent.h,
      growsHere: !parentRow && grow > 0,
      stretchesHere: parentRow && stretches,
      isLeaf: isLeaf,
    });

    // Anchor fix: a "fill" child inside a parent that HUGS the cross axis has
    // nothing to stretch against (the parent's cross size is derived from its
    // children). If every child were "fill" the row/column would collapse. So
    // pin the cross axis to its measured size to anchor the parent (mirrors an
    // explicit-height tile in a stretch row, e.g. a bento cell).
    const cross = parentRow ? "h" : "w";
    if (parentCtx.crossHug) {
      if (cross === "h" && h === "fill") return { w: w, h: "fixed" };
      if (cross === "w" && w === "fill") return { w: "fixed", h: h };
    }
    return { w, h };
  }

  // Estimate this element's own content-box extents from its direct children,
  // so we can tell "explicit fixed size" apart from "hugs content".
  function ownContentSize(el, mode, gap, padH, padV) {
    const kids = Array.from(el.children)
      .filter((c) => { const p = getComputedStyle(c).position; return p !== "absolute" && p !== "fixed"; })
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 0 || r.height > 0);
    if (kids.length === 0) return { w: padH, h: padV };
    const sumW = kids.reduce((s, r) => s + r.width, 0);
    const sumH = kids.reduce((s, r) => s + r.height, 0);
    const maxW = Math.max.apply(null, kids.map((r) => r.width));
    const maxH = Math.max.apply(null, kids.map((r) => r.height));
    const mainGap = gap * (kids.length - 1);
    return mode === "horizontal"
      ? { w: sumW + mainGap + padH, h: maxH + padV }
      : { w: maxW + padH, h: sumH + mainGap + padV };
  }

  function frameLayout(el, cs, parentCtx) {
    const isFlex = cs.display.indexOf("flex") !== -1;
    const mode = isFlex
      ? (cs.flexDirection.indexOf("row") === 0 ? "horizontal" : "vertical")
      : "vertical"; // non-flex fallback: stack vertically
    const gapProp = mode === "horizontal" ? cs.columnGap : cs.rowGap;
    const gap = gapProp === "normal" ? 0 : px(gapProp);

    const pad = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)];
    // border-box: children sit inside padding AND border, so the inset that
    // separates the outer rect from the children is padding + border on each side.
    const insetH = pad[1] + pad[3] + px(cs.borderRightWidth) + px(cs.borderLeftWidth);
    const insetV = pad[0] + pad[2] + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const rect = el.getBoundingClientRect();
    const ownContent = ownContentSize(el, mode, gap, insetH, insetV);
    const size = sizing(cs, parentCtx, rect, ownContent, el.children.length === 0);

    const layout = {
      mode,
      gap,
      padding: pad,
      justify: JUSTIFY[cs.justifyContent] || "start",
      align: isFlex ? (ALIGN[cs.alignItems] || "stretch") : "stretch",
      sizing: size,
      _flex: isFlex, // internal flag for warnings
      _contentW: rect.width - insetH, // content-box available to children
      _contentH: rect.height - insetV,
      // does this frame hug its children on THEIR cross axis? (row -> height, col -> width)
      _crossHug: mode === "horizontal" ? size.h === "hug" : size.w === "hug",
    };
    if (size.w === "fixed") layout.width = Math.round(rect.width);
    if (size.h === "fixed") layout.height = Math.round(rect.height);
    return layout;
  }

  function nameOf(el) {
    return el.getAttribute("data-figma-name")
      || el.getAttribute("aria-label")
      || (el.id ? "#" + el.id : null)
      || (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : null)
      || el.tagName.toLowerCase();
  }

  const warnings = [];

  function walk(el, parentCtx) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    // Phase 5 — position:absolute/fixed -> Figma absolute layout child.
    // Position is taken from the actual rendered rect relative to the parent
    // frame's top-left (contract: absolute element must be a DIRECT child of a
    // position:relative parent). Constraints derive from which CSS offsets are set.
    let absolute = null;
    if (parentCtx && parentCtx.parentRect && (cs.position === "absolute" || cs.position === "fixed")) {
      const pr = parentCtx.parentRect;
      const x = rect.left - pr.left, y = rect.top - pr.top;
      // getComputedStyle resolves left/right (and top/bottom) BOTH to px for an
      // absolutely-positioned element, so we can't tell which edge was authored.
      // Derive the constraint from the gaps instead: pin to the nearer edge,
      // CENTER when both gaps match.
      const lg = x, rg = pr.width - x - rect.width;
      const tg = y, bg = pr.height - y - rect.height;
      const pick = (a, b) => Math.abs(a - b) < 2 ? "center" : (a <= b ? "min" : "max");
      absolute = { x: Math.round(x), y: Math.round(y), cx: pick(lg, rg), cy: pick(tg, bg) };
    }
    const withAbs = (node) => { if (node && absolute) node.absolute = absolute; return node; };

    const elementChildren = Array.from(el.children);
    const directText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    // IMG -> image node (carry the resolved absolute URL for Node to fetch)
    if (el.tagName === "IMG") {
      return withAbs({
        type: "image",
        name: nameOf(el),
        style: styleOf(el, cs),
        _w: Math.round(rect.width),
        _h: Math.round(rect.height),
        imageUrl: el.currentSrc || el.src || null,
      });
    }

    // Inline <svg> -> vector node. Extract each drawable element as a path + its CTM (so the
    // lib builds editable VECTOR nodes, crisp at any zoom). Also keep the serialized markup as
    // a raster fallback for SVGs we can't path-ify (e.g. <text>/<image>/<use>/filters).
    if (el.tagName.toLowerCase() === "svg") {
      // resolved fill/stroke as {r,g,b,a} (alpha folds in *-opacity); null for none/transparent.
      function svgPaint(node, prop, opProp) {
        var st = getComputedStyle(node);
        var raw = st[prop];
        if (!raw || raw === "none") return null;
        var col = parseColor(raw === "currentColor" ? cs.color : raw);
        if (!col) return null;
        var op = parseFloat(st[opProp]);
        if (!isNaN(op)) col.a = (col.a == null ? 1 : col.a) * op;
        return col;
      }
      function ptsToD(str, close) {
        var nums = (str || "").trim().split(/[\s,]+/).map(parseFloat).filter(function (n) { return !isNaN(n); });
        if (nums.length < 4) return "";
        var d = "M" + nums[0] + " " + nums[1];
        for (var k = 2; k + 1 < nums.length; k += 2) d += "L" + nums[k] + " " + nums[k + 1];
        return d + (close ? "Z" : "");
      }
      function elemToD(node) {
        var tag = node.tagName.toLowerCase();
        var A = function (n, d) { var v = parseFloat(node.getAttribute(n)); return isNaN(v) ? (d || 0) : v; };
        if (tag === "path") return node.getAttribute("d") || "";
        if (tag === "line") return "M" + A("x1") + " " + A("y1") + "L" + A("x2") + " " + A("y2");
        if (tag === "polyline") return ptsToD(node.getAttribute("points"), false);
        if (tag === "polygon") return ptsToD(node.getAttribute("points"), true);
        if (tag === "circle") {
          var cx = A("cx"), cy = A("cy"), r = A("r");
          if (r <= 0) return "";
          return "M" + (cx - r) + " " + cy + "a" + r + " " + r + " 0 1 0 " + (2 * r) + " 0a" + r + " " + r + " 0 1 0 " + (-2 * r) + " 0Z";
        }
        if (tag === "ellipse") {
          var ex = A("cx"), ey = A("cy"), rx = A("rx"), ry = A("ry");
          if (rx <= 0 || ry <= 0) return "";
          return "M" + (ex - rx) + " " + ey + "a" + rx + " " + ry + " 0 1 0 " + (2 * rx) + " 0a" + rx + " " + ry + " 0 1 0 " + (-2 * rx) + " 0Z";
        }
        if (tag === "rect") {
          var x = A("x"), y = A("y"), w = A("width"), h = A("height");
          if (w <= 0 || h <= 0) return "";
          var rx2 = A("rx", -1), ry2 = A("ry", -1);
          if (rx2 < 0) rx2 = ry2 < 0 ? 0 : ry2;
          if (ry2 < 0) ry2 = rx2;
          rx2 = Math.min(rx2, w / 2); ry2 = Math.min(ry2, h / 2);
          if (rx2 <= 0 || ry2 <= 0) return "M" + x + " " + y + "h" + w + "v" + h + "h" + (-w) + "Z";
          return "M" + (x + rx2) + " " + y +
            "h" + (w - 2 * rx2) + "a" + rx2 + " " + ry2 + " 0 0 1 " + rx2 + " " + ry2 +
            "v" + (h - 2 * ry2) + "a" + rx2 + " " + ry2 + " 0 0 1 " + (-rx2) + " " + ry2 +
            "h" + (-(w - 2 * rx2)) + "a" + rx2 + " " + ry2 + " 0 0 1 " + (-rx2) + " " + (-ry2) +
            "v" + (-(h - 2 * ry2)) + "a" + rx2 + " " + ry2 + " 0 0 1 " + rx2 + " " + (-ry2) + "Z";
        }
        return "";
      }
      function svgToPaths(svgEl) {
        var out = [];
        var els = svgEl.querySelectorAll("path,rect,circle,ellipse,line,polyline,polygon");
        for (var n = 0; n < els.length; n++) {
          var node = els[n];
          var d = elemToD(node);
          if (!d) continue;
          var fill = svgPaint(node, "fill", "fillOpacity");
          var stroke = svgPaint(node, "stroke", "strokeOpacity");
          if (!fill && !stroke) continue;
          var ctm = [1, 0, 0, 1, 0, 0];
          try { var m = node.getCTM(); if (m) ctm = [m.a, m.b, m.c, m.d, m.e, m.f]; } catch (e) { /* default */ }
          out.push({
            d: d, ctm: ctm, fill: fill, stroke: stroke,
            strokeWidth: stroke ? (parseFloat(getComputedStyle(node).strokeWidth) || 1) : 0,
            fillRule: getComputedStyle(node).fillRule || "nonzero",
          });
        }
        return out;
      }
      // viewBox so the lib can scale geometry to the rendered box
      var vb = [0, 0, Math.round(rect.width) || 1, Math.round(rect.height) || 1];
      var vbAttr = el.getAttribute("viewBox");
      if (vbAttr) {
        var vp = vbAttr.trim().split(/[\s,]+/).map(parseFloat);
        if (vp.length === 4 && vp.every(function (n) { return !isNaN(n); })) vb = vp;
      }
      var svg = el.outerHTML.replace(/currentColor/gi, cs.color);
      if (svg.indexOf("xmlns") === -1) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      return withAbs({
        type: "vector",
        name: nameOf(el),
        paths: svgToPaths(el),
        viewBox: vb,
        svg: svg, // raster fallback when paths is empty
        _w: Math.round(rect.width),
        _h: Math.round(rect.height),
        // fixed sizing so a stretch parent never distorts the icon
        layout: { sizing: { w: "fixed", h: "fixed" } },
      });
    }

    // leaf with text -> text node.
    // Only PIN a width when the browser actually wrapped the text onto multiple
    // lines: then we want Figma to wrap at the same width. For single-line text
    // we leave it auto-width, because Figma renders Inter slightly wider than
    // Chromium and a tight fixed width would force a spurious second line
    // (nav links, stat numbers, logo labels). +3px buffer absorbs the per-line
    // metric difference so a wrapped paragraph keeps its line count.
    if (elementChildren.length === 0 && directText) {
      var range = document.createRange();
      range.selectNodeContents(el);
      var lineCount = range.getClientRects().length || 1;
      var multiline = lineCount > 1;
      var node = {
        type: "text",
        name: nameOf(el),
        // Measured per-line height in px (handles line-height:normal, which
        // getComputedStyle reports as "normal" not a number). Without carrying
        // this, Figma's tighter default line-height makes every block shorter,
        // which accumulates into vertical drift down a long page.
        lineHeight: Math.round((rect.height / lineCount) * 100) / 100,
        text: {
          content: directText,
          size: px(cs.fontSize),
          weight: cs.fontWeight === "normal" ? 400 : cs.fontWeight === "bold" ? 700 : parseInt(cs.fontWeight, 10) || 400,
          color: parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 },
        },
      };
      // background-clip:text -> text painted with a gradient fill
      if (cs.webkitBackgroundClip === "text" || cs.backgroundClip === "text") {
        const tg = parseGradients(cs.backgroundImage, rect);
        if (tg.length) node.text.gradient = tg[0];
      }
      if (multiline) node.width = Math.ceil(rect.width) + 3;
      return withAbs(node);
    }

    // otherwise -> frame
    const layout = frameLayout(el, cs, parentCtx);
    if (!layout._flex && elementChildren.length > 0) {
      warnings.push("Non-flex container with children: <" + el.tagName.toLowerCase() + " " + nameOf(el) + "> — Contract requires display:flex");
    }
    if (cs.flexWrap === "wrap") {
      warnings.push("flex-wrap:wrap not supported in v1: " + nameOf(el));
    }
    if (elementChildren.length > 0 && directText) {
      warnings.push("Mixed text + elements ignored on: " + nameOf(el) + " (text \"" + directText.slice(0, 20) + "...\")");
    }

    const ctx = {
      mode: layout.mode,
      align: layout.align,
      contentW: layout._contentW,
      contentH: layout._contentH,
      crossHug: layout._crossHug,
      parentRect: rect, // for absolute children to position against (Phase 5)
    };
    const children = elementChildren.map((c) => walk(c, ctx)).filter(Boolean);
    delete layout._flex;
    delete layout._contentW;
    delete layout._contentH;
    delete layout._crossHug;

    var node = {
      type: "frame",
      name: nameOf(el),
      layout,
      style: styleOf(el, cs),
      component: el.getAttribute("data-figma-component") || null,
      children,
    };
    // overflow:hidden/clip -> clip content in Figma (e.g. glow blob stays inside card)
    if (/hidden|clip/.test(cs.overflow) || /hidden|clip/.test(cs.overflowX)) node.clip = true;
    // CSS background-image -> carry URL for Node to fetch (rendered as an image fill)
    var bg = cs.backgroundImage;
    if (bg && bg !== "none") {
      var m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) {
        try { node.imageUrl = new URL(m[1], location.href).href; }
        catch (e) { node.imageUrl = m[1]; }
      }
    }
    return withAbs(node);
  }

  const root = selector ? document.querySelector(selector) : document.body.firstElementChild;
  if (!root) return { error: "No root element found for selector: " + selector };
  const ir = walk(root, null);
  return { ir, warnings };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error("Usage: node extract.js <input.html> [--selector \"<css>\"] [--out <file.json>]");
    process.exit(1);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const url = "file://" + path.resolve(args.input);
    await page.goto(url, { waitUntil: "networkidle" });
    // Measure with real Inter so the IR geometry (line-heights, text widths) matches
    // what Figma renders — Figma always uses Inter, so the extractor must too,
    // otherwise a system fallback font skews every text box and drifts the layout.
    try {
      await page.addStyleTag({ url: "https://fonts.googleapis.com/css2?family=Inter:wght@100;200;300;400;500;600;700;800;900&display=swap" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
    } catch (e) { console.error("⚠️  không tải được Inter web font, dùng font hệ thống: " + e.message); }
    const result = await page.evaluate(walkInPage, args.selector);

    if (result.error) {
      console.error("Error:", result.error);
      process.exit(2);
    }
    (result.warnings || []).forEach((w) => console.error("⚠️  " + w));

    await embedImages(result.ir, page);
    await rasterizeVectors(result.ir, page);

    const json = JSON.stringify(result.ir, null, 2);
    if (args.out) {
      fs.writeFileSync(args.out, json);
      console.error("✓ IR written to " + args.out);
    } else {
      process.stdout.write(json + "\n");
    }
  } finally {
    await browser.close();
  }
}

// Fetch every imageUrl in the IR tree and inline it as base64 so the plugin
// (which can't do network/disk I/O) can rebuild the image. Uses the page's
// request context so file:// and same-origin assets resolve too. Dedupes by URL.
async function embedImages(ir, page) {
  const nodes = [];
  (function collect(n) {
    if (n && n.imageUrl) nodes.push(n);
    if (n && n.children) n.children.forEach(collect);
  })(ir);
  if (!nodes.length) return;

  const cache = new Map();
  let ok = 0;
  for (const n of nodes) {
    const u = n.imageUrl;
    delete n.imageUrl;
    try {
      if (!cache.has(u)) {
        const resp = await page.request.get(u);
        if (!resp.ok()) throw new Error("HTTP " + resp.status());
        const buf = await resp.body();
        const ct = (resp.headers()["content-type"] || "").split(";")[0] || "image/jpeg";
        cache.set(u, { data: buf.toString("base64"), format: ct });
      }
      const img = cache.get(u);
      n.image = { data: img.data, format: img.format, scaleMode: "FILL" };
      ok++;
    } catch (e) {
      console.error("⚠️  ảnh tải lỗi: " + u + " (" + e.message + ")");
    }
  }
  console.error("✓ Đã nhúng " + ok + "/" + nodes.length + " ảnh");
}

// Rasterize each inline-<svg> (type:"vector") to a PNG and convert it into an image node so
// the figma-clip pipeline renders it as an IMAGE paint. Figma editable-vector synthesis is out
// of scope (v1); a crisp 2x raster on a transparent background is the handoff tradeoff. The
// SVG markup already has currentColor baked + xmlns guaranteed by walkInPage.
async function rasterizeVectors(ir, page) {
  const nodes = [];
  (function collect(n) {
    // only rasterize vectors we couldn't path-ify (no drawable paths) — the rest stay editable VECTOR
    if (n && n.type === "vector" && n.svg && (!n.paths || !n.paths.length)) nodes.push(n);
    if (n && n.children) n.children.forEach(collect);
  })(ir);
  if (!nodes.length) return;

  let ok = 0;
  for (const n of nodes) {
    const w = Math.max(1, n._w || 24);
    const h = Math.max(1, n._h || 24);
    // give the <svg> root an intrinsic size so the browser doesn't fall back to 300x150
    let svg = n.svg;
    if (!/<svg[^>]*\swidth=/i.test(svg)) svg = svg.replace(/<svg/i, '<svg width="' + w + '" height="' + h + '"');
    try {
      const data = await page.evaluate(async (args) => {
        const scale = 8; // 8x supersample so icons stay crisp on retina + deep zoom in Figma
        const cw = Math.min(4096, Math.max(1, Math.round(args.w * scale)));
        const ch = Math.min(4096, Math.max(1, Math.round(args.h * scale)));
        const img = new Image();
        const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(args.svg);
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error("không load được SVG"));
          img.src = url;
        });
        const c = document.createElement("canvas");
        c.width = cw;
        c.height = ch;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, cw, ch);
        return c.toDataURL("image/png").split(",")[1];
      }, { svg: svg, w: w, h: h });
      if (data) {
        n.type = "image";
        n.image = { data: data, format: "image/png", scaleMode: "FILL" };
        delete n.svg;
        ok++;
      }
    } catch (e) {
      console.error("⚠️  icon rasterize lỗi (" + (n.name || "svg") + "): " + e.message);
    }
  }
  console.error("✓ Đã rasterize " + ok + "/" + nodes.length + " icon (SVG → PNG 8x)");
}

main().catch((e) => { console.error(e); process.exit(1); });
