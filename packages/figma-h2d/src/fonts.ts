// Clean-room font collector. See specs/current/h2d-serializer-spec.md §4.text / §5.
// Detects which font families are actually available (canvas width probe), records the
// (stretch, style, weight, size) usages seen, and measures line-box heights used to constrain
// text boxes under transforms.

import type { Realm } from "./realm.js";
import type { FontFamily } from "./types.js";

/** font-stretch percentage -> CSS keyword Chromium accepts in `ctx.font`. */
function stretchKeyword(stretch: string): string {
  if (!stretch.endsWith("%")) return stretch.toLowerCase();
  const pct = parseFloat(stretch);
  if (isNaN(pct)) return "normal";
  if (pct <= 50) return "ultra-condensed";
  if (pct <= 62.5) return "extra-condensed";
  if (pct <= 75) return "condensed";
  if (pct <= 87.5) return "semi-condensed";
  if (pct <= 100) return "normal";
  if (pct <= 112.5) return "semi-expanded";
  if (pct <= 125) return "expanded";
  if (pct <= 150) return "extra-expanded";
  return "ultra-expanded";
}

// CSS generic / system font keywords. These are NOT real font faces — the
// browser resolves them to an OS font (e.g. `system-ui` → San Francisco on
// macOS), so a canvas-width probe reports them "available" and they leak into
// the emitted family name. Figma's HTML-to-Design paste then tries to load a
// font literally named "system-ui", fails, and throws
// `Cannot read properties of undefined (reading 'startsWith')`. Skip them so
// the resolver falls through to the next CONCRETE family in the stack (the
// designer's intended fallback, e.g. "Helvetica Neue" / "Arial"), which Figma
// can actually load.
const GENERIC_FONT_KEYWORDS = new Set([
  "system-ui",
  "-apple-system",
  "blinkmacsystemfont",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "unset",
  "revert",
]);

/** Concrete fallback when a font-family stack is ALL generics — Figma-loadable. */
function genericFallbackFamily(families: readonly string[]): string {
  const lower = families.map((f) => f.toLowerCase());
  if (lower.includes("monospace") || lower.includes("ui-monospace")) return "Courier New";
  if (lower.includes("serif") || lower.includes("ui-serif")) return "Times New Roman";
  return "Arial";
}

/** Split a CSS font-family list into individual family names (quotes stripped). */
function parseFamilies(value: string): string[] {
  const out: string[] = [];
  const re = /(?:"([^"]+)"|'([^']+)'|([^,\s][^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const name = (m[1] ?? m[2] ?? m[3])?.trim();
    if (name) out.push(name);
  }
  return out;
}

export interface FontKey {
  fontFamily?: string;
  fontStretch?: string;
  fontStyle?: string;
  fontWeight?: string;
  fontSize?: string;
}

function normalize(styles: FontKey) {
  return {
    family: styles.fontFamily ?? "Times",
    stretch: styles.fontStretch ?? "100%",
    style: styles.fontStyle === "italic" ? "italic" : "normal",
    weight: styles.fontWeight ?? "400",
    size: styles.fontSize ?? "16px",
  };
}

export class FontCollector {
  private families = new Map<string, FontFamily>();
  private processedUsages = new Set<string>();
  private lineBoxHeightCache = new Map<string, number>();
  private unavailable = new Set<string>();
  private _ctx: CanvasRenderingContext2D | null = null;

  constructor(private readonly realm: Realm) {}

  private get ctx(): CanvasRenderingContext2D | null {
    if (!this._ctx) this._ctx = this.realm.doc.createElement("canvas").getContext("2d");
    return this._ctx;
  }

