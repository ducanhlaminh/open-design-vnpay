// Apply an agent-authored `patch.json` to a draw.io page → the "Đề xuất" page.
//
// The agent NEVER rewrites mxfile XML: it emits a small list of operations
// (relabel / mark / addNode / addEdge / redirectEdge) referencing cell ids from
// `cells.json`, and this module applies them deterministically — geometry for
// new nodes, the fixed colour legend, and the `<object od-change od-finding>`
// wrapper that links every changed cell to its finding are all computed here,
// so the output is always valid XML with a consistent visual language.

import { type CheerioAPI } from 'cheerio';
import { listCells, loadGraph, serializeGraph, styleSet, type MxCellInfo } from './mxfile.js';

export type ChangeKind = 'added' | 'modified' | 'removed';
export type NodeShape = 'action' | 'decision' | 'start' | 'end';
export type Direction = 'below' | 'right' | 'left' | 'above';

export type PatchOp =
  | { op: 'relabel'; cell: string; label: string; finding?: string }
  | { op: 'mark'; cell: string; change: 'modified' | 'removed'; finding?: string }
  | { op: 'addNode'; id: string; shape: NodeShape; label: string; near: string; dir?: Direction; finding?: string }
  | { op: 'addEdge'; id: string; from: string; to: string; label?: string; finding?: string }
  | { op: 'redirectEdge'; edge: string; from?: string; to?: string; finding?: string };

export interface PatchDoc {
  flowId?: string;
  ops: PatchOp[];
}

export interface PatchResult {
  graphXml: string;
  applied: number;
  /** Ops that could not be applied, with the reason — surfaced in index.json. */
  skipped: { op: PatchOp; reason: string }[];
}

/** Fixed colour legend — the same values the web panel documents. */
export const CHANGE_STYLE: Record<ChangeKind, Record<string, string>> = {
  added: { fillColor: '#D5E8D4', strokeColor: '#82B366' },
  modified: { fillColor: '#FFF2CC', strokeColor: '#D6B656' },
  removed: { fillColor: '#F8CECC', strokeColor: '#B85450', dashed: '1' },
};
const EDGE_CHANGE_STYLE: Record<ChangeKind, Record<string, string>> = {
  added: { strokeColor: '#82B366', strokeWidth: '2' },
  modified: { strokeColor: '#D6B656', strokeWidth: '2' },
  removed: { strokeColor: '#B85450', strokeWidth: '2', dashed: '1' },
};
export const CHANGE_LABEL_VI: Record<ChangeKind, string> = {
  added: 'Thêm mới',
  modified: 'Sửa đổi',
  removed: 'Đề nghị bỏ',
};

const SHAPE_STYLE: Record<NodeShape, string> = {
  action: 'rounded=0;whiteSpace=wrap;html=1;',
  decision: 'rhombus;whiteSpace=wrap;html=1;',
  start: 'ellipse;whiteSpace=wrap;html=1;',
  end: 'ellipse;whiteSpace=wrap;html=1;',
};
const SHAPE_SIZE: Record<NodeShape, { w: number; h: number }> = {
  action: { w: 160, h: 60 },
  decision: { w: 150, h: 80 },
  start: { w: 120, h: 50 },
  end: { w: 120, h: 50 },
};
const EDGE_BASE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;';
const GAP = 60;

/** For attribute values inside an XML FRAGMENT string (parsed with
 *  decodeEntities:false, so entities are kept literally). */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** For values passed to cheerio `.attr(k, v)`: the serializer escapes quotes
 *  itself but leaves `&` / `<` alone, so those must be pre-escaped here. */
function escapeAttrSet(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Tolerant parse of the agent's patch.json → PatchDoc (bad ops are dropped,
 *  reported as skipped by `applyPatch`). */
export function parsePatchDoc(raw: string): PatchDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ops: [] };
  }
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const list = Array.isArray(obj.ops) ? obj.ops : Array.isArray(parsed) ? (parsed as unknown[]) : [];
  const ops: PatchOp[] = [];
  for (const item of list) {
    if (item && typeof item === 'object' && typeof (item as { op?: unknown }).op === 'string') ops.push(item as PatchOp);
  }
  return { ...(typeof obj.flowId === 'string' ? { flowId: obj.flowId } : {}), ops };
}

/** Find the element that owns a cell id: the `<object>`/`<UserObject>` wrapper
 *  when there is one, else the `<mxCell>` itself. */
