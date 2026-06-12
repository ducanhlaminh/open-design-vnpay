// text-layout: (string, style, fontSize) → derivedTextData + glyph blobs.
// Figma renders pasted TEXT ONLY from derivedTextData (per-glyph commandsBlob = vector
// outline). Blobs are em-normalized / size-independent, so we reuse Figma's own harvested
// outlines and synthesise new text by recomputing advances/positions. Basic word-wrap.
import { readAssetJSON } from "./assets.js";

interface GlyphEntry {
  advance: number;
  blob: string; // base64 outline bytes
}

interface AtlasStyle {
  fontMetaData: unknown;
}

export interface Atlas {
  styles: Record<string, AtlasStyle>;
  chars: Record<string, Record<string, GlyphEntry>>;
}

interface Baseline {
  position: { x: number; y: number };
  width: number;
  lineY: number;
  lineHeight: number;
  lineAscent: number;
  firstCharacter: number;
  endCharacter: number;
}

interface Glyph {
  commandsBlob: number;
  position: { x: number; y: number };
  fontSize: number;
  firstCharacter: number;
  advance: number;
  rotation: number;
}

export interface DerivedTextData {
  layoutSize: { x: number; y: number };
  baselines: Baseline[];
  glyphs: Glyph[];
  fontMetaData: unknown;
  truncationStartIndex: number;
  truncatedHeight: number;
  logicalIndexToCharacterOffsetMap: number[];
  derivedLines: unknown[];
}

export interface LayoutResult {
  derivedTextData: DerivedTextData;
  glyphBlobs: Uint8Array[];
  warnings: string[];
  layoutSize: { x: number; y: number };
}

let cachedAtlas: Atlas | null = null;
export function loadAtlas(): Atlas {
  if (!cachedAtlas) cachedAtlas = readAssetJSON<Atlas>("glyph-atlas.json");
  return cachedAtlas;
}

const b64ToU8 = (b: string): Uint8Array => new Uint8Array(Buffer.from(b, "base64"));

// fontMetaData is serialised with { __u8: base64 } stand-ins for Uint8Array fields.
function restoreFontMeta(style: string, atlas: Atlas): unknown {
  const fm = atlas.styles?.[style]?.fontMetaData;
  if (fm == null) return null;
  return JSON.parse(JSON.stringify(fm), (_k, v) =>
    v && typeof v === "object" && "__u8" in v ? b64ToU8((v as { __u8: string }).__u8) : v,
  );
}

function fontLineHeightRatio(style: string, atlas: Atlas): number {
  const fm = atlas.styles?.[style]?.fontMetaData as Array<{ fontLineHeight?: number }> | undefined;
  return fm?.[0]?.fontLineHeight ?? 1.2102;
}

const SPACE_ADV = 0.25; // em fallback when atlas lacks " "

export interface LayoutArgs {
  text: string;
  style?: string;
  fontSize?: number;
  maxWidth?: number;
  atlas?: Atlas;
}

export function layoutText({
  text,
  style = "Regular",
  fontSize = 16,
  maxWidth = Infinity,
  atlas = loadAtlas(),
}: LayoutArgs): LayoutResult {
  const chars = [...text];
  const lineHeight = fontLineHeightRatio(style, atlas) * fontSize;
  const ascent = 0.9583 * fontSize; // baseline ratio (46/48 from a real node)

  const advOf = (ch: string): number | null => {
    if (ch === " ") return atlas.chars[" "]?.[style]?.advance ?? SPACE_ADV;
    return atlas.chars[ch]?.[style]?.advance ?? null;
  };

  const warnings = new Set<string>();
  const glyphBlobs: Uint8Array[] = [];
  const blobIndex = new Map<string, number>();
  const useBlob = (b64: string): number => {
    let idx = blobIndex.get(b64);
    if (idx === undefined) {
      idx = glyphBlobs.length;
      blobIndex.set(b64, idx);
      glyphBlobs.push(b64ToU8(b64));
    }
    return idx;
  };

  const glyphs: Glyph[] = [];
  const baselines: Baseline[] = [];
  let line = 0;
  let x = 0;
  let lineStart = 0;
  let maxLineW = 0;

  const newline = (endIdx: number): void => {
    baselines.push({
      position: { x: 0, y: ascent + line * lineHeight },
      width: x,
      lineY: 0,
      lineHeight,
      lineAscent: ascent,
      firstCharacter: lineStart,
      endCharacter: endIdx,
    });
    maxLineW = Math.max(maxLineW, x);
    line++;
    x = 0;
    lineStart = endIdx;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const entry = ch !== " " ? atlas.chars[ch]?.[style] : undefined;
    const adv = advOf(ch);
    if (adv == null) {
      warnings.add(ch); // glyph outside atlas → drop + warn
      continue;
    }
    if (x + adv * fontSize > maxWidth && x > 0 && ch === " ") {
      newline(i + 1);
      continue;
    }
    if (entry) {
      glyphs.push({
        commandsBlob: useBlob(entry.blob),
        position: { x, y: ascent + line * lineHeight },
        fontSize,
        firstCharacter: i,
        advance: entry.advance,
        rotation: 0,
      });
    }
    x += adv * fontSize;
  }
  newline(chars.length);

  const derivedTextData: DerivedTextData = {
    layoutSize: { x: Math.round(maxLineW), y: Math.round(line * lineHeight) },
    baselines,
    glyphs,
    fontMetaData: restoreFontMeta(style, atlas),
    truncationStartIndex: -1,
    truncatedHeight: line * lineHeight,
    logicalIndexToCharacterOffsetMap: [],
    derivedLines: [],
  };
  return { derivedTextData, glyphBlobs, warnings: [...warnings], layoutSize: derivedTextData.layoutSize };
}
