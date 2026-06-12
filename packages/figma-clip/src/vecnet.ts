// SVG subpaths → Figma vectorNetworkBlob (the geometry blob a VECTOR node references).
// Format decoded + round-trip byte-verified against a real Figma VECTOR:
//   u32 numVertices, numSegments, numRegions
//   vertices[]: { u32 style=0, f32 x, f32 y }
//   segments[]: { u32 style=0, u32 vA, f32 tAx,tAy, u32 vB, f32 tBx,tBy }  (tangent = cubic control offset)
//   regions[]:  { u32 windingRule, u32 numLoops, (u32 numSegs, u32 segIdx[])... }
// windingRule: NONZERO = 1 (SVG default), EVENODD = 2.
import type { SubPath } from "./svg-path.js";

export const WINDING = { nonzero: 1, evenodd: 2 } as const;

interface Vertex {
  s: number;
  x: number;
  y: number;
}
interface Segment {
  s: number;
  a: number;
  tax: number;
  tay: number;
  b: number;
  tbx: number;
  tby: number;
}
interface Region {
  wind: number;
  loops: number[][];
}
export interface VectorNetwork {
  vertices: Vertex[];
  segments: Segment[];
  regions: Region[];
}

export interface BuildOpts {
  scaleX?: number;
  scaleY?: number;
  offsetX?: number;
  offsetY?: number;
  filled?: boolean;
  winding?: number;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;

// Build vertices + segments for one subpath; reuse the start vertex on close to avoid a dup.
function addSubpath(sp: SubPath, verts: Vertex[], segs: Segment[], tx: (p: { x: number; y: number }) => { x: number; y: number }): number[] {
  const cmds = sp.cmds;
  if (!cmds.length || cmds[0]!.t !== "M") return [];
  const start = tx(cmds[0]!.p[0]!);
  const startIdx = verts.length;
  verts.push({ s: 0, x: start.x, y: start.y });
  let curIdx = startIdx;
  let cur = start;
  const segIndices: number[] = [];

  for (let i = 1; i < cmds.length; i++) {
    const c = cmds[i]!;
    const end = tx(c.p[c.p.length - 1]!);
    const isClosingToStart = sp.closed && i === cmds.length - 1 && c.t === "L" && near(end.x, start.x) && near(end.y, start.y);
    let endIdx: number;
    if (isClosingToStart) {
      endIdx = startIdx;
    } else {
      endIdx = verts.length;
      verts.push({ s: 0, x: end.x, y: end.y });
    }
    let tA = { x: 0, y: 0 };
    let tB = { x: 0, y: 0 };
    if (c.t === "C") {
      const c1 = tx(c.p[0]!), c2 = tx(c.p[1]!);
      tA = { x: c1.x - cur.x, y: c1.y - cur.y };
      tB = { x: c2.x - end.x, y: c2.y - end.y };
    }
    segs.push({ s: 0, a: curIdx, tax: tA.x, tay: tA.y, b: endIdx, tbx: tB.x, tby: tB.y });
    segIndices.push(segs.length - 1);
    curIdx = endIdx;
    cur = end;
  }
  if (sp.closed && curIdx !== startIdx) {
    segs.push({ s: 0, a: curIdx, tax: 0, tay: 0, b: startIdx, tbx: 0, tby: 0 });
    segIndices.push(segs.length - 1);
  }
  return segIndices;
}

export function buildVectorNetwork(subpaths: SubPath[], opts: BuildOpts = {}): VectorNetwork {
  const { scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0, filled = true, winding = WINDING.nonzero } = opts;
  const tx = (p: { x: number; y: number }) => ({ x: (p.x + offsetX) * scaleX, y: (p.y + offsetY) * scaleY });
  const verts: Vertex[] = [];
  const segs: Segment[] = [];
  const loops: number[][] = [];
  for (const sp of subpaths) {
    const segIdx = addSubpath(sp, verts, segs, tx);
    if (segIdx.length) loops.push(segIdx);
  }
  const regions: Region[] = filled && loops.length ? [{ wind: winding, loops }] : [];
  return { vertices: verts, segments: segs, regions };
}

export function encodeVectorNetwork(vn: VectorNetwork): Uint8Array {
  const parts: Buffer[] = [];
  const wu = (v: number): void => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); };
  const wf = (v: number): void => { const b = Buffer.alloc(4); b.writeFloatLE(v); parts.push(b); };
  wu(vn.vertices.length); wu(vn.segments.length); wu(vn.regions.length);
  for (const v of vn.vertices) { wu(v.s); wf(v.x); wf(v.y); }
  for (const s of vn.segments) { wu(s.s); wu(s.a); wf(s.tax); wf(s.tay); wu(s.b); wf(s.tbx); wf(s.tby); }
  for (const r of vn.regions) {
    wu(r.wind); wu(r.loops.length);
    for (const lp of r.loops) { wu(lp.length); for (const idx of lp) wu(idx); }
  }
  return new Uint8Array(Buffer.concat(parts));
}