function findOwner($: CheerioAPI, id: string) {
  const esc = id.replace(/["\\]/g, '\\$&');
  const wrapper = $(`object[id="${esc}"], UserObject[id="${esc}"]`).first();
  if (wrapper.length) return { owner: wrapper, cell: wrapper.children('mxCell').first(), wrapped: true };
  const cell = $(`mxCell[id="${esc}"]`).first();
  if (!cell.length) return null;
  const parent = cell.parent();
  const wrapped = parent.length && /^(object|UserObject)$/i.test(String(parent.prop('tagName') ?? ''));
  return wrapped ? { owner: parent, cell, wrapped: true } : { owner: cell, cell, wrapped: false };
}

/** Ensure the cell has an `<object>` wrapper (draw.io custom data) and stamp
 *  `od-change` / `od-finding` on it. Returns the wrapper. */
function stampChange($: CheerioAPI, id: string, change: ChangeKind, finding?: string) {
  const found = findOwner($, id);
  if (!found) return null;
  let wrapper = found.owner;
  if (!found.wrapped) {
    const cell = found.cell;
    // `value` comes back in raw XML form (entities intact) — reuse verbatim.
    const label = cell.attr('value') ?? '';
    cell.removeAttr('id');
    cell.removeAttr('value');
    cell.wrap(`<object id="${escapeXml(id)}" label="${label.replace(/"/g, '&quot;')}"></object>`);
    wrapper = cell.parent();
  }
  wrapper.attr('od-change', change);
  if (finding) wrapper.attr('od-finding', finding);
  return wrapper;
}

function restyleCell($: CheerioAPI, id: string, change: ChangeKind) {
  const found = findOwner($, id);
  if (!found) return false;
  const cell = found.cell;
  const isEdge = cell.attr('edge') === '1';
  const style = cell.attr('style') ?? '';
  cell.attr('style', styleSet(style, isEdge ? EDGE_CHANGE_STYLE[change] : CHANGE_STYLE[change]));
  return true;
}

function setLabel($: CheerioAPI, id: string, label: string) {
  const found = findOwner($, id);
  if (!found) return false;
  if (found.wrapped) found.owner.attr('label', escapeAttrSet(label));
  else found.cell.attr('value', escapeAttrSet(label));
  return true;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: MxCellInfo): boolean {
  if (b.x === undefined || b.y === undefined || b.width === undefined || b.height === undefined) return false;
  return a.x < b.x + b.width && a.x + a.w > b.x && a.y < b.y + b.height && a.y + a.h > b.y;
}

/** Place a new node next to `near`, stepping further in `dir` until it does not
 *  overlap an existing vertex (max 8 steps — after that "slightly ugly but in
 *  the right place" is accepted). */
function placeNear(near: MxCellInfo, size: { w: number; h: number }, dir: Direction, vertices: MxCellInfo[]) {
  const nx = near.x ?? 0;
  const ny = near.y ?? 0;
  const nw = near.width ?? size.w;
  const nh = near.height ?? size.h;
  for (let step = 1; step <= 8; step += 1) {
    const d = GAP * step + (step > 1 ? (dir === 'below' || dir === 'above' ? size.h : size.w) * (step - 1) : 0);
    const pos =
      dir === 'below'
        ? { x: nx + (nw - size.w) / 2, y: ny + nh + d }
        : dir === 'above'
          ? { x: nx + (nw - size.w) / 2, y: ny - d - size.h }
          : dir === 'left'
            ? { x: nx - d - size.w, y: ny + (nh - size.h) / 2 }
            : { x: nx + nw + d, y: ny + (nh - size.h) / 2 };
    const box = { x: pos.x, y: pos.y, w: size.w, h: size.h };
    if (!vertices.some((v) => overlaps(box, v))) return pos;
  }
  const d = GAP;
  return dir === 'below'
    ? { x: nx + (nw - size.w) / 2, y: ny + nh + d }
    : dir === 'above'
      ? { x: nx + (nw - size.w) / 2, y: ny - d - size.h }
      : dir === 'left'
        ? { x: nx - d - size.w, y: ny + (nh - size.h) / 2 }
        : { x: nx + nw + d, y: ny + (nh - size.h) / 2 };
}

function layerOf($: CheerioAPI, id: string): string {
  const found = findOwner($, id);
  const p = found?.cell.attr('parent');
  return p && p !== '0' ? p : '1';
}

/** Append the colour legend (top-left of the drawing) so someone opening the
 *  file in draw.io itself understands the colours without the web panel. */
function appendLegend($: CheerioAPI, vertices: MxCellInfo[]) {
  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  const minX = xs.length ? Math.min(...xs) : 0;
  const minY = ys.length ? Math.min(...ys) : 0;
  const x0 = minX;
  const y0 = minY - 130;
  const root = $('root').first();
  if (!root.length) return;
  const items: ChangeKind[] = ['added', 'modified', 'removed'];
  const cells: string[] = [];
  cells.push(
    `<mxCell id="od-legend-title" value="Chú giải đề xuất UX" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="${x0}" y="${y0}" width="200" height="24" as="geometry"/></mxCell>`,
  );
  items.forEach((k, i) => {
    const st = styleSet('rounded=0;whiteSpace=wrap;html=1;fontSize=11;', CHANGE_STYLE[k]);
    cells.push(
      `<mxCell id="od-legend-${k}" value="${escapeXml(CHANGE_LABEL_VI[k])}" style="${st}" vertex="1" parent="1"><mxGeometry x="${x0 + i * 130}" y="${y0 + 30}" width="120" height="30" as="geometry"/></mxCell>`,
    );
  });
  root.append(cells.join('\n'));
}

/** Apply `patch` to a decoded page → new page XML (the input is not mutated). */
export function applyPatch(graphXml: string, patch: PatchDoc): PatchResult {
  const $ = loadGraph(graphXml);
  const skipped: PatchResult['skipped'] = [];
  let applied = 0;
  let cells = listCells(graphXml);
  const has = (id: string) => cells.some((c) => c.id === id);
  const refresh = () => {
    cells = listCells(serializeGraph($));
  };
  const root = $('root').first();
  if (!root.length) return { graphXml, applied: 0, skipped: patch.ops.map((op) => ({ op, reason: 'page has no <root>' })) };

  for (const op of patch.ops) {
    switch (op.op) {
      case 'relabel': {
        if (!has(op.cell)) {
          skipped.push({ op, reason: `cell "${op.cell}" not found` });
          break;
        }
        stampChange($, op.cell, 'modified', op.finding);
        setLabel($, op.cell, op.label);
        restyleCell($, op.cell, 'modified');
        applied += 1;
        break;
      }
      case 'mark': {
        if (!has(op.cell)) {
          skipped.push({ op, reason: `cell "${op.cell}" not found` });
          break;
        }
        const change: ChangeKind = op.change === 'removed' ? 'removed' : 'modified';
        stampChange($, op.cell, change, op.finding);
        restyleCell($, op.cell, change);
        applied += 1;
        break;
      }
      case 'addNode': {
        if (!op.id || has(op.id)) {
          skipped.push({ op, reason: `node id "${op.id}" missing or already used` });
          break;
        }
        const near = cells.find((c) => c.id === op.near && c.kind === 'vertex');
        if (!near) {
          skipped.push({ op, reason: `near cell "${op.near}" not found or not a vertex` });
          break;
        }
        const shape: NodeShape = (['action', 'decision', 'start', 'end'] as NodeShape[]).includes(op.shape) ? op.shape : 'action';
        const size =
          shape === 'action' && near.width && near.height && !/rhombus|ellipse/.test(near.style)
            ? { w: near.width, h: near.height }
            : SHAPE_SIZE[shape];
        const pos = placeNear(near, size, op.dir ?? 'below', cells.filter((c) => c.kind === 'vertex'));
        const style = styleSet(SHAPE_STYLE[shape], CHANGE_STYLE.added);
        const parent = layerOf($, near.id);
        root.append(
          `<object id="${escapeXml(op.id)}" label="${escapeXml(op.label ?? '')}" od-change="added"${op.finding ? ` od-finding="${escapeXml(op.finding)}"` : ''}>` +
            `<mxCell style="${style}" vertex="1" parent="${escapeXml(parent)}">` +
            `<mxGeometry x="${Math.round(pos.x)}" y="${Math.round(pos.y)}" width="${size.w}" height="${size.h}" as="geometry"/>` +
            `</mxCell></object>`,
        );
        applied += 1;
        refresh();
        break;
      }
      case 'addEdge': {
        if (!op.id || has(op.id)) {
          skipped.push({ op, reason: `edge id "${op.id}" missing or already used` });
          break;
        }
        if (!has(op.from) || !has(op.to)) {
          skipped.push({ op, reason: `edge endpoints "${op.from}" → "${op.to}" not found` });
          break;
        }
        const style = styleSet(EDGE_BASE_STYLE, EDGE_CHANGE_STYLE.added);
        const parent = layerOf($, op.from);
        root.append(
          `<object id="${escapeXml(op.id)}" label="${escapeXml(op.label ?? '')}" od-change="added"${op.finding ? ` od-finding="${escapeXml(op.finding)}"` : ''}>` +
            `<mxCell style="${style}" edge="1" parent="${escapeXml(parent)}" source="${escapeXml(op.from)}" target="${escapeXml(op.to)}">` +
            `<mxGeometry relative="1" as="geometry"/>` +
            `</mxCell></object>`,
        );
        applied += 1;
        refresh();
        break;
      }
      case 'redirectEdge': {
        const edge = cells.find((c) => c.id === op.edge && c.kind === 'edge');
        if (!edge) {
          skipped.push({ op, reason: `edge "${op.edge}" not found` });
          break;
        }
        if ((op.from && !has(op.from)) || (op.to && !has(op.to))) {
          skipped.push({ op, reason: `redirect target not found` });
          break;
        }
        const found = findOwner($, op.edge);
        if (!found) {
          skipped.push({ op, reason: `edge "${op.edge}" not found` });
          break;
        }
        if (op.from) found.cell.attr('source', op.from);
        if (op.to) found.cell.attr('target', op.to);
        stampChange($, op.edge, 'modified', op.finding);
        restyleCell($, op.edge, 'modified');
        applied += 1;
        break;
      }
      default:
        skipped.push({ op, reason: `unknown op "${String((op as { op?: unknown }).op)}"` });
    }
  }
  if (applied > 0) appendLegend($, cells.filter((c) => c.kind === 'vertex'));
  return { graphXml: serializeGraph($), applied, skipped };
}
