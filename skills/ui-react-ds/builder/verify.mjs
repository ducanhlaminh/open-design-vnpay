#!/usr/bin/env node
//
// verify.mjs — design-system gate for the UI-Spec (React DS) stage.
//
// A green `tsc && vite build` only proves the app RUNS. It says nothing about
// whether the screens will survive the trip back into Figma. These failure
// modes are silent at build time and only show up as a broken Figma file:
//
//   1. Token written inline (`style={{ color: 'var(--ground-foreground)' }}`).
//      The capture step (`stampFigMarkers`) derives token names from the
//      `.tk-*` CSS rules matched against `el.classList` — it never reads inline
//      styles. Inline tokens paste into Figma as dead literal values: no
//      variable binding, no text style.
//   2. Styling VALUE written as a literal (`fontSize: 14`, `color: 'white'`,
//      `borderRadius: 8`). No token was consulted at all — the screen silently
//      drifts off the design system and nothing in Figma binds.
//   3. Screen scaffolding hand-rolled from <div> while the imported design
//      system already ships the component (Dialog / BottomSheet / AppBar /
//      Tabs…). Hand-rolled markup pastes as plain frames instead of instances.
//
// Scaffold detection matches ds component names by NORMALIZED SUBSTRING
// (`i-pay-dialog`, `dialog-action` → the Dialog family) because Figma-imported
// bundles carry the design team's own names, never the generic ones. The check
// is PER FILE: a file is exempt only when it itself imports a component of that
// family. If a family component genuinely cannot be used (static render, fixed
// text, no handlers), declare the exception in the file — it surfaces as a
// warning, not silently:
//
//     // od-verify-allow: scaffold — <specific reason, min 8 chars>
//
// Scope = agent-authored code only (`src/screens/`, `src/components/`,
// `src/App.tsx`); `src/ds/` is generated and exempt.
//
// Usage:  node verify.mjs [<project-react-ds-dir>]     (default: ./react-ds)
// Env:    UIREACT_VERIFY_SOFT=1   report but always exit 0

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] ?? "./react-ds");
const soft = process.env.UIREACT_VERIFY_SOFT === "1";

// --- css props whose value MUST come from a tk-* class ----------------------
// Layout props (display/flex/gap/position/size/padding…) are deliberately absent:
// those are structure, and inline style is the documented way to write them.
const VALUE_PROPS = new Set([
  "color", "background", "backgroundColor", "backgroundImage",
  "border", "borderColor", "borderTop", "borderRight", "borderBottom", "borderLeft",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "outline", "outlineColor", "fill", "stroke",
  "fontSize", "fontWeight", "lineHeight", "letterSpacing", "fontFamily",
  "borderRadius", "borderTopLeftRadius", "borderTopRightRadius",
  "borderBottomLeftRadius", "borderBottomRightRadius",
  "boxShadow", "textDecorationColor", "caretColor",
]);

// Values that are resets/pass-throughs, not design decisions — allowed inline.
const VALUE_ALLOWED = new Set([
  "transparent", "currentcolor", "inherit", "initial", "unset", "none",
  "auto", "normal", "0", "0px",
]);

