// Offline structural + slug validation for a screen.json content tree.
// Runs in ~100ms with no browser; use it BEFORE rendering/verify.mjs.
//
// Usage:  node validate.mjs <file.screen.json|screen.json> [--allow-handwritten]
//
// Checks:
//   - provenance: the screen.json carries the `__provenance` stamp written by
//     ui_screen_export (KG-first pipeline). A hand-authored file (file mode) has
//     no stamp and FAILS unless --allow-handwritten is passed (explicit opt-in)
//   - JSON parses; top-level is one of {screen:{...}} | {roots:[...]} | [...roots]
//     (same forms the shell's extractScreen() accepts)
//   - node shape: componentSlug/component string, props object, text string,
//     children array (recursive)
//   - every slug resolves against PRIMITIVE_SLUGS + specials parsed LIVE from
//     app-shell-block.jsx (single source — no duplicated list here)
//   - Asset icon tokens resolve via ICON_TOKEN_TO_LUCIDE or the PascalCase
//     auto-fallback (verified against lucide-react when it is installed)
//   - flow edges: shape, type enum, `from` ids exist in the tree
//   - duplicate node ids (warning)
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const rawArgs = process.argv.slice(2);
const allowHandwritten = rawArgs.includes("--allow-handwritten") || rawArgs.includes("--file-mode");
const file = rawArgs.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node validate.mjs <file.screen.json> [--allow-handwritten]");
  process.exit(2);
}

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

// ---- single-source whitelist: parse app-shell-block.jsx ----------------------
const blockSrc = readFileSync(resolve(here, "app-shell-block.jsx"), "utf8");

