import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Driver } from "neo4j-driver";
import type { KgConfig } from "./config.js";
import { withSession } from "./neo4j.js";
import { kgRawValueToCss, type SurfaceCss } from "./kg-css.js";
import { loadCompositionLayers } from "./styles.js";

/**
 * Composition → standalone dual-scheme stylesheet (the vnpay-glass.css shape):
 * resolve every layer's token values from the LOCAL graph in USES_THEME order
 * (later layers override per path+scheme), convert rawValues via the ported
 * kgRawValueToCss resolver, and assemble :root (light) + html.dark blocks plus
 * the audited [data-slot] control/glass bindings from
 * skills/react-shadcn/references/kg-brand-binding.md.
 * Include AFTER theme.css — drop-in replacement for assets/vnpay-glass.css.
 */

export type Scheme = "dark" | "light";
export interface MergedValue { dark?: string; light?: string }

export interface CollectedComposition {
  name: string;
  liveLayers: Array<{ themeId: string; order: number; kind: string | null; name: string | null; cloned: boolean }>;
  /** path → rawValue per scheme; later layers already override earlier ones. */
  merged: Map<string, MergedValue>;
  warnings: string[];
}

/** Shared collect step: resolve a composition's layers in USES_THEME order and
 * merge every layer's token values per path+scheme. Used by both the CSS
 * exporter and ui_tokens_get. */
export async function collectCompositionValues(
  driver: Driver,
  config: KgConfig,
  compositionId: string,
): Promise<CollectedComposition> {
  const warnings: string[] = [];
  const warn = (msg: string) => { if (!warnings.includes(msg)) warnings.push(msg); };

  const loaded = await loadCompositionLayers(driver, compositionId);
  if (!loaded) throw new Error(`composition "${compositionId}" not found (id or exact name)`);
  const liveLayers = loaded.layers.filter((l) => l.exists);
  if (liveLayers.length === 0) throw new Error(`composition "${loaded.name}" has no resolvable layers — run ui_composition_lint`);
  for (const l of loaded.layers.filter((x) => !x.exists)) {
    warn(`layer order=${l.order} theme "${l.themeId}" missing — skipped`);
  }

  const merged = new Map<string, MergedValue>();
  await withSession(driver, async (session) => {
    for (const layer of liveLayers) {
      if (layer.kind === "icon") continue; // icon layer carries no CSS
      const res = await session.run(
        `MATCH (v:UI_TOKEN_VALUE {themeId: $themeId})
         OPTIONAL MATCH (v)-[:IN_MODE]->(m:UI_MODE)
         RETURN v.targetPath AS path, v.rawValue AS raw,
                coalesce(v.scheme, toLower(m.name)) AS scheme`,
        { themeId: layer.themeId },
      );
      for (const record of res.records) {
        const path = String(record.get("path"));
        if (path.startsWith("type.") || path.startsWith("asset.")) continue; // meta tokens, not CSS
        const raw = String(record.get("raw"));
        const scheme = record.get("scheme") as Scheme | null;
        const entry = merged.get(path) ?? {};
        if (scheme === "dark" || scheme === null) entry.dark = raw;
        if (scheme === "light" || scheme === null) entry.light = raw;
        merged.set(path, entry);
      }
    }
  });
  if (merged.size === 0) throw new Error(`composition "${loaded.name}" resolves to zero token values`);
  return { name: loaded.name, liveLayers, merged, warnings };
}

const COLOR_TOKENS = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "secondary", "secondary-foreground", "muted", "muted-foreground",
  "destructive", "destructive-foreground", "success", "success-foreground",
  "warning", "warning-foreground", "info", "info-foreground",
  "border", "input", "input-border", "ring",
  "primary", "primary-foreground", "accent", "accent-foreground", "accent-muted",
  "primary-soft", "primary-softer", "border-focus",
];

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

export interface ExportCssResult {
  file: string;
  bytes: number;
  paths: number;
  warnings: string[];
  /** The emitted stylesheet text (vars-only payload when varsOnly=true). */
  css: string;
}

export interface ExportCssOptions {
  outFile?: string;
  /** Emit ONLY the value blocks (:root light + html.dark vars, including
   * --glass-* and --primary-gradient). No structural [data-slot] rules — those
   * live permanently in the shell with var-fallbacks. This is the brand.css /
   * <style id="brand"> payload an agent fills into an artifact. */
  varsOnly?: boolean;
}

