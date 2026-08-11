// Clean-room DOM → H2D walk. See specs/current/h2d-serializer-spec.md §2-§6.
// captureElement/captureDocument walk the live DOM inside a requestAnimationFrame (so layout is
// settled), producing the H2D document Figma reads. Element/text/pseudo nodes carry filtered
// styles + transform-aware rects; images/fonts are gathered into side collectors.
//
// Realm-aware: all DOM access goes through `realm` so we can serialize an offscreen same-origin
// <iframe> (the web "Copy to Figma" path) without WrongDocumentError / cross-realm stylesheet
// failures. See realm.ts.

import { FontCollector, type FontKey } from "./fonts.js";
import { ImageCollector } from "./images.js";
import { realmOf, type Realm } from "./realm.js";
import { extractStyles } from "./styles.js";
import { bakeSvgOuterHtml } from "./svg.js";
import { measureText } from "./text-layout.js";
import {
  composeInverse,
  computeLocalMatrix,
  computeRect,
  hasTransform,
  measureSize,
} from "./transform.js";
import { ATTR_ALLOWLIST, PLACEHOLDER_INPUT_TYPES } from "./style-defaults.js";
import { NODE_TYPE, type CaptureOptions, type H2DDocument, type H2DElementNode, type H2DNode } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10000;
const SUPPRESS_BEFORE = "data-h2d-suppress-before";
const SUPPRESS_AFTER = "data-h2d-suppress-after";

interface WalkContext {
  realm: Realm;
  images: ImageCollector;
  fonts: FontCollector;
}

interface ChildContext {
  inverseTransform: DOMMatrix | null;
  styles: Record<string, string>;
}

// --- stable per-node ids (reset each capture) -----------------------------------------------
let idCounter = 0;
let idMap = new WeakMap<Node, string>();
function nodeId(node: Node | null): string {
  if (node !== null) {
    const existing = idMap.get(node);
    if (existing) return existing;
  }
  const id = `h2d-node-${++idCounter}`;
  if (node !== null) idMap.set(node, id);
  return id;
}

function tagName(realm: Realm, el: Element): string | null {
  const tag = el.tagName;
  if (typeof tag === "string") return tag.toUpperCase();
  return el instanceof realm.win.HTMLFormElement ? "FORM" : null;
}

function isSerializable(realm: Realm, el: Element): boolean {
  return !(
    el instanceof realm.win.HTMLScriptElement ||
    (el.nodeType === Node.ELEMENT_NODE && el.getAttribute("data-h2d-ignore") === "true")
  );
}

function pickAttributes(realm: Realm, el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of Array.from(el.attributes)) {
    const lower = name.toLowerCase();
    if (ATTR_ALLOWLIST.has(lower) || lower.startsWith("aria-")) out[name] = value;
  }
  const { win } = realm;
  if (el instanceof win.HTMLVideoElement && el.poster) out.poster = el.poster;
  if ((el instanceof win.HTMLImageElement || el instanceof win.HTMLVideoElement) && el.currentSrc) {
    out.currentSrc = el.currentSrc;
  }
  if (el instanceof win.HTMLInputElement && out.type == null) out.type = el.type;
  return out;
}

