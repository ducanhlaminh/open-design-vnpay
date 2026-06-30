// Clean-room transform + rect math. See specs/current/h2d-serializer-spec.md §4.
// All coordinates are viewport-space (getBoundingClientRect). When an element (or an ancestor)
// carries a CSS transform we recover the *untransformed* box and, when skewed, an explicit quad.

import type { Realm } from "./realm.js";
import type { Point, Quad, Rect } from "./types.js";

export interface Size {
  width: number;
  height: number;
}

export function hasTransform(styles: Record<string, string>): boolean {
  return !!(
    (styles.rotate && styles.rotate !== "none") ||
    (styles.scale && styles.scale !== "none") ||
    (styles.transform && styles.transform !== "none") ||
    (styles.translate && styles.translate !== "none")
  );
}

function resolvePercent(value: string, base: number): string {
  return value.endsWith("%") ? `${(parseFloat(value) / 100) * base}px` : value;
}

function parseTranslate(size: Size, value: string | undefined): DOMMatrix {
  if (!value) return new DOMMatrix();
  const parts = value.trim().split(/\s+/);
  if (parts.length === 0) return new DOMMatrix();
  if (parts.length > 3) throw new Error(`Invalid translate value: ${value}`);
  const tx = resolvePercent(parts[0] ?? "0px", size.width);
  const ty = resolvePercent(parts[1] ?? "0px", size.height);
  const tz = parts[2] ?? "0px";
  return new DOMMatrix(`translate3d(${tx}, ${ty}, ${tz})`);
}

function parseScale(value: string | undefined): DOMMatrix {
  if (!value) return new DOMMatrix();
  const p = value.trim().split(/\s+/);
  if (p.length === 0) return new DOMMatrix();
  if (p.length > 3) throw new Error(`Invalid scale value: ${value}`);
  return new DOMMatrix(`scale3d(${p[0]}, ${p[1] ?? p[0]}, ${p[2] ?? 1})`);
}

function parseRotate(value: string | undefined): DOMMatrix {
  if (!value) return new DOMMatrix();
  const p = value.trim().split(/\s+/);
  if (p.length === 0) return new DOMMatrix();
  if (p.length === 1) return new DOMMatrix(`rotate(${p[0]})`);
  if (p.length === 2) {
    switch (p[0]) {
      case "x":
        return new DOMMatrix(`rotateX(${p[1]})`);
      case "y":
        return new DOMMatrix(`rotateY(${p[1]})`);
      case "z":
        return new DOMMatrix(`rotateZ(${p[1]})`);
      default:
        return new DOMMatrix();
    }
  }
  return p.length === 4
    ? new DOMMatrix(`rotate3d(${p[0]}, ${p[1]}, ${p[2]}, ${p[3]})`)
    : new DOMMatrix();
}

/** Local transform matrix about the element's transform-origin (null when no transform). */
export function computeLocalMatrix(
  size: Size,
  styles: Record<string, string>,
): DOMMatrix | null {
  if (!hasTransform(styles)) return null;
  try {
    const [ox = "0px", oy = "0px", oz = "0px"] =
      styles.transformOrigin?.trim().split(/\s+/) ?? [];
    const toOrigin = new DOMMatrix(`translate3d(${ox}, ${oy}, ${oz})`);
    return toOrigin
      .multiply(parseTranslate(size, styles.translate))
      .multiply(parseRotate(styles.rotate))
      .multiply(parseScale(styles.scale))
      .multiply(new DOMMatrix(styles.transform ?? "none"))
      .multiply(toOrigin.inverse());
  } catch {
    return null;
  }
}

/**
 * Inverse transform handed down to children so their viewport coords are expressed in the
 * parent's untransformed frame. Mirrors the reference composition Wt(parentInverse, local, origin).
 */
export function composeInverse(
  parentInverse: DOMMatrix | null,
  localMatrix: DOMMatrix | null,
  origin: Point | undefined,
): DOMMatrix | null {
  if (!localMatrix) return parentInverse;
  try {
    let inv = localMatrix.inverse();
    if (origin) {
      const { x, y } = origin;
      inv = new DOMMatrix().translate(x, y).multiply(inv).translate(-x, -y);
    }
    return parentInverse ? inv.multiply(parentInverse) : inv;
  } catch {
    return parentInverse;
  }
}

