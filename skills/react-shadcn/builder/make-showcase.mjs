// Assemble assets/showcase.html — a self-contained gallery of the verbatim
// components/ui set, themed with the FULL "VNPAY Glass" composition pulled
// VERBATIM from the sm-mcp Knowledge Graph (ws-project-XPOS):
//   Default Spacing · Rounded · Dashboard Type · Large controls ·
//   Payment Glass Pro (color) · VNPAY Merchant (brand)
//
// Colors/surfaces are NOT hand-transcribed: the `KG` object below holds the raw
// KG rawValues VERBATIM, and `kgRawValueToCss()` converts each by its format
// (plain · paint JSON · shadow JSON · Tailwind class-token) to plain CSS —
// mirroring design-v3's theme-lab resolver. See references/kg-brand-binding.md.
//
// Inputs: ../assets/runtime/{theme.css,components.bundle.js} + ./showcase-block.jsx
// Output: ../assets/showcase.html + ../assets/vnpay-glass.css
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, "../assets");
const runtime = resolve(assets, "runtime");

const theme = readFileSync(resolve(runtime, "theme.css"), "utf8");
const bundle = readFileSync(resolve(runtime, "components.bundle.js"), "utf8");
const block = readFileSync(resolve(here, "showcase-block.jsx"), "utf8");

/* ── Fonts (Dashboard Type layer) ──────────────────────────────────────── */
const INTER = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const BRICOLAGE = "'Bricolage Grotesque', 'Inter', system-ui, sans-serif";
const JBMONO = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";

/* ── Type scale (Dashboard Type) — verbatim KG, key tokens the gallery uses.
   theme.css `.type-<name>` utilities read these --text-<name>-* vars. ────── */
const TYPO = {
  "display-small":  { f: BRICOLAGE, s: "40px", lh: "44px", w: 700, tr: "0em" },
  "heading-medium": { f: BRICOLAGE, s: "24px", lh: "28px", w: 650, tr: "0em" },
  "heading-small":  { f: BRICOLAGE, s: "20px", lh: "24px", w: 650, tr: "0em" },
  "title-large":    { f: INTER, s: "22px", lh: "28px", w: 650, tr: "0em" },
  "title-medium":   { f: INTER, s: "18px", lh: "24px", w: 650, tr: "0em" },
  "title-small":    { f: INTER, s: "16px", lh: "22px", w: 650, tr: "0em" },
  "body-large":     { f: INTER, s: "18px", lh: "28px", w: 400, tr: "0em" },
  "body":           { f: INTER, s: "16px", lh: "24px", w: 400, tr: "0em" },
  "body-small":     { f: INTER, s: "14px", lh: "20px", w: 400, tr: "0em" },
  "label":          { f: INTER, s: "14px", lh: "20px", w: 500, tr: "0em" },
  "label-small":    { f: INTER, s: "12px", lh: "16px", w: 500, tr: "0em" },
  "label-xs":       { f: INTER, s: "12px", lh: "16px", w: 500, tr: "0em" },
  "body-xs":        { f: INTER, s: "12px", lh: "18px", w: 400, tr: "0em" },
  "caption":        { f: INTER, s: "12px", lh: "18px", w: 400, tr: "0em" },
};
const typoVars = Object.entries(TYPO)
  .map(([k, v]) =>
    `  --text-${k}-family: ${v.f}; --text-${k}-size: ${v.s}; --text-${k}-line-height: ${v.lh}; --text-${k}-weight: ${v.w}; --text-${k}-tracking: ${v.tr};`,
  )
  .join("\n");

/* ═══════════════════════════════════════════════════════════════════════════
   KG TOKEN RESOLVER — kgRawValueToCss(path, rawValue)

   The KG stores each token in one of FOUR formats. The resolver dispatches on
   the format and emits PLAIN CSS (the in-browser Tailwind engine cannot compile
   the complex arbitrary classes — multi-layer shadow-[], mask-composite — so we
   do what Tailwind would do, deterministically, here):

     • plain        "oklch(…)" | "16px"               → use as-is
     • paint  JSON  {type:"paint",  layers:[…]}        → solid color | linear-gradient
     • shadow JSON  {type:"shadow", layers:[…]}        → box-shadow
     • class-token  "bg-[…] backdrop-… shadow-[…] before:…"  → parsed to plain CSS
   ═══════════════════════════════════════════════════════════════════════════ */
