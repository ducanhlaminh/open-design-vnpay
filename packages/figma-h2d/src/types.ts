// @open-design/figma-h2d — H2D ("HTML to Design") document schema.
// Clean-room from specs/current/h2d-serializer-spec.md. The JSON shape Figma's paste handler
// reads from the (figh2d) clipboard blob; Figma builds editable nodes from it on paste.

export interface Point {
  x: number;
  y: number;
}

export interface Quad {
  p1: Point;
  p2: Point;
  p3: Point;
  p4: Point;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Present only when the element's local transform is non-axis-aligned (skew/rotate). */
  quad?: Quad;
}

export const NODE_TYPE = { ELEMENT: 1, TEXT: 3 } as const;

export interface H2DTextNode {
  nodeType: 3;
  id: string;
  text: string;
  rect: Rect;
  lineCount: number;
}

export interface H2DElementNode {
  nodeType: 1;
  id: string;
  tag: string;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  rect: Rect;
  childNodes: H2DNode[];
  /** SVG: baked outerHTML. */
  content?: string;
  /** <canvas>: rasterized asset key. */
  placeholderUrl?: string;
  pseudoElementNodes?: { before?: H2DElementNode; after?: H2DElementNode };
  pseudoElementStyles?: { placeholder?: Record<string, string> };
  /** Specified (pre-resolution) values for sizing/grid props, via CSS Typed OM. */
  computedStyles?: Record<string, string>;
}

export type H2DNode = H2DElementNode | H2DTextNode;

export interface FontUsage {
  fontWeight: string;
  fontStyle: string;
  fontStretch: string;
  fontSize: string;
  metrics?: { fontBoundingBoxAscent: number; fontBoundingBoxDescent: number };
}

export interface FontFamily {
  familyName: string;
  faces: unknown[];
  usages: FontUsage[];
}

/** In-memory asset (before serialize): blob is a Blob; after serialize it becomes a data URL. */
export interface AssetEntry {
  url: string;
  blob: Blob | null;
  error?: string;
}

export interface SerializedAsset {
  url: string;
  blob: string | null; // data URL
  error?: string;
}

export interface H2DDocument {
  root: H2DElementNode;
  documentTitle?: string;
  documentRect: Rect;
  viewportRect: Rect;
  devicePixelRatio: number;
  version: 2;
  /** Live capture holds Blobs; serializeDocument() converts to data URLs. */
  assets: Map<string, AssetEntry> | Record<string, SerializedAsset>;
  fonts: Record<string, FontFamily>;
}

export interface CaptureOptions {
  /** Throw if the document has zero layout (default true). */
  assertLayoutValid?: boolean;
  /** Don't fetch cross-origin assets; emit a null-blob placeholder (default false). */
  skipRemoteAssetSerialization?: boolean;
  /** Max time for the recursive walk before aborting (ms, default 10000). */
  timeoutSignal?: AbortSignal;
}

export interface ClipboardMeta {
  dataType: "h2d";
  source: string;
  capturedAtIso: string;
  h2d: { v: 1; origin: { source: string; capturedAtIso: string } };
}