export function measureSize(
  realm: Realm,
  el: Element,
  styles: Record<string, string>,
  inTransformContext: boolean,
): Size {
  const { win } = realm;
  if (el instanceof win.HTMLElement && (hasTransform(styles) || inTransformContext)) {
    return { width: el.offsetWidth, height: el.offsetHeight };
  }
  if (el instanceof win.HTMLElement) {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }
  if (el instanceof win.SVGSVGElement) {
    const cs = win.getComputedStyle(el);
    return {
      width: parseFloat(cs.width) || el.width.baseVal.value,
      height: parseFloat(cs.height) || el.height.baseVal.value,
    };
  }
  if (el instanceof win.SVGGraphicsElement) {
    const b = el.getBBox();
    return { width: b.width, height: b.height };
  }
  if (typeof win.MathMLElement !== "undefined" && el instanceof win.MathMLElement) {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }
  return { width: 0, height: 0 };
}

function matrixIsTransformed(m: DOMMatrix): boolean {
  return (
    Math.abs(m.a - 1) > 1e-6 ||
    Math.abs(m.b) > 1e-6 ||
    Math.abs(m.c) > 1e-6 ||
    Math.abs(m.d - 1) > 1e-6 ||
    Math.abs(m.e) > 1e-6 ||
    Math.abs(m.f) > 1e-6
  );
}

// Solve the untransformed top-left from the transformed center (reference Ta).
function centerSolve(
  bcr: DOMRect,
  width: number,
  height: number,
  parentInverse: DOMMatrix | null,
  localMatrix: DOMMatrix | null,
): Point {
  const center = new DOMPoint(bcr.x + bcr.width / 2, bcr.y + bcr.height / 2);
  const localCenter = new DOMPoint(width / 2, height / 2);
  const c = parentInverse ? center.matrixTransform(parentInverse) : center;
  const l = localMatrix ? localCenter.matrixTransform(localMatrix) : localCenter;
  return { x: c.x - l.x, y: c.y - l.y };
}

function transformQuad(q: DOMQuad, m: DOMMatrix): DOMQuad {
  return new DOMQuad(
    q.p1.matrixTransform(m),
    q.p2.matrixTransform(m),
    q.p3.matrixTransform(m),
    q.p4.matrixTransform(m),
  );
}

function buildQuad(localMatrix: DOMMatrix, w: number, h: number, origin: Point): Quad {
  const base = DOMQuad.fromQuad({
    p1: { x: 0, y: 0 },
    p2: { x: w, y: 0 },
    p3: { x: w, y: h },
    p4: { x: 0, y: h },
  });
  const transformed = transformQuad(base, localMatrix);
  const placed = transformQuad(transformed, new DOMMatrix().translate(origin.x, origin.y));
  return {
    p1: { x: placed.p1.x, y: placed.p1.y },
    p2: { x: placed.p2.x, y: placed.p2.y },
    p3: { x: placed.p3.x, y: placed.p3.y },
    p4: { x: placed.p4.x, y: placed.p4.y },
  };
}

export function computeRect(
  el: Element,
  size: Size,
  localMatrix: DOMMatrix | null,
  parentInverse: DOMMatrix | null,
): Rect {
  const bcr = el.getBoundingClientRect();
  if (!parentInverse && !localMatrix) {
    return { x: bcr.x, y: bcr.y, width: size.width, height: size.height };
  }
  const w = Math.max(size.width, 0.01);
  const h = Math.max(size.height, 0.01);
  try {
    const tl = centerSolve(bcr, w, h, parentInverse, localMatrix);
    const rect: Rect = { x: tl.x, y: tl.y, width: size.width, height: size.height };
    if (localMatrix && matrixIsTransformed(localMatrix)) {
      try {
        rect.quad = buildQuad(localMatrix, w, h, tl);
      } catch {
        /* quad is best-effort */
      }
    }
    return rect;
  } catch {
    return { x: bcr.x, y: bcr.y, width: size.width, height: size.height };
  }
}