// --- design-system component marker ---------------------------------------------------------
// A node carrying `data-slot` is a design-system component. We stamp a marker into the figh2d
// layer-name field (`owningReactComponent`) so a downstream Figma plugin can find the pasted
// frame and swap it for a real component INSTANCE (variant chosen from the data-* attrs) + bind
// tokens. Shape: `kg:<slot>|<attr>=<val>;…` (identity/internal attrs excluded). Paste keeps the
// layer name, so this survives the clipboard even though pluginData does not.
const KG_MARKER_SKIP = new Set(["data-node-id", "data-name", "data-testid"]);
export function kgComponentMarker(el: Element): string | undefined {
  if (el.tagName.toLowerCase() === "svg") {
    // Design-system icons: the fig-import compiler stamps `data-fig-icon`
    // (+ `data-fig-icon-key`) into the generated SVG markup. Those icons ARE
    // Figma components, so route them through the same `kg:fig` channel the
    // plugin already uses for component swap — key first, name as fallback.
    // Without this the icon serialises as a plain <svg> and pastes as a frame.
    const figIcon = el.getAttribute("data-fig-icon");
    if (figIcon) {
      const key = el.getAttribute("data-fig-icon-key");
      return `kg:fig|fig-comp=${figIcon}${key ? `;fig-key=${key}` : ""}`;
    }
    // lucide <svg> icons: name the layer `icon/<name>` so the swap plugin can
    // replace it with the design system's Icon/<name> component.
    const m = (el.getAttribute("class") ?? "").match(/lucide-([a-z0-9-]+)/);
    return m ? `icon/${m[1]}` : undefined;
  }
  const slot = el.getAttribute("data-slot");
  if (!slot) return undefined;
  const parts: string[] = [];
  for (const { name, value } of Array.from(el.attributes)) {
    const lower = name.toLowerCase();
    if (!lower.startsWith("data-") || lower === "data-slot") continue;
    if (KG_MARKER_SKIP.has(lower) || lower.startsWith("data-h2d-")) continue;
    parts.push(`${lower.slice(5)}=${value}`); // strip "data-" prefix
  }
  if (el.getAttribute("aria-invalid") === "true") parts.push("aria-invalid=true");
  return parts.length ? `kg:${slot}|${parts.join(";")}` : `kg:${slot}`;
}

// --- pseudo-element content (::before / ::after) --------------------------------------------
function decodeCssString(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex: string, ch: string) => {
    if (!hex) return ch ?? "";
    const code = parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "�";
  });
}

function parseContentText(content: string | undefined, quotes: string | undefined): string | null {
  if (!content) return null;
  if (content === "open-quote" || content === "close-quote") {
    const marks =
      quotes && quotes !== "auto"
        ? Array.from(quotes.matchAll(/"((?:[^"\\]|\\.)*)"/g), (m) => decodeCssString(m[1]!))
        : ["“", "”", "‘", "’"];
    return content === "open-quote" ? (marks[0] ?? "“") : (marks[1] ?? "”");
  }
  const m = content.match(/^"((?:[^"\\]|\\.)*)"/);
  return m ? decodeCssString(m[1]!) : null;
}

const suppressSheets = new Map<Document | ShadowRoot, CSSStyleSheet>();
function adoptSuppressSheet(realm: Realm, root: Document | ShadowRoot): void {
  if (suppressSheets.has(root)) return;
  const sheet = new realm.win.CSSStyleSheet();
  sheet.insertRule(`[${SUPPRESS_BEFORE}]::before { content: none !important; }`);
  sheet.insertRule(`[${SUPPRESS_AFTER}]::after { content: none !important; }`);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  suppressSheets.set(root, sheet);
}
function clearSuppressSheets(): void {
  for (const [root, sheet] of suppressSheets) {
    try {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
    } catch {
      /* ignore */
    }
  }
  suppressSheets.clear();
}

