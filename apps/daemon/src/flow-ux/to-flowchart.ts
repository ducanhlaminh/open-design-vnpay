// Derive `flows/<FLOW-ID>.flowchart.json` (the frozen schema dr-comp / dr-review
// / the web FlowchartPreview consume) from a diagram SOURCE — a decoded draw.io
// page or a Mermaid flowchart — instead of asking the LLM to re-draw it from
// prose. Edges are explicit in both sources, shapes map to the four node
// types by a small heuristic, and the agent only contributes `screens.json`
// (cell id → SCREEN-KEY) which is merged here.

import { listCells, styleGet, styleHas, type MxCellInfo } from './mxfile.js';

export type FlowchartNodeType = 'start' | 'end' | 'action' | 'decision';
export interface FlowchartNode {
  id: string;
  type: FlowchartNodeType;
  label: string;
  screen?: string;
}
export interface FlowchartEdge {
  from: string;
  to: string;
  label?: string;
}
export interface FlowchartDoc {
  id: string;
  title: string;
  source: string;
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
}

interface RawGraph {
  nodes: { id: string; label: string; shape: 'terminal' | 'decision' | 'process' }[];
  edges: FlowchartEdge[];
}

/** Sự cố #5d13309f: sơ đồ kiểu sequence (UML) đặt thao tác trên CẠNH, không
 *  trên đỉnh, nên `screens.json` của agent hợp lệ trỏ vào một id cạnh —
 *  daemon trước đây âm thầm loại bỏ vì chỉ khớp id đỉnh. Quy mapping-vào-cạnh
 *  về đỉnh ĐÍCH của cạnh đó (người dùng vừa đi TỚI đâu thì đó là màn hình);
 *  đích không dùng được (không tồn tại / là decision) thì lùi về đỉnh NGUỒN.
 *  Tách thành hàm thuần để `index.ts` gọi lại với cùng input và lấy đúng
 *  danh sách `dropped` cho báo cáo, mà không phải đổi shape `FlowchartDoc`.
 *
 *  WP9b, 2 bổ sung:
 *  - Cạnh TRÔI (sơ đồ sequence vẽ theo toạ độ giữa các lifeline, mxCell
 *    không có source/target) có id THẬT nhưng không quy được về đỉnh nào —
 *    trước đây lẫn vào "không có trong sơ đồ" (id sai), gây hiểu nhầm; giờ
 *    có lý do riêng.
 *  - Mỗi ĐỈNH chỉ mang MỘT màn: khi hai khoá của `screens` cùng quy về một
 *    node (trực tiếp hoặc qua cạnh), trước đây khoá đến sau ghi đè khoá đến
 *    trước ÂM THẦM (`byNode[target] = key` không kiểm tra đã có giá trị) —
 *    ví dụ tái hiện: `{e1:'doc__MH1', b:'doc__MH2'}` với cạnh `e1: a→b` thì
 *    `doc__MH1` biến mất không lý do. Giờ ưu tiên mapping TRỎ THẲNG vào node
 *    hơn suy ra từ cạnh; cùng loại thì giữ khoá ĐẾN TRƯỚC theo thứ tự
 *    `Object.entries(screens)` duyệt — khoá thua vào `dropped` có lý do.
 *    WP9c: thứ tự đó KHÔNG LUÔN LÀ thứ tự soạn thảo trong `screens` — id
 *    dạng số nguyên thuần ("2", "10") là "khoá chỉ số mảng" theo đặc tả
 *    JS, `Object.entries` duyệt chúng theo thứ tự SỐ TĂNG DẦN trước mọi
 *    khoá chuỗi khác (JS Spec §OrdinaryOwnPropertyKeys), bất kể vị trí
 *    trong object literal — vẫn tất định, chỉ không phải thứ tự soạn thảo.
 *    Id draw.io thật dạng UUID-prefix (`wLl92Z-3KRblUW1EAXX-1`) không phải
 *    khoá chỉ số nên không bị ảnh hưởng. */
