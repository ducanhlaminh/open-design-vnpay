import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Component slug whitelist for lint. Parsed LIVE from the react-shadcn skill's
 * render block (skills/react-shadcn/builder/app-shell-block.jsx) so the
 * renderer stays the single source of truth — no duplicated list here.
 * Fail-open: when the file is missing or the parse breaks, lint skips the
 * unknown-component rule with an explicit warning instead of false-positives.
 */

const APP_SHELL_BLOCK = "skills/react-shadcn/builder/app-shell-block.jsx";

/** Specials wired outside PRIMITIVE_SLUGS in the render block. */
const SPECIAL_SLUGS = ["asset", "form", "div", "span", "p", "ul", "li", "img"];

/** Verbatim from design-v3 / app-shell-block.jsx: PascalCase -> kebab-case. */
export function componentCatalogSlug(component: string): string {
  return String(component)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

let cached: Set<string> | null | undefined;

export function loadWhitelist(repoRoot: string): Set<string> | null {
  if (cached !== undefined) return cached;
  try {
    const src = readFileSync(resolve(repoRoot, APP_SHELL_BLOCK), "utf8");
    const m = src.match(/const PRIMITIVE_SLUGS = \[([\s\S]*?)\];/);
    if (!m) throw new Error("PRIMITIVE_SLUGS array not found");
    const slugs = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    if (slugs.length < 40) throw new Error(`implausibly small whitelist (${slugs.length})`);
    cached = new Set([...slugs, ...SPECIAL_SLUGS]);
  } catch (error) {
    console.error(`[tools-kg] WARN cannot load component whitelist from ${APP_SHELL_BLOCK}: ${String(error)} — unknown-component lint skipped`);
    cached = null;
  }
  return cached;
}

export function slugResolves(whitelist: Set<string>, slug: string): boolean {
  return whitelist.has(slug) || whitelist.has(componentCatalogSlug(slug));
}