function walkPseudo(
  ctx: WalkContext,
  el: Element,
  pseudo: "::before" | "::after",
  id: string,
  parentInverse: DOMMatrix | null,
): H2DElementNode | undefined {
  const { realm } = ctx;
  const extracted = extractStyles(realm, el, pseudo);
  if (!extracted) return undefined;
  const styles = extracted.styles;
  const text = parseContentText(styles.content ?? "normal", styles.quotes);
  ctx.fonts.collect(styles as FontKey);

  const root = el.getRootNode();
  if (!(root instanceof realm.win.Document || root instanceof realm.win.ShadowRoot)) return undefined;
  adoptSuppressSheet(realm, root as Document | ShadowRoot);

  const span = realm.doc.createElement("span");
  span.style.all = "initial";
  Object.assign(span.style, styles);
  span.style.removeProperty("content");
  const suppressAttr = pseudo === "::before" ? SUPPRESS_BEFORE : SUPPRESS_AFTER;

  try {
    el.setAttribute(suppressAttr, "");
    span.textContent = text;
    if (pseudo === "::before") el.prepend(span);
    else el.append(span);

    const size = measureSize(realm, span, styles, parentInverse != null);
    const localMatrix = computeLocalMatrix(size, styles);
    const rect = computeRect(span, size, localMatrix, parentInverse);
    const childInverse = composeInverse(parentInverse, localMatrix, { x: rect.x, y: rect.y });

    const childNodes: H2DNode[] = [];
    for (const child of Array.from(span.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const measure = measureText(realm, child as Text, childInverse, ctx.fonts.lineBoxHeight(styles as FontKey));
        const { lineCount, ...box } = measure;
        childNodes.push({
          nodeType: NODE_TYPE.TEXT,
          id: `${id}-text`,
          text: (child as Text).textContent || "",
          rect: box,
          lineCount,
        });
        break;
      }
    }

    return {
      nodeType: NODE_TYPE.ELEMENT,
      id,
      tag: "SPAN",
      attributes: {},
      styles,
      rect,
      childNodes,
    };
  } finally {
    span.remove();
    el.removeAttribute(suppressAttr);
  }
}

// --- node walk ------------------------------------------------------------------------------
const SKIP_TAGS = new Set(["HEAD", "SCRIPT", "STYLE", "NOSCRIPT"]);

function* groupChildren(nodes: Iterable<Node>): Generator<Node | Text[]> {
  const it = nodes[Symbol.iterator]();
  let next = it.next();
  while (!next.done) {
    if (next.value.nodeType === Node.TEXT_NODE) {
      const run: Text[] = [next.value as Text];
      next = it.next();
      while (!next.done && next.value.nodeType === Node.TEXT_NODE) {
        run.push(next.value as Text);
        next = it.next();
      }
      yield run;
    } else {
      yield next.value;
      next = it.next();
    }
  }
}

function walkText(ctx: WalkContext, node: Text | Text[], parent: ChildContext | undefined): H2DNode {
  const lineBoxHeight = parent ? ctx.fonts.lineBoxHeight(parent.styles as FontKey) : null;
  const measure = measureText(ctx.realm, node, parent?.inverseTransform ?? null, lineBoxHeight);
  const { lineCount, ...box } = measure;
  const text = Array.isArray(node)
    ? node.map((t) => t.textContent || "").join("")
    : node.textContent || "";
  const anchor = Array.isArray(node) ? (node.length === 1 ? node[0]! : null) : node;
  return { nodeType: NODE_TYPE.TEXT, id: nodeId(anchor), text, rect: box, lineCount };
}

function walkChildren(ctx: WalkContext, nodes: Iterable<Node>, childCtx: ChildContext): H2DNode[] {
  const out: H2DNode[] = [];
  for (const grouped of groupChildren(nodes)) {
    const node = walkNode(ctx, grouped, childCtx);
    if (node != null) out.push(node);
  }
  return out;
}

