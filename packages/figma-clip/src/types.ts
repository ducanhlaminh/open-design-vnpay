// Public IR types — the figma-skill IR contract (IR-SCHEMA.md), the single input to irToClip.
// Kept deliberately loose at the leaves: the extractor is the source of truth for shapes.

export interface Color {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface SolidFill {
  type: "solid";
  color: Color;
}

/** Gradient transform is Figma's 2x3 matrix as [[m00,m01,m02],[m10,m11,m12]]. */
export interface GradientFill {
  type: "gradient";
  kind?: "linear" | "radial" | "angular";
  stops: Array<{ pos: number; color: Color }>;
  transform?: number[][];
}

export type Fill = SolidFill | GradientFill;

/** A `:root` design token → Figma Variable. Currently solid colors only. */
export interface ColorToken {
  /** Source CSS custom-property name, e.g. "--primary" (leading "--" optional). */
  name: string;
  color: Color;
}

export interface ShadowEffect {
  type: "shadow";
  x?: number;
  y?: number;
  blur?: number;
  spread?: number;
  color: Color;
  inset?: boolean;
}

export interface BlurEffect {
  type: "background-blur" | "layer-blur";
  radius?: number;
}

export type Effect = ShadowEffect | BlurEffect;

export interface NodeStyle {
  fills?: Fill[];
  /** Corner radii [topLeft, topRight, bottomRight, bottomLeft]. */
  radius?: number[];
  stroke?: { color: Color; width?: number };
  effects?: Effect[];
}

export interface Layout {
  mode?: "horizontal" | "vertical";
  gap?: number;
  /** [top, right, bottom, left]. */
  padding?: number[];
  justify?: "start" | "center" | "end" | "space-between";
  align?: "start" | "center" | "end" | "stretch";
  width?: number;
  height?: number;
  sizing?: { w?: "hug" | "fill" | "fixed"; h?: "hug" | "fill" | "fixed" };
}

/** Raster image payload, base64-encoded bytes plus its scale mode. */
export interface ImagePayload {
  data: string;
  format?: string;
  scaleMode?: "FILL" | "FIT" | "TILE" | "STRETCH";
}

export interface TextSpec {
  content?: string;
  size?: number;
  weight?: number;
  color?: Color;
}

/** One drawable path within an inline-SVG icon, with its resolved paint + CTM. */
export interface VectorPath {
  /** SVG path data (`d`); primitives are converted to a path by the extractor. */
  d: string;
  /** Solid fill, or null for fill:none. */
  fill?: Color | null;
  /** Solid stroke, or null for stroke:none. */
  stroke?: Color | null;
  /** Stroke width in viewBox units. */
  strokeWidth?: number;
  fillRule?: "nonzero" | "evenodd";
  /** Element CTM [a,b,c,d,e,f] mapping local coords → SVG viewBox space (bakes group transforms). */
  ctm?: number[];
}

export interface IRNode {
  type: "frame" | "text" | "image" | "vector";
  name?: string;
  /** Inline-SVG geometry: one entry per drawable element. Renders as editable VECTOR nodes. */
  paths?: VectorPath[];
  /** SVG viewBox [minX, minY, width, height]; defaults to [0,0,_w,_h]. */
  viewBox?: number[];
  style?: NodeStyle;
  layout?: Layout;
  /** Absolute position relative to the nearest positioned ancestor. */
  absolute?: { x: number; y: number };
  /** Root-only: `:root` color tokens, materialised as Figma Variables + bound to matching fills. */
  tokens?: ColorToken[];
  /** Fixed width for a text node (enables word-wrap) or generic node width. */
  width?: number;
  /** Text content + style for a text node. */
  text?: TextSpec;
  /** Background-image (frame) or <img> source, embedded. */
  image?: ImagePayload;
  /** Intrinsic size for <img> nodes. */
  _w?: number;
  _h?: number;
  children?: IRNode[];
  [key: string]: unknown;
}

export interface IRToClipOptions {
  /** Font size used when a text node omits one. */
  fontSizeFallback?: number;
}

export interface IRToClipResult {
  /** Clipboard-ready `text/html` payload (paste straight into Figma). */
  html: string;
  /** Non-fatal degradations (missing glyphs, dropped vectors, failed images). */
  warnings: string[];
}
