// POST /api/figma-clipboard — turn an extracted IR tree (figma-skill IR-SCHEMA) into a Figma
// clipboard payload (text/html with the .fig Kiwi buffer). The IR is extracted client-side
// (web: from the rendered iframe DOM; CLI: via the Playwright extractor) and posted here; the
// daemon runs the pure IR→.fig transform (no browser). See @open-design/figma-clip.

export interface FigmaClipboardRequest {
  /** Extracted IR root node (figma-skill IR-SCHEMA). Opaque to the contract layer. */
  ir: unknown;
  /** Font size used when a text node omits one (defaults to 16). */
  fontSizeFallback?: number;
}

export interface FigmaClipboardStats {
  /** Total scene nodes synthesised (excludes the DOCUMENT/CANVAS scaffold). */
  nodes: number;
  /** Payload size in bytes (the clipboard text/html string). */
  bytes: number;
  /** VECTOR nodes produced from inline SVG icons. */
  vectors: number;
  /** IMAGE paints embedded (raster images + rasterized fallbacks). */
  images: number;
}

export interface FigmaClipboardResponse {
  /** Clipboard-ready `text/html` payload — paste straight into Figma. */
  html: string;
  /** Non-fatal degradations (missing glyphs, dropped/rasterized elements). */
  warnings: string[];
  stats: FigmaClipboardStats;
}
