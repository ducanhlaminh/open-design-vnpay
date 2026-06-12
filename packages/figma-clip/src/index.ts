// @open-design/figma-clip — turn a figma-skill IR tree into a clipboard payload that pastes
// into Figma as editable Auto Layout nodes, no plugin/MCP. Pure node TS (daemon + skill use it).
export { irToClip } from "./ir-to-fig.js";
export { readClip, writeClip, unescapeHTML, FIG_VERSION } from "./figclip.js";
export { layoutText, loadAtlas } from "./text-layout.js";
export type {
  Atlas,
  DerivedTextData,
  LayoutArgs,
  LayoutResult,
} from "./text-layout.js";
export type {
  FigMessage,
  FigMeta,
  ReadResult,
  WriteClipArgs,
} from "./figclip.js";
export type {
  Color,
  Effect,
  Fill,
  GradientFill,
  IRNode,
  IRToClipOptions,
  IRToClipResult,
  ImagePayload,
  Layout,
  NodeStyle,
  SolidFill,
  TextSpec,
  VectorPath,
} from "./types.js";
export { parsePath } from "./svg-path.js";
export { buildVectorNetwork, encodeVectorNetwork, WINDING } from "./vecnet.js";
