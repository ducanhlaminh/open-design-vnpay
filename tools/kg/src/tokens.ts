import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Driver } from "neo4j-driver";
import type { KgConfig } from "./config.js";
import { kgRawValueToCss } from "./kg-css.js";
import { collectCompositionValues, exportCompositionCss } from "./export-css.js";

/**
 * ui_tokens_get — the agent's creative grounding step. Returns, in ONE call:
 *   • palette: resolved token values per scheme, grouped, with the Tailwind
 *     semantic utilities that exist for each color token (parsed live from the
 *     shell's @theme registration — the single source of the vocabulary)
 *   • cssVars: the vars-only stylesheet payload to fill into the artifact
 *     (door 1: ./brand.css file · door 2: <style id="brand"> slot)
 */

const THEME_CSS = "skills/react-shadcn/assets/runtime/theme.css";

export type TokenGroup = "color" | "radius" | "control" | "typography" | "spacing" | "effect" | "other";

export interface PaletteEntry {
  group: TokenGroup;
  dark?: string;
  light?: string;
  /** linear-gradient(...) when the token is a paint gradient (e.g. primary). */
  gradient?: string;
  /** Tailwind semantic utilities available for this token (registered in @theme). */
  utilities?: string[];
}

export interface CompositionTokens {
  composition: string;
  layers: string[];
  palette: Record<string, PaletteEntry>;
  /** Vars-only stylesheet — write it to <artifact>/brand.css (door 1) or paste
   * into <style id="brand"> (door 2). Also persisted at `file`. */
  cssVars: string;
  file: string;
  warnings: string[];
}

let registeredColors: Set<string> | null | undefined;

/** Color token names registered in the shell's @theme (→ bg-X / text-X exist). */
function loadRegisteredColors(repoRoot: string): Set<string> | null {
  if (registeredColors !== undefined) return registeredColors;
  try {
    const css = readFileSync(resolve(repoRoot, THEME_CSS), "utf8");
    registeredColors = new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    if (registeredColors.size < 30) throw new Error(`implausibly few registrations (${registeredColors.size})`);
  } catch (error) {
    console.error(`[tools-kg] WARN cannot parse @theme registrations from ${THEME_CSS}: ${String(error)}`);
    registeredColors = null;
  }
  return registeredColors;
}

function classifyPath(path: string): TokenGroup {
  if (path.startsWith("radius")) return "radius";
  if (path.startsWith("control") || path.startsWith("switch-") || path === "input-height" || path === "selection-indicator-size" || path === "font-size-control") return "control";
  if (path.startsWith("text-") || path.startsWith("font-")) return "typography";
  if (path.startsWith("space-")) return "spacing";
  if (path.startsWith("blur-") || path.startsWith("glass-") || path.startsWith("shadow")) return "effect";
  if (/^(background|foreground|card|popover|primary|secondary|muted|accent|destructive|success|warning|info|border|input|ring|data-)/.test(path)) return "color";
  return "other";
}

export async function getCompositionTokens(
  driver: Driver,
  config: KgConfig,
  compositionId: string,
): Promise<CompositionTokens> {
  const collected = await collectCompositionValues(driver, config, compositionId);
  const registered = loadRegisteredColors(config.repoRoot);
  const warn = (msg: string) => { if (!collected.warnings.includes(msg)) collected.warnings.push(msg); };

  const palette: Record<string, PaletteEntry> = {};
  for (const [path, value] of collected.merged) {
    const group = classifyPath(path);
    const entry: PaletteEntry = { group };
    for (const scheme of ["dark", "light"] as const) {
      const raw = value[scheme];
      if (raw === undefined) continue;
      const r = kgRawValueToCss(raw, warn);
      if (r.type === "plain" || r.type === "shadow") entry[scheme] = r.value;
      else if (r.type === "paint") {
        entry[scheme] = r.mid ?? r.value;
        if (r.gradient) entry.gradient = r.gradient;
      } else if (r.type === "surface") {
        entry[scheme] = r.color ?? r.background ?? undefined;
      } else if (r.type === "typography") {
        entry[scheme] = [r.family, r.size && `${r.size}/${r.lineHeight ?? "-"}`, r.weight !== undefined && `w${r.weight}`]
          .filter(Boolean).join(" ");
      }
    }
    if (group === "color" && registered?.has(path)) {
      entry.utilities = [`bg-${path}`, `text-${path}`, `border-${path}`, `from-${path}`, `to-${path}`, `ring-${path}`, `bg-${path}/N (tint)`];
    }
    palette[path] = entry;
  }

  // Vars-only payload (also persisted under exportDir/_css/).
  const cssResult = await exportCompositionCss(driver, config, compositionId, { varsOnly: true });
  for (const w of cssResult.warnings) warn(w);

  return {
    composition: collected.name,
    layers: collected.liveLayers.map((l) => `${l.order}:${l.name ?? l.themeId}${l.cloned ? "" : " [agent]"}`),
    palette,
    cssVars: cssResult.css,
    file: cssResult.file,
    warnings: collected.warnings,
  };
}
