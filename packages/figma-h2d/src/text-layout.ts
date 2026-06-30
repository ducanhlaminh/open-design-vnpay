// Clean-room text measurement. See specs/current/h2d-serializer-spec.md §4.text.
// A text run's box is derived from a DOM Range; when under a transform we re-solve each client
// rect through the inverse matrix (AABB), and we count visual lines by clustering rect centers.

import type { Realm } from "./realm.js";

export interface TextMeasure {
  x: number;
  y: number;
  width: number;
  height: number;
  lineCount: number;
}

interface Mat2 {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** 2×2 inverse of the linear part of a DOMMatrix (null if singular). */
function invert2x2(m: DOMMatrix): Mat2 | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-10) return null;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det };
}

/** Recover (width,height) of an axis-aligned box that maps to (w,h) under inverse `m`. */
function solveAABB(w: number, h: number, m: Mat2): { width: number; height: number } | null {
  const a = Math.abs(m.a);
  const b = Math.abs(m.b);
  const c = Math.abs(m.c);
  const d = Math.abs(m.d);
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-10) return null;
  const width = (w * d - h * c) / det;
  const height = (h * a - w * b) / det;
  return width <= 0 || height <= 0 ? null : { width, height };
}

function solveRects(
  rects: DOMRect[],
  inverse: DOMMatrix,
  solveSize: (r: DOMRect) => { width: number; height: number } | null,
): DOMRect[] | null {
  if (rects.length === 0) return null;
  const out: DOMRect[] = [];
  for (const r of rects) {
    const size = solveSize(r);
    if (!size) continue;
    const center = new DOMPoint(r.x + r.width / 2, r.y + r.height / 2).matrixTransform(inverse);
    out.push(
      new DOMRect(center.x - size.width / 2, center.y - size.height / 2, size.width, size.height),
    );
  }
  return out.length > 0 ? out : null;
}

// Constrain by a known line-box height (preferred when font metrics are available).
function solveWithLineHeight(
  rects: DOMRect[],
  inverse: DOMMatrix,
  inv2: Mat2,
  lineHeight: number,
): DOMRect[] | null {
  const a = Math.abs(inv2.a);
  const b = Math.abs(inv2.b);
  const c = Math.abs(inv2.c);
  const d = Math.abs(inv2.d);
  const horizontal = a >= b;
  if ((horizontal ? a : b) < 1e-10) return null;
  return solveRects(rects, inverse, (r) => {
    const len = horizontal ? (r.width - c * lineHeight) / a : (r.height - d * lineHeight) / b;
    return len <= 0 ? null : { width: len, height: lineHeight };
  });
}

function solveGeneral(rects: DOMRect[], inverse: DOMMatrix, inv2: Mat2): DOMRect[] | null {
  return solveRects(rects, inverse, (r) => solveAABB(r.width, r.height, inv2));
}

function unionRects(rects: DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null;
  return rects.reduce((acc, r) => {
    const x = Math.min(acc.x, r.x);
    const y = Math.min(acc.y, r.y);
    return new DOMRect(
      x,
      y,
      Math.max(acc.x + acc.width, r.x + r.width) - x,
      Math.max(acc.y + acc.height, r.y + r.height) - y,
    );
  });
}

/** Count visual lines by clustering rect centers along the block axis (≥1px apart = new line). */
function countLines(rects: DOMRect[], vertical: boolean): number {
  const spans = rects
    .map((r) => (vertical ? { start: r.left, end: r.right } : { start: r.top, end: r.bottom }))
    .filter(({ start, end }) => end > start)
    .sort((p, q) => p.start - q.start);
  const threshold = 1;
  let lines = 0;
  let lastCenter = -Infinity;
  for (const { start, end } of spans) {
    const center = (start + end) / 2;
    if (Math.abs(center - lastCenter) >= threshold) {
      lines++;
      lastCenter = center;
    }
  }
  return lines;
}

export function measureText(
  realm: Realm,
  node: Text | Text[],
  inverse: DOMMatrix | null,
  lineBoxHeight: number | null,
): TextMeasure {
  const range = realm.doc.createRange();
  if (Array.isArray(node)) {
    const first = node[0]!;
    const last = node[node.length - 1]!;
    range.setStart(first, 0);
    range.setEnd(last, last.length);
  } else {
    range.selectNode(node);
  }
  const bcr = range.getBoundingClientRect();
  const clientRects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  const vertical =
    range.commonAncestorContainer instanceof realm.win.HTMLElement
      ? realm.win.getComputedStyle(range.commonAncestorContainer).writingMode.startsWith("vertical")
      : false;
  range.detach();

  if (clientRects.length > 0 && inverse) {
    const inv2 = invert2x2(inverse);
    if (inv2) {
      const solved =
        lineBoxHeight != null
          ? solveWithLineHeight(clientRects, inverse, inv2, lineBoxHeight)
          : solveGeneral(clientRects, inverse, inv2);
      if (solved) {
        const u = unionRects(solved) ?? bcr;
        return {
          x: u.x,
          y: u.y,
          width: u.width,
          height: u.height,
          lineCount: countLines(solved, vertical),
        };
      }
    }
  }
  return {
    x: bcr.x,
    y: bcr.y,
    width: bcr.width,
    height: bcr.height,
    lineCount: countLines(clientRects, vertical),
  };
}