function parseStringArray(source, constName) {
  const m = source.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\];`));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
function parseObjectKeys(source, constName) {
  const m = source.match(new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\};`));
  if (!m) return null;
  return Object.fromEntries(
    [...m[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((x) => [x[1], x[2]]),
  );
}

const primitiveSlugs = parseStringArray(blockSrc, "PRIMITIVE_SLUGS");
const iconTable = parseObjectKeys(blockSrc, "ICON_TOKEN_TO_LUCIDE");
if (!primitiveSlugs) fail("cannot parse PRIMITIVE_SLUGS from app-shell-block.jsx (renderer changed?)");
if (!iconTable) warn("cannot parse ICON_TOKEN_TO_LUCIDE from app-shell-block.jsx — icon checks skipped");

// Specials wired outside PRIMITIVE_SLUGS in the render block (asset, form, HTML fallbacks).
const SPECIAL_SLUGS = ["asset", "form", "div", "span", "p", "ul", "li", "img"];
const allowed = new Set([...(primitiveSlugs ?? []), ...SPECIAL_SLUGS]);

// ---- Level-A styling contract (see SKILL.md "Khế ước mức A") -----------------
// Color may ONLY appear as semantic utilities of registered tokens, and ONLY on
// decorative elements. These rules are mechanical guards for that contract.

// Color token names registered in the shell's @theme → the legal utility set.
let colorTokens = null;
try {
  const themeCss = readFileSync(resolve(here, "../assets/runtime/theme.css"), "utf8");
  colorTokens = new Set([...themeCss.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  if (colorTokens.size < 30) throw new Error(`implausibly few registrations (${colorTokens.size})`);
} catch (e) {
  warn(`cannot parse @theme color registrations from assets/runtime/theme.css (${e.message}) — component-paint checks degraded`);
  colorTokens = null;
}

const COLOR_UTIL_PREFIXES = "bg|text|border|from|to|via|ring|shadow|fill|stroke|outline|divide|accent|caret|decoration";
// Raw color literals — forbidden anywhere in props (not traceable to a token).
const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:oklch|oklab|rgba?|hsla?|color-mix|light-dark)\s*\(/;
// Arbitrary-value utility whose body smuggles a color/var/gradient (bg-[…], shadow-[…rgba…]).
// Layout arbitraries (size-[44px], grid-cols-[1fr_2fr], text-[14px]) stay legal.
const ARBITRARY_COLOR_RE = new RegExp(
  `\\b(?:${COLOR_UTIL_PREFIXES})-\\[[^\\]]*(?:#[0-9a-fA-F]|oklch|oklab|rgba?\\(|hsla?\\(|var\\(|color-mix|linear-gradient|radial-gradient|conic-gradient)[^\\]]*\\]`,
);
// Tailwind's OWN default palette (bg-red-500…) — that's Tailwind's colors, not the KG tokens.
const TW_PALETTE_RE = new RegExp(
  `\\b(?:${COLOR_UTIL_PREFIXES})-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(?:\\/\\d+)?\\b`,
);
// Semantic token utility (the ONLY legal way to color) — used to police components.
const TOKEN_UTIL_RE = new RegExp(`^(?:${COLOR_UTIL_PREFIXES})-([a-z][a-z0-9-]*?)(?:\\/\\d{1,3})?$`);

function foreignColorIn(value) {
  const findings = [];
  let m;
  if ((m = COLOR_LITERAL_RE.exec(value))) findings.push(`color literal "${m[0]}…"`);
  if ((m = ARBITRARY_COLOR_RE.exec(value))) findings.push(`arbitrary color class "${m[0].slice(0, 50)}"`);
  if ((m = TW_PALETTE_RE.exec(value))) findings.push(`Tailwind default palette class "${m[0]}" (not a KG token)`);
  return findings;
}

/** Token color utilities present in a className string (for component-paint). */
function tokenColorClasses(className) {
  if (!colorTokens) return [];
  return String(className).split(/\s+/).filter((cls) => {
    const m = TOKEN_UTIL_RE.exec(cls);
    return m && colorTokens.has(m[1]);
  });
}

/** Recursively collect every string in props (style objects, nested values…). */
function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

// Verbatim from app-shell-block.jsx / design-v3: PascalCase -> kebab-case.
function componentCatalogSlug(component) {
  return String(component)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}
function slugResolves(slug) {
  return allowed.has(slug) || allowed.has(componentCatalogSlug(slug));
}

// Optional: verify icon names against lucide-react when installed locally.
let lucideNames = null;
try {
  lucideNames = new Set(Object.keys(require("lucide-react")));
} catch { /* not installed — fall back to pattern-level checks */ }

function iconTokenToPascal(path) {
  const m = /^asset\.icon\.(.+)$/.exec(path || "");
  if (!m) return null;
  return m[1].split(/[-_.]/).filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

// ---- load + extract -----------------------------------------------------------
let data;
try {
  data = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
} catch (e) {
  console.error(`INVALID: ${file} is not valid JSON — ${e.message}`);
  process.exit(1);
}

// ---- provenance gate: KG-first pipeline ---------------------------------------
// The default pipeline authors screens IN THE GRAPH and emits screen.json via
// ui_screen_export, which stamps `__provenance`. A screen.json without that stamp
// was hand-authored (file mode) — accepted only with an explicit --allow-handwritten
// opt-in, so "forgot the graph, typed the JSON by hand" fails loudly instead of
// silently shipping an ungrounded, untraceable artifact.
const fromKgExport =
  (data && typeof data === "object" && data.__provenance && data.__provenance.tool === "ui_screen_export") ||
  /^od-kg-export:/.test(String(data?.source ?? ""));
if (!fromKgExport) {
  if (allowHandwritten) {
    warn("provenance — hand-authored screen.json accepted via --allow-handwritten (file mode: no KG grounding/trace, not reskinnable from a KG composition).");
  } else {
    fail(
      "provenance — this screen.json was NOT produced by ui_screen_export (no __provenance stamp). " +
        "Default pipeline is KG-first: author the screen in the graph (ui_screen_upsert/ui_instance_upsert), lint, then ui_screen_export. " +
        "For a genuine throwaway hand-authored screen, re-run with --allow-handwritten.",
    );
  }
}

function extractScreen(d) {
  if (d && d.screen) return d.screen;
  if (d && d.roots) return d;
  if (Array.isArray(d)) return { roots: d };
  return null;
}
const screen = extractScreen(data);
if (!screen || !Array.isArray(screen.roots) || screen.roots.length === 0) {
  console.error("INVALID: no roots found — top-level must be {screen:{roots:[...]}} | {roots:[...]} | [...nodes]");
  process.exit(1);
}
if (screen.viewport !== undefined && !["mobile", "desktop"].includes(screen.viewport)) {
  fail(`screen.viewport "${screen.viewport}" invalid (mobile|desktop)`);
}
if (screen.category !== undefined && !["mobile", "web"].includes(screen.category)) {
  fail(`screen.category "${screen.category}" invalid (mobile|web)`);
}

// ---- walk ----------------------------------------------------------------------
const ids = new Map(); // id -> count
let nodeCount = 0;

function walk(node, path) {
  if (typeof node === "string") return; // bare text child is fine for the shell
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    fail(`${path}: node must be an object`);
    return;
  }
  nodeCount += 1;
  const slug = node.component || node.componentSlug;
  if (!slug || typeof slug !== "string") {
    fail(`${path}: missing componentSlug`);
  } else if (!slugResolves(slug)) {
    fail(`${path}: unknown componentSlug "${slug}" -> would render as red ?${slug} badge (see references/components.md)`);
  }
  if (node.id !== undefined) {
    if (typeof node.id !== "string" || !node.id) fail(`${path}: id must be a non-empty string`);
    else ids.set(node.id, (ids.get(node.id) ?? 0) + 1);
  }
  if (node.props !== undefined && (typeof node.props !== "object" || node.props === null || Array.isArray(node.props))) {
    fail(`${path}: props must be an object`);
  }
  if (node.text !== undefined && typeof node.text !== "string") {
    fail(`${path}: text must be a string`);
  }
  // Level-A contract: colors only as registered-token utilities (props only —
  // node.text is display content, not style).
  if (node.props && typeof node.props === "object" && !Array.isArray(node.props)) {
    for (const s of collectStrings(node.props)) {
      for (const finding of foreignColorIn(s)) {
        fail(`${path}: foreign-color — ${finding}. Colors must be semantic token utilities (bg-primary/12, from-info, …) from the chosen composition.`);
      }
    }
    const catalogOfSlug = slug ? componentCatalogSlug(slug) : "";
    const isComponent = slug && slugResolves(slug) && !SPECIAL_SLUGS.includes(catalogOfSlug);
    if (isComponent && node.props.className) {
      const painted = tokenColorClasses(node.props.className);
      if (painted.length > 0) {
        fail(`${path}: component-paint — color utilities [${painted.join(", ")}] on component <${slug}>. Level A locks components to variant/size + layout classes; paint decorative wrappers instead.`);
      }
    }
  }
  // Asset icon token check
  const catalog = slug ? componentCatalogSlug(slug) : "";
  if (catalog === "asset" && iconTable) {
    const token = node.props?.token || node.props?.value || "";
    if (!token) {
      warn(`${path}: Asset without props.token renders an empty placeholder`);
    } else if (!iconTable[token]) {
      const derived = iconTokenToPascal(token);
      if (!derived) {
        fail(`${path}: Asset token "${token}" is not asset.icon.* and not in ICON_TOKEN_TO_LUCIDE -> placeholder box`);
      } else if (lucideNames && !lucideNames.has(derived)) {
        fail(`${path}: Asset token "${token}" -> auto-derived Lucide "${derived}" does not exist -> placeholder box`);
      }
    }
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      fail(`${path}: children must be an array`);
    } else {
      node.children.forEach((c, i) => walk(c, `${path}.children[${i}]`));
    }
  }
}
screen.roots.forEach((r, i) => walk(r, `roots[${i}]`));

for (const [id, n] of ids) if (n > 1) warn(`duplicate node id "${id}" (${n}x) — React keys may collide`);

// ---- flow ------------------------------------------------------------------------
if (screen.flow !== undefined) {
  if (!Array.isArray(screen.flow)) {
    fail("screen.flow must be an array");
  } else {
    screen.flow.forEach((e, i) => {
      const p = `flow[${i}]`;
      if (!e || typeof e !== "object") return fail(`${p}: must be an object`);
      if (!e.from || typeof e.from !== "string") fail(`${p}: missing "from" (trigger node id)`);
      else if (!ids.has(e.from)) fail(`${p}: from "${e.from}" matches no node id in this screen`);
      if (!e.to || typeof e.to !== "string") fail(`${p}: missing "to" (target screen slug)`);
      if (!["navigate", "showDialog", "closeDialog"].includes(e.type)) {
        fail(`${p}: type "${e.type}" invalid (navigate|showDialog|closeDialog)`);
      }
    });
  }
}

// ---- report -----------------------------------------------------------------------
console.log(`validate: ${file}`);
console.log(`  nodes: ${nodeCount}, whitelist: ${allowed.size} slugs${lucideNames ? `, lucide: ${lucideNames.size} icons` : " (lucide-react not installed — icon existence not verified)"}`);
for (const w of warnings) console.log(`  WARN  ${w}`);
for (const e of errors) console.log(`  ERROR ${e}`);
console.log(errors.length === 0 ? "VALIDATE: PASS" : `VALIDATE: FAIL (${errors.length} error${errors.length > 1 ? "s" : ""})`);
process.exit(errors.length === 0 ? 0 : 1);