export function resolveScreenCells(
  input: { nodes: Array<{ id: string; type: FlowchartNodeType }>; edges: Array<{ id?: string; from?: string | undefined; to?: string | undefined }> },
  screens: Record<string, string>,
): { byNode: Record<string, string>; dropped: Array<{ cell: string; key: string; reason: string }> } {
  const nodeType = new Map(input.nodes.map((n) => [n.id, n.type]));
  const edgeById = new Map<string, { from?: string | undefined; to?: string | undefined }>();
  for (const e of input.edges) if (e.id) edgeById.set(e.id, { from: e.from, to: e.to });
  const usable = (id: string) => nodeType.has(id) && nodeType.get(id) !== 'decision';
  const dropped: Array<{ cell: string; key: string; reason: string }> = [];

  type Candidate = { cell: string; key: string; direct: boolean };
  const byTargetNode = new Map<string, Candidate>();
  const registerCandidate = (node: string, cand: Candidate) => {
    const existing = byTargetNode.get(node);
    if (!existing) {
      byTargetNode.set(node, cand);
      return;
    }
    // `existing` luôn đến trước `cand` (ta xử lý theo thứ tự `Object.entries`
    // duyệt `screens` — xem docblock trên hàm về ngoại lệ id dạng số nguyên
    // thuần) — chỉ cần so ưu tiên: trỏ thẳng vào node thắng cạnh suy ra;
    // cùng loại thì giữ cái đến trước.
    if (!existing.direct && cand.direct) {
      dropped.push({ cell: existing.cell, key: existing.key, reason: `node "${node}" đã gắn màn "${cand.key}" — mỗi bước chỉ mang một màn` });
      byTargetNode.set(node, cand);
    } else {
      dropped.push({ cell: cand.cell, key: cand.key, reason: `node "${node}" đã gắn màn "${existing.key}" — mỗi bước chỉ mang một màn` });
    }
  };

  for (const [cell, key] of Object.entries(screens)) {
    if (nodeType.has(cell)) {
      if (!usable(cell)) {
        dropped.push({ cell, key, reason: 'node loại quyết định (decision) không phải màn' });
        continue;
      }
      registerCandidate(cell, { cell, key, direct: true });
      continue;
    }
    const edge = edgeById.get(cell);
    if (!edge) {
      dropped.push({ cell, key, reason: 'không có trong sơ đồ' });
      continue;
    }
    if (!edge.from && !edge.to) {
      dropped.push({ cell, key, reason: 'là cạnh không nối hai đỉnh (sơ đồ kiểu sequence)' });
      continue;
    }
    const target = edge.to && usable(edge.to) ? edge.to : edge.from && usable(edge.from) ? edge.from : null;
    if (!target) {
      dropped.push({ cell, key, reason: 'là cạnh nhưng hai đầu không phải bước dùng được' });
      continue;
    }
    registerCandidate(target, { cell, key, direct: false });
  }

  const byNode: Record<string, string> = {};
  for (const [node, cand] of byTargetNode) byNode[node] = cand.key;
  return { byNode, dropped };
}