export async function exportCompositionCss(
  driver: Driver,
  config: KgConfig,
  compositionId: string,
  options: ExportCssOptions = {},
): Promise<ExportCssResult> {
  const { outFile, varsOnly = false } = options;
  const collected = await collectCompositionValues(driver, config, compositionId);
  const { liveLayers, merged, warnings } = collected;
  const loaded = { name: collected.name };
  const warn = (msg: string) => { if (!warnings.includes(msg)) warnings.push(msg); };

  // ── bucket + resolve ──────────────────────────────────────────────────────
  const shared: string[] = [];            // vars identical in both schemes
  const perScheme: Record<Scheme, string[]> = { dark: [], light: [] };
  const surfaces = new Map<string, { dark?: SurfaceCss; light?: SurfaceCss }>();
  let primaryGradient: { value: string; mid: string } | null = null;
  let primaryHoverGradient: string | null = null;

  const emitVar = (name: string, value: MergedValue) => {
    if (value.dark !== undefined && value.dark === value.light) shared.push(`  --${name}: ${value.dark};`);
    else {
      if (value.light !== undefined) perScheme.light.push(`  --${name}: ${value.light};`);
      if (value.dark !== undefined) perScheme.dark.push(`  --${name}: ${value.dark};`);
    }
  };

  for (const [path, value] of merged) {
    // Typography JSON → --text-<name>-* vars (scheme-agnostic).
    const sample = value.dark ?? value.light ?? "";
    const resolvedSample = kgRawValueToCss(sample, warn);
    if (resolvedSample.type === "typography" && path.startsWith("text-")) {
      const t = resolvedSample;
      const decls: string[] = [];
      if (t.family) decls.push(`--${path}-family: ${t.family};`);
      if (t.size) decls.push(`--${path}-size: ${t.size};`);
      if (t.lineHeight) decls.push(`--${path}-line-height: ${t.lineHeight};`);
      if (t.weight !== undefined) decls.push(`--${path}-weight: ${t.weight};`);
      if (t.tracking) decls.push(`--${path}-tracking: ${t.tracking};`);
      shared.push("  " + decls.join(" "));
      continue;
    }

    const out: MergedValue = {};
    for (const scheme of ["dark", "light"] as const) {
      const raw = value[scheme];
      if (raw === undefined) continue;
      const r = kgRawValueToCss(raw, warn);
      if (r.type === "plain" || r.type === "shadow") out[scheme] = r.value;
      else if (r.type === "paint") {
        out[scheme] = r.mid ?? r.value; // gradient → mid-stop solid for the color var
        if (r.gradient && path === "primary") primaryGradient = { value: r.gradient, mid: r.mid ?? r.value };
        else if (r.gradient && path === "primary-hover") primaryHoverGradient = r.gradient;
        else if (r.gradient) shared.push(`  --${path}-gradient: ${r.gradient};`);
      } else if (r.type === "surface") {
        const entry = surfaces.get(path) ?? {};
        entry[scheme] = r;
        surfaces.set(path, entry);
        out[scheme] = r.color ?? r.background ?? undefined;
      }
    }
    if (out.dark !== undefined || out.light !== undefined) emitVar(path, out);
  }

  // Audited aliases: KG path names → vars the components/static block read.
  const alias = (from: string, to: string) => {
    const v = merged.get(from);
    if (!v) return;
    const resolved: MergedValue = {};
    for (const scheme of ["dark", "light"] as const) {
      if (v[scheme] === undefined) continue;
      const r = kgRawValueToCss(v[scheme], warn);
      resolved[scheme] = r.type === "plain" ? r.value : undefined;
    }
    if (resolved.dark !== undefined || resolved.light !== undefined) emitVar(to, resolved);
  };
  alias("radius-md", "radius");
  alias("switch-thumb-size", "switch-thumb");

  if (primaryGradient) {
    shared.push(`  --primary-gradient: ${primaryGradient.value};`);
    if (primaryHoverGradient) shared.push(`  --primary-gradient-hover: ${primaryHoverGradient};`);
  }

  // ── glass surface helpers (card / popover) ───────────────────────────────
  // blur/sat are emitted as vars too so the shell's permanent structural rules
  // (backdrop-filter: blur(var(--glass-card-blur, 0px)) …) can consume them.
  const glassVars = (scheme: Scheme): string[] => {
    const lines: string[] = [];
    const card = surfaces.get("card")?.[scheme];
    const pop = surfaces.get("popover")?.[scheme];
    if (card?.backdropBlur) lines.push(`  --glass-card-blur: ${card.backdropBlur};`);
    if (card?.backdropSat) lines.push(`  --glass-card-sat: ${card.backdropSat};`);
    if (card?.boxShadow) lines.push(`  --glass-card-shadow: ${card.boxShadow};`);
    if (card?.before.background) lines.push(`  --glass-card-hairline: ${card.before.background};`);
    if (card?.before["mask"]) lines.push(`  --glass-card-mask: ${card.before["mask"]};`);
    if (pop?.backdropBlur) lines.push(`  --glass-pop-blur: ${pop.backdropBlur};`);
    if (pop?.backdropSat) lines.push(`  --glass-pop-sat: ${pop.backdropSat};`);
    if (pop?.boxShadow) lines.push(`  --glass-pop-shadow: ${pop.boxShadow};`);
    if (pop?.before.background) lines.push(`  --glass-pop-hairline: ${pop.before.background};`);
    if (pop?.before["mask"]) lines.push(`  --glass-pop-mask: ${pop.before["mask"]};`);
    // Glass surfaces drop the component border (the hairline ::before replaces
    // it); flat compositions keep the shell fallback of 1px.
    if (pop) lines.push("  --glass-pop-border-width: 0px;");
    return lines;
  };
  const anySurface = (path: string): SurfaceCss | undefined => surfaces.get(path)?.dark ?? surfaces.get(path)?.light;
  const cardS = anySurface("card");
  const popS = anySurface("popover");
  const maskDecls = (s: SurfaceCss): string => {
    const mask = s.before["mask"];
    const composite = s.before["mask-composite"] ?? "exclude";
    return mask ? `-webkit-mask: ${mask}; -webkit-mask-composite: xor; mask: ${mask}; mask-composite: ${composite};` : "";
  };

  const hasControls = merged.has("control-h-default") || merged.has("control-height");

  // ── assemble ──────────────────────────────────────────────────────────────
  const header = `/* AUTO-GENERATED by tools-kg (ui_composition_export_css${varsOnly ? ", vars-only" : ""}) — do not hand-edit.
 * Composition "${loaded.name}" resolved VERBATIM from the LOCAL UI knowledge
 * graph (bolt ${config.boltUri}) via the kg-css resolver. Include AFTER theme.css.
 * Layers (by order): ${liveLayers.map((l) => `${l.order}:${l.name ?? l.themeId}${l.cloned ? "" : " [agent]"}`).join(" · ")}
 */`;
  const valueBlocks = `:root, html.dark {
${shared.join("\n")}
}

/* ── LIGHT scheme (default) ─────────────────────────────────── */
:root {
  color-scheme: light;
${perScheme.light.join("\n")}
${glassVars("light").join("\n")}
}

/* ── DARK scheme ────────────────────────────────────────────── */
html.dark {
  color-scheme: dark;
${perScheme.dark.join("\n")}
${glassVars("dark").join("\n")}
}
`;

  const css = varsOnly ? `${header}
${valueBlocks}` : `${header}
${valueBlocks}${primaryGradient ? `
/* ── Brand gradient on the primary surface ──────────────────── */
.bg-primary { background-image: var(--primary-gradient) !important; }
${primaryHoverGradient ? `[data-slot="button"][data-variant="default"]:hover { background-image: var(--primary-gradient-hover) !important; }` : ""}
` : ""}${cardS?.backdropBlur ? `
/* ── Glass: card treatment (KG-resolved) ────────────────────── */
[data-slot="card"] {
  backdrop-filter: blur(${cardS.backdropBlur}) saturate(${cardS.backdropSat ?? "100%"});
  -webkit-backdrop-filter: blur(${cardS.backdropBlur}) saturate(${cardS.backdropSat ?? "100%"});
  box-shadow: var(--glass-card-shadow);
  border: 0 !important;
  position: relative;
}
[data-slot="card"]::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  padding: 1px; pointer-events: none; background: var(--glass-card-hairline); ${maskDecls(cardS)}
}
` : ""}${popS?.backdropBlur ? `
/* ── Glass: popover / overlay family ────────────────────────── */
${POPOVER_SLOTS} {
  background-color: var(--popover) !important;
  backdrop-filter: blur(${popS.backdropBlur}) saturate(${popS.backdropSat ?? "100%"});
  -webkit-backdrop-filter: blur(${popS.backdropBlur}) saturate(${popS.backdropSat ?? "100%"});
  box-shadow: var(--glass-pop-shadow);
  border: 0 !important;
  position: relative;
}
${POPOVER_SLOTS.split(",\n").map((s) => `${s}::before`).join(",\n")} {
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  padding: 1px; pointer-events: none; background: var(--glass-pop-hairline); ${maskDecls(popS)}
}
[data-slot="dropdown-menu-item"], [data-slot="select-item"],
[data-slot="dialog-header"], [data-slot="sheet-header"] { position: relative; z-index: 1; }
` : ""}${hasControls ? `
/* ── Control sizing: bind KG control tokens to the real controls ─ */
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
[data-slot="input-group"] { min-height: var(--input-height); border-radius: var(--radius-input); }
[data-slot="textarea"] { border-radius: var(--radius-input); }
[data-slot="toggle"] { height: var(--control-h-default); min-width: var(--control-h-default); border-radius: var(--radius-control); }
[data-slot="toggle-group-item"] { height: var(--control-h-default); min-width: var(--control-h-default); }
[data-slot="input-otp-slot"] { width: var(--control-size-default); height: var(--control-size-default); }
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
[data-slot="checkbox"], [data-slot="radio-group-item"] { width: var(--selection-indicator-size); height: var(--selection-indicator-size); }
[data-slot="checkbox-indicator"] > svg { width: 1rem; height: 1rem; }
[data-slot="radio-group-indicator"] > span { width: 0.625rem; height: 0.625rem; }
` : ""}
html, body, #root { height: 100%; }
body {
  margin: 0; overflow: auto;
  background: var(--background) fixed;
  color: var(--foreground);
  font-family: var(--font-sans);
}
`;

  const slug = String(loaded.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const file = outFile ?? resolve(config.exportDir, "_css", `${slug}.css`);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, css);
  return { file, bytes: css.length, paths: merged.size, warnings, css };
}
