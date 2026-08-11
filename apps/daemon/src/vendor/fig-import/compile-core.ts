// @ts-nocheck
// Vendored from design-v3 fig-pipeline/tools/compile-core.mjs (branch
// feat/ui-figma-new — the Fig Pipeline plugin toolchain, successor of the
// removed contract/fig-import). Pure ESM, zero dependencies; Buffer usage is
// feature-guarded so the same file runs in the plugin browser bundle. Kept
// verbatim apart from this header AND the one block marked "OD LOCAL PATCH"
// below — re-vendor from upstream, then re-apply that patch.
// compile-core.mjs — pure IR → React bundle compiler. No Node APIs: runs both
// in the CLI (build-react.mjs) and INSIDE the fig-export plugin UI (bundled by
// the plugin build into dist/ui.html, where it powers the one-click .zip).
//
//   compileIR(ir) -> { files: [{path, content}], summary }
//   zipFiles(files) -> Uint8Array   (store-only ZIP, utf-8 names)

// ---------- naming ----------

export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function cssVar(figName) {
  return "--" + slug(figName);
}

function pascal(name) {
  const p = String(name)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return /^[A-Za-z]/.test(p) ? p : "C" + p;
}

function propJsName(figKey) {
  // "label#123:4" -> "label"; variant axis "Size" -> "size"; "showIcon#9:1" -> "showIcon"
  const base = figKey.split("#")[0];
  const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  let name = parts.map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1))).join("");
  // designers name props like "2nd Icon" — identifiers can't start with a digit
  if (/^[0-9]/.test(name)) name = "_" + name;
  // a Figma axis named "Style"/"className" would collide with React's own
  // props (spreading "Success" into style crashes CSSStyleDeclaration)
  if (name === "style" || name === "className") name += "Prop";
  return name || "prop";
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function px(n) {
  return typeof n === "number" ? `${round(n)}px` : n;
}

// ---------- main compile ----------