function finish(
  raw: RawGraph,
  meta: { id: string; title: string; source: string },
  screens: Record<string, string>,
  // WP9c: `from`/`to` optional — cạnh TRÔI (draw.io, không source/target)
  // vẫn có mặt trong bảng này (xem `drawioPageToFlowchart`) để
  // `resolveScreenCells` nội bộ tự phân loại đúng lý do, nhất quán với
  // `edgesForDrop` ở `flow-ux/index.ts`.
  edgeById: Record<string, { from?: string | undefined; to?: string | undefined }> = {},
): FlowchartDoc {
  const ids = new Set(raw.nodes.map((n) => n.id));
  const edges = raw.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const indeg = new Map<string, number>();
  const outdeg = new Map<string, number>();
  for (const e of edges) {
    outdeg.set(e.from, (outdeg.get(e.from) ?? 0) + 1);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const typed = raw.nodes.map((n) => {
    let type: FlowchartNodeType;
    if (n.shape === 'decision') type = 'decision';
    else if (n.shape === 'terminal') type = (indeg.get(n.id) ?? 0) === 0 ? 'start' : (outdeg.get(n.id) ?? 0) === 0 ? 'end' : 'action';
    else type = 'action';
    return { id: n.id, type, label: n.label };
  });
  const { byNode } = resolveScreenCells(
    { nodes: typed.map(({ id, type }) => ({ id, type })), edges: Object.entries(edgeById).map(([id, e]) => ({ id, ...e })) },
    screens,
  );
  const nodes: FlowchartNode[] = typed.map((n) => {
    const node: FlowchartNode = { id: n.id, type: n.type, label: n.label };
    const screen = byNode[n.id];
    if (screen) node.screen = screen;
    return node;
  });
  // A flow with no ellipse at all still needs a start: the first node with
  // no incoming edge, else the first node.
  if (nodes.length && !nodes.some((n) => n.type === 'start')) {
    const first = nodes.find((n) => (indeg.get(n.id) ?? 0) === 0) ?? nodes[0]!;
    if (first.type !== 'decision') first.type = 'start';
  }
  return { ...meta, nodes, edges };
}

/* ── draw.io ─────────────────────────────────────────────────────────────── */

const TERMINAL_STYLE = /(^|;)(ellipse|shape=ellipse|shape=mxgraph\.flowchart\.(start_1|start_2|terminator)|shape=terminator)(;|$)/;
const DECISION_STYLE = /(^|;)(rhombus|shape=rhombus|shape=mxgraph\.flowchart\.decision)(;|$)/;

function shapeOf(c: MxCellInfo): RawGraph['nodes'][number]['shape'] {
  if (DECISION_STYLE.test(c.style)) return 'decision';
  if (TERMINAL_STYLE.test(c.style)) return 'terminal';
  return 'process';
}

/** Vertices that are drawing furniture, not flow steps. */
function isFurniture(c: MxCellInfo, edgeIds: Set<string>, parentOf: Map<string, string | undefined>): boolean {
  if (c.id.startsWith('od-legend-')) return true;
  if (styleHas(c.style, 'swimlane') || styleHas(c.style, 'group') || styleGet(c.style, 'shape') === 'swimlane') return true;
  // Edge labels are vertices parented to an edge.
  const p = parentOf.get(c.id);
  if (p && edgeIds.has(p)) return true;
  // Free text with no label content is a note, not a step; free text WITH a
  // label but no edges is an annotation.
  if (styleHas(c.style, 'text') && !c.label) return true;
  return false;
}

/** Decoded draw.io page → flowchart doc. `screens` maps cell id → SCREEN-KEY. */
export function drawioPageToFlowchart(
  graphXml: string,
  meta: { id: string; title: string; source: string },
  screens: Record<string, string> = {},
): FlowchartDoc {
  const cells = listCells(graphXml);
  const edgeIds = new Set(cells.filter((c) => c.kind === 'edge').map((c) => c.id));
  // listCells does not expose `parent`; recover it cheaply for edge-label detection.
  const parentOf = new Map<string, string | undefined>();
  for (const m of graphXml.matchAll(/<mxCell\b([^>]*)>/g)) {
    const attrs = m[1] ?? '';
    const id = /\bid="([^"]*)"/.exec(attrs)?.[1];
    const parent = /\bparent="([^"]*)"/.exec(attrs)?.[1];
    if (id) parentOf.set(id, parent);
  }
  const edgeSet = new Set<string>();
  const connected = new Set<string>();
  for (const c of cells) if (c.kind === 'edge' && c.source && c.target) {
    connected.add(c.source);
    connected.add(c.target);
  }
  const nodes: RawGraph['nodes'] = [];
  for (const c of cells) {
    if (c.kind !== 'vertex') continue;
    if (isFurniture(c, edgeIds, parentOf)) continue;
    // Text-only annotations that no edge touches are not steps.
    if (styleHas(c.style, 'text') && !connected.has(c.id)) continue;
    if (!c.label && !connected.has(c.id)) continue;
    nodes.push({ id: c.id, label: c.label || '(không nhãn)', shape: shapeOf(c) });
  }
  const edges: FlowchartEdge[] = [];
  // Bảng id cạnh → {from,to}: draw.io có id cạnh thật (khác Mermaid), dùng để
  // quy mapping-vào-cạnh của agent về node (xem resolveScreenCells). WP9c:
  // ghi MỌI cạnh vào đây, kể cả cạnh TRÔI (sơ đồ sequence, không
  // source/target) — nhất quán với `edgesForDrop` ở `flow-ux/index.ts`
  // (WP9b) để `resolveScreenCells` nội bộ của `finish()` tự phân loại đúng
  // lý do ("là cạnh không nối hai đỉnh") thay vì lọc trước làm mất lý do đó
  // (kết quả `dropped` của lượt gọi nội bộ này không dùng cho warnings —
  // chỉ để JSDoc không nói một đằng code làm một nẻo). `edges`/`edgeSet`
  // (đồ thị thật) vẫn CHỈ nhận cạnh có đủ hai đầu như cũ.
  const edgeById: Record<string, { from?: string | undefined; to?: string | undefined }> = {};
  for (const c of cells) {
    if (c.kind !== 'edge') continue;
    edgeById[c.id] = { from: c.source, to: c.target };
    if (!c.source || !c.target) continue;
    const key = `${c.source}→${c.target}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    edges.push(c.label ? { from: c.source, to: c.target, label: c.label } : { from: c.source, to: c.target });
  }
  return finish({ nodes, edges }, meta, screens, edgeById);
}

/* ── Mermaid flowchart ───────────────────────────────────────────────────── */

const NODE_RE =
  /([A-Za-z0-9_][A-Za-z0-9_-]*)(?:\s*(\(\[|\[\[|\[\(|\(\(|\[\/|\[\\|\{\{|>|\[|\(|\{)\s*("(?:[^"\\]|\\.)*"|[^\]\)\}]*?)\s*(\]\)|\]\]|\)\]|\)\)|\/\]|\\\]|\}\}|\]|\)|\}))?/y;

function cleanMermaidLabel(raw: string, fallback: string): string {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  s = s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/#quot;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return s || fallback;
}

function mermaidShape(open: string | undefined): RawGraph['nodes'][number]['shape'] {
  if (!open) return 'process';
  if (open === '{' || open === '{{') return 'decision';
  if (open === '([' || open === '((') return 'terminal';
  return 'process';
}

/** Parse the subset of Mermaid `flowchart`/`graph` syntax real URDs use: node
 *  definitions with the common shapes, `-->`/`---`/`-.->`/`==>` links with
 *  `|label|` or `-- label -->` labels, chains and `&` fan-out. Directives,
 *  subgraph wrappers, classDef/class/style/click/linkStyle lines are ignored.
 *  Returns null when the text is not a flowchart at all. */
export function mermaidToFlowchart(
  text: string,
  meta: { id: string; title: string; source: string },
  screens: Record<string, string> = {},
): FlowchartDoc | null {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/%%.*$/, '').trim())
    .filter(Boolean);
  const head = lines.findIndex((l) => /^(flowchart|graph)\b/i.test(l));
  if (head === -1) return null;
  const nodes = new Map<string, RawGraph['nodes'][number]>();
  const edges: FlowchartEdge[] = [];
  const order: string[] = [];

  const defineNode = (id: string, open: string | undefined, label: string | undefined) => {
    const existing = nodes.get(id);
    if (existing) {
      if (open && label !== undefined) {
        existing.label = cleanMermaidLabel(label, id);
        existing.shape = mermaidShape(open);
      }
      return;
    }
    nodes.set(id, { id, label: open && label !== undefined ? cleanMermaidLabel(label, id) : id, shape: mermaidShape(open) });
    order.push(id);
  };

  // Link tokens, labelled forms first (`-- text -->`, `-. text .->`,
  // `== text ==>`), then the plain arrows. Sticky regexes anchored at `pos`.
  const LABELLED = [
    /-{2,}\s*(?![->|])([\s\S]*?)\s*-{2,}>/y,
    /-\.\s*(?![-.>])([\s\S]*?)\s*\.->/y,
    /={2,}\s*(?![=>])([\s\S]*?)\s*={2,}>/y,
  ];
  const PLAIN = /<?-{2,}>?|<?-\.+->?|<?={2,}>?/y;
  const readLink = (line: string, at: number): { end: number; label?: string } | null => {
    for (const re of LABELLED) {
      re.lastIndex = at;
      const m = re.exec(line);
      if (m && m.index === at) return { end: re.lastIndex, label: cleanMermaidLabel(m[1] ?? '', '') };
    }
    PLAIN.lastIndex = at;
    const m = PLAIN.exec(line);
    if (m && m.index === at) return { end: PLAIN.lastIndex };
    return null;
  };

  for (const line of lines.slice(head + 1)) {
    if (/^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/i.test(line)) continue;
    let pos = 0;
    let prevGroup: string[] | null = null;
    let pendingLabel: string | undefined;
    for (let guard = 0; guard < 200 && pos < line.length; guard += 1) {
      // node group
      const group: string[] = [];
      for (;;) {
        NODE_RE.lastIndex = pos;
        const m = NODE_RE.exec(line);
        if (!m || m.index !== pos || !m[1]) break;
        defineNode(m[1], m[2], m[3]);
        group.push(m[1]);
        pos = NODE_RE.lastIndex;
        const amp = /\s*&\s*/y;
        amp.lastIndex = pos;
        const a = amp.exec(line);
        if (a && a.index === pos) {
          pos = amp.lastIndex;
          continue;
        }
        break;
      }
      if (!group.length) break;
      if (prevGroup) {
        for (const from of prevGroup) for (const to of group) edges.push(pendingLabel ? { from, to, label: pendingLabel } : { from, to });
      }
      prevGroup = group;
      pendingLabel = undefined;
      // link token (skip leading whitespace)
      const ws = /\s*/y;
      ws.lastIndex = pos;
      ws.exec(line);
      pos = ws.lastIndex;
      const link = readLink(line, pos);
      if (!link) break;
      pos = link.end;
      if (link.label) pendingLabel = link.label;
      // Mermaid also allows `-->|label|` right after the arrow.
      const tail = /\s*\|([^|]*)\|\s*/y;
      tail.lastIndex = pos;
      const t = tail.exec(line);
      if (t && t.index === pos) {
        pendingLabel = cleanMermaidLabel(t[1] ?? '', '');
        pos = tail.lastIndex;
      }
      ws.lastIndex = pos;
      ws.exec(line);
      pos = ws.lastIndex;
      if (pendingLabel === '') pendingLabel = undefined;
    }
  }
  if (!nodes.size) return null;
  const seen = new Set<string>();
  const dedup = edges.filter((e) => {
    const k = `${e.from}→${e.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return finish({ nodes: order.map((id) => nodes.get(id)!), edges: dedup }, meta, screens);
}