// Scaffold families. `keys` are normalized substrings matched against the ds
// component inventory (and against this file's own ds imports for exemption);
// `fileRe` flags a file whose NAME says it rebuilds the family; `patterns`
// flag the markup signals inside the file.
const SCAFFOLD_RULES = [
  {
    keys: ["dialog", "modal"],
    label: "Dialog",
    fileRe: /dialog|modal/i,
    patterns: [/role=["']alertdialog["']/, /role=["']dialog["']/, /\baria-modal\b/],
  },
  {
    keys: ["bottomsheet", "actionsheet", "drawer"],
    label: "BottomSheet",
    fileRe: /sheet|drawer/i,
    patterns: [/\bbottom-?sheet\b/i, /\bdrawer\b/i],
  },
  {
    keys: ["appbar", "topnavigationbar", "topbar", "navigationbar"],
    label: "AppBar / TopNavigationBar",
    fileRe: /app-?bar|top-?bar|top-?nav/i,
    patterns: [/<header[\s>]/, /\bapp-?bar\b/i, /\btop-?bar\b/i],
  },
  {
    keys: ["tabs", "tabitem", "tabbar", "bottomnavigation", "navigationbar"],
    label: "Tabs / NavigationBar",
    fileRe: /\btabs?\b|bottom-?nav/i,
    patterns: [/<nav[\s>]/, /\btab-?bar\b/i, /\bbottom-?nav\b/i],
  },
  {
    keys: ["snackbar", "toast"],
    label: "Snackbar / Toast",
    fileRe: /snack|toast/i,
    patterns: [/\bsnackbar\b/i, /\btoast\b/i],
  },
];

// Horizontal whitespace only — the reason must sit on the SAME line, or an
// empty pragma would swallow the next code line as its "reason".
const ALLOW_PRAGMA = /od-verify-allow:[ \t]*scaffold\b[ \t—:–-]*(.*)/;

const CSS_TO_CAMEL = (p) => p.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
const norm = (name) => name.replace(/-/g, "").toLowerCase();

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

// --- 1. token vocabulary from globals.css ----------------------------------
// Source of truth is the CSS rule, not the class name: duplicate token names get
// -2/-3 suffixes, so reverse-parsing the class name would lie.
function readTokenClasses(cssPath) {
  const byPropToken = new Map(); // "camelProp|token" -> class
  const byToken = new Map(); // token -> [class]
  if (!existsSync(cssPath)) return { byPropToken, byToken, ok: false };
  const css = readFileSync(cssPath, "utf8");
  const ruleRe = /\.(tk-[a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g;
  let rule;
  while ((rule = ruleRe.exec(css))) {
    const cls = rule[1];
    const declRe = /([-a-zA-Z]+)\s*:\s*[^;{}]*?var\(\s*--([a-zA-Z0-9-]+)/g;
    let decl;
    while ((decl = declRe.exec(rule[2]))) {
      const camel = CSS_TO_CAMEL(decl[1].toLowerCase());
      const token = decl[2];
      if (!byPropToken.has(`${camel}|${token}`)) byPropToken.set(`${camel}|${token}`, cls);
      if (!byToken.has(token)) byToken.set(token, []);
      if (!byToken.get(token).includes(cls)) byToken.get(token).push(cls);
    }
  }
  return { byPropToken, byToken, ok: true };
}

// --- 2. ds component inventory ---------------------------------------------
function readDsComponents(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => f.replace(/\.tsx$/, ""));
}

// Blank out comments while PRESERVING offsets/line numbers, so scaffold
// patterns never fire on prose ("…bottom-sheet select…" in a doc comment).
function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

// A match inside `<AppDialog role="alertdialog" …>` is a PROP handed to a
// composite — the violation belongs to the file that defines the composite
// (where the attribute lands on a real HTML tag), not to its callers.
function inUppercaseJsxTag(src, idx) {
  const open = src.lastIndexOf("<", idx);
  if (open < 0) return false;
  if (src.slice(open, idx).includes(">")) return false; // text content, not an attribute
  const m = /^<([A-Za-z][A-Za-z0-9.]*)/.exec(src.slice(open, open + 64));
  return m !== null && /^[A-Z]/.test(m[1]);
}

// --- 3. style={{ … }} ranges -----------------------------------------------
// The literal-value rule must only look INSIDE style objects, or it would
// misread ds variant props (`hierarchy: 'Primary'`) and data structures.
// Returns [start, end) offsets of each style object literal in the source.
function styleObjectRanges(src) {
  const ranges = [];
  const re = /style\s*=\s*\{\{|style\s*:\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", m.index);
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    ranges.push([open, Math.min(i + 1, src.length)]);
    re.lastIndex = Math.max(re.lastIndex, open + 1);
  }
  return ranges;
}

const errors = [];
const warnings = [];
const push = (list, file, line, code, msg, fix) =>
  list.push({ file: path.relative(target, file), line, code, msg, fix });

// --- target marker (.od-target.json, written by the daemon at DS staging) ---
// responsive targets (websites) MUST ship breakpoints; the fixed-viewport
// mobile app must NOT. Missing marker = legacy staging → fixed viewport.
function readTargetMarker(markerPath) {
  try {
    const raw = JSON.parse(readFileSync(markerPath, "utf8"));
    return { target: raw?.target ?? null, responsive: raw?.responsive === true };
  } catch {
    return { target: null, responsive: false };
  }
}

// --- layout.css: the ONE agent-editable stylesheet, LAYOUT-ONLY -------------
// Returns its defined `ly-*` class names and pushes violations: non-ly class
// definitions, styling declarations (they belong on tk-* classes), and the
// media-query rule for the run's target (see readTargetMarker).
const LAYOUT_DENY_PROPS = new Set([
  "color", "background", "background-color", "background-image",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "outline", "outline-color", "fill", "stroke",
  "font-size", "font-weight", "line-height", "letter-spacing", "font-family",
  "border-radius", "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  "box-shadow", "text-decoration-color", "caret-color",
]);

function checkLayoutCss(cssPath, marker) {
  const defined = new Set();
  if (!existsSync(cssPath)) {
    if (marker.responsive) {
      push(errors, cssPath, 1, "missing-breakpoint", "target website RESPONSIVE nhưng không có src/styles/layout.css (breakpoint phải khai ở đó)", "tạo src/styles/layout.css với class ly-* + @media (max-width: 768px) theo responsive_notes của UX spec");
    }
    return defined;
  }
  // Blank /* … */ comments offset-stable FIRST — the seeded template header
  // carries example rules (`.ly-shell`, `@media …`) that must never trip the
  // gate, and prose like "layout.css" would match the class regex as ".css".
  const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  const lineOf = (idx) => css.slice(0, idx).split("\n").length;

  // class definitions: every defined class must be ly-*
  for (const m of css.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)) {
    const cls = m[1];
    if (cls.startsWith("ly-")) defined.add(cls);
    else push(errors, cssPath, lineOf(m.index), "layout-css-class", `class ".${cls}" trong layout.css không có prefix ly-`, "layout.css chỉ định nghĩa class ly-*; styling giá trị dùng class tk-* của DS");
  }
  // styling declarations are forbidden — layout properties only
  for (const m of css.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]+)/g)) {
    const prop = m[1].toLowerCase();
    if (LAYOUT_DENY_PROPS.has(prop)) {
      push(errors, cssPath, lineOf(m.index), "layout-css-value", `"${prop}: ${m[2].trim()}" trong layout.css — file này CHỈ chứa layout (display/flex/grid/gap/size/spacing)`, "chuyển giá trị styling sang class tk-* trong markup");
    }
  }
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) {
    push(errors, cssPath, lineOf(m.index), "layout-css-value", `màu literal "${m[0]}" trong layout.css`, "màu chỉ được nằm trong token của DS (class tk-*)");
    break;
  }
  // media-query rule per target
  const mediaIdx = css.search(/@media\b/);
  if (marker.responsive && mediaIdx < 0) {
    push(errors, cssPath, 1, "missing-breakpoint", "target website RESPONSIVE nhưng layout.css không có @media breakpoint nào", "thêm @media (max-width: 768px) hiện thực responsive_notes của từng màn");
  }
  if (!marker.responsive && mediaIdx >= 0) {
    push(errors, cssPath, lineOf(mediaIdx), "no-media-query", "target mobile-app là FIXED viewport — cấm @media trong layout.css", "bỏ media query; app mobile chỉ có một layout 390px");
  }
  return defined;
}