  private isAvailable(
    family: string,
    stretch: string,
    style: string,
    weight: string,
    sample?: string,
  ): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const text = sample ?? "mmmmmmmmmmlli";
    const size = "72px";
    const stretchKw = stretchKeyword(stretch);
    for (const fallback of ["monospace", "sans-serif", "serif"]) {
      ctx.font = `${stretchKw} ${style} ${weight} ${size} ${fallback}`;
      const baseW = ctx.measureText(text).width;
      ctx.font = `${stretchKw} ${style} ${weight} ${size} "${family}", ${fallback}`;
      const withFamily = ctx.measureText(text).width;
      if (baseW !== withFamily) return true;
    }
    return false;
  }

  private measureMetrics(family: string, stretch: string, style: string, weight: string, size: string, sample?: string) {
    const ctx = this.ctx;
    if (!ctx) return undefined;
    const fam = this.families.get(family.toLowerCase());
    if (!fam) return undefined;
    ctx.font = `${stretchKeyword(stretch)} ${style} ${weight} ${size} "${fam.familyName}"`;
    const m = ctx.measureText(sample ?? "Hg");
    return {
      fontBoundingBoxAscent: m.fontBoundingBoxAscent,
      fontBoundingBoxDescent: m.fontBoundingBoxDescent,
    };
  }

  private addUsage(
    familyKey: string,
    stretch: string,
    style: string,
    weight: string,
    size: string,
    originalFamily: string,
    sample?: string,
  ): void {
    const usageKey = `${familyKey}|${stretch}|${style}|${weight}|${size}`;
    if (this.processedUsages.has(usageKey)) return;
    this.processedUsages.add(usageKey);
    const fam = this.families.get(familyKey);
    if (!fam) return;
    const metrics = this.measureMetrics(familyKey, stretch, style, weight, size, sample);
    fam.usages.push({ fontWeight: weight, fontStyle: style, fontStretch: stretch, fontSize: size, metrics });
    if (metrics) {
      const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
      this.lineBoxHeightCache.set(`${originalFamily}|${stretch}|${style}|${weight}|${size}`, height);
    }
  }

  /** Record a usage from a style set; probes availability across the family list. */
  collect(styles: FontKey): void {
    const { family, stretch, style, weight, size } = normalize(styles);
    const families = parseFamilies(family);
    for (const candidate of families) {
      const key = candidate.toLowerCase();
      // Never emit a CSS generic / system keyword as the resolved family —
      // Figma can't load it and crashes on paste. Fall through to the next
      // concrete family in the stack.
      if (GENERIC_FONT_KEYWORDS.has(key)) continue;
      const probeKey = `${key}|${stretch}|${style}|${weight}|latin`;
      if (this.unavailable.has(probeKey)) continue;
      if (this.families.has(key)) {
        this.addUsage(key, stretch, style, weight, size, family);
        return;
      }
      if (!this.isAvailable(candidate, stretch, style, weight)) {
        this.unavailable.add(probeKey);
        continue;
      }
      this.families.set(key, { familyName: candidate, faces: [], usages: [] });
      this.addUsage(key, stretch, style, weight, size, family);
      return;
    }
    // No concrete family in the stack was available (e.g. `font-family:
    // system-ui` alone) — record a Figma-loadable fallback so the text still
    // gets a font instead of nothing.
    const fallback = genericFallbackFamily(families);
    const key = fallback.toLowerCase();
    if (!this.families.has(key)) {
      if (!this.isAvailable(fallback, stretch, style, weight)) return;
      this.families.set(key, { familyName: fallback, faces: [], usages: [] });
    }
    this.addUsage(key, stretch, style, weight, size, family);
  }

  /**
   * Resolve a node's raw CSS `font-family` value to a SINGLE family that is
   * present in `getFonts()` — i.e. a real, Figma-loadable font. Figma's
   * HTML-to-Design paste parses each element's `styles.fontFamily`, maps over
   * the family list and tries to load every entry; a CSS generic / system
   * keyword (`system-ui`, `-apple-system`, `sans-serif`, …) or any family it
   * doesn't have resolves to `undefined` and crashes the paste on
   * `.startsWith`. Emitting only the resolved concrete family avoids that.
   * Returns null when nothing resolves (caller should leave the value as-is).
   */
  emitFamily(value: string | undefined): string | null {
    if (!value) return null;
    const families = parseFamilies(value);
    for (const candidate of families) {
      if (GENERIC_FONT_KEYWORDS.has(candidate.toLowerCase())) continue;
      const fam = this.families.get(candidate.toLowerCase());
      if (fam) return fam.familyName;
    }
    const fallback = this.families.get(genericFallbackFamily(families).toLowerCase());
    return fallback ? fallback.familyName : null;
  }

  /** Line-box height previously measured for a style set, or null. */
  lineBoxHeight(styles: FontKey): number | null {
    const { family, stretch, style, weight, size } = normalize(styles);
    return this.lineBoxHeightCache.get(`${family}|${stretch}|${style}|${weight}|${size}`) ?? null;
  }

  getFonts(): Record<string, FontFamily> {
    return Object.fromEntries(this.families);
  }
}