const sp = (s) => String(s).replace(/_/g, " ").trim(); // Tailwind underscore → space

function paintToCss(layers) {
  const one = (L) => {
    if (L.kind === "solid") return L.color;
    if (L.kind === "gradient") {
      const stops = L.stops.map((s) => `${s.color} ${s.position}%`).join(", ");
      return `linear-gradient(${L.angle ?? 0}deg, ${stops})`;
    }
    return null;
  };
  return layers.map(one).filter(Boolean).join(", ");
}

function shadowToCss(layers, refColor = () => "transparent") {
  return layers
    .map((L) => {
      const c = L.color ?? refColor(L.colorRef, L.opacity);
      return `${L.kind === "inner" ? "inset " : ""}${L.x || 0}px ${L.y || 0}px ${L.blur || 0}px ${L.spread || 0}px ${c}`;
    })
    .join(", ");
}

// Map one Tailwind utility fragment → [cssProp, value] (or null if unknown).
function utilToDecl(t) {
  let m;
  if ((m = t.match(/^bg-\[(.+)\]$/))) return ["background", sp(m[1])];
  if ((m = t.match(/^backdrop-blur-\[(.+)\]$/))) return ["__blur", sp(m[1])];
  if ((m = t.match(/^backdrop-saturate-\[(.+)\]$/))) return ["__sat", sp(m[1])];
  if ((m = t.match(/^shadow-\[(.+)\]$/))) return ["box-shadow", sp(m[1])];
  if ((m = t.match(/^content-\[(.*)\]$/))) return ["content", m[1] ? sp(m[1]) : '""'];
  if ((m = t.match(/^rounded-\[(.+)\]$/))) return ["border-radius", sp(m[1])];
  if ((m = t.match(/^\[([a-z-]+):(.+)\]$/))) return [m[1], sp(m[2])]; // arbitrary [prop:value]
  if (t === "relative") return ["position", "relative"];
  if (t === "absolute") return ["position", "absolute"];
  if (t === "inset-0") return ["inset", "0"];
  if (t === "p-px") return ["padding", "1px"];
  if (t === "pointer-events-none") return ["pointer-events", "none"];
  if (t === "border-0") return ["border", "0"];
  return null;
}

