// flowchart-to-flow — chuyển sơ đồ khối `flows/<FLOW-ID>.flowchart.json` (bước
// dr-flow: node tường minh start/action/decision/end, action có thể mang
// `screen` = SCREEN-KEY) sang FlowDoc của tab Flow bên ux, nơi node LÀ MÀN
// HÌNH có thumbnail wireframe. Nhờ đó tab "Flow màn hình" của FlowchartPreview
// vẽ bằng đúng bộ node dùng chung (SpecFlowCanvas) thay vì thêm một canvas nữa.
//
// Ý tưởng: người đọc muốn thấy "đi qua những màn nào" chứ không phải từng cú
// bấm; các action liên tiếp trên cùng một màn vì thế gộp lại thành MỘT node
// màn, còn nhãn của chúng dồn sang cạnh đi ra để không mất thông tin.
//
// Module thuần (không React, không I/O) để test được.

import type { FlowchartDoc, FlowchartEdge, FlowchartNode } from './FlowchartPreview';
import type { FlowDoc, FlowDocNode } from './SpecFlowCanvas';

export interface FlowchartScreen {
  /** SCREEN-KEY — cũng là id node màn trong FlowDoc và tên file wireframe. */
  id: string;
  /** Tên hiển thị (từ `flows/index.json`), fallback = SCREEN-KEY. */
  name: string;
}

export interface FlowchartToFlowResult {
  flow: FlowDoc;
  /** Các màn theo thứ tự gặp khi đi BFS từ start; rỗng nếu file không gán màn. */
  screens: FlowchartScreen[];
}

/** Node nào được gộp thành màn: `action` (và `start` khi chính nó là một màn)
 *  mang `screen`. `decision`/`end` giữ nguyên dù có `screen` — hình thoi và
 *  oval kết thúc là ký pháp người đọc cần thấy. */
function screenKeyOf(node: FlowchartNode | undefined): string | undefined {
  if (!node || !node.screen) return undefined;
  return node.type === 'action' || node.type === 'start' ? node.screen : undefined;
}

/**
 * Chuyển FlowchartDoc → FlowDoc.
 *
 * Thuật toán gộp:
 * 1. Mỗi node có `screen` (action/start) ánh xạ sang node màn `id = SCREEN-KEY`;
 *    mọi node cùng key là cùng một màn. decision/end giữ id gốc; start/action
 *    không có screen thành node `nav` (xám, ngoài feature).
 * 2. Cạnh mà hai đầu cùng một màn là cạnh NỘI BỘ cụm → biến mất sau gộp; mọi
 *    cạnh khác giữ nguyên (đầu mút đổi sang id đã gộp) — không mất nhánh.
 * 3. Cạnh đi ra khỏi cụm mà không có nhãn gốc nhận nhãn = chuỗi nhãn action
 *    trong cụm dẫn tới điểm ra (lần ngược cạnh nội bộ tới điểm vào cụm), nối
 *    bằng " → "; cạnh có nhãn gốc giữ nguyên nhãn đó.
 * 4. `entry` = màn đầu tiên gặp theo BFS từ start; không có màn → undefined.
 */
export function flowchartToFlowDoc(
  doc: FlowchartDoc,
  names: Record<string, string> = {},
): FlowchartToFlowResult {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const keyOf = (id: string) => screenKeyOf(byId.get(id));
  const mergedId = (id: string) => keyOf(id) ?? id;
  const isInternal = (e: FlowchartEdge) => {
    const a = keyOf(e.from);
    return !!a && a === keyOf(e.to);
  };

  // Điểm vào cụm = node màn có cạnh tới từ NGOÀI cụm (hoặc là start). Lần
  // ngược nhãn action dừng ở đây, để nhãn của một nhánh quay lại (báo lỗi →
  // nhập lại) không bị kéo vào nhãn của cạnh đi thẳng.
  const internalPreds = new Map<string, string[]>();
  const entryNodes = new Set<string>();
  for (const e of doc.edges) {
    if (isInternal(e)) internalPreds.set(e.to, [...(internalPreds.get(e.to) ?? []), e.from]);
    else if (keyOf(e.to)) entryNodes.add(e.to);
  }
  for (const n of doc.nodes) if (n.type === 'start' && keyOf(n.id)) entryNodes.add(n.id);

  const pathLabel = (exit: string): string | undefined => {
    const path = [exit];
    const visited = new Set(path);
    let cur = exit;
    while (!entryNodes.has(cur)) {
      const pred = (internalPreds.get(cur) ?? []).find((p) => !visited.has(p));
      if (!pred) break;
      path.unshift(pred);
      visited.add(pred);
      cur = pred;
    }
    // Chỉ nhãn ACTION: nhãn của một start-là-màn ("Trang chủ") là tên nơi
    // đứng, không phải việc làm.
    const labels = path.map((id) => byId.get(id)!).filter((n) => n.type === 'action').map((n) => n.label);
    return labels.length ? labels.join(' → ') : undefined;
  };

  const nodes: FlowDocNode[] = [];
  const seenScreens = new Set<string>();
  for (const n of doc.nodes) {
    const key = screenKeyOf(n);
    if (key) {
      if (seenScreens.has(key)) continue;
      seenScreens.add(key);
      nodes.push({ id: key, kind: 'screen', label: names[key] ?? key, screen: key });
    } else if (n.type === 'decision') {
      nodes.push({ id: n.id, kind: 'decision', label: n.label });
    } else if (n.type === 'end') {
      nodes.push({ id: n.id, kind: 'end', label: n.label });
    } else {
      nodes.push({ id: n.id, kind: 'nav', label: n.label });
    }
  }

  const edges: NonNullable<FlowDoc['edges']> = [];
  for (const e of doc.edges) {
    if (isInternal(e)) continue;
    const label = e.label ?? (keyOf(e.from) ? pathLabel(e.from) : undefined);
    edges.push({ from: mergedId(e.from), to: mergedId(e.to), ...(label ? { label } : {}) });
  }

  // Thứ tự màn = thứ tự gặp khi BFS từ start (không có start → node không ai
  // trỏ vào → node đầu). Màn không với tới được vẫn liệt kê ở cuối.
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>(doc.nodes.map((n) => [n.id, 0]));
  for (const e of doc.edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const starts = doc.nodes.filter((n) => n.type === 'start').map((n) => n.id);
  const roots = starts.length ? starts : doc.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const queue = roots.length ? [...roots] : doc.nodes.slice(0, 1).map((n) => n.id);
  const visited = new Set<string>();
  const screens: FlowchartScreen[] = [];
  const pushScreen = (key: string | undefined) => {
    if (key && !screens.some((s) => s.id === key)) screens.push({ id: key, name: names[key] ?? key });
  };
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    pushScreen(keyOf(id));
    for (const to of out.get(id) ?? []) queue.push(to);
  }
  for (const n of doc.nodes) pushScreen(screenKeyOf(n));

  const flow: FlowDoc = {
    id: doc.id,
    ...(doc.title ? { name: doc.title } : {}),
    ...(screens[0] ? { entry: screens[0].id } : {}),
    nodes,
    edges,
  };
  return { flow, screens };
}