function walkElement(ctx: WalkContext, el: Element, parent: ChildContext | undefined): H2DNode | null {
  const { realm } = ctx;
  if (!isSerializable(realm, el)) return null;
  const tag = tagName(realm, el);
  if (tag === null || SKIP_TAGS.has(tag)) return null;

  const extracted = extractStyles(realm, el);
  if (!extracted) return null;
  const { styles, computedStyles } = extracted;
  // display:none (incl. the `hidden` attribute, which computes to none) is not rendered — skip
  // the element and its subtree. Without this, script-driven multi-step UIs (wizards/tabs that
  // toggle steps via display) serialize EVERY step, so the wrong/stacked step lands in Figma.
  if (styles.display === 'none') return null;
  const parentInverse = parent?.inverseTransform ?? null;

  // NB: the reference collapses an element to a bare text node only when it carries fginspector
  // "sources" metadata (devtools) — which v1 does not capture — so we never collapse here.
  ctx.fonts.collect(styles as FontKey);
  const size = measureSize(realm, el, styles, parentInverse != null || hasTransform(styles));
  const localMatrix = computeLocalMatrix(size, styles);
  const rect = computeRect(el, size, localMatrix, parentInverse);
  const childInverse = composeInverse(parentInverse, localMatrix, { x: rect.x, y: rect.y });
  const childCtx: ChildContext = { inverseTransform: childInverse, styles };

  let content: string | undefined;
  let placeholderUrl: string | undefined;
  let childNodes: H2DNode[] = [];

  const { win } = realm;
  if (el instanceof win.SVGElement) {
    content = bakeSvgOuterHtml(realm, el);
  } else if (el instanceof win.HTMLCanvasElement) {
    placeholderUrl = ctx.images.addCanvas(el);
  } else if (el instanceof win.HTMLSlotElement && el.getRootNode() instanceof win.ShadowRoot) {
    childNodes = walkChildren(ctx, el.assignedNodes({ flatten: true }), childCtx);
  } else if (el.shadowRoot) {
    childNodes = walkChildren(ctx, el.shadowRoot.childNodes, childCtx);
  } else {
    childNodes = walkChildren(ctx, el.childNodes, childCtx);
  }

  let pseudoElementStyles: H2DElementNode["pseudoElementStyles"];
  if (
    ((el instanceof win.HTMLInputElement && PLACEHOLDER_INPUT_TYPES.has(el.type)) ||
      el instanceof win.HTMLTextAreaElement) &&
    el.placeholder
  ) {
    pseudoElementStyles = { placeholder: extractStyles(realm, el, "::placeholder")?.styles };
  }

  ctx.images.collectFor(el, styles);

  const before = walkPseudo(ctx, el, "::before", `${nodeId(el)}::before`, childInverse);
  const after = walkPseudo(ctx, el, "::after", `${nodeId(el)}::after`, childInverse);
  const pseudoElementNodes = before || after ? { before, after } : undefined;

  const node: H2DElementNode = {
    nodeType: NODE_TYPE.ELEMENT,
    id: nodeId(el),
    tag,
    attributes: pickAttributes(realm, el),
    styles,
    rect,
    childNodes,
    content,
    placeholderUrl,
    pseudoElementNodes,
    pseudoElementStyles,
  };
  if (Object.keys(computedStyles).length > 0) node.computedStyles = computedStyles;
  const kgMarker = kgComponentMarker(el);
  if (kgMarker) node.owningReactComponent = kgMarker;
  return node;
}

function walkNode(ctx: WalkContext, node: Node | Text[], parent: ChildContext | undefined): H2DNode | null {
  if (Array.isArray(node) || node.nodeType === Node.TEXT_NODE) {
    return walkText(ctx, node as Text | Text[], parent);
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return walkElement(ctx, node as Element, parent);
  }
  return null;
}

// --- public capture entrypoints -------------------------------------------------------------
function assertLayout(realm: Realm): void {
  const r = realm.doc.body.getBoundingClientRect();
  if (r.x === 0 && r.y === 0 && r.width === 0 && r.height === 0) {
    throw new Error("Document does not have valid layout");
  }
}

async function decodeImages(images: HTMLImageElement[]): Promise<void> {
  for (const img of images) {
    if (img.decoding !== "sync") img.decoding = "sync";
    if (img.loading !== "eager") img.loading = "eager";
  }
  await Promise.allSettled(images.map((img) => img.decode()));
}

function runInFrame<T>(realm: Realm, fn: () => T, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Capture aborted"));
    const raf = realm.win.requestAnimationFrame(() => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      } finally {
        clearSuppressSheets();
      }
    });
    signal.addEventListener(
      "abort",
      () => {
        realm.win.cancelAnimationFrame(raf);
        clearSuppressSheets();
        reject(new Error("H2D capture timed out"));
      },
      { once: true },
    );
  });
}