// Parse a Tailwind class-composition string → plain-CSS pieces.
function classTokenToCss(str) {
  const out = { color: null, background: null, backdropBlur: null, backdropSat: null, boxShadow: null, before: {} };
  for (const raw of str.split(/\s+/).filter(Boolean)) {
    const isBefore = raw.startsWith("before:");
    const t = isBefore ? raw.slice(7) : raw;
    const decl = utilToDecl(t);
    if (!decl) { console.warn(`[kgRawValueToCss] unknown class fragment: "${t}"`); continue; }
    if (isBefore) { out.before[decl[0]] = decl[1]; continue; }
    if (decl[0] === "background") { out.background = decl[1]; if (/^(oklch|rgb|#)/.test(decl[1])) out.color = decl[1]; }
    else if (decl[0] === "__blur") out.backdropBlur = decl[1];
    else if (decl[0] === "__sat") out.backdropSat = decl[1];
    else if (decl[0] === "box-shadow") out.boxShadow = decl[1];
    // structural (border-0 / position:relative) are applied by the slot rule.
  }
  return out;
}

// Dispatcher → normalized descriptor the assembly consumes.
function kgRawValueToCss(path, rawValue) {
  const v = String(rawValue).trim();
  if (v[0] === "{") {
    const o = JSON.parse(v);
    if (o.type === "paint") {
      const grad = o.layers.find((L) => L.kind === "gradient");
      const value = paintToCss(o.layers);
      const mid = grad
        ? grad.stops.slice().sort((a, b) => Math.abs(a.position - 50) - Math.abs(b.position - 50))[0].color
        : null;
      return { type: "paint", value, gradient: grad ? value : null, mid };
    }
    if (o.type === "shadow") return { type: "shadow", value: shadowToCss(o.layers) };
  }
  if (/(^|\s)(bg-\[|backdrop-|shadow-\[|relative|border-0|before:)/.test(v))
    return { type: "surface", ...classTokenToCss(v) };
  return { type: "plain", value: v };
}

/* ── VERBATIM KG rawValues (Payment Glass Pro color + VNPAY Merchant brand).
   {d}=dark (index0), {l}=light (index1); a bare string = same in both schemes.
   Reskin to another brand = re-pull that composition's layers and swap here. ── */
const KG = {
  background: {
    d: "bg-[radial-gradient(ellipse_60%_50%_at_18%_12%,oklch(0.55_0.21_275_/_0.32)_0%,oklch(0.55_0.21_275_/_0)_100%),radial-gradient(ellipse_55%_45%_at_82%_88%,oklch(0.62_0.19_152_/_0.18)_0%,oklch(0.62_0.19_152_/_0)_100%),radial-gradient(ellipse_40%_35%_at_92%_8%,oklch(0.70_0.16_220_/_0.14)_0%,oklch(0.70_0.16_220_/_0)_100%),oklch(0.08_0.025_270)] backdrop-saturate-[120%]",
    l: "bg-[radial-gradient(ellipse_60%_50%_at_16%_14%,oklch(0.55_0.21_275_/_0.14)_0%,oklch(0.55_0.21_275_/_0)_100%),radial-gradient(ellipse_55%_45%_at_84%_86%,oklch(0.78_0.10_220_/_0.10)_0%,oklch(0.78_0.10_220_/_0)_100%),radial-gradient(ellipse_40%_35%_at_94%_10%,oklch(0.85_0.08_60_/_0.10)_0%,oklch(0.85_0.08_60_/_0)_100%),oklch(0.99_0.005_270)] backdrop-saturate-[120%]",
  },
  foreground: { d: "oklch(0.96 0.012 250)", l: "oklch(0.16 0.024 270)" },
  card: {
    d: "bg-[oklch(0.16_0.045_268_/_0.30)] backdrop-blur-[28px] backdrop-saturate-[180%] border-0 shadow-[inset_0px_1px_0px_0px_oklch(1_0_0_/_0.16),_0px_2px_6px_-3px_oklch(0_0_0_/_0.30),_0px_20px_46px_-24px_oklch(0_0_0_/_0.28)] relative before:content-[''] before:absolute before:inset-0 before:rounded-[inherit] before:p-px before:pointer-events-none before:bg-[linear-gradient(135deg,_oklch(1_0_0_/_0.48)_0%,_oklch(1_0_0_/_0.16)_12%,_oklch(0.80_0.006_260_/_0.10)_34%,_oklch(0.72_0.006_260_/_0.08)_50%,_oklch(0.80_0.006_260_/_0.10)_66%,_oklch(1_0_0_/_0.14)_88%,_oklch(1_0_0_/_0.42)_100%)] before:[mask:linear-gradient(#fff_0_0)_content-box,linear-gradient(#fff_0_0)] before:[mask-composite:exclude]",
    l: "bg-[oklch(1_0_0_/_0.38)] backdrop-blur-[28px] backdrop-saturate-[180%] border-0 shadow-[inset_0px_1px_0px_0px_oklch(1_0_0_/_0.88),_inset_0px_-1px_0px_0px_oklch(1_0_0_/_0.32),_0px_2px_6px_-3px_oklch(0.26_0.010_260_/_0.10),_0px_18px_42px_-26px_oklch(0.22_0.012_260_/_0.12)] relative before:content-[''] before:absolute before:inset-0 before:rounded-[inherit] before:p-px before:pointer-events-none before:bg-[linear-gradient(135deg,_oklch(1_0_0_/_0.78)_0%,_oklch(1_0_0_/_0.22)_12%,_oklch(0.72_0.006_260_/_0.16)_34%,_oklch(0.64_0.006_260_/_0.12)_50%,_oklch(0.72_0.006_260_/_0.16)_66%,_oklch(1_0_0_/_0.20)_88%,_oklch(1_0_0_/_0.68)_100%)] before:[mask:linear-gradient(#fff_0_0)_content-box,linear-gradient(#fff_0_0)] before:[mask-composite:exclude]",
  },
  "card-foreground": { d: "oklch(0.96 0.012 250)", l: "oklch(0.16 0.024 270)" },
  popover: {
    d: "bg-[oklch(0.20_0.050_270_/_0.80)] backdrop-blur-[24px] backdrop-saturate-[180%] border-0 shadow-[inset_0px_1px_0px_0px_oklch(1_0_0_/_0.18),_0px_3px_8px_-4px_oklch(0_0_0_/_0.34),_0px_26px_58px_-30px_oklch(0_0_0_/_0.32)] relative before:content-[''] before:absolute before:inset-0 before:rounded-[inherit] before:p-px before:pointer-events-none before:bg-[linear-gradient(135deg,_oklch(1_0_0_/_0.56)_0%,_oklch(1_0_0_/_0.18)_12%,_oklch(0.80_0.006_260_/_0.11)_34%,_oklch(0.72_0.006_260_/_0.09)_50%,_oklch(0.80_0.006_260_/_0.11)_66%,_oklch(1_0_0_/_0.16)_88%,_oklch(1_0_0_/_0.50)_100%)] before:[mask:linear-gradient(#fff_0_0)_content-box,linear-gradient(#fff_0_0)] before:[mask-composite:exclude]",
    l: "bg-[oklch(1_0_0_/_0.80)] backdrop-blur-[24px] backdrop-saturate-[180%] border-0 shadow-[inset_0px_1px_0px_0px_oklch(1_0_0_/_0.90),_inset_0px_-1px_0px_0px_oklch(1_0_0_/_0.34),_0px_3px_8px_-4px_oklch(0.26_0.010_260_/_0.12),_0px_22px_50px_-30px_oklch(0.22_0.012_260_/_0.14)] relative before:content-[''] before:absolute before:inset-0 before:rounded-[inherit] before:p-px before:pointer-events-none before:bg-[linear-gradient(135deg,_oklch(1_0_0_/_0.84)_0%,_oklch(1_0_0_/_0.24)_12%,_oklch(0.72_0.006_260_/_0.18)_34%,_oklch(0.64_0.006_260_/_0.14)_50%,_oklch(0.72_0.006_260_/_0.18)_66%,_oklch(1_0_0_/_0.22)_88%,_oklch(1_0_0_/_0.74)_100%)] before:[mask:linear-gradient(#fff_0_0)_content-box,linear-gradient(#fff_0_0)] before:[mask-composite:exclude]",
  },
  "popover-foreground": { d: "oklch(0.96 0.012 250)", l: "oklch(0.16 0.024 270)" },
  secondary: {
    d: '{"type":"paint","layers":[{"kind":"solid","color":"oklch(0.20 0.050 270 / 0.62)"}]}',
    l: '{"type":"paint","layers":[{"kind":"solid","color":"oklch(0.89 0.050 255 / 0.72)"}]}',
  },
  "secondary-foreground": { d: "oklch(0.96 0.012 250)", l: "oklch(0.16 0.024 270)" },
  muted: { d: "bg-[oklch(0.18_0.040_270_/_0.26)]", l: "bg-[oklch(0.94_0.014_270_/_0.55)]" },
  "muted-foreground": { d: "oklch(0.72 0.025 252)", l: "oklch(0.46 0.022 270)" },
  destructive: '{"type":"paint","layers":[{"kind":"solid","color":"oklch(0.58 0.20 25)"}]}',
  "destructive-foreground": "oklch(0.98 0.01 25)",
  success: '{"type":"paint","layers":[{"kind":"solid","color":"oklch(0.62 0.18 152)"}]}',
  "success-foreground": { d: "oklch(0.10 0.05 152)", l: "oklch(0.99 0.02 152)" },
  warning: '{"type":"paint","layers":[{"kind":"solid","color":"oklch(0.78 0.18 70)"}]}',
  "warning-foreground": { d: "oklch(0.18 0.10 70)", l: "oklch(0.22 0.10 70)" },
  info: {
    d: '{"type":"paint","layers":[{"kind":"solid","color":"oklch(0.62 0.21 275)"}]}',
    l: '{"type":"paint","layers":[{"kind":"solid","color":"oklch(0.55 0.21 275)"}]}',
  },
  "info-foreground": { d: "oklch(0.10 0.05 275)", l: "oklch(0.99 0.02 275)" },
  border: { d: "oklch(0.95 0.040 260 / 0.14)", l: "oklch(0.55 0.030 270 / 0.18)" },
  input: { d: "oklch(1 0 0 / 0.09)", l: "oklch(1 0 0 / 0.34)" },
  "input-border": { d: "oklch(1 0 0 / 0.28)", l: "oklch(0.72 0.004 250 / 0.34)" },
  ring: { d: "oklch(0.46 0.18 258 / 0.42)", l: "oklch(0.46 0.18 258 / 0.32)" }, // VNPAY Merchant
  // ── VNPAY Merchant brand ──
  primary: '{"type":"paint","layers":[{"kind":"gradient","angle":135,"stops":[{"color":"oklch(0.46 0.18 258)","position":0},{"color":"oklch(0.55 0.21 275)","position":52},{"color":"oklch(0.66 0.19 240)","position":100}]}]}',
  "primary-hover": '{"type":"paint","layers":[{"kind":"gradient","angle":135,"stops":[{"color":"oklch(0.66 0.19 240)","position":0},{"color":"oklch(0.55 0.21 275)","position":48},{"color":"oklch(0.46 0.18 258)","position":100}]}]}',
  "primary-foreground": "oklch(0.99 0.01 0)",
  accent: "oklch(0.55 0.22 25)",
  "accent-foreground": "oklch(0.99 0.01 0)",
};

const pick = (tok, s) => (typeof tok === "string" ? tok : tok[s]);

// Value bound to `--<path>` for a given scheme ('d' | 'l').
function tokenValue(path, scheme) {
  const r = kgRawValueToCss(path, pick(KG[path], scheme));
  if (r.type === "plain") return r.value;
  if (r.type === "paint") return r.mid || r.value; // gradient → mid-stop solid; solid → color
  if (r.type === "surface") return r.color || r.background; // card → color; bg → mesh
  return r.value;
}
// Glass pieces from a surface class-token (card / popover).
function glass(path, scheme) {
  const r = kgRawValueToCss(path, pick(KG[path], scheme));
  const b = r.before || {};
  return { blur: r.backdropBlur, sat: r.backdropSat, boxShadow: r.boxShadow, hairline: b.background, mask: b.mask, maskComposite: b["mask-composite"] };
}

const COLOR_TOKENS = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "secondary", "secondary-foreground", "muted", "muted-foreground",
  "destructive", "destructive-foreground", "success", "success-foreground",
  "warning", "warning-foreground", "info", "info-foreground",
  "border", "input", "input-border", "ring",
];
const colorVars = (s) => COLOR_TOKENS.map((p) => `  --${p}: ${tokenValue(p, s)};`).join("\n");

// Primary brand gradient (verbatim from KG paint), + reversed hover variant.
const PRIMARY_MID = kgRawValueToCss("primary", KG.primary).mid;
const PRIMARY_GRADIENT = kgRawValueToCss("primary", KG.primary).gradient;
const PRIMARY_GRADIENT_HOVER = kgRawValueToCss("primary-hover", KG["primary-hover"]).gradient;

const cardG = { d: glass("card", "d"), l: glass("card", "l") };
const popG = { d: glass("popover", "d"), l: glass("popover", "l") };
const maskDecls = (g) =>
  `-webkit-mask: ${g.mask}; -webkit-mask-composite: xor; mask: ${g.mask}; mask-composite: ${g.maskComposite};`;

const POPOVER_SLOTS = [
  '[data-slot="popover-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="sheet-content"]',
  '[data-slot="drawer-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="select-content"]',
  '[data-slot="hover-card-content"]',
  '[data-slot="tooltip-content"]',
].join(",\n");

const brandCss = `
/* ============================================================= *
 *  VNPAY Glass — full composition override (KG rawValue → CSS)
 * ============================================================= */
:root, html.dark {
${typoVars}

  --font-sans: ${INTER};
  --font-display: ${BRICOLAGE};
  --font-mono: ${JBMONO};

  /* Rounded layer (full scale) */
  --radius: 16px;
  --radius-xs: 10px;  --radius-sm: 12px;  --radius-md: 16px;
  --radius-lg: 20px;  --radius-xl: 24px;  --radius-2xl: 28px;
  --radius-3xl: 36px; --radius-4xl: 44px;
  --radius-card: 28px; --radius-control: 16px; --radius-input: 16px;
  --radius-panel: 24px; --radius-pill: 999px; --radius-full: 999px;

  /* Large controls layer */
  --control-h-default: 48px; --control-h-sm: 40px; --control-h-lg: 52px; --control-h-xs: 36px;
  --control-size-default: 48px; --control-size-sm: 40px; --control-size-lg: 52px; --control-size-xs: 36px;
  --control-px-default: 20px; --control-px-sm: 16px; --control-px-xs: 14px;
  --input-height: 48px;
  /* switch.tsx reads these directly (h-[var(--switch-track-h)] etc.) */
  --switch-track-w: 44px; --switch-track-h: 24px; --switch-thumb: 22px;
  --selection-indicator-size: 24px;   /* checkbox / radio (Large controls) */

  /* VNPAY Merchant brand (resolved from KG paint) */
  --primary: ${PRIMARY_MID};
  --primary-foreground: ${tokenValue("primary-foreground", "d")};
  --primary-gradient: ${PRIMARY_GRADIENT};
  --primary-gradient-hover: ${PRIMARY_GRADIENT_HOVER};
  --accent: ${tokenValue("accent", "d")};
  --accent-foreground: ${tokenValue("accent-foreground", "d")};
}

/* ── LIGHT scheme (default) ─────────────────────────────────── */
:root {
  color-scheme: light;
${colorVars("l")}
  --glass-card-shadow: ${cardG.l.boxShadow};
  --glass-card-hairline: ${cardG.l.hairline};
  --glass-pop-shadow: ${popG.l.boxShadow};
  --glass-pop-hairline: ${popG.l.hairline};
}

/* ── DARK scheme ────────────────────────────────────────────── */
html.dark {
  color-scheme: dark;
${colorVars("d")}
  --glass-card-shadow: ${cardG.d.boxShadow};
  --glass-card-hairline: ${cardG.d.hairline};
  --glass-pop-shadow: ${popG.d.boxShadow};
  --glass-pop-hairline: ${popG.d.hairline};
}

/* ── Brand gradient on the primary surface ──────────────────── */
.bg-primary { background-image: var(--primary-gradient) !important; }
[data-slot="button"][data-variant="default"]:hover { background-image: var(--primary-gradient-hover) !important; }

/* ── Glass: real Payment Glass Pro card treatment (KG-resolved) ─ */
[data-slot="card"] {
  backdrop-filter: blur(${cardG.d.blur}) saturate(${cardG.d.sat});
  -webkit-backdrop-filter: blur(${cardG.d.blur}) saturate(${cardG.d.sat});
  box-shadow: var(--glass-card-shadow);
  border: 0 !important;
  position: relative;
}
[data-slot="card"]::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  padding: 1px; pointer-events: none; background: var(--glass-card-hairline); ${maskDecls(cardG.d)}
}

/* ── Glass: popover / overlay family ────────────────────────── */
${POPOVER_SLOTS} {
  background-color: var(--popover) !important;
  backdrop-filter: blur(${popG.d.blur}) saturate(${popG.d.sat});
  -webkit-backdrop-filter: blur(${popG.d.blur}) saturate(${popG.d.sat});
  box-shadow: var(--glass-pop-shadow);
  border: 0 !important;
  position: relative;
}
${POPOVER_SLOTS.split(",\n").map((s) => `${s}::before`).join(",\n")} {
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  padding: 1px; pointer-events: none; background: var(--glass-pop-hairline); ${maskDecls(popG.d)}
}
/* keep menu/select items above the hairline pseudo */
[data-slot="dropdown-menu-item"], [data-slot="select-item"],
[data-slot="dialog-header"], [data-slot="sheet-header"] { position: relative; z-index: 1; }

/* ── Large controls: bind KG control sizing to the real controls ─ */
[data-slot="button"] { border-radius: var(--radius-control); }
[data-slot="button"]:not([data-size^="icon"]) { height: var(--control-h-default); padding-inline: var(--control-px-default); }
[data-slot="button"][data-size="sm"] { height: var(--control-h-sm); padding-inline: var(--control-px-sm); }
[data-slot="button"][data-size="lg"] { height: var(--control-h-lg); }
[data-slot="button"][data-size="xs"] { height: var(--control-h-xs); padding-inline: var(--control-px-xs); }
[data-slot="button"][data-size="icon"] { height: var(--control-size-default); width: var(--control-size-default); }
[data-slot="button"][data-size="icon-sm"] { height: var(--control-size-sm); width: var(--control-size-sm); }
[data-slot="button"][data-size="icon-lg"] { height: var(--control-size-lg); width: var(--control-size-lg); }
[data-slot="button"][data-size="icon-xs"] { height: var(--control-size-xs); width: var(--control-size-xs); }
[data-slot="input"], [data-slot="select-trigger"] { height: var(--input-height); border-radius: var(--radius-input); }
/* InputGroup is a wrapper (data-slot="input-group") whose inner control is
   "input-group-control", NOT "input" — size the wrapper so all three input
   demos share the Large-controls height. min-height keeps the textarea/block
   variants (which switch to h-auto) able to grow. */
[data-slot="input-group"] { min-height: var(--input-height); border-radius: var(--radius-input); }
/* textarea stays multi-line (component default min-h-16 = 64px); only radius. */
[data-slot="textarea"] { border-radius: var(--radius-input); }

/* Toggle is button-like → match Large-controls height. toggle-group-item gets
   height only (the group owns the segmented start/end radius). */
[data-slot="toggle"] { height: var(--control-h-default); min-width: var(--control-h-default); border-radius: var(--radius-control); }
[data-slot="toggle-group-item"] { height: var(--control-h-default); min-width: var(--control-h-default); }

/* OTP slots align to the control square size. */
[data-slot="input-otp-slot"] { width: var(--control-size-default); height: var(--control-size-default); }

/* Tabs is a segmented control — KG "Large controls" has no tab-specific token,
   so reuse the small control size (40px / px-sm) instead of leaving it at the
   component default 32px, which looked undersized next to the 48px controls.
   Give the track a frosted inset and the active thumb the glass-popover surface
   with primary-tinted text, so the active tab reads as an elevated frosted chip
   instead of the default opaque bg-background pill (which renders near-black on
   the dark mesh and looked broken). Token-driven — no hand-picked colors. */
[data-slot="tabs-list"] {
  height: var(--control-h-sm); padding: 4px; border-radius: var(--radius-control);
  background-color: var(--muted) !important;
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
}
[data-slot="tabs-trigger"] {
  padding-inline: var(--control-px-sm);
  border-radius: calc(var(--radius-control) - 5px);
  color: var(--muted-foreground);
  transition: color .18s ease, background-color .18s ease;
}
[data-slot="tabs-trigger"][data-state="active"] {
  background: var(--popover) !important;
  color: var(--primary) !important;
  box-shadow: var(--glass-pop-shadow);
  font-weight: 600;
}

/* Selection controls — KG selection-indicator-size (24px), inner marks scaled. */
[data-slot="checkbox"], [data-slot="radio-group-item"] { width: var(--selection-indicator-size); height: var(--selection-indicator-size); }
[data-slot="checkbox-indicator"] > svg { width: 1rem; height: 1rem; }
[data-slot="radio-group-indicator"] > span { width: 0.625rem; height: 0.625rem; }

html, body, #root { height: 100%; }
body {
  margin: 0; overflow: auto;
  background: var(--background) fixed;
  color: var(--foreground);
  font-family: var(--font-sans);
}
`;

const html = `<!doctype html>
<html lang="vi" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>VNPAY Glass — react-shadcn Component Showcase</title>

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Bricolage+Grotesque:wght@500;600;650;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />

  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>

  <style type="text/tailwindcss">
${theme}
  </style>

  <!-- VNPAY Glass full-composition override (KG rawValue → CSS). -->
  <style>
${brandCss}
  </style>

  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>

  <script>
/*__OD_COMPONENT_BUNDLE_START__*/
${bundle}
/*__OD_COMPONENT_BUNDLE_END__*/
  </script>

  <script type="text/babel" data-presets="react">
${block}
  </script>
</body>
</html>
`;

writeFileSync(resolve(assets, "showcase.html"), html);
console.log("[make-showcase] assets/showcase.html written:", html.length, "bytes");

// Also emit the brand override as a STANDALONE, reusable stylesheet so any
// branded artifact (showcase OR a shell.html screen) can include it verbatim.
// Single source for the audited VNPAY Glass token + control + glass mapping
// (see references/kg-brand-binding.md). Pair it AFTER theme.css so :root wins.
const glassCss = `/* AUTO-GENERATED by builder/make-showcase.mjs — do not hand-edit.
 * Full "VNPAY Glass" composition resolved VERBATIM from the sm-mcp Knowledge
 * Graph (rawValue → CSS via kgRawValueToCss). Include AFTER theme.css.
 * Reskin to another brand = swap the KG rawValues and regenerate.
 */
${brandCss}`;
writeFileSync(resolve(assets, "vnpay-glass.css"), glassCss);
console.log("[make-showcase] assets/vnpay-glass.css written:", glassCss.length, "bytes");
