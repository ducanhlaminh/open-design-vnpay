// Clean-room SVG baking. See specs/current/h2d-serializer-spec.md §5.
// SVG isn't walked into H2D nodes; instead we clone it and bake every non-default presentation
// attribute (computed) onto the clone so the serialized outerHTML renders identically in Figma.

import type { Realm } from "./realm.js";
import { SVG_PRESENTATION_DEFAULTS } from "./style-defaults.js";

const ELEMENT_NODE = 1;

// camelCase default key -> dashed CSS/attribute name (e.g. strokeWidth -> stroke-width). Both
// getPropertyValue and setAttribute need the dashed form.
const PRESENTATION_DASH: Record<string, string> = Object.fromEntries(
  Object.keys(SVG_PRESENTATION_DEFAULTS).map((p) => [p, p.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()]),
);

function bakeAttributes(realm: Realm, source: Node, clone: Node): void {
  // Duck-type via nodeType (not `instanceof Element`): nodes come from the artifact's iframe
  // realm, so the parent-realm `Element` ctor would never match — which previously made this a
  // no-op, leaving fill/stroke="currentColor" unresolved (icons paste as default black).
  if (source.nodeType !== ELEMENT_NODE || clone.nodeType !== ELEMENT_NODE) return;
  const cs = realm.win.getComputedStyle(source as Element);
  const dst = clone as Element;
  for (const [prop, dash] of Object.entries(PRESENTATION_DASH)) {
    const value = cs.getPropertyValue(dash);
    const def = SVG_PRESENTATION_DEFAULTS[prop]!;
    if (value && value.toLowerCase() !== def.toLowerCase()) {
      dst.setAttribute(dash, value);
    }
  }
  for (let i = 0; i < source.childNodes.length; i++) {
    bakeAttributes(realm, source.childNodes[i]!, clone.childNodes[i]!);
  }
}

export function bakeSvgOuterHtml(realm: Realm, el: Element): string {
  const clone = el.cloneNode(true) as Element;
  bakeAttributes(realm, el, clone);
  const { width, height } = realm.win.getComputedStyle(el);
  if (width.endsWith("px") && height.endsWith("px")) {
    clone.setAttribute("width", width);
    clone.setAttribute("height", height);
  }
  return clone.outerHTML;
}
