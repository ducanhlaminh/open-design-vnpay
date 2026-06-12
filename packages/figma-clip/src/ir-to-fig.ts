// ir-to-fig: IR (figma-skill IR-SCHEMA) → Figma Kiwi message → clipboard HTML.
// Frame: stack/fills(solid+gradient)/radius/stroke/effects/image. Text: via glyph-atlas
// (text-layout). Vector: skipped (warn). Uses the pinned scaffold (no live reference file).
import { createHash } from "node:crypto";

import { writeClip } from "./figclip.js";
import { getScaffold } from "./scaffold.js";
import { type SubPath, parsePath } from "./svg-path.js";
import { type Atlas, layoutText, loadAtlas } from "./text-layout.js";
import { WINDING, buildVectorNetwork, encodeVectorNetwork } from "./vecnet.js";
import type {
  Color,
  ColorToken,
  GradientFill,
  IRNode,
  IRToClipOptions,
  IRToClipResult,
  ImagePayload,
  VectorPath,
} from "./types.js";

type FigNode = Record<string, unknown>;
type Guid = { sessionID: number; localID: number };

const SYNTH_SESSION = 70000;
const PASTE_ID = 909090;

const xf = (x = 0, y = 0) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const col = (c: Color) => ({ r: c.r, g: c.g, b: c.b, a: c.a == null ? 1 : c.a });
const solidPaint = (c: Color): FigNode => ({
  type: "SOLID",
  color: col(c),
  opacity: c.a == null ? 1 : c.a,
  visible: true,
  blendMode: "NORMAL",
});

const GRAD_TYPE: Record<string, string> = {
  linear: "GRADIENT_LINEAR",
  radial: "GRADIENT_RADIAL",
  angular: "GRADIENT_ANGULAR",
};

function gradientPaint(f: GradientFill): FigNode {
  const t = f.transform ?? [
    [1, 0, 0],
    [0, 1, 0],
  ];
  return {
    type: GRAD_TYPE[f.kind ?? "linear"] ?? "GRADIENT_LINEAR",
    stops: (f.stops ?? []).map((s) => ({
      color: col(s.color ?? { r: 0, g: 0, b: 0, a: 1 }),
      position: clamp01(s.pos == null ? 0 : s.pos),
    })),
    transform: { m00: t[0]![0], m01: t[0]![1], m02: t[0]![2], m10: t[1]![0], m11: t[1]![1], m12: t[1]![2] },
    opacity: 1,
    visible: true,
    blendMode: "NORMAL",
  };
}

const JUSTIFY: Record<string, string> = {
  start: "MIN",
  center: "CENTER",
  end: "MAX",
  "space-between": "SPACE_EVENLY",
};
const ALIGN: Record<string, string> = { start: "MIN", center: "CENTER", end: "MAX", stretch: "MIN" };
const SCALE_MODE: Record<string, string> = { FILL: "FILL", FIT: "FIT", TILE: "TILE", STRETCH: "STRETCH" };

// atlas currently carries Regular + Bold
const weightToStyle = (w: number): string => (w >= 600 ? "Bold" : "Regular");

// Apply an SVG CTM [a,b,c,d,e,f] to every point of the parsed subpaths (bakes group transforms).
function applyCTM(subs: SubPath[], m: number[]): SubPath[] {
  const tp = (p: { x: number; y: number }) => ({ x: m[0]! * p.x + m[2]! * p.y + m[4]!, y: m[1]! * p.x + m[3]! * p.y + m[5]! });
  return subs.map((sp) => ({ closed: sp.closed, cmds: sp.cmds.map((c) => ({ t: c.t, p: c.p.map(tp) })) }));
}

function applyRadius(node: FigNode, radius: number[] | undefined): void {
  if (radius && radius.some((v) => v > 0)) {
    node.rectangleTopLeftCornerRadius = radius[0] ?? 0;
    node.rectangleTopRightCornerRadius = radius[1] ?? 0;
    node.rectangleBottomRightCornerRadius = radius[2] ?? 0;
    node.rectangleBottomLeftCornerRadius = radius[3] ?? 0;
    node.rectangleCornerRadiiIndependent = true;
  }
}

