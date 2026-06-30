// Clean-room computed-style extraction. See specs/current/h2d-serializer-spec.md §3.
// Keeps only computed values that differ from the Chromium default, then uses CSS Typed OM to
// recover the *specified* sizing/grid values (so `width:100%` / `margin:auto` survive instead of
// the resolved px), and drops border/outline sub-props with no width.

import type { Realm } from "./realm.js";
import {
  BORDER_EDGES,
  DASH_PROP,
  GRID_PROPS,
  MARGIN_PROPS,
  SIZING_PROPS,
  STYLE_DEFAULTS,
  STYLE_DEFAULT_ENTRIES,
} from "./style-defaults.js";

export interface ExtractedStyles {
  styles: Record<string, string>;
  computedStyles: Record<string, string>;
}

type StyleMapLike = { get(prop: string): { toString(): string } | undefined } | null;

export function extractStyles(realm: Realm, el: Element, pseudo?: string): ExtractedStyles | null {
  const cs = realm.win.getComputedStyle(el, pseudo);

  if (pseudo === "::before" || pseudo === "::after") {
    const content = cs.content;
    if (
      content === "none" ||
      content === "normal" ||
      content === "no-open-quote" ||
      content === "no-close-quote"
    ) {
      return null;
    }
  }

  const styles: Record<string, string> = {};
  for (const [prop, def] of STYLE_DEFAULT_ENTRIES) {
    const value = (cs as unknown as Record<string, string>)[prop];
    if (value != null && value !== def) styles[prop] = value;
  }

  const computedStyles: Record<string, string> = {};
  const styleMap: StyleMapLike =
    "computedStyleMap" in el && !pseudo
      ? (el as unknown as { computedStyleMap(): StyleMapLike }).computedStyleMap()
      : null;

  if (styleMap) {
    for (const prop of SIZING_PROPS) {
      const specified = styleMap.get(DASH_PROP[prop]!)?.toString();
      if (!specified) continue;
      if (specified === STYLE_DEFAULTS[prop]) delete styles[prop];
      else if (specified !== styles[prop]) computedStyles[prop] = specified;
    }
    for (const prop of GRID_PROPS) {
      const specified = styleMap.get(DASH_PROP[prop]!)?.toString();
      if (specified && specified !== STYLE_DEFAULTS[prop] && specified !== styles[prop]) {
        computedStyles[prop] = specified;
      }
    }
    for (const prop of MARGIN_PROPS) {
      if (styleMap.get(DASH_PROP[prop]!)?.toString() === "auto") styles[prop] = "auto";
    }
  }

  for (const edge of BORDER_EDGES) {
    if (styles[edge.width] == null) {
      delete styles[edge.style];
      delete styles[edge.color];
    }
  }
  if (styles.outlineWidth == null) {
    delete styles.outlineStyle;
    delete styles.outlineColor;
  }
  if (styles.webkitTextFillColor != null && styles.webkitTextFillColor === cs.color) {
    delete styles.webkitTextFillColor;
  }

  return { styles, computedStyles };
}
