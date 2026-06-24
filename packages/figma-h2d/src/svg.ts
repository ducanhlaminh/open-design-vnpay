// Clean-room SVG baking. See specs/current/h2d-serializer-spec.md §5.
// SVG isn't walked into H2D nodes; instead we clone it and bake every non-default presentation
// attribute (computed) onto the clone so the serialized outerHTML renders identically in Figma.

import type { Realm } from "./realm.js";
import { SVG_PRESENTATION_DEFAULTS } from "./style-defaults.js";

const PRESENTATION_DASH: Record<string, string> = Object.fromEntries(
  Object.keys(SVG_PRESENTATION_DEFAULTS).map((p) => [p, p.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()]),
);

function bakeAttributes(realm: Realm, source: Node, clone: Node): void {
  if (!(source instanceof Element) || !(clone instanceof Element)) return;
  const cs = realm.win.getComputedStyle(source);
  for (const [prop, def] of Object.entries(SVG_PRESENTATION_DEFAULTS)) {
    const value = cs.getPropertyValue(prop);
    if (value && value.toLowerCase() !== def.toLowerCase()) {
      clone.setAttribute(PRESENTATION_DASH[prop]!, value);
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
