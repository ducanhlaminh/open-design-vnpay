#!/usr/bin/env node
//
// verify.mjs — design-system gate for the UI-Spec (React DS) stage.
//
// A green `tsc && vite build` only proves the app RUNS. It says nothing about
// whether the screens will survive the trip back into Figma. Two failure modes
// are silent at build time and only show up as a broken Figma file:
//
//   1. Token written inline (`style={{ color: 'var(--ground-foreground)' }}`).
//      The capture step (`stampFigMarkers`) derives token names from the
//      `.tk-*` CSS rules matched against `el.classList` — it never reads inline
//      styles. Inline tokens paste into Figma as dead literal values: no
//      variable binding, no text style.
//   2. Screen scaffolding hand-rolled from <div> while the imported design
//      system already ships the component (AppBar / BottomSheet / Dialog /
//      Tab…). Hand-rolled markup pastes as plain frames instead of instances.
//
// This script fails the build on both, plus hex/rgb literals and hand-rolled
// utility class names, and prints the exact `tk-*` class or ds component to use
// instead. Scope = agent-authored code only (`src/screens/`,
// `src/components/app/`, `src/App.tsx`); `src/ds/` is generated and exempt.
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

// ds component name (lowercased, punctuation-free) → the hand-rolled markup
// signals that mean "you rebuilt this by hand". Only enforced when the imported
// design system actually ships that component.
const SCAFFOLD_RULES = [
  { comps: ["dialog"], label: "Dialog", patterns: [/role=["']alertdialog["']/, /role=["']dialog["']/, /\baria-modal\b/] },
  { comps: ["bottomsheet", "sheet", "sheetheader", "sheetfooter"], label: "BottomSheet", patterns: [/\bbottom-?sheet\b/i, /\bdrawer\b/i] },
  { comps: ["appbar", "navigationbar"], label: "AppBar", patterns: [/<header[\s>]/, /\bapp-?bar\b/i, /\btop-?bar\b/i] },
  { comps: ["tab", "tabitem", "navigationbar", "navigationitem"], label: "Tab / NavigationBar", patterns: [/<nav[\s>]/, /\btab-?bar\b/i, /\bbottom-?nav\b/i] },
  { comps: ["snackbar", "toastify", "reminddertoastify", "remindertoastify"], label: "Snackbar", patterns: [/\bsnackbar\b/i, /\btoast\b/i] },
];

const CSS_TO_CAMEL = (p) => p.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());

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

const errors = [];
const warnings = [];
const push = (list, file, line, code, msg, fix) =>
  list.push({ file: path.relative(target, file), line, code, msg, fix });

const tokens = readTokenClasses(path.join(target, "src/ds/styles/globals.css"));
const dsComponents = readDsComponents(path.join(target, "src/ds/components/ui"));
const dsNorm = new Set(dsComponents.map((c) => c.replace(/-/g, "")));

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

  for (const m of src.matchAll(/ds\/components\/ui\/([a-z0-9-]+)/g)) usedDsComponents.add(m[1]);

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

    // (b) literal colors
    for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) {
      if (/^#[0-9a-fA-F]{3,8}$/.test(m[0]) && /(?:href|id|url|#od-)/.test(line)) continue;
      push(errors, file, lineNo, "literal-color", `màu literal "${m[0]}" — mọi màu phải là token qua class tk-*`, "tra token trong src/ds/styles/globals.css");
      break;
    }

    // (c) hand-rolled utility class names
    for (const m of line.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
      const value = m[1] ?? m[2] ?? m[3] ?? "";
      for (const cls of value.split(/\s+/).filter(Boolean)) {
        if (cls.startsWith("tk-") || cls.startsWith("od-") || cls.includes("${")) continue;
        push(errors, file, lineNo, "raw-class", `class "${cls}" không phải tk-* — không có utility tự chế / Tailwind ở stage này`, "dùng class tk-* của globals.css hoặc inline style cho layout thuần");
      }
    }
  });

  // (d) scaffolding rebuilt by hand while the ds ships the component
  for (const rule of SCAFFOLD_RULES) {
    const available = rule.comps.filter((c) => dsNorm.has(c));
    if (available.length === 0) continue;
    const usesDs = [...usedDsComponents].some((u) => available.includes(u.replace(/-/g, "")));
    if (usesDs) continue;
    for (const pattern of rule.patterns) {
      const idx = src.search(pattern);
      if (idx < 0) continue;
      const lineNo = src.slice(0, idx).split("\n").length;
      push(errors, file, lineNo, "hand-rolled-scaffold", `dựng tay ${rule.label} bằng markup thường`, `import component có sẵn: ${available.map((c) => `ds/components/ui/${dsComponents.find((d) => d.replace(/-/g, "") === c)}`).join(" | ")}`);
      break;
    }
  }
}

// --- report -----------------------------------------------------------------
const fmt = (list, head) => {
  if (list.length === 0) return;
  console.error(`\n${head}`);
  for (const e of list) console.error(`  ${e.file}:${e.line}  [${e.code}] ${e.msg}\n      → ${e.fix}`);
};

console.error(`[verify] design-system gate — ${appFiles.length} file agent viết, ${dsComponents.length} component DS có sẵn`);
if (!tokens.ok) {
  warnings.push({ file: "src/ds/styles/globals.css", line: 0, code: "no-tokens", msg: "không đọc được globals.css — bỏ qua kiểm tra token", fix: "kiểm tra bundle DS đã stage chưa" });
}

fmt(errors, `❌ ${errors.length} vi phạm:`);
fmt(warnings, `⚠️  ${warnings.length} cảnh báo:`);

const scaffoldAvailable = SCAFFOLD_RULES.flatMap((r) => r.comps.filter((c) => dsNorm.has(c)));
const scaffoldUsed = [...usedDsComponents].filter((u) => scaffoldAvailable.includes(u.replace(/-/g, "")));
console.error(
  `\n[verify] component DS dùng: ${usedDsComponents.size}/${dsComponents.length}` +
    ` · khung màn: ${scaffoldUsed.length}/${new Set(scaffoldAvailable).size}` +
    ` · lỗi: ${errors.length}`,
);

if (errors.length > 0 && !soft) {
  console.error(`\n[verify] FAILED — sửa các lỗi trên rồi chạy lại build.sh (UIREACT_VERIFY_SOFT=1 chỉ để xem báo cáo).`);
  process.exit(1);
}
console.error(`[verify] ${errors.length > 0 ? "SOFT PASS (bỏ qua lỗi vì UIREACT_VERIFY_SOFT=1)" : "OK"}`);