export function irToClip(ir: IRNode, opts: IRToClipOptions = {}): IRToClipResult {
  const fontSizeFallback = opts.fontSizeFallback ?? 16;
  const scaffold = getScaffold();
  const atlas: Atlas = loadAtlas();

  let nextId = 1;
  const guid = (): Guid => ({ sessionID: SYNTH_SESSION, localID: nextId++ });
  const POS = (i: number): string => String.fromCharCode(33 + i); // '!','"','#',...
  const nodeChanges: FigNode[] = [scaffold.document, scaffold.canvas];
  const blobs: Array<{ bytes: Uint8Array }> = [];
  const warnings: string[] = [];

  // ---- Figma Variables from :root color tokens -------------------------------
  // Each unique solid-color token becomes one COLOR variable in a single-mode "VNPAY"
  // collection (under an internal-only canvas, exactly as Figma serialises local variables).
  // Solid fills/strokes/text whose colour matches a token bind to it via paint.colorVar.
  // Cross-file paste (synthetic fileKey, set below) is what makes Figma CREATE the variables;
  // a fileKey matching the open file would make Figma look for pre-existing keys and drop ours.
  const VAR_VERSION = `${SYNTH_SESSION}:0`;
  const colorKeyOf = (c: Color): string => `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  const varKeyByColor = new Map<string, string>();
  const hex = (s: string, len: number): string => createHash("sha512").update(s).digest("hex").slice(0, len);
  // Prefer the most "semantic" token name when several share a colour: drop gradient-stop names,
  // then shortest, then first declared.
  const betterName = (a: string, b: string): boolean => {
    const ga = /grad/i.test(a), gb = /grad/i.test(b);
    if (ga !== gb) return gb; // a is better if b is a gradient-stop name
    return a.length < b.length;
  };
  let hasVariables = false;

  function buildVariables(tokens: ColorToken[] | undefined): void {
    if (!tokens?.length) return;
    const byColor = new Map<string, { name: string; color: Color }>();
    for (const t of tokens) {
      if (!t?.color) continue;
      const ck = colorKeyOf(t.color);
      const name = (t.name || "color").replace(/^--/, "");
      const cur = byColor.get(ck);
      if (!cur || betterName(name, cur.name)) byColor.set(ck, { name, color: t.color });
    }
    if (!byColor.size) return;
    hasVariables = true;

    const internal: FigNode = {
      guid: { sessionID: 20_000_000 + SYNTH_SESSION, localID: 2 },
      phase: "CREATED",
      parentIndex: { guid: scaffold.document.guid, position: "z" },
      type: "CANVAS",
      name: "Internal Only Canvas",
      visible: false,
      opacity: 1,
      transform: xf(),
      backgroundOpacity: 1,
      backgroundEnabled: true,
      internalOnly: true,
    };
    const modeGuid = guid();
    const setKey = hex("figclip:collection:VNPAY", 40);
    const srcLib = `lk-${hex("figclip:srclib", 128)}`;
    const setGuid = guid();
    const set: FigNode = {
      guid: setGuid,
      phase: "CREATED",
      parentIndex: { guid: internal.guid, position: "!" },
      type: "VARIABLE_SET",
      name: "VNPAY",
      isPublishable: false,
      key: setKey,
      version: VAR_VERSION,
      userFacingVersion: VAR_VERSION,
      sourceLibraryKey: srcLib,
      publishID: setGuid,
      visible: false,
      locked: true,
      variableSetModes: [{ id: modeGuid, name: "Mode 1", sortPosition: "!" }],
      isCollectionExtendable: true,
    };
    const varNodes: FigNode[] = [];
    let i = 0;
    for (const { name, color } of byColor.values()) {
      const vKey = hex(`figclip:var:${name}:${colorKeyOf(color)}`, 40);
      const vGuid = guid();
      const pos = POS(i++);
      varNodes.push({
        guid: vGuid,
        phase: "CREATED",
        parentIndex: { guid: internal.guid, position: pos },
        type: "VARIABLE",
        name,
        isPublishable: false,
        key: vKey,
        version: VAR_VERSION,
        userFacingVersion: VAR_VERSION,
        sortPosition: pos,
        sourceLibraryKey: srcLib,
        publishID: vGuid,
        visible: false,
        locked: true,
        variableSetID: { assetRef: { key: setKey, version: VAR_VERSION } },
        variableResolvedType: "COLOR",
        variableDataValues: {
          entries: [
            {
              modeID: modeGuid,
              variableData: { value: { colorValue: col(color) }, dataType: "COLOR", resolvedDataType: "COLOR" },
            },
          ],
        },
      });
      varKeyByColor.set(colorKeyOf(color), vKey);
    }
    nodeChanges.push(internal, set, ...varNodes);
  }

  // Attach a variable alias to a solid paint when its colour matches a token. Returns the paint.
  function bindColor(paint: FigNode, color: Color | undefined): FigNode {
    if (color) {
      const key = varKeyByColor.get(colorKeyOf(color));
      if (key) {
        paint.colorVar = {
          value: { alias: { assetRef: { key, version: VAR_VERSION } } },
          dataType: "ALIAS",
          resolvedDataType: "COLOR",
        };
      }
    }
    return paint;
  }
  const boundSolid = (c: Color): FigNode => bindColor(solidPaint(c), c);

  // IR image {data(base64), format, scaleMode} → IMAGE paint. bytes → blob; hash = SHA-1 (20
  // byte) of the bytes (NOT md5 16 byte — Figma rejects a 16-byte hash and drops the image).
  function imagePaint(img: ImagePayload | undefined): FigNode | null {
    if (!img?.data) return null;
    const bytes = new Uint8Array(Buffer.from(img.data, "base64"));
    const hash = new Uint8Array(createHash("sha1").update(bytes).digest());
    const dataBlob = blobs.length;
    blobs.push({ bytes });
    return {
      type: "IMAGE",
      imageScaleMode: SCALE_MODE[img.scaleMode ?? "FILL"] ?? "FILL",
      image: { hash, dataBlob },
      opacity: 1,
      visible: true,
      blendMode: "NORMAL",
    };
  }

  function applyAbsolute(node: FigNode, irNode: IRNode): void {
    if (!irNode.absolute) return;
    node.stackPositioning = "ABSOLUTE";
    node.transform = xf(irNode.absolute.x, irNode.absolute.y);
  }

  // child sizing relative to parent: fill → grow on main axis / stretch on cross axis
  function applyChildSizing(node: FigNode, irNode: IRNode, parentMode: string): void {
    const sz = irNode.layout?.sizing ?? {};
    const horizontal = parentMode === "horizontal";
    const fillMain = horizontal ? sz.w === "fill" : sz.h === "fill";
    const fillCross = horizontal ? sz.h === "fill" : sz.w === "fill";
    if (fillMain) node.stackChildPrimaryGrow = 1;
    if (fillCross) node.stackChildAlignSelf = "STRETCH";
  }

  function frameNode(irNode: IRNode, parentGuid: Guid, posIdx: number): FigNode {
    const L = irNode.layout ?? {};
    const mode = L.mode === "horizontal" ? "HORIZONTAL" : "VERTICAL";
    const pad = L.padding ?? [0, 0, 0, 0];
    const sz = L.sizing ?? { w: "hug", h: "hug" };
    const n: FigNode = {
      guid: guid(),
      phase: "CREATED",
      parentIndex: { guid: parentGuid, position: POS(posIdx) },
      type: "FRAME",
      name: irNode.name ?? "Frame",
      visible: true,
      opacity: 1,
      size: { x: L.width ?? 100, y: L.height ?? 100 },
      transform: xf(),
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      strokeJoin: "MITER",
      frameMaskDisabled: true,
      stackMode: mode,
      stackSpacing: L.gap ?? 0,
      stackHorizontalPadding: pad[3] ?? 0,
      stackVerticalPadding: pad[0] ?? 0,
      stackPaddingRight: pad[1] ?? 0,
      stackPaddingBottom: pad[2] ?? 0,
      stackPrimaryAlignItems: JUSTIFY[L.justify ?? "start"] ?? "MIN",
      stackCounterAlignItems: ALIGN[L.align ?? "start"] ?? "MIN",
    };
    const mainHug = mode === "HORIZONTAL" ? sz.w === "hug" : sz.h === "hug";
    const crossHug = mode === "HORIZONTAL" ? sz.h === "hug" : sz.w === "hug";
    n.stackPrimarySizing = mainHug ? "RESIZE_TO_FIT" : "FIXED";
    n.stackCounterSizing = crossHug ? "RESIZE_TO_FIT" : "FIXED";

    const fills: FigNode[] = [];
    for (const f of irNode.style?.fills ?? []) {
      if (f.type === "solid" && f.color) fills.push(boundSolid(f.color));
      else if (f.type === "gradient" && f.stops?.length) fills.push(gradientPaint(f));
    }
    if (irNode.image) {
      const ip = imagePaint(irNode.image);
      if (ip) fills.push(ip);
    }
    if (fills.length) n.fillPaints = fills;

    applyRadius(n, irNode.style?.radius);
    const stroke = irNode.style?.stroke;
    if (stroke?.color) {
      n.strokePaints = [boundSolid(stroke.color)];
      n.strokeWeight = stroke.width ?? 1;
    }

    const eff: FigNode[] = [];
    for (const e of irNode.style?.effects ?? []) {
      if (e.type === "shadow") {
        eff.push({
          type: e.inset ? "INNER_SHADOW" : "DROP_SHADOW",
          color: col(e.color),
          offset: { x: e.x ?? 0, y: e.y ?? 0 },
          radius: e.blur ?? 0,
          spread: e.spread ?? 0,
          visible: true,
          blendMode: "NORMAL",
        });
      } else if (e.type === "background-blur") {
        eff.push({ type: "BACKGROUND_BLUR", radius: e.radius ?? 0, visible: true });
      } else if (e.type === "layer-blur") {
        eff.push({ type: "FOREGROUND_BLUR", radius: e.radius ?? 0, visible: true });
      }
    }
    if (eff.length) n.effects = eff;

    applyAbsolute(n, irNode);
    return n;
  }

  function textNode(irNode: IRNode, parentGuid: Guid, posIdx: number): FigNode {
    const t = irNode.text ?? {};
    const style = weightToStyle(t.weight ?? 400);
    const { derivedTextData, glyphBlobs, warnings: w } = layoutText({
      text: t.content ?? "",
      style,
      fontSize: t.size ?? fontSizeFallback,
      maxWidth: irNode.width ?? Infinity,
      atlas,
    });
    if (w.length) {
      warnings.push(`text "${(t.content ?? "").slice(0, 16)}…": thiếu glyph ${JSON.stringify(w.join(""))} (${style})`);
    }
    // relocate glyph blob indices to the global blob table
    const base = blobs.length;
    for (const b of glyphBlobs) blobs.push({ bytes: b });
    for (const g of derivedTextData.glyphs) g.commandsBlob += base;

    const n: FigNode = {
      guid: guid(),
      phase: "CREATED",
      parentIndex: { guid: parentGuid, position: POS(posIdx) },
      type: "TEXT",
      name: irNode.name ?? "Text",
      visible: true,
      opacity: 1,
      size: { x: derivedTextData.layoutSize.x || 1, y: derivedTextData.layoutSize.y || 1 },
      transform: xf(),
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      strokeJoin: "MITER",
      fontSize: t.size ?? fontSizeFallback,
      textAlignVertical: "TOP",
      textAutoResize: irNode.width ? "HEIGHT" : "WIDTH_AND_HEIGHT",
      lineHeight: { value: 100, units: "PERCENT" },
      fontName: { family: "Inter", style, postscript: "" },
      fillPaints: [t.color ? boundSolid(t.color) : solidPaint({ r: 0.1, g: 0.1, b: 0.12, a: 1 })],
      textData: {
        characters: t.content ?? "",
        lines: [
          {
            lineType: "PLAIN",
            styleId: 0,
            indentationLevel: 0,
            sourceDirectionality: "AUTO",
            listStartOffset: 0,
            isFirstLineOfList: false,
          },
        ],
      },
      derivedTextData,
      textUserLayoutVersion: 5,
      textExplicitLayoutVersion: 1,
      textBidiVersion: 1,
    };
    applyAbsolute(n, irNode);
    return n;
  }

  // <img> → FRAME with IMAGE fill, fixed size, clipped
  function imageNode(irNode: IRNode, parentGuid: Guid, posIdx: number): FigNode {
    const ip = imagePaint(irNode.image);
    const n: FigNode = {
      guid: guid(),
      phase: "CREATED",
      parentIndex: { guid: parentGuid, position: POS(posIdx) },
      type: "FRAME",
      name: irNode.name ?? "Image",
      visible: true,
      opacity: 1,
      size: { x: irNode._w ?? 100, y: irNode._h ?? 100 },
      transform: xf(),
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      strokeJoin: "MITER",
      frameMaskDisabled: true,
      clipsContent: true,
      stackPrimarySizing: "FIXED",
      stackCounterSizing: "FIXED",
      fillPaints: [ip ?? solidPaint({ r: 0.85, g: 0.85, b: 0.87, a: 1 })],
    };
    if (!ip) warnings.push(`ảnh "${n.name as string}" tải lỗi → placeholder xám`);
    applyRadius(n, irNode.style?.radius);
    applyAbsolute(n, irNode);
    return n;
  }

  interface VecGeom {
    vx: number;
    vy: number;
    sx: number;
    sy: number;
    w: number;
    h: number;
  }

  // One SVG <path>/primitive → one editable VECTOR node (true vector, crisp at any zoom).
  function vectorNode(path: VectorPath, parentGuid: Guid, posIdx: number, g: VecGeom): FigNode | null {
    const sub = parsePath(path.d || "");
    if (!sub.length) return null;
    const filled = !!path.fill;
    const stroked = !!path.stroke && (path.strokeWidth ?? 0) > 0;
    if (!filled && !stroked) return null; // fill:none + stroke:none → nothing to draw
    const transformed = path.ctm && path.ctm.length === 6 ? applyCTM(sub, path.ctm) : sub;
    const vn = buildVectorNetwork(transformed, {
      offsetX: -g.vx,
      offsetY: -g.vy,
      scaleX: g.sx,
      scaleY: g.sy,
      filled,
      winding: WINDING[path.fillRule ?? "nonzero"] ?? WINDING.nonzero,
    });
    const blobIdx = blobs.length;
    blobs.push({ bytes: encodeVectorNetwork(vn) });
    const n: FigNode = {
      guid: guid(),
      phase: "CREATED",
      parentIndex: { guid: parentGuid, position: POS(posIdx) },
      type: "VECTOR",
      name: "path",
      visible: true,
      opacity: 1,
      size: { x: g.w, y: g.h },
      transform: xf(),
      strokeWeight: stroked ? (path.strokeWidth ?? 1) * g.sx : 0,
      strokeAlign: "CENTER",
      strokeJoin: "ROUND",
      strokeCap: "ROUND",
      vectorData: { vectorNetworkBlob: blobIdx, normalizedSize: { x: g.w, y: g.h } },
    };
    if (filled && path.fill) n.fillPaints = [solidPaint(path.fill)];
    if (stroked && path.stroke) n.strokePaints = [solidPaint(path.stroke)];
    return n;
  }

  // inline <svg> → FRAME (icon container, fixed _w×_h) holding one VECTOR per drawable path.
  function vectorFrameNode(irNode: IRNode, parentGuid: Guid, posIdx: number, parentMode: string): void {
    const w = irNode._w ?? 24;
    const h = irNode._h ?? 24;
    const vb = irNode.viewBox && irNode.viewBox.length === 4 ? irNode.viewBox : [0, 0, w, h];
    const [vx, vy, vw, vh] = vb as [number, number, number, number];
    const g: VecGeom = { vx, vy, sx: w / (vw || 1), sy: h / (vh || 1), w, h };
    const frame: FigNode = {
      guid: guid(),
      phase: "CREATED",
      parentIndex: { guid: parentGuid, position: POS(posIdx) },
      type: "FRAME",
      name: irNode.name ?? "Icon",
      visible: true,
      opacity: 1,
      size: { x: w, y: h },
      transform: xf(),
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      strokeJoin: "MITER",
      frameMaskDisabled: true,
      clipsContent: false,
      stackPrimarySizing: "FIXED",
      stackCounterSizing: "FIXED",
    };
    applyChildSizing(frame, irNode, parentMode);
    applyAbsolute(frame, irNode);
    nodeChanges.push(frame);
    let pi = 0;
    let drawn = 0;
    for (const path of irNode.paths ?? []) {
      const node = vectorNode(path, frame.guid as Guid, pi, g);
      if (node) {
        nodeChanges.push(node);
        pi++;
        drawn++;
      }
    }
    if (!drawn) warnings.push(`icon "${irNode.name ?? "?"}" không có path vẽ được`);
  }

  function walk(irNode: IRNode, parentGuid: Guid, posIdx: number, parentMode: string): void {
    if (irNode.type === "text") {
      nodeChanges.push(textNode(irNode, parentGuid, posIdx));
      return;
    }
    if (irNode.type === "vector") {
      if (irNode.paths?.length) {
        vectorFrameNode(irNode, parentGuid, posIdx, parentMode);
      } else if (irNode.image) {
        // rasterized fallback (extractor couldn't produce vector paths)
        const n = imageNode(irNode, parentGuid, posIdx);
        applyChildSizing(n, irNode, parentMode);
        nodeChanges.push(n);
      } else {
        warnings.push(`vector bỏ qua ở "${irNode.name ?? "?"}" (không có paths)`);
      }
      return;
    }
    if (irNode.type === "image") {
      const n = imageNode(irNode, parentGuid, posIdx);
      applyChildSizing(n, irNode, parentMode);
      nodeChanges.push(n);
      return;
    }
    const n = frameNode(irNode, parentGuid, posIdx);
    applyChildSizing(n, irNode, parentMode);
    nodeChanges.push(n);
    for (const [i, child] of (irNode.children ?? []).entries()) {
      walk(child, n.guid as Guid, i, irNode.layout?.mode ?? "vertical");
    }
  }

  buildVariables(ir.tokens);
  walk(ir, scaffold.canvas.guid as Guid, 0, "vertical");

  // When we synthesise variables, the payload must look like a CROSS-file paste so Figma creates
  // them (a fileKey equal to the open file → "same file" → Figma expects our keys to pre-exist and
  // silently drops the bindings). The pinned scaffold's fileKey is a real file, so override both
  // the figmeta fileKey and message.pasteFileKey with a synthetic key that can't match any file.
  const SYNTH_FILE_KEY = "ODFigmaClip0000000001";
  const message: Record<string, unknown> = { ...scaffold.message, pasteID: PASTE_ID, blobs, nodeChanges };
  const meta: Record<string, unknown> = { ...scaffold.meta, pasteID: PASTE_ID };
  if (hasVariables) {
    meta.fileKey = SYNTH_FILE_KEY;
    message.pasteFileKey = SYNTH_FILE_KEY;
  }
  const html = writeClip({
    meta,
    schema: scaffold.schema,
    compiled: scaffold.compiled,
    message,
  });
  return { html, warnings };
}