const tokens = readTokenClasses(path.join(target, "src/ds/styles/globals.css"));
const dsComponents = readDsComponents(path.join(target, "src/ds/components/ui"));
const targetMarker = readTargetMarker(path.join(target, ".od-target.json"));
const layoutClasses = checkLayoutCss(path.join(target, "src/styles/layout.css"), targetMarker);

// Scaffold families actually shipped by THIS design system (fuzzy by name).
const familyComps = (rule) =>
  dsComponents.filter((c) => rule.keys.some((k) => norm(c).includes(k)));

const appFiles = [
  ...walk(path.join(target, "src/screens")),
  ...walk(path.join(target, "src/components")),
  ...(existsSync(path.join(target, "src/App.tsx")) ? [path.join(target, "src/App.tsx")] : []),
].filter((f) => !f.includes(`${path.sep}ds${path.sep}`));

if (appFiles.length === 0) {
  console.error(`[verify] no agent-authored sources under ${target}/src — nothing to check.`);
  process.exit(soft ? 0 : 1);
}

const usedDsComponents = new Set();

for (const file of appFiles) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");

  // ds imports of THIS file — the unit of scaffold exemption.
  const fileDsImports = [...src.matchAll(/ds\/components\/ui\/([a-z0-9-]+)/g)].map((m) => m[1]);
  for (const name of fileDsImports) usedDsComponents.add(name);

  // Per-file scaffold escape hatch: must carry a real reason.
  let scaffoldAllowed = false;
  const pragma = ALLOW_PRAGMA.exec(src);
  if (pragma) {
    const reason = (pragma[1] ?? "").trim();
    const lineNo = src.slice(0, pragma.index).split("\n").length;
    if (reason.length < 8) {
      push(errors, file, lineNo, "allow-pragma", "od-verify-allow: scaffold thiếu lý do", "ghi lý do cụ thể sau dấu — (vd: DS Dialog text cứng, không nhận onClick)");
    } else {
      scaffoldAllowed = true;
      push(warnings, file, lineNo, "allow-pragma", `khung màn tự dựng được khai báo ngoại lệ: ${reason}`, "reviewer xác nhận lý do còn đúng khi DS được import lại");
    }
  }

  // line start offsets + style ranges for the literal-value rule
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const styleRanges = styleObjectRanges(src);
  const styleSegmentsOfLine = (idx) => {
    const start = lineStarts[idx];
    const end = idx + 1 < lineStarts.length ? lineStarts[idx + 1] : src.length;
    const segs = [];
    for (const [s, e] of styleRanges) {
      const from = Math.max(s, start);
      const to = Math.min(e, end);
      if (from < to) segs.push(src.slice(from, to));
    }
    return segs;
  };

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.replace(/\/\/.*$/, ""); // drop trailing line comments
    if (/^\s*\*/.test(raw) || /^\s*\/\//.test(raw)) return; // block/line comment

    // (a) inline token — the silent Figma killer
    for (const m of line.matchAll(/([a-zA-Z]+)\s*:\s*(?:'|"|`)?[^,;\n]*?var\(\s*--([a-zA-Z0-9-]+)/g)) {
      const prop = m[1];
      const token = m[2];
      if (!VALUE_PROPS.has(prop)) continue;
      const exact = tokens.byPropToken.get(`${prop}|${token}`);
      const any = tokens.byToken.get(token);
      const fix = exact
        ? `dùng class "${exact}"`
        : any?.length
          ? `token này chỉ có class cho thuộc tính khác (${any.join(", ")}) — đổi sang token đã có class cho "${prop}"`
          : `không có class tk-* nào bind --${token} — chọn token khác đã có class`;
      push(errors, file, lineNo, "inline-token", `inline style "${prop}: var(--${token})" — capture Figma không đọc inline style, token sẽ mất`, fix);
    }

    // (b) literal colors (any context — style objects, SVG attrs, strings)
    let hasColorLiteral = false;
    for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) {
      if (/^#[0-9a-fA-F]{3,8}$/.test(m[0]) && /(?:href|id|url|#od-)/.test(line)) continue;
      hasColorLiteral = true;
      push(errors, file, lineNo, "literal-color", `màu literal "${m[0]}" — mọi màu phải là token qua class tk-*`, "tra token trong src/ds/styles/globals.css");
      break;
    }

    // (c) literal VALUES for styling props inside style objects — fontSize: 14,
    // color: 'white', borderRadius: 8… No var(), no hex, still off-token.
    if (!hasColorLiteral) {
      for (const seg of styleSegmentsOfLine(i)) {
        for (const m of seg.matchAll(/([a-zA-Z]+)\s*:\s*([^,}\n]+)/g)) {
          const prop = m[1];
          if (!VALUE_PROPS.has(prop)) continue;
          const rawValue = m[2].trim();
          if (rawValue.includes("var(") || rawValue.includes("${")) continue;
          const value = rawValue.replace(/^['"`]|['"`]$/g, "").trim().toLowerCase();
          if (value === "" || VALUE_ALLOWED.has(value)) continue;
          push(
            errors, file, lineNo, "literal-value",
            `inline style "${prop}: ${rawValue}" — giá trị styling phải là token qua class tk-*`,
            "tra class tk-* trong src/ds/styles/globals.css; reset thuần thì dùng transparent/none/0/inherit",
          );
        }
      }
    }

    // (d) hand-rolled utility class names. `ly-*` is allowed ONLY when the
    // class is actually defined in src/styles/layout.css.
    for (const m of line.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
      const value = m[1] ?? m[2] ?? m[3] ?? "";
      for (const cls of value.split(/\s+/).filter(Boolean)) {
        if (cls.startsWith("tk-") || cls.startsWith("od-") || cls.includes("${")) continue;
        if (cls.startsWith("ly-")) {
          if (!layoutClasses.has(cls)) {
            push(errors, file, lineNo, "raw-class", `class "${cls}" chưa được định nghĩa trong src/styles/layout.css`, `định nghĩa .${cls} (layout-only) trong layout.css hoặc bỏ class`);
          }
          continue;
        }
        push(errors, file, lineNo, "raw-class", `class "${cls}" không phải tk-*/ly-* — không có utility tự chế / Tailwind ở stage này`, "styling giá trị: class tk-* của globals.css; layout tái dùng/breakpoint: class ly-* trong src/styles/layout.css; layout một chỗ: inline style");
      }
    }
  });

  // (e) scaffolding rebuilt by hand while the ds ships the family.
  // PER FILE: only this file's own ds imports exempt it — one import elsewhere
  // in the project must not silence every other hand-rolled copy.
  if (!scaffoldAllowed) {
    const base = path.basename(file);
    const srcScaffold = blankComments(src);
    for (const rule of SCAFFOLD_RULES) {
      const available = familyComps(rule);
      if (available.length === 0) continue;
      const usesFamily = fileDsImports.some((name) => rule.keys.some((k) => norm(name).includes(k)));
      if (usesFamily) continue;
      const suggest = available.slice(0, 4).map((c) => `ds/components/ui/${c}`).join(" | ");
      let contentIdx;
      outer: for (const p of rule.patterns) {
        const re = new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`);
        for (const m of srcScaffold.matchAll(re)) {
          if (inUppercaseJsxTag(srcScaffold, m.index)) continue;
          contentIdx = m.index;
          break outer;
        }
      }
      if (contentIdx !== undefined) {
        const lineNo = srcScaffold.slice(0, contentIdx).split("\n").length;
        push(errors, file, lineNo, "hand-rolled-scaffold", `dựng tay ${rule.label} bằng markup thường`, `import component có sẵn: ${suggest}`);
      } else if (rule.fileRe.test(base)) {
        push(errors, file, 1, "hand-rolled-scaffold", `file "${base}" tự dựng ${rule.label} mà không dùng component DS nào của nhóm này`, `import component có sẵn: ${suggest}`);
      }
    }
  }

  // (f) rendered UI that references NOTHING from the design system — no tk-*
  // class, no ds component, no app-layer composite: the browser defaults are
  // styling this file, which means zero tokens survive into Figma. HARD error:
  // "did not use tokens at all" is exactly the silent drift this gate exists
  // to stop. A purely structural wrapper belongs in the app layer, composed —
  // this file must reference the design system somewhere.
  const rendersMarkup = /<(?:div|span|p|button|section|main|ul|li|h[1-6])[\s>]/.test(src);
  if (
    rendersMarkup &&
    !src.includes("tk-") &&
    fileDsImports.length === 0 &&
    !/components\/app/.test(src)
  ) {
    push(errors, file, 1, "no-token-usage", "file render markup nhưng không tham chiếu token tk-*, component DS hay app-layer nào — chữ/màu đang là mặc định trình duyệt, 0 token sang được Figma", "style chữ/màu qua class tk-* hoặc compose từ component DS / app-layer");
  }
}

// --- (g) human-locked wireframe components ----------------------------------
// A wireframe's data-comp attribute is a component assignment the reviewer
// locked in the ux-spec preview. Collect assignments from sibling HTML files.
function collectLockedComps(wireDir) {
  const locked = new Map();
  if (!existsSync(wireDir)) return locked;
  for (const entry of readdirSync(wireDir)) {
    if (!entry.endsWith(".html")) continue;
    try {
      const raw = readFileSync(path.join(wireDir, entry), "utf8");
      for (const match of raw.matchAll(/\bdata-comp\s*=\s*["']([^"']+)["']/gi)) {
        const comp = match[1].trim();
        if (!comp) continue;
        if (!locked.has(comp)) locked.set(comp, []);
        locked.get(comp).push(entry);
      }
    } catch {
      /* invalid HTML is the ux stage's problem, not this gate's */
    }
  }
  return locked;
}

{
  const locked = collectLockedComps(path.join(target, "..", "wireframes"));
  if (locked.size > 0) {
    const allSources = appFiles.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const [comp, wireFiles] of locked) {
      if (!dsComponents.includes(comp)) {
        push(errors, path.join(target, "..", "wireframes", wireFiles[0]), 1, "locked-comp", `wireframe chốt component "${comp}" nhưng bộ DS không có component đó`, "sửa lựa chọn trong preview ux-spec (UI gán component) cho khớp DS đang chạy");
        continue;
      }
      if (!allSources.includes(`ds/components/ui/${comp}`)) {
        push(errors, path.join(target, "..", "wireframes", wireFiles[0]), 1, "locked-comp", `component "${comp}" đã được NGƯỜI chốt trong wireframe (${wireFiles.join(", ")}) nhưng app không import nó`, `import và dùng ds/components/ui/${comp} cho đúng node wireframe đã chốt`);
      }
    }
    console.error(`[verify] wireframe locked comps: ${locked.size} component đã chốt từ ${new Set([...locked.values()].flat()).size} wire file`);
  }
}

// --- report -----------------------------------------------------------------
const fmt = (list, head) => {
  if (list.length === 0) return;
  console.error(`\n${head}`);
  for (const e of list) console.error(`  ${e.file}:${e.line}  [${e.code}] ${e.msg}\n      → ${e.fix}`);
};

console.error(
  `[verify] design-system gate — ${appFiles.length} file agent viết, ${dsComponents.length} component DS có sẵn` +
    ` · target: ${targetMarker.target ?? "(legacy)"}${targetMarker.responsive ? " (RESPONSIVE)" : " (fixed viewport)"}` +
    ` · ly-*: ${layoutClasses.size}`,
);
if (!tokens.ok) {
  warnings.push({ file: "src/ds/styles/globals.css", line: 0, code: "no-tokens", msg: "không đọc được globals.css — bỏ qua kiểm tra token", fix: "kiểm tra bundle DS đã stage chưa" });
}

fmt(errors, `❌ ${errors.length} vi phạm:`);
fmt(warnings, `⚠️  ${warnings.length} cảnh báo:`);

const familiesAvailable = SCAFFOLD_RULES.filter((r) => familyComps(r).length > 0);
const familiesUsed = familiesAvailable.filter((r) =>
  [...usedDsComponents].some((name) => r.keys.some((k) => norm(name).includes(k))),
);
console.error(
  `\n[verify] component DS dùng: ${usedDsComponents.size}/${dsComponents.length}` +
    ` · khung màn: ${familiesUsed.length}/${familiesAvailable.length}` +
    ` (${familiesAvailable.map((r) => r.label).join(", ") || "DS không có nhóm khung màn nào"})` +
    ` · lỗi: ${errors.length}`,
);

if (errors.length > 0 && !soft) {
  console.error(`\n[verify] FAILED — sửa các lỗi trên rồi chạy lại build.sh (UIREACT_VERIFY_SOFT=1 chỉ để xem báo cáo).`);
  process.exit(1);
}
console.error(`[verify] ${errors.length > 0 ? "SOFT PASS (bỏ qua lỗi vì UIREACT_VERIFY_SOFT=1)" : "OK"}`);