export function compileIR(ir) {
  // ---------- tokens.css ----------

  function isUnitless(name) {
    return /weight|opacity|z-index|flex|count/i.test(name);
  }

  function tokenValue(v, varName) {
    const val = v && typeof v === "object" && "value" in v ? v.value : v;
    if (typeof val === "number") return isUnitless(varName) ? String(val) : `${val}px`;
    const s = String(val);
    // Font tokens ship as a bare family name ("Geist") — without a fallback
    // chain the browser drops to serif when the webfont isn't loaded.
    if (/font/i.test(varName) && /^[A-Za-z][\w ]*$/.test(s) && !/^(normal|italic|bold|\d)/.test(s)) {
      const mono = /mono/i.test(s);
      return `"${s}", ${mono ? "ui-monospace, SFMono-Regular, monospace" : "ui-sans-serif, system-ui, sans-serif"}`;
    }
    return s;
  }

  function buildTokensCss() {
    const collections = ir.collections ?? [];
    const variables = ir.variables ?? [];
    let css = `/* generated from ${ir.meta?.file ?? "?"} — do not edit by hand */\n`;
    for (const col of collections) {
      const vars = variables.filter((v) => v.collection === col.name);
      if (!vars.length) continue;
      for (const mode of col.modes) {
        const isDefault = mode === col.defaultMode;
        const selectors = [];
        if (isDefault) selectors.push(":root");
        const modeClass = `.mode-${slug(col.name)}-${slug(mode)}`;
        selectors.push(modeClass);
        if (/dark/i.test(mode)) selectors.push(".dark");
        css += `\n/* ${col.name} · ${mode}${isDefault ? " (default)" : ""} */\n${selectors.join(", ")} {\n`;
        for (const v of vars) {
          const entry = v.values?.[mode];
          if (entry === undefined) continue;
          css += `  ${cssVar(v.name)}: ${tokenValue(entry, v.name)};\n`;
        }
        css += `}\n`;
      }
    }
    return css;
  }

  // ---------- style generation ----------

  function refOrLiteral(varName, literal) {
    return varName ? `var(${cssVar(varName)}, ${literal})` : literal;
  }

  function paintCss(p) {
    if (!p) return null;
    if (p.type === "solid") return refOrLiteral(p.var, p.color);
    if (p.type === "gradient") {
      const stops = (p.stops ?? []).map((s) => `${s.color} ${round(s.pos * 100)}%`).join(", ");
      if (p.gradientType === "GRADIENT_RADIAL") return `radial-gradient(circle, ${stops})`;
      const t = p.transform;
      let angle = 135;
      if (Array.isArray(t) && Array.isArray(t[0])) {
        angle = Math.round(90 + (Math.atan2(t[1][0], t[0][0]) * 180) / Math.PI);
      }
      return `linear-gradient(${angle}deg, ${stops})`;
    }
    if (p.type === "image") return "#d0d0d5"; // placeholder — image fills not exported
    return null;
  }

  const ALIGN = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between", BASELINE: "baseline" };

  // ---------- absolute placement (IR x/y is the source of truth) ----------

  function padPair(node) {
    if (node.layout?.padding) {
      const [pt, pr, pb, pl] = node.layout.padding;
      return { x: (pr ?? 0) + (pl ?? 0), y: (pt ?? 0) + (pb ?? 0) };
    }
    const css = node.css ?? {};
    const short = css.padding ? String(css.padding).replace(/\/\*[\s\S]*?\*\//g, "").trim().split(/\s+/).map((v) => parseFloat(v) || 0) : null;
    if (short && short.length) {
      const [t, r = t, b = t, l = r] = short;
      return { x: r + l, y: t + b };
    }
    const num = (k) => parseFloat(css[k]) || 0;
    return { x: num("padding-right") + num("padding-left"), y: num("padding-top") + num("padding-bottom") };
  }

  // in-context (design) size: FILL nodes have no w/h in IR — recover from the
  // parent chain (root always has w) so absolute children can be edge-anchored.
  function designSize(node, ctx) {
    return {
      w: node.w !== undefined ? node.w : ctx.parentDesignW !== undefined ? ctx.parentDesignW - (ctx.parentPadX ?? 0) : undefined,
      h: node.h !== undefined ? node.h : ctx.parentDesignH !== undefined ? ctx.parentDesignH - (ctx.parentPadY ?? 0) : undefined,
    };
  }

  // Anchor an absolutely-placed node. Figma constraints win when the IR has
  // them; otherwise reverse-engineer the intent: anchor to the NEARER edge
  // (identical rendering while the parent keeps its design width, and the
  // right thing when a FILL container stretches — status bar indicators sit
  // 31.57px from the right, so they track the right edge).
  function absAnchor(s, node, ctx) {
    const gx = ctx.groupOrigin?.x ?? 0;
    const gy = ctx.groupOrigin?.y ?? 0;
    const localX = node.x - gx;
    const localY = node.y - gy;
    const pw = ctx.parentDesignW;
    const ph = ctx.parentDesignH;
    const ch = node.constraints?.h;
    const cv = node.constraints?.v;
    s.position = "absolute";
    delete s.left; delete s.right; delete s.top; delete s.bottom;
    const canH = pw !== undefined && node.w !== undefined;
    if (canH && ch === "STRETCH") {
      s.left = px(round(localX));
      s.right = px(round(pw - localX - node.w));
      delete s.width;
    } else if (canH && (ch === "MAX" || (ch === undefined && pw - localX - node.w < localX))) {
      s.right = px(round(pw - localX - node.w));
    } else {
      s.left = px(round(localX));
    }
    if (ph !== undefined && node.h !== undefined && cv === "MAX") {
      s.bottom = px(round(ph - localY - node.h));
    } else {
      s.top = px(round(localY));
    }
  }

  function styleForNode(node, ctx) {
    const s = {};
    const bound = node.bound ?? {};
    const layout = node.layout;

    if (layout) {
      s.display = "flex";
      s.flexDirection = layout.dir;
      if (layout.wrap) s.flexWrap = "wrap";
      if (layout.alignMain === "SPACE_BETWEEN") s.justifyContent = "space-between";
      else s.justifyContent = ALIGN[layout.alignMain] ?? "flex-start";
      s.alignItems = ALIGN[layout.alignCross] ?? "flex-start";
      if (layout.gap && layout.alignMain !== "SPACE_BETWEEN") {
        const g = refOrLiteral(bound.itemSpacing, px(layout.gap));
        s.gap = layout.wrap && layout.gapCross !== undefined ? `${refOrLiteral(bound.counterAxisSpacing, px(layout.gapCross))} ${g}` : g;
      }
      const [pt, pr, pb, pl] = layout.padding ?? [0, 0, 0, 0];
      if (pt) s.paddingTop = refOrLiteral(bound.paddingTop, px(pt));
      if (pr) s.paddingRight = refOrLiteral(bound.paddingRight, px(pr));
      if (pb) s.paddingBottom = refOrLiteral(bound.paddingBottom, px(pb));
      if (pl) s.paddingLeft = refOrLiteral(bound.paddingLeft, px(pl));
    } else if ((node.children ?? []).some((c) => c.x !== undefined)) {
      s.position = "relative";
    }

    const parentDir = ctx.parentDir;
    if (node.sizingH === "FILL") {
      if (parentDir === "row") { s.flexGrow = 1; s.flexShrink = 1; s.flexBasis = "0%"; }
      else if (parentDir === "column") s.alignSelf = "stretch";
      else s.width = "100%";
    } else if (node.w !== undefined) {
      s.width = refOrLiteral(bound.width, px(node.w));
    }
    if (node.sizingV === "FILL") {
      if (parentDir === "column") { s.flexGrow = 1; s.flexShrink = 1; s.flexBasis = "0%"; }
      else if (parentDir === "row") s.alignSelf = "stretch";
      else s.height = "100%";
    } else if (node.h !== undefined) {
      s.height = refOrLiteral(bound.height, px(node.h));
    }
    if (node.type !== "TEXT" && s.display === undefined && (s.width !== undefined || s.height !== undefined)) {
      s.flexShrink = 0;
    }

    if (node.x !== undefined && !ctx.isRoot) {
      absAnchor(s, node, ctx);
    }

    const fill = paintCss((node.fills ?? [])[0]);
    if (fill) {
      if (node.type === "TEXT") s.color = fill;
      else if (fill.includes("gradient")) s.background = fill;
      else s.backgroundColor = fill;
    }
    const stroke = (node.strokes ?? [])[0];
    if (stroke && node.strokeWeight) {
      s.border = `${px(node.strokeWeight)} ${node.dash ? "dashed" : "solid"} ${paintCss(stroke)}`;
      s.boxSizing = "border-box";
    }

    if (node.radius) {
      const names = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
      const corners = node.radius.map((r, i) => refOrLiteral(bound[names[i]], px(r)));
      s.borderRadius = corners.every((c) => c === corners[0]) ? corners[0] : corners.join(" ");
    }

    const shadows = (node.effects ?? [])
      .filter((e) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW")
      .map((e) => `${e.type === "INNER_SHADOW" ? "inset " : ""}${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread ?? 0)} ${e.color}`);
    if (shadows.length) s.boxShadow = shadows.join(", ");
    const bgBlur = (node.effects ?? []).find((e) => e.type === "BACKGROUND_BLUR");
    if (bgBlur) s.backdropFilter = `blur(${px(bgBlur.blur)})`;
    const blur = (node.effects ?? []).find((e) => e.type === "LAYER_BLUR");
    if (blur) s.filter = `blur(${px(blur.blur)})`;

    if (node.opacity !== undefined) s.opacity = node.opacity;
    if (node.clips) s.overflow = "hidden";
    if (node.rotation) s.transform = `rotate(${-node.rotation}deg)`;

    if (node.text) {
      const t = node.text;
      if (t.fontFamily) s.fontFamily = `"${t.fontFamily}", system-ui, sans-serif`;
      if (t.fontSize) s.fontSize = refOrLiteral(bound.fontSize, px(t.fontSize));
      if (t.fontWeight) s.fontWeight = bound.fontWeight ? `var(${cssVar(bound.fontWeight)}, ${t.fontWeight})` : t.fontWeight;
      if (t.lineHeight) s.lineHeight = refOrLiteral(bound.lineHeight, px(t.lineHeight));
      else if (t.lineHeightPct) s.lineHeight = String(round(t.lineHeightPct / 100));
      if (t.letterSpacing) s.letterSpacing = refOrLiteral(bound.letterSpacing, px(t.letterSpacing));
      if (t.decoration) s.textDecoration = t.decoration.toLowerCase().replace("_", "-");
      if (t.case) s.textTransform = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" }[t.case] ?? undefined;
      if (t.alignH && t.alignH !== "LEFT") s.textAlign = t.alignH.toLowerCase();
      if (/italic/i.test(t.fontStyle ?? "")) s.fontStyle = "italic";
      s.whiteSpace = s.whiteSpace ?? "pre-wrap";
    }

    return s;
  }

  function styleLiteral(s) {
    const entries = Object.entries(s).filter(([, v]) => v !== undefined && v !== null);
    if (!entries.length) return "{}";
    return "{ " + entries.map(([k, v]) => `${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`).join(", ") + " }";
  }

  // ---------- style object -> token classes (tk-*) + literal inline style ----------
  //
  // Two channels, one rule: a declaration whose value references a Figma
  // variable (contains `var(--…)`) becomes a shared `tk-*` class emitted into
  // tk.css; every other declaration stays inline in the JSX. Inline style in
  // generated markup therefore always means "literal the designer never bound
  // in Figma" — the tokenization-debt report is readable off the JSX itself,
  // and the class vocabulary is exactly the token vocabulary (no Tailwind).

  const SPLIT_OUTSIDE_PARENS = /\s+(?![^()]*\))/;

  // class-name segment per CSS property (camelCase key). Anything missing
  // falls back to the kebab-case property name.
  const TK_ABBREV = {
    background: "bg", backgroundColor: "bg", color: "text",
    borderColor: "border", borderWidth: "bw",
    gap: "gap", rowGap: "gap-y", columnGap: "gap-x",
    padding: "p", paddingTop: "pt", paddingRight: "pr", paddingBottom: "pb", paddingLeft: "pl",
    width: "w", height: "h", minWidth: "min-w", maxWidth: "max-w", minHeight: "min-h", maxHeight: "max-h",
    borderRadius: "rounded", borderTopLeftRadius: "rounded-tl", borderTopRightRadius: "rounded-tr",
    borderBottomRightRadius: "rounded-br", borderBottomLeftRadius: "rounded-bl",
    fontSize: "fs", fontWeight: "fw", lineHeight: "lh", letterSpacing: "ls",
    boxShadow: "shadow", backdropFilter: "backdrop",
  };

  function kebab(prop) {
    return prop.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  }

  const tkRegistry = new Map(); // "prop|value" -> class name
  const tkByName = new Map(); // class name -> { prop, value }
  let tokenDecls = 0;
  let literalDecls = 0;

  function tkClass(prop, value) {
    const key = prop + "|" + value;
    const hit = tkRegistry.get(key);
    if (hit) return hit;
    // named after the FIRST token in the value; same token bound with a
    // different fallback (mode-dependent literal) gets a -2/-3 suffix
    const token = String(value).match(/var\(\s*--([a-zA-Z0-9-]+)/)?.[1] ?? "x";
    const base = `tk-${TK_ABBREV[prop] ?? kebab(prop)}-${slug(token)}`;
    let name = base;
    for (let n = 2; tkByName.has(name); n++) name = `${base}-${n}`;
    tkRegistry.set(key, name);
    tkByName.set(name, { prop, value });
    return name;
  }

  // Expand shorthands so each declaration carries at most one bindable value.
  // Required for clean class naming AND to stop an inline shorthand from
  // clobbering a token-class longhand (inline `border` would wipe the
  // border-color a class provides).
  function expandShorthands(s) {
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (v === undefined || v === null) continue;
      const sv = String(v);
      if (k === "gap") {
        const p = sv.split(SPLIT_OUTSIDE_PARENS);
        if (p.length === 2) { out.rowGap = p[0]; out.columnGap = p[1]; continue; }
      } else if (k === "padding") {
        const p = sv.split(SPLIT_OUTSIDE_PARENS);
        if (p.length >= 2 && p.length <= 4) {
          const [t, r, b, l] = p.length === 2 ? [p[0], p[1], p[0], p[1]] : p.length === 3 ? [p[0], p[1], p[2], p[1]] : p;
          out.paddingTop = t; out.paddingRight = r; out.paddingBottom = b; out.paddingLeft = l;
          continue;
        }
      } else if (k === "border") {
        const m = sv.match(/^(\S+)\s+(solid|dashed|dotted)\s+(.+)$/);
        if (m) { out.borderWidth = m[1]; out.borderStyle = m[2]; out.borderColor = m[3]; continue; }
      } else if (k === "borderRadius") {
        const p = sv.split(SPLIT_OUTSIDE_PARENS);
        if (p.length === 4) {
          out.borderTopLeftRadius = p[0]; out.borderTopRightRadius = p[1];
          out.borderBottomRightRadius = p[2]; out.borderBottomLeftRadius = p[3];
          continue;
        }
      }
      out[k] = v;
    }
    return out;
  }

  function splitStyle(styleObj) {
    const cls = [];
    const rest = {};
    for (const [k, v] of Object.entries(expandShorthands(styleObj))) {
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && v.includes("var(--")) {
        cls.push(tkClass(k, v));
        tokenDecls++;
      } else {
        rest[k] = v;
        literalDecls++;
      }
    }
    return { cls, rest };
  }

  // Layout utilities CƠ BẢN, tên tương thích Tailwind (user 07-24: "vẫn cho
  // dùng tailwind nhưng chỉ giới hạn flex… mấy cái cơ bản") — emit TĨNH vào
  // globals.css nên không cần cài Tailwind, và vocabulary vẫn ĐÓNG: chỉ đúng
  // bộ này tồn tại. Mọi thứ dính TOKEN (màu/spacing/radius/shadow/typography)
  // vẫn bắt buộc tk-* — cố tình KHÔNG có p-4/gap-2/bg-*/text-*/shadow-*/rounded-*.
  const LAYOUT_UTILS = {
    flex: "display: flex", "inline-flex": "display: inline-flex", grid: "display: grid",
    block: "display: block", "inline-block": "display: inline-block", hidden: "display: none",
    "flex-row": "flex-direction: row", "flex-col": "flex-direction: column",
    "flex-row-reverse": "flex-direction: row-reverse", "flex-col-reverse": "flex-direction: column-reverse",
    "flex-wrap": "flex-wrap: wrap", "flex-nowrap": "flex-wrap: nowrap",
    "flex-1": "flex: 1 1 0%", "flex-auto": "flex: 1 1 auto", "flex-none": "flex: none",
    grow: "flex-grow: 1", "grow-0": "flex-grow: 0", shrink: "flex-shrink: 1", "shrink-0": "flex-shrink: 0",
    "items-start": "align-items: flex-start", "items-center": "align-items: center",
    "items-end": "align-items: flex-end", "items-stretch": "align-items: stretch", "items-baseline": "align-items: baseline",
    "justify-start": "justify-content: flex-start", "justify-center": "justify-content: center",
    "justify-end": "justify-content: flex-end", "justify-between": "justify-content: space-between",
    "justify-around": "justify-content: space-around", "justify-evenly": "justify-content: space-evenly",
    "self-start": "align-self: flex-start", "self-center": "align-self: center",
    "self-end": "align-self: flex-end", "self-stretch": "align-self: stretch",
    relative: "position: relative", absolute: "position: absolute", fixed: "position: fixed", sticky: "position: sticky",
    "inset-0": "inset: 0", "top-0": "top: 0", "right-0": "right: 0", "bottom-0": "bottom: 0", "left-0": "left: 0",
    "overflow-hidden": "overflow: hidden", "overflow-auto": "overflow: auto",
    "overflow-x-auto": "overflow-x: auto", "overflow-y-auto": "overflow-y: auto",
    "w-full": "width: 100%", "h-full": "height: 100%", "min-w-0": "min-width: 0", "min-h-0": "min-height: 0",
    "max-w-full": "max-width: 100%", "text-center": "text-align: center", "text-left": "text-align: left", "text-right": "text-align: right",
    "text-nowrap": "white-space: nowrap", truncate: "overflow: hidden; text-overflow: ellipsis; white-space: nowrap",
    "pointer-events-none": "pointer-events: none", "cursor-pointer": "cursor: pointer",
  };

  // --- OD LOCAL PATCH (not upstream) -------------------------------------
  // Backfill: tkClass() only mints a class when some Figma component happens to
  // bind that (property × token) pair. A token nobody bound yet therefore has NO
  // class — and an app author who needs it has no legal way to use it: inline
  // `var(--token)` is the only option left, and inline token values do NOT
  // survive the capture step back into Figma (stampFigMarkers reads classList).
  // So mint the obvious class for every declared variable up front. Cheap
  // (1–2 declarations per token) and it keeps "class = the only channel" true.
  function backfillTkClasses() {
    for (const v of ir.variables ?? []) {
      const name = String(v.name ?? "");
      if (!name) continue;
      const ref = `var(${cssVar(name)})`;
      const n = name.toLowerCase();
      if (v.type === "COLOR") {
        tkClass("color", ref);
        tkClass("backgroundColor", ref);
        if (/border|outline|ring|stroke|divider/.test(n)) tkClass("borderColor", ref);
      } else if (v.type === "FLOAT" || v.type === "STRING") {
        if (/font-?weight|\bweight\b/.test(n)) tkClass("fontWeight", ref);
        else if (/font-?size|\bsize\b(?!.*icon)/.test(n) && /font|text|type/.test(n)) tkClass("fontSize", ref);
        else if (/line-?height|leading/.test(n)) tkClass("lineHeight", ref);
        else if (/letter-?spacing|tracking/.test(n)) tkClass("letterSpacing", ref);
        else if (/radius|rounded/.test(n)) tkClass("borderRadius", ref);
        else if (/font-?family/.test(n)) tkClass("fontFamily", ref);
      }
    }
  }
  // --- end OD LOCAL PATCH -------------------------------------------------

  function buildTkCss() {
    backfillTkClasses();
    let css = `/* generated token classes — the ONLY legal classes for markup in this bundle.
   1 class = 1 token-bound declaration (values resolve via tokens.css).
   Literal values live inline in the JSX = spots the designer left unbound in Figma. */\n`;
    for (const name of [...tkByName.keys()].sort()) {
      const { prop, value } = tkByName.get(name);
      css += `.${name} { ${kebab(prop)}: ${value}; }\n`;
    }
    css += `\n/* ---------- layout utilities (Tailwind-compatible subset, TĨNH — không cần Tailwind) ----------\n   CHỈ layout cơ bản; màu/spacing/radius/shadow/chữ PHẢI dùng tk-* (docs/classes.md). */\n`;
    for (const [name, decl] of Object.entries(LAYOUT_UTILS)) {
      css += `.${name} { ${decl}; }\n`;
    }
    return css;
  }

  function attrString({ cls, rest }, mergeRoot = false) {
    let out = "";
    if (mergeRoot) {
      // component root: caller's className appends after the generated one,
      // caller's style (inline, always wins) merges last — this is how call
      // sites impose the in-context size of a resized/FILL instance.
      if (cls.length) out += ` className={${JSON.stringify(cls.join(" "))} + (props.className ? " " + props.className : "")}`;
      else out += ` className={props.className}`;
      out += Object.keys(rest).length ? ` style={{ ...${styleLiteral(rest)}, ...props.style }}` : ` style={props.style}`;
      return out;
    }
    if (cls.length) out += ` className=${JSON.stringify(cls.join(" "))}`;
    if (Object.keys(rest).length) out += ` style={${styleLiteral(rest)}}`;
    return out;
  }

  // Emit `className="…" style={{…}}` attribute string from a style object.
  function emitAttrs(styleObj) {
    return attrString(splitStyle(styleObj));
  }

  // ---------- Figma Dev Mode CSS (node.css from getCSSAsync) -> style object ----------

  function kebabToCamel(k) {
    return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  function styleFromCssEntries(css) {
    const s = {};
    for (const [k, vRaw] of Object.entries(css)) {
      // Figma CSS values carry annotations like `20px /* 142.857% */` — strip
      // comments or they corrupt the declaration.
      let v = String(vRaw).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (!v) continue;
      // Dev Mode CSS ships bare family names ("SF Pro Text") — without a
      // fallback chain the browser drops to serif when the font is missing.
      if (k === "font-family" && !v.includes(",")) {
        v = `${v}, ${/mono/i.test(v) ? "ui-monospace, SFMono-Regular, monospace" : "ui-sans-serif, system-ui, sans-serif"}`;
      }
      s[kebabToCamel(k)] = v;
    }
    return s;
  }

  // ---------- JSX emit ----------

  // Figma set/component name -> generated component name (filled by pre-pass).
  let REF_MAP = {};
  let CURRENT_REFS = null;
  let CURRENT_ICON_REFS = null; // asset hashes of icon components referenced

  // JSX attribute value: plain quotes when safe, {"…"} expression when the
  // string contains quotes/backslashes/newlines (JSX attrs have NO escapes).
  function jsxAttr(v) {
    const s = String(v);
    return /^[^"\\\n\r{}<>&]*$/.test(s) ? JSON.stringify(s) : `{${JSON.stringify(s)}}`;
  }

  // Placement-only styles for call-site refs: the referenced component renders
  // its own box; the call site only contributes flex/absolute placement.
  function placementStyle(node, ctx) {
    const s = {};
    const parentDir = ctx.parentDir;
    if (node.sizingH === "FILL") {
      if (parentDir === "row") { s.flexGrow = 1; s.flexShrink = 1; s.flexBasis = "0%"; }
      else if (parentDir === "column") s.alignSelf = "stretch";
      else s.width = "100%";
    }
    if (node.sizingV === "FILL") {
      if (parentDir === "column") { s.flexGrow = 1; s.flexShrink = 1; s.flexBasis = "0%"; }
      else if (parentDir === "row") s.alignSelf = "stretch";
      else s.height = "100%";
    }
    if (node.grow) s.flexGrow = node.grow;
    if (node.selfAlign === "STRETCH") s.alignSelf = "stretch";
    if (node.x !== undefined && !ctx.isRoot) {
      absAnchor(s, node, ctx);
    }
    return s;
  }

  // Returns a pure JS *expression* (JSX element or ternary). Parents embed child
  // expressions as {expr}; the variant render body is `(props) => (expr)`.
  function exprForNode(node, ctx, indent) {
    const pad = "  ".repeat(indent);
    // Figma's own Dev Mode CSS (getCSSAsync) wins when the exporter captured
    // it; our derived style is the fallback for older IR files.
    // Empty leaf boxes (no children/text) keep Figma's padding in their CSS,
    // but with border-box that padding imposes a MIN size (Switch thumb: 16px
    // box + 10px padding → 20px blob). Padding on an empty box renders
    // nothing in Figma, so dropping it is faithful.
    const isEmptyLeaf = !node.text && !node.asset && !node.ref && !node.iconRef && !(node.children?.length);
    let cssSource = node.css ? fixImageCss(node.css, node) : node.css;
    if (cssSource && isEmptyLeaf) {
      cssSource = { ...cssSource };
      for (const k of Object.keys(cssSource)) if (/^(padding|gap|row-gap|column-gap)/.test(k)) delete cssSource[k];
    }
    let parts;
    if (cssSource) {
      const s = styleFromCssEntries(cssSource);
      // Figma Dev-Mode CSS is unreliable for absolutely-placed children: it
      // may drop position entirely (children then flow in z-order — status
      // bars rendered mirrored/stacked) or give offsets against the wrong
      // containing block (battery cap flew out of its 27px parent). IR x/y is
      // always relative to the direct parent — exactly our DOM nesting — so
      // when the node is absolutely placed, IR wins over css offsets.
      if (node.x !== undefined && !ctx.isRoot) {
        absAnchor(s, node, ctx);
      }
      // Dev-Mode CSS KHÔNG mang overflow — node Figma bật "Clip content" mà
      // React không clip thì content tràn đè lên sibling (List Item 49px:
      // separator gạch ngang chữ Label trong showcase 07-24).
      if (node.clips && s.overflow === undefined && s["overflow-x"] === undefined) s.overflow = "hidden";
      parts = splitStyle(s);
    } else {
      const s = styleForNode(node, ctx);
      if (isEmptyLeaf) for (const k of Object.keys(s)) if (/^(padding|gap)/.test(k)) delete s[k];
      parts = splitStyle(s);
    }
    if (node.css && !("position" in node.css)) {
      // Figma CSS gives children position:absolute but never marks the parent
      // as the containing block — without this, absolute children anchor to
      // some distant ancestor and "fly out" (charts were the first victims).
      // Never overwrite a position the node already has (an absolute parent
      // is itself a valid containing block).
      const childAbs = (node.children ?? []).some((c) => (c.css && c.css.position === "absolute") || c.x !== undefined);
      if (childAbs && parts.rest.position === undefined) parts.rest.position = "relative";
    }
    const attrs = attrString(parts, ctx.isRoot === true);
    const refs = node.propRefs ?? {};
    let expr;

    if (node.iconRef) {
      // Icon call site: a real icon component import when one exists;
      // the stringly <Icon name> registry is only the legacy fallback.
      const st = { ...(node.w !== undefined ? { width: px(node.w) } : {}), ...(node.h !== undefined ? { height: px(node.h) } : {}), ...placementStyle(node, ctx) };
      const ich = iconsFlat[node.iconRef];
      const icomp = ich && ICON_COMPS[ich];
      if (icomp) {
        CURRENT_ICON_REFS.add(ich);
        expr = `<${icomp.name} style={${styleLiteral(st)}} />`;
      } else {
        expr = `<Icon name=${jsxAttr(node.iconRef)} style={${styleLiteral(st)}} />`;
      }
    } else if (node.ref && !(node.hasOverrides && node.children?.length)) {
      // Component call site: render the generated component, not a re-flattened tree.
      // Instance mang OVERRIDE sâu (hasOverrides + subtree từ exporter) KHÔNG
      // đi đường này — rơi xuống render subtree như frame thường (sự thật
      // visual: text sửa tay, con ẩn/hiện — vụ Template/Address "Label/Body").
      const comp = REF_MAP[node.ref];
      if (comp && CURRENT_REFS) CURRENT_REFS.add(comp);
      const merged = { ...(node.refVariant ?? {}), ...(node.instanceProps ?? {}) };
      const propParts = [];
      for (const [k, v] of Object.entries(merged)) {
        if (v === undefined || v === null || typeof v === "object") continue;
        if (typeof v === "string" && /^\d+:\d+$/.test(v)) {
          // INSTANCE_SWAP id -> component reference via swapNames. A swap
          // target is a NORMAL component: icons resolve to their generated
          // icon component, everything else to its call-site component (with
          // the target variant's props). Old IR without swapNames drops the
          // id (the default subtree renders).
          const sw = SWAP_NAMES[v];
          const js = propJsName(k);
          if (sw && sw.icon) {
            const size = SWAP_SLOT_SIZE[comp]?.[js];
            const ich = iconsFlat[sw.icon];
            const icomp = ich && ICON_COMPS[ich];
            if (icomp) {
              CURRENT_ICON_REFS.add(ich);
              propParts.push(`${js}={<${icomp.name}${size ? ` size={${size}}` : ""} />}`);
            } else {
              propParts.push(`${js}={<Icon name=${jsxAttr(sw.icon)}${size ? ` size={${size}}` : ""} />}`);
            }
          } else if (sw && sw.ref && REF_MAP[sw.ref]) {
            const target = REF_MAP[sw.ref];
            CURRENT_REFS.add(target);
            const vp = Object.entries(sw.props ?? {})
              .map(([pk, pv]) => `${propJsName(pk)}=${jsxAttr(String(pv))}`)
              .join(" ");
            propParts.push(`${js}={<${target}${vp ? " " + vp : ""} />}`);
          }
          continue;
        }
        const js = propJsName(k);
        if (typeof v === "boolean") propParts.push(v ? js : `${js}={false}`);
        else if (typeof v === "number") propParts.push(`${js}={${v}}`);
        else propParts.push(`${js}=${jsxAttr(v)}`);
      }
      // Placement + the instance's IN-CONTEXT size go straight into the
      // component root via the style prop (inline style beats the root's own
      // width classes — fixes FILL/resized instances overflowing containers).
      const ps = placementStyle(node, ctx);
      if (node.sizingH === "FILL") ps.width = "100%";
      else if (node.w !== undefined) ps.width = px(node.w);
      if (node.sizingV === "FILL") ps.height = "100%";
      else if (node.h !== undefined) ps.height = px(node.h);
      const styleAttr = Object.keys(ps).length ? ` style={${styleLiteral(ps)}}` : "";
      expr = comp
        ? `<${comp}${propParts.length ? " " + propParts.join(" ") : ""}${styleAttr} />`
        : `<div style={${styleLiteral({ padding: "4px", border: "1px dashed #f66", fontSize: "10px", ...ps })}}>{${JSON.stringify("⟨" + node.ref + "⟩")}}</div>`;
    } else if (node.asset) {
      expr = `<Svg a="${node.asset}"${attrs} />`;
    } else if (node.text) {
      const content = refs.characters
        ? `{P(props, ${JSON.stringify(propJsName(refs.characters))}, ${JSON.stringify(node.text.characters)})}`
        : `{${JSON.stringify(node.text.characters)}}`;
      expr = `<div${attrs}>${content}</div>`;
    } else {
      const myDesign = designSize(node, ctx);
      const myPad = padPair(node);
      const childCtx = {
        parentDir: node.layout?.dir ?? null,
        isRoot: false,
        // group children keep frame-space coordinates — hand them the origin
        groupOrigin: node.type === "GROUP" ? { x: node.x ?? 0, y: node.y ?? 0 } : undefined,
        parentDesignW: myDesign.w,
        parentDesignH: myDesign.h,
        parentPadX: myPad.x,
        parentPadY: myPad.y,
      };
      const kidPad = "  ".repeat(indent + 1);
      const kids = (node.children ?? [])
        .map((c) => exprForNode(c, childCtx, indent + 1))
        .filter(Boolean)
        .map((e) => (e.startsWith("<") ? `${kidPad}${e}` : `${kidPad}{${e}}`));
      // Figma Slot: caller-provided content replaces the default children.
      const slotName = refs.slotContentId ? propJsName(refs.slotContentId) : null;
      if (slotName) {
        const fallback = kids.length ? `(<>\n${kids.join("\n")}\n${pad}</>)` : "null";
        expr = `<div${attrs}>{props.${slotName} !== undefined ? props.${slotName} : ${fallback}}</div>`;
      } else if (kids.length) {
        expr = `<div${attrs}>\n${kids.join("\n")}\n${pad}</div>`;
      } else {
        expr = `<div${attrs} />`;
      }
    }

    // instance-swap slot: caller-provided node wins over the default subtree
    if (refs.mainComponent) {
      const name = propJsName(refs.mainComponent);
      expr = `(props.${name} !== undefined ? props.${name} : ${expr})`;
    }

    // boolean visibility binding
    if (refs.visible) {
      const name = propJsName(refs.visible);
      const dflt = node.hidden ? "false" : "true";
      return `(P(props, ${JSON.stringify(name)}, ${dflt}) ? ${expr} : null)`;
    }
    if (node.hidden) return null;

    return expr;
  }

  // ---------- component emit ----------

  function variantKey(axes, propsObj, defaults) {
    return axes.map((a) => `${a}=${String(propsObj[a] ?? defaults[a] ?? "")}`).join("|");
  }

  // PascalCase component name -> shadcn-style file name ("AppBar" -> "app-bar")
  function compFileName(n) {
    return kebab(n).replace(/_/g, "-").replace(/^-+/, "").replace(/-+/g, "-");
  }

  // Figma prop def -> TS type for the generated Props interface.
  function tsType(def) {
    switch (def.type) {
      case "VARIANT": {
        const opts = (def.options ?? []).map((o) => JSON.stringify(String(o)));
        if (!opts.length) return "string";
        if ((def.options ?? []).every((o) => o === "true" || o === "false")) return "boolean | " + opts.join(" | ");
        return opts.join(" | ");
      }
      case "BOOLEAN": return "boolean";
      case "TEXT": return "string";
      case "INSTANCE_SWAP":
      case "SLOT": return "React.ReactNode";
      default: return "any";
    }
  }

  function buildComponent(set) {
    const name = set.__compName ?? pascal(set.name);
    CURRENT_REFS = new Set();
    CURRENT_ICON_REFS = new Set();
    const defs = set.props ?? {};
    const axes = Object.keys(defs).filter((k) => defs[k].type === "VARIANT");
    const defaults = {};
    for (const [k, d] of Object.entries(defs)) defaults[k] = d.default;

    const variantEntries = [];
    for (const variant of set.variants ?? []) {
      if (!variant.tree) continue;
      const key = variantKey(axes, variant.props ?? {}, defaults);
      const body = exprForNode(variant.tree, { parentDir: null, isRoot: true }, 1);
      if (!body) continue;
      variantEntries.push({ key, props: variant.props ?? {}, body });
    }

    const defaultKey = variantKey(axes, {}, defaults);
    const axisJs = axes.map((a) => ({ axis: a, js: propJsName(a) }));

    // shared blocks
    const seenProps = new Set();
    const typeLines = ["  className?: string;", "  style?: React.CSSProperties;"];
    for (const [k, d] of Object.entries(defs)) {
      const js = propJsName(k);
      if (js === "className" || seenProps.has(js)) continue;
      seenProps.add(js);
      typeLines.push(`  ${/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(js) ? js : JSON.stringify(js)}?: ${tsType(d)};`);
    }
    const variantBlocks = variantEntries
      .map(
        (v) => `VARIANTS[${JSON.stringify(v.key)}] = (props) => (
  ${v.body}
);`,
      )
      .join("\n");
    const metaBlock = `export const ${name}Meta = {
  figmaName: ${JSON.stringify(set.name)},
  props: ${JSON.stringify(
    Object.fromEntries(Object.entries(defs).map(([k, d]) => [propJsName(k), { type: d.type, default: d.default, options: d.options }])),
    null,
    2,
  )},
  variants: ${JSON.stringify(variantEntries.map((v) => v.props))},
};`;
    // capture markers: khi window.__FIG_CAPTURE__ bật (Playwright capture),
    // root element mang data-fig-comp/variant/props với TÊN RAW của Figma —
    // extractor đọc DOM là dựng lại được screen JSON cho builder.
    const rawVariantKeys = {};
    const rawPropKeys = {};
    // DEFAULT của từng prop (js name → giá trị): dispatch ghi GIÁ TRỊ RESOLVED
    // kể cả khi app không truyền — thiếu nó thì show/hide theo default React
    // không tới Figma (master bật Body/Content thừa, vụ 07-24).
    const rawDefaults = {};
    for (const [k, d] of Object.entries(defs)) {
      const js = propJsName(k);
      if (d.type === "VARIANT") {
        rawVariantKeys[js] = k;
        if (d.default !== undefined && d.default !== null) rawDefaults[js] = d.default;
      } else if (d.type === "TEXT" || d.type === "BOOLEAN") {
        rawPropKeys[js] = k.split("#")[0];
        if (d.default !== undefined && d.default !== null) rawDefaults[js] = d.default;
      }
    }
    const captureConsts = `const FIG_NAME = ${JSON.stringify(set.name)};
const FIG_KEY = ${JSON.stringify(set.key ?? null)};
const FIG_VARIANT_KEYS = ${JSON.stringify(rawVariantKeys)};
const FIG_PROP_KEYS = ${JSON.stringify(rawPropKeys)};
const FIG_DEFAULTS = ${JSON.stringify(rawDefaults)};`;
    const dispatchBody = `  const key = [${axisJs.map(({ axis, js }) => `${JSON.stringify(axis)} + "=" + String(P(props, ${JSON.stringify(js)}, ${JSON.stringify(defaults[axis])}))`).join(", ")}].join("|");
  const render = VARIANTS[key] ?? VARIANTS[DEFAULT_KEY] ?? Object.values(VARIANTS)[0];
  const el = render ? render(props) : null;
  if (el && typeof window !== "undefined" && window.__FIG_CAPTURE__ && React.isValidElement(el)) {
    const fv = {};
    const fp = {};
    for (const k in FIG_VARIANT_KEYS) {
      const val = props[k] !== undefined && props[k] !== null ? props[k] : FIG_DEFAULTS[k];
      if (val !== undefined && val !== null && typeof val !== "object") fv[FIG_VARIANT_KEYS[k]] = String(val);
    }
    for (const k in FIG_PROP_KEYS) {
      const val = props[k] !== undefined && props[k] !== null ? props[k] : FIG_DEFAULTS[k];
      if (val !== undefined && val !== null && typeof val !== "object") fp[FIG_PROP_KEYS[k]] = val;
    }
    const mk = { "data-fig-comp": FIG_NAME, "data-fig-variant": JSON.stringify(fv), "data-fig-props": JSON.stringify(fp) };
    if (FIG_KEY) mk["data-fig-key"] = FIG_KEY;
    return React.cloneElement(el, mk);
  }
  return el;`;
    // Annotations (dev-mode notes của designer) gom từ set + mọi node trong
    // variant tree → JSDoc đầu file: AI mở component là thấy usage + ghi chú.
    const annotations = [];
    {
      for (const note of set.annotations ?? []) annotations.push({ node: set.name, note });
      const walkAnn = (n) => {
        if (!n) return;
        for (const note of n.annotations ?? []) annotations.push({ node: n.name ?? "?", note });
        (n.children ?? []).forEach(walkAnn);
      };
      for (const v of set.variants ?? []) walkAnn(v.tree);
    }
    const seenAnn = new Set();
    const annList = annotations.filter((a) => {
      const k = `${a.node}|${a.note}`;
      if (seenAnn.has(k)) return false;
      seenAnn.add(k);
      return true;
    });
    const docLines = [];
    if (set.description) docLines.push(...String(set.description).trim().split("\n"));
    if (annList.length) {
      if (docLines.length) docLines.push("");
      docLines.push("Annotations (ghi chú thiết kế trong Figma):");
      for (const a of annList) docLines.push(`- [${a.node}] ${a.note}`);
    }
    const header = `// ${set.name} — generated from Figma (fig-export IR). Do not edit by hand.` +
      (docLines.length ? `\n/**\n${docLines.map((l) => (" * " + l).trimEnd()).join("\n")}\n */` : "");
    const refNames = [...CURRENT_REFS].filter((n) => n !== name).sort();
    const iconRefs = [...CURRENT_ICON_REFS].sort((a, b) => ICON_COMPS[a].name.localeCompare(ICON_COMPS[b].name));
    // File ví dụ nằm examples/ (root bundle) → đường import khác components/ui.
    const isExample = Boolean(set.__isExample);
    const runtimePath = isExample ? "../lib/runtime" : "../../lib/runtime";
    const refPrefix = isExample ? "../components/ui/" : "./";
    const iconPrefix = isExample ? "../components/icons/" : "../icons/";
    const iconImports = iconRefs.map((h) => `import { ${ICON_COMPS[h].name} } from "${iconPrefix}${ICON_COMPS[h].file}";`).join("\n");

    // typed file version (components/ui/<kebab-name>.tsx, shadcn-style)
    const srcTsx = `${header}
import React from "react";
import { Svg, P, Icon } from "${runtimePath}";
${refNames.map((n) => `import { ${n} } from "${refPrefix}${compFileName(n)}";`).join("\n")}${refNames.length ? "\n" : ""}${iconImports}${iconImports ? "\n" : ""}
export type ${name}Props = {
${typeLines.join("\n")}
};

const VARIANTS: Record<string, (props: ${name}Props) => React.ReactElement> = {};
${variantBlocks}

const DEFAULT_KEY = ${JSON.stringify(defaultKey)};
${captureConsts}

${metaBlock}

export function ${name}(props: ${name}Props = {}) {
${dispatchBody}
}

export default ${name};
`;

    // untyped version for the Babel-standalone showcase inline
    const srcInline = `import React from "react";

const VARIANTS = {};
${variantBlocks}

const DEFAULT_KEY = ${JSON.stringify(defaultKey)};
${captureConsts}

${metaBlock}

export function ${name}(props = {}) {
${dispatchBody}
}
`;

    return { name, srcTsx, srcInline, defs, variantEntries, iconRefs, description: set.description, annotations: annList, example: isExample, figName: set.name };
  }

  // ---------- outputs ----------

  const files = [];
  const tokensCss = buildTokensCss();

  // Icon library → flat name→assetHash map. Set variants get "Set / variant" keys,
  // the bare set name aliases its first variant.
  const iconsFlat = {};
  for (const ic of ir.icons ?? []) {
    if (ic.asset) iconsFlat[ic.name] = ic.asset;
    for (const v of ic.variants ?? []) {
      const label = Object.values(v.props ?? {}).join(" ");
      const key = label ? `${ic.name} / ${label}` : ic.name;
      if (v.asset) {
        iconsFlat[key] = v.asset;
        if (!iconsFlat[ic.name]) iconsFlat[ic.name] = v.asset;
      }
    }
  }

  const assets = ir.assets ?? {};
  // IMAGE fill bytes (ir.images: hash -> {ext, b64}) — Dev-Mode CSS chỉ cho
  // placeholder `url(<path-to-image>)`; thay bằng data URI theo hash fill của
  // node. IR cũ không có bytes → BỎ declaration hỏng + đếm báo (ô xám 98
  // component 07-24 là background url placeholder + lightgray).
  const images = ir.images ?? {};
  let missingImages = 0;
  const imageFillHash = (node) => {
    for (const f of node.fills ?? []) if (f.type === "image" && f.hash) return f.hash;
    return null;
  };
  const fixImageCss = (cssSource, node) => {
    let touched = null;
    for (const [k, v] of Object.entries(cssSource)) {
      if (typeof v !== "string" || v.indexOf("<path-to-image>") < 0) continue;
      touched = touched ?? { ...cssSource };
      const hash = imageFillHash(node);
      const img = hash ? images[hash] : null;
      if (img) {
        touched[k] = v.replace(/url\(<path-to-image>\)/g, `url(data:image/${img.ext === "jpg" ? "jpeg" : "png"};base64,${img.b64})`);
      } else {
        delete touched[k]; // placeholder vỡ — thà trống còn hơn ô xám url hỏng
        missingImages++;
      }
    }
    return touched ?? cssSource;
  };
  // Components inline the assets they use (ASSETS trong lib/asset-data.ts);
  // svg KHÔNG còn xuất file — icon là component, mảnh vô danh sống inline.
  // assets/ trên đĩa chỉ còn images/ (ảnh IMAGE fill, tên theo layer design).
  // Icon KHÔNG xuất file svg nữa (user 07-24: "icons đã là comp thì cần gì
  // xuất svg") — icon sống trong components/icons/*.tsx (inline). Chỉ cần
  // map hash -> fileBase (tên designer slug, dedupe) cho ICON_COMPS.
  const iconFileOf = {}; // hash -> fileBase (không đuôi)
  {
    const nameOfHash = {}; // hash -> shortest designer name
    for (const [name, h] of Object.entries(iconsFlat)) {
      if (!(h in nameOfHash) || name.length < nameOfHash[h].length) nameOfHash[h] = name;
    }
    const usedSlugs = new Set();
    for (const h of Object.keys(assets)) {
      const iconName = nameOfHash[h];
      if (!iconName) continue;
      let base = slug(iconName);
      let name = base;
      for (let n = 2; usedSlugs.has(name); n++) name = `${base}-${n}`;
      usedSlugs.add(name);
      iconFileOf[h] = name;
    }
  }

  // Ảnh IMAGE fill ra file thật — TÊN THEO LAYER design (ir.images[h].name từ
  // exporter; IR cũ chưa có name thì fallback hash). Code component vẫn nhúng
  // data URI (portable mọi môi trường).
  {
    const b64ToBytes = (b64) =>
      typeof Buffer !== "undefined"
        ? Buffer.from(b64, "base64")
        : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const usedImg = new Set();
    for (const [h, img] of Object.entries(images)) {
      let base = img.name ? slug(img.name) : h;
      let name = base;
      for (let n = 2; usedImg.has(name); n++) name = `${base}-${n}`;
      usedImg.add(name);
      try {
        files.push({ path: `assets/images/${name}.${img.ext === "jpg" ? "jpg" : "png"}`, content: b64ToBytes(img.b64) });
      } catch { /* b64 hỏng — data URI trong code vẫn còn */ }
    }
  }

  const allSets = [...(ir.componentSets ?? []), ...(ir.components ?? [])];

  // Pre-pass: assign stable component names FIRST so instance refs (<Badge/>
  // inside a block) resolve regardless of build order.
  const usedNames = new Set();
  REF_MAP = {};
  for (const set of allSets) {
    // Component đánh dấu ví dụ: suffix "_example" (Dashboard/HeroSection_example)
    // = bố cục production-mẫu cho AI xem cách ghép — xuất riêng examples/.
    set.__isExample = /_example\s*$/i.test(String(set.name));
    let name = set.__isExample
      ? pascal(String(set.name).replace(/_example\s*$/i, "")) + "Example"
      : pascal(set.name);
    if (usedNames.has(name)) name = name + "_" + slug(set.id ?? "x").replace(/-/g, "");
    usedNames.add(name);
    set.__compName = name;
    if (!(set.name in REF_MAP)) REF_MAP[set.name] = name;
  }

  // Monochrome icons adopt currentColor (lucide-style) so CSS `color` — and
  // therefore text-color token classes — recolors them (a baked #131315
  // stroke rendered black on Primary buttons). Multicolor art (logos, emoji,
  // flags) keeps its palette untouched.
  function iconCurrentColor(svg) {
    const colors = new Set();
    for (const m of svg.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)) {
      const v = m[1].trim();
      if (v === "none" || v.startsWith("url(") || v === "currentColor") continue;
      colors.add(v.toLowerCase());
    }
    if (colors.size !== 1) return svg;
    return svg.replace(/\b(fill|stroke)="([^"]+)"/g, (all, attr, v) => (v === "none" || v.startsWith("url(") ? all : `${attr}="currentColor"`));
  }

  // Icons are ordinary components (lucide-style): components/icons/<slug>.tsx,
  // one per unique SVG, typed size prop defaulting to the design size.
  // The runtime <Icon name> registry stays only for data-driven names.
  const ICON_COMPS = {}; // asset hash -> { name, file, size }
  {
    const reserved = new Set([...usedNames, "Svg", "Icon", "P", "React", "ASSETS", "ICONS", "ASSET_FILES"]);
    const sizeOf = {};
    for (const ic of ir.icons ?? []) {
      if (ic.asset && ic.w) sizeOf[ic.asset] = round(ic.w);
      for (const v of ic.variants ?? []) if (v.asset && v.w && !sizeOf[v.asset]) sizeOf[v.asset] = round(v.w);
    }
    // key của icon component trong Figma (exporter mới ghi vào ir.icons) —
    // nhúng vào marker data-fig-icon-key để plugin swap xuyên file.
    const keyOfAsset = {};
    for (const ic of ir.icons ?? []) {
      if (ic.asset && ic.key && !keyOfAsset[ic.asset]) keyOfAsset[ic.asset] = ic.key;
      for (const v of ic.variants ?? []) if (v.asset && v.key && !keyOfAsset[v.asset]) keyOfAsset[v.asset] = v.key;
    }
    for (const [h, fileBase] of Object.entries(iconFileOf)) {
      let name = pascal(fileBase);
      while (reserved.has(name)) name = name + "Glyph";
      reserved.add(name);
      const size = sizeOf[h] ?? 24;
      ICON_COMPS[h] = { name, file: fileBase, size };
      // data-fig-icon trong markup svg: figh2d serialize svg thành content
      // string NGUYÊN VĂN → capture mang tên icon qua Figma, plugin swap
      // INSTANCE_SWAP theo tên/key (icon React là element, không vào marker props).
      const iconMeta = ` data-fig-icon="${fileBase}"${keyOfAsset[h] ? ` data-fig-icon-key="${keyOfAsset[h]}"` : ""}`;
      files.push({
        path: `components/icons/${fileBase}.tsx`,
        content: `// generated icon — do not edit by hand.
import React from "react";
import { Svg } from "../../lib/runtime";

const SVG = ${JSON.stringify(iconCurrentColor(assets[h]).replace(/<svg/, `<svg${iconMeta}`))};

export function ${name}({ size = ${size}, style, className }: { size?: number; style?: React.CSSProperties; className?: string }) {
  return <Svg html={SVG} className={className} style={{ width: size, height: size, ...style }} />;
}

export default ${name};
`,
      });
    }
  }

  // INSTANCE_SWAP resolution: the exporter dumps swapNames (component id ->
  // reference; a swap target is a NORMAL component, icon or not). Per
  // component, note the size of each swap slot (the node carrying the propRef
  // in the component's own tree) so swapped icons render at the design size.
  const SWAP_NAMES = ir.swapNames ?? {};
  const SWAP_SLOT_SIZE = {};
  for (const set of allSets) {
    const sizes = {};
    const walkSlots = (n) => {
      if (!n) return;
      if (n.propRefs?.mainComponent) {
        const js = propJsName(n.propRefs.mainComponent);
        if (sizes[js] === undefined && n.w) sizes[js] = round(n.w);
      }
      (n.children ?? []).forEach(walkSlots);
    };
    for (const v of set.variants ?? []) walkSlots(v.tree);
    SWAP_SLOT_SIZE[set.__compName] = sizes;
  }

  const built = [];
  const errors = [];
  for (const set of allSets) {
    try {
      const comp = buildComponent(set);
      files.push({ path: comp.example ? `examples/${compFileName(comp.name)}.tsx` : `components/ui/${compFileName(comp.name)}.tsx`, content: comp.srcTsx });
      built.push(comp);
    } catch (e) {
      errors.push(`${set.name}: ${e.message}`);
    }
  }

  // styles/globals.css — single stylesheet, shadcn-style: token variables per
  // collection/mode first, then the tk-* utility classes. Built AFTER the
  // components so the registry holds every token class the markup references.
  const tkCss = buildTkCss();
  const globalsCss = `${tokensCss}\n/* ---------- token utility classes (tk-*) ---------- */\n${tkCss}`;
  files.push({ path: "styles/globals.css", content: globalsCss });

  // docs/classes.md — BẢNG KÊ class hợp lệ (vocabulary ĐÓNG cho người/AI):
  // đúng những class tk-* mà bộ này sinh từ variable/style Figma, kèm
  // declaration thật. Ngoài danh sách này KHÔNG có class nào khác được dùng.
  {
    const SECTION_OF = {
      background: "Nền (bg)", backgroundColor: "Nền (bg)",
      color: "Màu chữ (text)",
      borderColor: "Màu viền (border)", borderWidth: "Độ dày viền (bw)",
      borderTop: "Viền cạnh", borderRight: "Viền cạnh", borderBottom: "Viền cạnh", borderLeft: "Viền cạnh",
      borderTopColor: "Viền cạnh", borderRightColor: "Viền cạnh", borderBottomColor: "Viền cạnh", borderLeftColor: "Viền cạnh",
      borderRadius: "Bo góc (rounded)", borderTopLeftRadius: "Bo góc (rounded)", borderTopRightRadius: "Bo góc (rounded)",
      borderBottomRightRadius: "Bo góc (rounded)", borderBottomLeftRadius: "Bo góc (rounded)",
      gap: "Khoảng cách (gap)", rowGap: "Khoảng cách (gap)", columnGap: "Khoảng cách (gap)",
      padding: "Padding (p*)", paddingTop: "Padding (p*)", paddingRight: "Padding (p*)", paddingBottom: "Padding (p*)", paddingLeft: "Padding (p*)",
      width: "Kích thước (w/h)", height: "Kích thước (w/h)", minWidth: "Kích thước (w/h)", maxWidth: "Kích thước (w/h)", minHeight: "Kích thước (w/h)", maxHeight: "Kích thước (w/h)",
      fontSize: "Chữ (fs/fw/lh/ls)", fontWeight: "Chữ (fs/fw/lh/ls)", lineHeight: "Chữ (fs/fw/lh/ls)", letterSpacing: "Chữ (fs/fw/lh/ls)", fontFamily: "Chữ (fs/fw/lh/ls)",
      boxShadow: "Bóng (shadow)", backdropFilter: "Blur (backdrop)",
    };
    const groups = new Map();
    for (const name of [...tkByName.keys()].sort()) {
      const { prop, value } = tkByName.get(name);
      const sec2 = SECTION_OF[prop] ?? `Khác (${prop})`;
      const arr = groups.get(sec2) ?? [];
      arr.push(`| \`${name}\` | \`${kebab(prop)}: ${value}\` |`);
      groups.set(sec2, arr);
    }
    const body = [...groups.entries()]
      .map(([title, rows]) => `\n## ${title} (${rows.length})\n\n| Class | Declaration |\n| --- | --- |\n${rows.join("\n")}\n`)
      .join("");
    files.push({
      path: "docs/classes.md",
      content: `# Class hợp lệ — vocabulary ĐÓNG (${tkByName.size} class)

Đây là TOÀN BỘ class được phép dùng khi viết màn trên bộ component này. Mỗi
class bind ĐÚNG 1 declaration vào token Figma (variable/style xuất ra) — sinh
máy từ export, không tự đặt thêm.

**Luật:**

1. CHỈ dùng class trong file này: bảng tk-* bên dưới + bộ **layout utilities** cuối file (tên tương thích Tailwind, đã emit tĩnh trong globals.css — KHÔNG cần cài Tailwind). KHÔNG class tự chế, KHÔNG hex/px trần trong className.
2. Mọi thứ dính TOKEN — màu, spacing (padding/gap), bo góc, bóng, chữ — PHẢI dùng class \`tk-*\`. Layout utilities CHỈ có cấu trúc (flex/grid/align/position/overflow/w-full…), cố tình KHÔNG có \`p-4\`/\`gap-2\`/\`bg-*\`/\`text-<màu>\`/\`shadow-*\`/\`rounded-*\`.
   **Chữ phải dùng ĐỦ BỘ cùng nhóm typography**: \`tk-fs-typography-<nhóm>-font-size\` + \`tk-lh-typography-<nhóm>-line-height\` (+ fw/ls nếu có) — lấy lẻ fs mà bỏ lh là line-height thừa kế sai token, và vòng dựng lại Figma mất dấu text style của nhóm.
3. Cần cặp (thuộc-tính × token) chưa có class? Thêm vào \`styles/globals.css\` đúng format \`.tk-<abbrev>-<token> { prop: var(--token, fallback) }\` rồi bổ sung vào bảng này — không đặt tên kiểu khác.
4. Giá trị chưa có token (literal) → inline style trong JSX (đó là báo cáo nợ tokenization, xem STYLE-GUIDE.md).
5. Token đổi theo mode (\`.dark\` trên root) — class giữ nguyên, KHÔNG viết màu dark thủ công.

Danh sách token gốc: STYLE-GUIDE.md · API component: docs/catalog.md · icon: docs/icons.md
${body}
## Layout utilities (${Object.keys(LAYOUT_UTILS).length} — tên tương thích Tailwind, chỉ cấu trúc)

| Class | Declaration |
| --- | --- |
${Object.entries(LAYOUT_UTILS).map(([n, d]) => `| \`${n}\` | \`${d}\` |`).join("\n")}
`,
    });
  }

  // docs/prop-gaps.md — BÁO CÁO GỐC RỄ cho designer (user 07-24 "làm gốc rễ"):
  // liệt kê từng chỗ thiết kế CHƯA expose prop — text cứng không TEXT prop,
  // icon cứng không INSTANCE_SWAP, SLOT (API không bơm nội dung được). Lib vá
  // đủ prop thì pipeline đúng nghĩa "gặp comp, điền prop" — máy text-zip/
  // icon-swap trong plugin tự hết việc.
  {
    const rows = [];
    for (const comp of allSets) {
      const textGaps = new Map(); // "name|chars" -> {name, chars}
      const iconGaps = new Map(); // node name -> iconRef
      const slots = new Set();
      const walkGap = (n) => {
        if (!n || typeof n !== "object") return;
        if (n.text && n.text.characters !== undefined && !(n.propRefs && n.propRefs.characters)) {
          const key = `${n.name}|${n.text.characters}`;
          if (!textGaps.has(key)) textGaps.set(key, { name: n.name, chars: n.text.characters });
        }
        if (n.iconRef && !(n.propRefs && n.propRefs.mainComponent)) {
          if (!iconGaps.has(n.name)) iconGaps.set(n.name, n.iconRef);
        }
        if (n.type === "SLOT") slots.add(n.name);
        for (const c of n.children ?? []) walkGap(c);
      };
      for (const v of comp.variants ?? []) if (v.tree) walkGap(v.tree);
      const total = textGaps.size + iconGaps.size + slots.size;
      if (!total) continue;
      rows.push({ name: comp.name, textGaps: [...textGaps.values()], iconGaps: [...iconGaps.entries()], slots: [...slots], total });
    }
    rows.sort((a, b) => b.total - a.total);
    const fmt = (r) => {
      let s = `\n## ${r.name} (${r.total} gap)\n\n`;
      if (r.textGaps.length) {
        s += `**Text cứng — cần expose TEXT prop** (sửa hiện tại phải gõ đè từng instance; máy phải override từng TextNode):\n\n`;
        s += r.textGaps.map((g) => `- layer \`${g.name}\` — "${String(g.chars).slice(0, 60)}"`).join("\n") + "\n\n";
      }
      if (r.iconGaps.length) {
        s += `**Icon cứng — cần expose INSTANCE_SWAP prop**:\n\n`;
        s += r.iconGaps.map(([nm, ref]) => `- layer \`${nm}\` — icon \`${ref}\``).join("\n") + "\n\n";
      }
      if (r.slots.length) {
        s += `**SLOT — API không bơm nội dung vào slot được** (plugin/codegen chỉ dựng được default; nội dung động nên chuyển thành TEXT prop / INSTANCE_SWAP):\n\n`;
        s += r.slots.map((nm) => `- slot \`${nm}\``).join("\n") + "\n\n";
      }
      return s;
    };
    const totalGaps = rows.reduce((t, r) => t + r.total, 0);
    files.push({
      path: "docs/prop-gaps.md",
      content: `# Prop-gap — checklist cho designer (${rows.length} component, ${totalGaps} gap)

Sinh máy từ export Figma. Mỗi dòng = một chỗ thiết kế chưa expose prop nên
"điền prop" không tới được — vòng Figma ⇄ React phải làm thay bằng override
từng node (text-zip / icon-swap / ẩn tay trong plugin). Expose đủ prop thì
các máy đó tự hết việc, roundtrip chỉ còn setProperties.

Luật chung khi vá lib:
1. Chữ nào cho phép đổi theo màn → TEXT prop (kể cả title/label/body).
2. Phần tử nào có màn cần ẩn → BOOLEAN prop \`Show *\`.
3. Icon nào thay được → INSTANCE_SWAP prop (preferred values = bộ icon).
4. SLOT chỉ dành cho nội dung tự do thật sự — nội dung có cấu trúc nên là prop.

Text trong component LỒNG được tính ở chính component đó (vá một lần, mọi nơi hưởng).
${rows.map(fmt).join("")}`,
    });
  }

  // runtime.jsx — built AFTER components so we know which assets they actually
  // use. Only those inline; everything else lazy-fetches assets/<hash>.svg.
  const usedAssets = new Set();
  for (const c of built) {
    for (const m of c.srcInline.matchAll(/\bSvg a="([^"]+)"/g)) usedAssets.add(m[1]);
    for (const m of c.srcInline.matchAll(/<Icon name="([^"]+)"/g)) {
      const h = iconsFlat[m[1]];
      if (h) usedAssets.add(h);
    }
  }
  const inlineAssets = {};
  for (const h of usedAssets) if (assets[h]) inlineAssets[h] = assets[h];

  // Data máy (3 blob JSON to) tách sang lib/asset-data.ts — runtime.tsx còn
  // lại là helper NGẮN đọc được (user 07-24 "sao nhiều file thừa thế").
  files.push({
    path: "lib/asset-data.ts",
    content: `// generated asset data — máy sinh, đừng sửa tay (đọc runtime.tsx để hiểu cách dùng)

// SVG inline cho các asset mà component tham chiếu (render sync).
export const ASSETS: Record<string, string> = ${JSON.stringify(inlineAssets, null, 0)};

// Toàn bộ thư viện icon: tên -> asset hash (asset đã inline trong ASSETS khi
// có component dùng; icon chỉ-tra-theo-tên nằm trong component icons/*.tsx).
export const ICONS: Record<string, string> = ${JSON.stringify(iconsFlat, null, 0)};
`,
  });

  const runtimeSrc = `// generated runtime — helper <Svg/>/<Icon/>/P(); data nằm ở ./asset-data.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { ASSETS, ICONS } from "./asset-data";

export { ASSETS, ICONS };

type SvgProps = { a?: string; html?: string; style?: React.CSSProperties; className?: string };
type IconProps = { name: string; size?: number; style?: React.CSSProperties; className?: string };

// Figma flattens effect-bearing nodes into SVGs whose canvas includes the
// shadow/blur bleed (a 44px button ships as an 84px canvas). Squeezing that
// canvas into the node box shrinks the artwork ~2x. Effect SVGs (filter /
// foreignObject markers) render at intrinsic size centered on the box with
// visible overflow — exactly how Figma paints them; plain icons rescale to
// fit the box crisply.
export function svgFit(html: string | undefined, style?: React.CSSProperties): { html: string; bleed: { iw: number; ih: number } | null } {
  if (!html) return { html: "", bleed: null };
  const w = parseFloat(style?.width as any);
  const h = parseFloat(style?.height as any);
  const m = /<svg[^>]*?\\swidth="([\\d.]+)"[^>]*?\\sheight="([\\d.]+)"/.exec(html);
  if (!m || !w || isNaN(w)) return { html, bleed: null };
  const iw = parseFloat(m[1]);
  const ih = parseFloat(m[2]);
  if (/<filter|<foreignObject|figma-bg-blur/.test(html) && iw > w + 1) return { html, bleed: { iw, ih } };
  if (Math.abs(iw - w) > 0.5 || (h && !isNaN(h) && Math.abs(ih - h) > 0.5)) {
    const hh = h && !isNaN(h) ? h : w * (ih / iw);
    const patched = m[0].replace(/\\swidth="[\\d.]+"/, ' width="' + w + '"').replace(/\\sheight="[\\d.]+"/, ' height="' + hh + '"');
    return { html: html.replace(m[0], patched), bleed: null };
  }
  return { html, bleed: null };
}

export function Svg({ a, html: inlineHtml, style, className }: SvgProps) {
  // Mọi asset component dùng đều đã inline trong ASSETS — không còn lazy
  // fetch file svg (assets/ chỉ chứa images/). Hash lạ = render rỗng + warn.
  const html = inlineHtml !== undefined ? inlineHtml : (ASSETS as Record<string, string>)[a ?? ""];
  if (html === undefined && a && typeof console !== "undefined") console.warn("[fig] asset không có trong ASSETS:", a);
  const fit = svgFit(html, style);
  if (fit.bleed) {
    const w = parseFloat(style?.width as any) || 0;
    const h = parseFloat(style?.height as any) || w;
    return (
      <span className={className} style={{ display: "inline-flex", flexShrink: 0, lineHeight: 0, position: "relative", overflow: "visible", ...style }}>
        <span style={{ position: "absolute", width: fit.bleed.iw, height: fit.bleed.ih, left: (w - fit.bleed.iw) / 2, top: (h - fit.bleed.ih) / 2, lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: fit.html }} />
      </span>
    );
  }
  return <span className={className} style={{ display: "inline-flex", flexShrink: 0, lineHeight: 0, ...style }} dangerouslySetInnerHTML={{ __html: fit.html }} />;
}

// Icon by designer-given library name, e.g. <Icon name="Phosphor Icon / XCircle" size={16} />
export function Icon({ name, size = 16, style, className }: IconProps) {
  const a = (ICONS as Record<string, string>)[name];
  if (!a) return null;
  return <Svg a={a} className={className} style={{ width: size, height: size, ...style }} />;
}

// prop accessor: variant values arrive as strings from Figma ("true"/"false")
export function P(props: any, name: string, dflt?: any) {
  const v = props[name];
  if (v === undefined || v === null) return dflt;
  return v;
}
`;
  files.push({ path: "lib/runtime.tsx", content: runtimeSrc });

  // catalog.md — the LLM-facing component API doc (examples liệt kê riêng)
  const builtUi = built.filter((c) => !c.example);
  const builtExamples = built.filter((c) => c.example);
  let catalog = `# ${ir.meta?.file ?? "UI Lib"} — component catalog\n\nGenerated ${new Date().toISOString()} from fig-export IR. ${builtUi.length} components.${builtExamples.length ? ` Bố cục mẫu: docs/examples.md (${builtExamples.length}).` : ""}\n`;
  for (const c of builtUi) {
    catalog += `\n## ${c.name}\n\n`;
    if (c.description) catalog += c.description.trim() + "\n\n";
    if (c.annotations?.length) {
      catalog += `Annotations (ghi chú thiết kế):\n${c.annotations.map((a) => `- [${a.node}] ${a.note}`).join("\n")}\n\n`;
    }
    catalog += `| prop | type | default | options |\n|---|---|---|---|\n`;
    for (const [k, d] of Object.entries(c.defs ?? {})) {
      catalog += `| \`${propJsName(k)}\` | ${d.type} | \`${JSON.stringify(d.default)}\` | ${(d.options ?? []).map((o) => `\`${o}\``).join(", ") || "—"} |\n`;
    }
    catalog += `\nVariants exported: ${c.variantEntries.length}\n`;
  }
  files.push({ path: "docs/catalog.md", content: catalog });

  // docs/examples.md — index bố cục mẫu (component *_example trong Figma):
  // AI đọc file này trước khi ghép màn để biết các mảnh khớp nhau thế nào,
  // rồi mở examples/<file>.tsx đọc JSX thật.
  {
    let ex = `# Bố cục mẫu (examples)\n\nComponent Figma đặt tên suffix \`_example\` được xuất vào \`examples/\` — đây là các composition production-mẫu cho thấy CÁCH GHÉP component thật.\nĐọc JSX của chúng như tài liệu: import, prop, token đều là chuẩn để bắt chước. KHÔNG import examples vào màn — copy cấu trúc rồi thay content.\n\n`;
    if (!builtExamples.length) {
      ex += `_Chưa có component \`*_example\` nào trong lib. Designer thêm component tên \`..._example\` (vd \`Dashboard/HeroSection_example\`) rồi re-export là chúng xuất hiện ở đây._\n`;
    }
    for (const c of builtExamples) {
      ex += `## ${c.name}\n\nFigma: \`${c.figName}\` → \`examples/${compFileName(c.name)}.tsx\`\n\n`;
      if (c.description) ex += c.description.trim() + "\n\n";
      if (c.annotations?.length) {
        ex += `Annotations:\n${c.annotations.map((a) => `- [${a.node}] ${a.note}`).join("\n")}\n\n`;
      }
    }
    files.push({ path: "docs/examples.md", content: ex });
  }

  const iconNames = Object.keys(iconsFlat).sort();
  if (iconNames.length) {
    files.push({
      path: "docs/icons.md",
      content: `# Icon library (${iconNames.length})\n\nMặc định import component thật: \`import { IcArrowLeft } from "components/icons/ic-arrow-left"\` → \`<IcArrowLeft size={20}/>\`.\n\`<Icon name="…"/>\` (lib/runtime) CHỈ dành cho tên icon động lấy từ data.\n\n${iconNames.map((n) => `- ${n}`).join("\n")}\n`,
    });
  }

  // STYLE-GUIDE.md — the token contract for LLM/devs composing screens:
  // ONLY the tokens below are legal; raw px/hex in generated components mark
  // spots the designer left unbound in Figma.
  {
    const vars = ir.variables ?? [];
    const byType = (pred) => vars.filter(pred);
    const colors = byType((v) => v.type === "COLOR");
    const floats = byType((v) => v.type === "FLOAT");
    const strings = byType((v) => v.type === "STRING");
    const line = (v) => {
      const modes = Object.entries(v.values ?? {});
      const shown = modes.map(([m, e]) => `${modes.length > 1 ? m + ": " : ""}\`${tokenValue(e, v.name)}\``).join(" · ");
      return `- \`var(${cssVar(v.name)})\` — ${shown}`;
    };
    const group = (list, rx) => list.filter((v) => rx.test(v.name));
    const typo = group(floats, /^(text|font|leading|tracking|typography)\//i).concat(group(strings, /font/i));
    const spacing = group(floats, /^(spacing|padding|gap)\//i);
    const radius = group(floats, /^(border-radius|radius)\//i);
    const sizes = group(floats, /^(width|height|size)\//i);
    const borders = group(floats, /^(border-width|stroke)\//i);
    const used = new Set([...typo, ...spacing, ...radius, ...sizes, ...borders]);
    const otherFloats = floats.filter((v) => !used.has(v));
    const sec = (title, list) => (list.length ? `\n## ${title} (${list.length})\n\n${list.map(line).join("\n")}\n` : "");
    files.push({
      path: "STYLE-GUIDE.md",
      content: `# ${ir.meta?.file ?? "UI Lib"} — Token contract

**LUẬT khi ghép màn từ bộ component này:**

1. **CHỈ dùng token liệt kê trong file này** cho màu, khoảng cách, bo góc, chữ. KHÔNG bịa hex/px mới.
2. **Class hợp lệ = class \`tk-*\` + bộ layout utilities tĩnh trong styles/globals.css — bảng kê đầy đủ ở docs/classes.md.** Layout cơ bản (flex/grid/items-center/justify-between/relative/w-full…) dùng tên tương thích Tailwind đã emit sẵn, KHÔNG cần cài Tailwind. Mọi thứ dính TOKEN (màu/spacing/radius/shadow/chữ) PHẢI là \`tk-*\` (vd \`.tk-bg-base-primary { background-color: var(--base-primary, #171717) }\`) — cố tình không có \`p-4\`/\`bg-*\`/\`shadow-*\`/\`rounded-*\` kiểu Tailwind. Cần cặp (thuộc tính × token) mới thì thêm vào globals.css đúng format tk-*, không đặt tên kiểu khác.
3. Ưu tiên dùng COMPONENT có sẵn (components/ui/, API xem docs/catalog.md) thay vì tự dựng markup; icon lấy theo tên trong docs/icons.md.
4. **Inline style trong components/ui/* = literal designer CHƯA bind token trong Figma** (báo cáo nợ tokenization nằm ngay trong JSX) — không được lấy đó làm cớ hardcode thêm; layout thuần (display/flex/position) cũng nằm inline, đó là output máy, không phải mẫu để bắt chước.
5. Dark mode: đổi class \`.dark\` trên root — token tự đổi, KHÔNG viết màu dark thủ công.
6. Trang nhúng chỉ cần load MỘT file styles/globals.css (token theo mode + class tk-*).
${sec("Colors", colors)}${sec("Typography", typo)}${sec("Spacing", spacing)}${sec("Radius", radius)}${sec("Border width", borders)}${sec("Size (width/height)", sizes)}${sec("Khác", otherFloats)}`,
    });
  }

  // ---------- showcase index.html ----------

  function escapeScript(text) {
    return text.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  }

  // Inline a generated module into the single showcase script. Each component
  // wraps in an IIFE so per-file consts (VARIANTS, DEFAULT_KEY) don't collide;
  // cross-refs work because every component becomes a top-level const.
  function inlineComponentSrc(src, name) {
    const body = src
      .split("\n")
      .filter((line) => !/^import /.test(line) && !/^export default /.test(line))
      .map((line) => line.replace(/^export /, ""))
      .join("\n");
    return name ? `const ${name} = (() => {\n${body}\nreturn ${name};\n})();` : body;
  }

  const galleryData = built.filter((c) => !c.example).map((c) => ({
    name: c.name,
    variants: c.variantEntries.map((v) => v.props),
    props: Object.fromEntries(Object.entries(c.defs ?? {}).map(([k, d]) => [propJsName(k), { type: d.type, default: d.default, options: d.options }])),
    description: c.description ?? "",
  }));

  const modeClasses = (ir.collections ?? []).flatMap((col) =>
    col.modes.filter((m) => m !== col.defaultMode).map((m) => ({ collection: col.name, mode: m, cls: `mode-${slug(col.name)}-${slug(m)}` })),
  );

  // Every font family used by text nodes → a Google Fonts link in the
  // showcase (unknown families just 404 harmlessly).
  const fontFams = new Set();
  (function collectFonts(sets) {
    const walk = (n) => {
      if (n?.text?.fontFamily) fontFams.add(n.text.fontFamily);
      for (const c of n?.children ?? []) walk(c);
    };
    for (const s of sets) for (const v of s.variants ?? []) if (v.tree) walk(v.tree);
  })(allSets);
  const fontLinks = [...fontFams]
    .map((f) => `<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;500;600;700&display=swap" rel="stylesheet" />`)
    .join("\n");

  // Heavy data ships as a PLAIN script (parsed natively, instantly) — pushing
  // these megabyte literals through Babel-in-browser froze the showcase.
  files.push({
    path: "showcase/showcase-data.js",
    content: `window.__FIG_ASSETS__ = ${JSON.stringify(inlineAssets)};\nwindow.__FIG_ICONS__ = ${JSON.stringify(iconsFlat)};\n`,
  });

  const showcaseRuntime = `
const ASSETS = window.__FIG_ASSETS__ || {};
const ICONS = window.__FIG_ICONS__ || {};
function svgFit(html, style) {
  if (!html) return { html: "", bleed: null };
  const w = parseFloat(style && style.width);
  const h = parseFloat(style && style.height);
  const m = /<svg[^>]*?\\swidth="([\\d.]+)"[^>]*?\\sheight="([\\d.]+)"/.exec(html);
  if (!m || !w || isNaN(w)) return { html, bleed: null };
  const iw = parseFloat(m[1]), ih = parseFloat(m[2]);
  if (/<filter|<foreignObject|figma-bg-blur/.test(html) && iw > w + 1) return { html, bleed: { iw, ih } };
  if (Math.abs(iw - w) > 0.5 || (h && !isNaN(h) && Math.abs(ih - h) > 0.5)) {
    const hh = h && !isNaN(h) ? h : w * (ih / iw);
    const patched = m[0].replace(/\\swidth="[\\d.]+"/, ' width="' + w + '"').replace(/\\sheight="[\\d.]+"/, ' height="' + hh + '"');
    return { html: html.replace(m[0], patched), bleed: null };
  }
  return { html, bleed: null };
}
function Svg({ a, html: inlineHtml, style, className }) {
  const html = inlineHtml !== undefined ? inlineHtml : ASSETS[a];
  const fit = svgFit(html, style);
  if (fit.bleed) {
    const w = parseFloat(style && style.width) || 0;
    const h = parseFloat(style && style.height) || w;
    return (
      <span className={className} style={{ display: "inline-flex", flexShrink: 0, lineHeight: 0, position: "relative", overflow: "visible", ...style }}>
        <span style={{ position: "absolute", width: fit.bleed.iw, height: fit.bleed.ih, left: (w - fit.bleed.iw) / 2, top: (h - fit.bleed.ih) / 2, lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: fit.html }} />
      </span>
    );
  }
  return <span className={className} style={{ display: "inline-flex", flexShrink: 0, lineHeight: 0, ...style }} dangerouslySetInnerHTML={{ __html: fit.html }} />;
}
function Icon({ name, size = 16, style, className }) {
  const a = ICONS[name];
  if (!a) return null;
  return <Svg a={a} className={className} style={{ width: size, height: size, ...style }} />;
}
function P(props, name, dflt) {
  const v = props[name];
  if (v === undefined || v === null) return dflt;
  return v;
}
`;

  const showcase = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${ir.meta?.file ?? "UI Lib"} — showcase</title>
${fontLinks}
<link rel="stylesheet" href="../styles/globals.css" />
<style>
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #f7f7f9; color: #1a1a1e; padding: 32px; }
body.dark { background: #131316; color: #ececf1; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin: 40px 0 12px; border-bottom: 1px solid #8884; padding-bottom: 6px; }
.toolbar { position: sticky; top: 0; background: inherit; padding: 8px 0; z-index: 10; display: flex; gap: 8px; flex-wrap: wrap; }
.toolbar button { padding: 6px 12px; border-radius: 8px; border: 1px solid #8886; background: transparent; color: inherit; cursor: pointer; }
.toolbar button.on { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.tokens { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
.tok { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; background: #fff2; border: 1px solid #8883; font-size: 11px; }
.tok .sw { width: 28px; height: 28px; border-radius: 6px; border: 1px solid #8885; flex-shrink: 0; }
.grid { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
.cell { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.cell .label { font-size: 10px; color: #888; max-width: 220px; word-break: break-all; }
.stage { padding: 14px; border-radius: 10px; border: 1px dashed #8884; }
</style>
<script type="importmap">
{ "imports": {
  "react": "https://esm.sh/react@19",
  "react-dom/client": "https://esm.sh/react-dom@19/client"
} }
</script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
<div id="root">Đang tải React từ esm.sh… (cần mạng; serve từ GỐC bundle: \`npx serve <bundle>\` rồi mở /showcase/)</div>
<script>window.__FIG_ASSET_BASE__ = "../assets/";</script>
<script src="showcase-data.js"></script>
<script type="text/babel" data-type="module">
import React from "react";
import { createRoot } from "react-dom/client";

${escapeScript(showcaseRuntime)}

${escapeScript(
    [...new Set(built.flatMap((c) => c.iconRefs ?? []))]
      .map((h) => {
        const ic = ICON_COMPS[h];
        return `const ${ic.name} = ({ size = ${ic.size}, style, className }) => <Svg html={${JSON.stringify(iconCurrentColor(assets[h]))}} className={className} style={{ width: size, height: size, ...style }} />;`;
      })
      .join("\n"),
  )}

${built.map((c) => escapeScript(inlineComponentSrc(c.srcInline, c.name))).join("\n\n")}

const GALLERY = ${escapeScript(JSON.stringify(galleryData))};
const COMPONENTS = { ${built.map((c) => `${c.name}`).join(", ")} };
const MODES = ${JSON.stringify(modeClasses)};
const COLOR_TOKENS = ${escapeScript(
    JSON.stringify((ir.variables ?? []).filter((v) => v.type === "COLOR").map((v) => ({ name: v.name, css: "--" + slug(v.name) }))),
  )};
const OTHER_TOKENS = ${escapeScript(
    JSON.stringify(
      (ir.variables ?? [])
        .filter((v) => v.type !== "COLOR")
        .map((v) => ({ name: v.name, value: Object.values(v.values ?? {})[0]?.value })),
    ),
  )};

function IconGrid() {
  const [q, setQ] = React.useState("");
  const all = Object.keys(ICONS);
  const names = all.filter((n) => n.toLowerCase().includes(q.toLowerCase()));
  const shown = names.slice(0, 400);
  if (!all.length) return null;
  return (
    <div>
      <h2>Icons <small style={{ opacity: 0.5 }}>({all.length})</small></h2>
      <input placeholder="tìm icon…" value={q} onChange={(e) => setQ(e.target.value)}
        style={{ margin: "8px 0 12px", padding: "6px 10px", borderRadius: 8, border: "1px solid #8886", background: "transparent", color: "inherit", width: 260 }} />
      <div className="tokens">
        {shown.map((n) => (
          <div className="tok" key={n}><Icon name={n} size={18} /><div style={{ fontSize: 10, wordBreak: "break-all" }}>{n}</div></div>
        ))}
      </div>
      {names.length > shown.length ? <p style={{ opacity: 0.5 }}>… còn {names.length - shown.length} icon nữa — gõ để lọc</p> : null}
    </div>
  );
}

function App() {
  const [modes, setModes] = React.useState([]);
  React.useEffect(() => {
    document.body.className = modes.join(" ") + (modes.some((m) => /dark/.test(m)) ? " dark" : "");
  }, [modes]);
  const toggle = (cls) => setModes((m) => (m.includes(cls) ? m.filter((x) => x !== cls) : [...m.filter((x) => !x.startsWith(cls.split("-").slice(0, 2).join("-"))), cls]));
  return (
    <div>
      <div className="toolbar">
        {MODES.map((m) => (
          <button key={m.cls} className={modes.includes(m.cls) ? "on" : ""} onClick={() => toggle(m.cls)}>
            {m.collection} · {m.mode}
          </button>
        ))}
      </div>
      <h1>${(ir.meta?.file ?? "UI Lib").replace(/`/g, "")} — ${built.length} components · ${(ir.variables ?? []).length} tokens</h1>

      <h2>Color tokens</h2>
      <div className="tokens">
        {COLOR_TOKENS.map((t) => (
          <div className="tok" key={t.name}>
            <div className="sw" style={{ background: "var(" + t.css + ")" }} />
            <div>{t.name}<br /><code style={{ opacity: 0.6 }}>var({t.css})</code></div>
          </div>
        ))}
      </div>

      <h2>Number / string tokens</h2>
      <div className="tokens">
        {OTHER_TOKENS.map((t) => (
          <div className="tok" key={t.name}><div>{t.name}: <b>{String(t.value)}</b></div></div>
        ))}
      </div>

      <IconGrid />

      {GALLERY.map((g) => {
        const Comp = COMPONENTS[g.name];
        if (!Comp) return null;
        return (
          <div key={g.name}>
            <h2>{g.name} <small style={{ opacity: 0.5 }}>({g.variants.length} variants)</small></h2>
            {g.description ? <p style={{ maxWidth: 720, fontSize: 12, opacity: 0.7, whiteSpace: "pre-wrap" }}>{g.description}</p> : null}
            <div className="grid">
              {(g.variants.length ? g.variants : [{}]).map((vp, i) => {
                const jsProps = {};
                for (const [k, v] of Object.entries(vp)) {
                  const js = k.split("#")[0];
                  let name = js.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w, wi) => (wi === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1))).join("");
                  if (name === "style" || name === "className") name += "Prop";
                  jsProps[name] = v;
                }
                return (
                  <div className="cell" key={i}>
                    <div className="stage"><Comp {...jsProps} /></div>
                    <div className="label">{Object.entries(vp).map(([k, v]) => k + "=" + v).join(" · ") || "default"}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
</script>
</body>
</html>
`;
  files.push({ path: "showcase/index.html", content: showcase });

  files.push({
    path: "README.md",
    content: `# ${ir.meta?.file ?? "UI Lib"} — design system bundle

Generated from Figma qua fig-export. Cấu trúc theo shadcn:

\`\`\`
components/ui/*.tsx   ${built.length} components — file kebab-case, export PascalCase
components/icons/*.tsx ${Object.keys(ICON_COMPS).length} icon components (lucide-style, \`<IcArrowLeft size={20}/>\`)
lib/runtime.tsx       helper <Svg/> P() + <Icon name> (chỉ cho tên icon động từ data)
lib/asset-data.ts     data máy sinh (SVG inline + registry icon) — đừng đọc/sửa tay
styles/globals.css    token variables theo mode + class tk-* + layout utilities (1 file css duy nhất)
assets/images/*.png   ảnh IMAGE fill xuất từ Figma, tên theo layer design (code nhúng data URI)
docs/catalog.md       API từng component (props/variants) — đưa cho LLM ghép màn
docs/classes.md       BẢNG KÊ class tk-* hợp lệ (vocabulary đóng — chỉ được dùng các class này)
docs/prop-gaps.md     checklist cho DESIGNER: chỗ nào chưa expose prop (text cứng/icon cứng/slot)
docs/icons.md         danh sách tên icon hợp lệ
STYLE-GUIDE.md        LUẬT token + class cho người/AI viết code trên bộ này
showcase/index.html   gallery xem nhanh (npx serve <bundle> → mở /showcase/)
\`\`\`

Dùng trong app React: copy cả bundle vào src/ (vd \`src/design-system/\`), import \`styles/globals.css\` một lần ở root, rồi \`import { Button } from "design-system/components/ui/button"\`.
`,
  });

  return {
    files,
    summary: {
      fileSlug: slug(ir.meta?.file ?? "fig-ir"),
      components: built.length,
      totalSets: allSets.length,
      variants: built.reduce((t, c) => t + c.variantEntries.length, 0),
      variables: (ir.variables ?? []).length,
      tokenClasses: tkByName.size,
      tokenDecls,
      literalDecls,
      icons: iconNames.length,
      assets: Object.keys(assets).length,
      images: Object.keys(images).length,
      missingImages,
      errors,
      componentNames: built.map((c) => `${c.name} (${c.variantEntries.length})`),
    },
  };
}

// ---------- ZIP (store-only, utf-8 names) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

export async function zipFiles(files /* [{path, content: string|Uint8Array}] */) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameB = enc.encode(f.path);
    const raw = typeof f.content === "string" ? enc.encode(f.content) : f.content;
    const crc = crc32(raw);
    let data = raw;
    let method = 0; // store
    if (raw.length > 512) {
      const comp = await deflateRaw(raw);
      if (comp && comp.length < raw.length) {
        data = comp;
        method = 8; // deflate
      }
    }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // utf-8 names
    lh.setUint16(8, method, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nameB.length, true);
    parts.push(new Uint8Array(lh.buffer), nameB, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const centralSize = central.reduce((t, a) => t + a.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const a of [...parts, ...central, new Uint8Array(eocd.buffer)]) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}
