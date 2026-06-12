// SVG path `d` → absolute subpaths of {M, L, C} commands (everything reduced to lines +
// cubic béziers: Q→C, A→C, H/V→L, S/T smooth → explicit, relative → absolute). One subpath
// per M. The Figma geometry encoder (vecnet) consumes this intermediate.

export interface Pt {
  x: number;
  y: number;
}
export interface PathCmd {
  t: "M" | "L" | "C";
  p: Pt[]; // C carries [control1, control2, end]; M/L carry [point]
}
export interface SubPath {
  closed: boolean;
  cmds: PathCmd[];
}

function tokenize(d: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) out.push(m[1] ?? parseFloat(m[2]!));
  return out;
}

function q2c(p0: Pt, qc: Pt, end: Pt): Pt[] {
  return [
    { x: p0.x + (2 / 3) * (qc.x - p0.x), y: p0.y + (2 / 3) * (qc.y - p0.y) },
    { x: end.x + (2 / 3) * (qc.x - end.x), y: end.y + (2 / 3) * (qc.y - end.y) },
    { x: end.x, y: end.y },
  ];
}

// Endpoint-parameterized elliptical arc → cubic segments (W3C SVG implementation notes).
function arcToCubics(p0: Pt, rxIn: number, ryIn: number, phiDeg: number, largeArc: boolean, sweep: boolean, end: Pt): Pt[][] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [[{ x: (p0.x + end.x) / 2, y: (p0.y + end.y) / 2 }, { x: end.x, y: end.y }, { x: end.x, y: end.y }]];
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (p0.x - end.x) / 2;
  const dy = (p0.y - end.y) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const sign = largeArc !== sweep ? 1 : -1;
  const num = Math.max(0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p);
  const co = sign * Math.sqrt(num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p) || 0);
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (p0.x + end.x) / 2;
  const cy = sinP * cxp + cosP * cyp + (p0.y + end.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out: Pt[][] = [];
  let th = theta1;
  let prev = p0;
  for (let i = 0; i < segs; i++) {
    const th2 = th + delta;
    const cos1 = Math.cos(th), sin1 = Math.sin(th), cos2 = Math.cos(th2), sin2 = Math.sin(th2);
    const e = (cosT: number, sinT: number): Pt => ({
      x: cx + rx * cosP * cosT - ry * sinP * sinT,
      y: cy + rx * sinP * cosT + ry * cosP * sinT,
    });
    const p2 = e(cos2, sin2);
    const c1 = { x: prev.x - t * (rx * cosP * sin1 + ry * sinP * cos1), y: prev.y - t * (rx * sinP * sin1 - ry * cosP * cos1) };
    const c2 = { x: p2.x + t * (rx * cosP * sin2 + ry * sinP * cos2), y: p2.y + t * (rx * sinP * sin2 - ry * cosP * cos2) };
    out.push([c1, c2, p2]);
    prev = p2;
    th = th2;
  }
  return out;
}

export function parsePath(d: string): SubPath[] {
  const t = tokenize(d);
  let i = 0;
  const subpaths: SubPath[] = [];
  let cur: SubPath | null = null;
  let start: Pt = { x: 0, y: 0 };
  let pos: Pt = { x: 0, y: 0 };
  let prevCubicC2: Pt | null = null;
  let prevQuadC: Pt | null = null;
  let lastCmd = "";

  const open = (): SubPath => { const s: SubPath = { closed: false, cmds: [] }; subpaths.push(s); return s; };
  const num = (): number => t[i++] as number;

  while (i < t.length) {
    let cmd = t[i];
    if (typeof cmd === "string") { i++; } else { cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd; }
    const c = (cmd as string).toUpperCase();
    const rel = (cmd as string) >= "a";
    const ax = (v: number): number => (rel ? pos.x + v : v);
    const ay = (v: number): number => (rel ? pos.y + v : v);

    if (c === "M") {
      const x = ax(num()), y = ay(num());
      cur = open(); pos = { x, y }; start = { x, y };
      cur.cmds.push({ t: "M", p: [{ x, y }] });
      prevCubicC2 = prevQuadC = null;
    } else if (!cur) {
      break; // data before an initial M — malformed
    } else if (c === "L") {
      const x = ax(num()), y = ay(num());
      cur.cmds.push({ t: "L", p: [{ x, y }] }); pos = { x, y };
      prevCubicC2 = prevQuadC = null;
    } else if (c === "H") {
      const x = rel ? pos.x + num() : num();
      cur.cmds.push({ t: "L", p: [{ x, y: pos.y }] }); pos = { x, y: pos.y };
      prevCubicC2 = prevQuadC = null;
    } else if (c === "V") {
      const y = rel ? pos.y + num() : num();
      cur.cmds.push({ t: "L", p: [{ x: pos.x, y }] }); pos = { x: pos.x, y };
      prevCubicC2 = prevQuadC = null;
    } else if (c === "C") {
      const c1 = { x: ax(num()), y: ay(num()) }, c2 = { x: ax(num()), y: ay(num()) }, e = { x: ax(num()), y: ay(num()) };
      cur.cmds.push({ t: "C", p: [c1, c2, e] }); pos = e; prevCubicC2 = c2; prevQuadC = null;
    } else if (c === "S") {
      const c1 = prevCubicC2 ? { x: 2 * pos.x - prevCubicC2.x, y: 2 * pos.y - prevCubicC2.y } : { ...pos };
      const c2 = { x: ax(num()), y: ay(num()) }, e = { x: ax(num()), y: ay(num()) };
      cur.cmds.push({ t: "C", p: [c1, c2, e] }); pos = e; prevCubicC2 = c2; prevQuadC = null;
    } else if (c === "Q") {
      const qc = { x: ax(num()), y: ay(num()) }, e = { x: ax(num()), y: ay(num()) };
      cur.cmds.push({ t: "C", p: q2c(pos, qc, e) }); pos = e; prevQuadC = qc; prevCubicC2 = null;
    } else if (c === "T") {
      const qc: Pt = prevQuadC ? { x: 2 * pos.x - prevQuadC.x, y: 2 * pos.y - prevQuadC.y } : { ...pos };
      const e = { x: ax(num()), y: ay(num()) };
      cur.cmds.push({ t: "C", p: q2c(pos, qc, e) }); pos = e; prevQuadC = qc; prevCubicC2 = null;
    } else if (c === "A") {
      const rx = num(), ry = num(), rot = num(), laf = num(), sf = num();
      const e = { x: ax(num()), y: ay(num()) };
      for (const seg of arcToCubics(pos, rx, ry, rot, !!laf, !!sf, e)) cur.cmds.push({ t: "C", p: seg });
      pos = e; prevCubicC2 = prevQuadC = null;
    } else if (c === "Z") {
      cur.closed = true;
      cur.cmds.push({ t: "L", p: [{ x: start.x, y: start.y }] });
      pos = { ...start };
      prevCubicC2 = prevQuadC = null;
    } else {
      break;
    }
    lastCmd = cmd as string;
  }
  return subpaths.filter((s) => s.cmds.length > 1);
}