async function capture(container: Element | Document, options: CaptureOptions): Promise<H2DDocument> {
  const realm = realmOf(container);
  const { win, doc } = realm;
  idCounter = 0;
  idMap = new WeakMap();
  if (options.assertLayoutValid !== false) assertLayout(realm);

  const images = new ImageCollector(realm, {
    skipRemoteAssetSerialization: options.skipRemoteAssetSerialization ?? false,
  });
  const ctx: WalkContext = { realm, images, fonts: new FontCollector(realm) };
  const signal = options.timeoutSignal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

  const isElement = container instanceof win.Element;
  const scope = isElement ? (container as Element) : doc;
  const rootEl = isElement ? (container as Element) : doc.documentElement;
  await decodeImages(Array.from(scope.querySelectorAll("img")));

  const root = await runInFrame(realm, () => walkNode(ctx, rootEl, undefined), signal);
  if (!root || root.nodeType !== NODE_TYPE.ELEMENT) {
    throw new Error("Container node could not be serialized");
  }

  const assets = await images.getBlobMap();
  const fonts = ctx.fonts.getFonts();
  // Rewrite every node's `styles.fontFamily` down to the single resolved,
  // Figma-loadable family (post-capture, so text measurement above still used
  // the real rendered stack). Prevents Figma's paste from choking on CSS
  // generic / system keywords (`system-ui`, `-apple-system`, …) in the stack.
  rewriteEmittedFontFamilies(root, ctx.fonts);

  if (isElement) {
    const el = container as Element;
    const bcr = el.getBoundingClientRect();
    return {
      root,
      documentTitle: doc.title || undefined,
      documentRect: { x: 0, y: 0, width: el.scrollWidth, height: el.scrollHeight },
      viewportRect: { x: el.scrollLeft, y: el.scrollTop, width: bcr.width, height: bcr.height },
      devicePixelRatio: win.devicePixelRatio,
      version: 2,
      assets,
      fonts,
    };
  }
  return {
    root,
    documentTitle: doc.title || undefined,
    documentRect: {
      x: 0,
      y: 0,
      width: doc.documentElement.scrollWidth,
      height: doc.documentElement.scrollHeight,
    },
    viewportRect: { x: 0, y: 0, width: win.innerWidth, height: win.innerHeight },
    devicePixelRatio: win.devicePixelRatio,
    version: 2,
    assets,
    fonts,
  };
}

/** Walk the captured tree and collapse each element's `styles.fontFamily` to
 * the single resolved, Figma-loadable family (see FontCollector.emitFamily). */
function rewriteEmittedFontFamilies(node: H2DNode | undefined, fonts: FontCollector): void {
  if (!node || node.nodeType !== NODE_TYPE.ELEMENT) return;
  const el = node as H2DElementNode;
  const ff = el.styles?.fontFamily;
  if (ff) {
    const resolved = fonts.emitFamily(ff);
    if (resolved) el.styles.fontFamily = resolved;
  }
  for (const child of el.childNodes ?? []) rewriteEmittedFontFamilies(child, fonts);
  if (el.pseudoElementNodes) {
    rewriteEmittedFontFamilies(el.pseudoElementNodes.before, fonts);
    rewriteEmittedFontFamilies(el.pseudoElementNodes.after, fonts);
  }
}

export function captureElement(el: Element, options: CaptureOptions = {}): Promise<H2DDocument> {
  // Duck-typed (not `instanceof Element`) so an element from an offscreen iframe realm passes.
  if (!el || el.nodeType !== Node.ELEMENT_NODE) throw new Error("captureElement requires an Element");
  return capture(el, options);
}

export function captureDocument(doc: Document = document, options: CaptureOptions = {}): Promise<H2DDocument> {
  return capture(doc, options);
}
