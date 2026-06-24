// @open-design/figma-h2d — clean-room DOM → Figma "HTML to Design" JSON serializer.
// Browser-only (needs DOM/getComputedStyle/canvas). Produces the (figh2d) clipboard payload that
// pastes into Figma as editable nodes — Figma builds the nodes from this JSON, so we never encode
// a binary .fig (that's the brittle part @open-design/figma-clip owns). See
// specs/current/h2d-serializer-spec.md.

export { captureElement, captureDocument } from "./serialize.js";
export {
  serializeDocument,
  toFigmaClipboardHtml,
  writeFigmaClipboard,
} from "./clipboard.js";
export type { ClipboardPayload, ToClipboardOptions } from "./clipboard.js";
export type {
  AssetEntry,
  CaptureOptions,
  ClipboardMeta,
  FontFamily,
  FontUsage,
  H2DDocument,
  H2DElementNode,
  H2DNode,
  H2DTextNode,
  Quad,
  Rect,
  SerializedAsset,
} from "./types.js";
export { STYLE_DEFAULTS, SVG_PRESENTATION_DEFAULTS } from "./style-defaults.js";
