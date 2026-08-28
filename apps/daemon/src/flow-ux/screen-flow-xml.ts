// WP-screen-flow (2026-08-27) — stage `dr-flow` đổi vai: "Đánh giá luồng UX"
// (review sơ đồ có sẵn) → "Luồng màn hình" (SINH screen-flow của tính năng từ
// tài liệu, skill `docs-screen-flow`). Agent ghi MỘT fragment mxCell trần
// (conventions vendor từ next-ai-draw-io, Apache-2.0 — xem SKILL.md của
// docs-screen-flow) + `screens.json` (schema cũ, không đổi). Module này là
// bước dịch phía daemon, chạy NGAY TRƯỚC `finalizeFlowUx`:
//
//   flows/SCREEN-FLOW/screen-flow.cells.xml  (agent, mxCell trần)
//     → wrap thành mxGraphModel + VALIDATE deterministic (thay vòng VLM của
//       next-ai-draw-io: id trùng, cạnh trỏ node ma, thiếu geometry, node đè
//       nhau, hai cạnh trùng path, reachability)
//     → flows/SCREEN-FLOW/as-is.drawio (mxfile thật, designer mở/kéo được)
//     → chuyển sơ đồ seed vào flows/_seeds/ + thu _inputs.json về đúng một
//       entry `SCREEN-FLOW` (kind 'drawio') — index cuối chỉ còn luồng màn
//
// Nhờ đó finalizeFlowUx hiện có nhìn thấy một flow drawio bình thường và tự
// làm nốt phần còn lại (drawioPageToFlowchart → flowchart.json, screens.json
// → index.json[].screens, screensDropped…) — dr-comp / dr-review / dr-screens
// KHÔNG phải đổi một dòng nào. Không có cells.xml (dự án cũ, hoặc skill khác)
// → { found: false }, mọi thứ chạy như trước.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DiscoveredDoc } from '../screen-components.js';
import { decodeMxfile, encodeMxfile, listCells, styleGet, type MxCellInfo, type MxPage } from './mxfile.js';
import { deriveCellsAndNames, parseScreenFlowScreensV2, toDiscoveredDocs, type ScreenPlatform, type ScreensV2 } from './screen-flow-screens.js';
import { PLATFORM_KEY_SUFFIX_RE } from '../screen-groups.js';
import { isLegendCellId } from './to-flowchart.js';

export const SCREEN_FLOW_ID = 'SCREEN-FLOW';
export const SCREEN_FLOW_CELLS_FILE = 'screen-flow.cells.xml';

// ── WP screen-flow-platform-split (2026-08-28) ────────────────────────────
// Tài liệu MỘT nền tảng → đúng một flow `SCREEN-FLOW` (output byte-identical
// như trước). Tài liệu ≥2 nền tảng (MB + IB, app + BO web…) → agent viết HAI
// flow tự đủ `flows/SCREEN-FLOW--app/` + `flows/SCREEN-FLOW--web/`, KHÔNG còn
// `flows/SCREEN-FLOW/` (trộn lẫn = lỗi SCREEN_FLOW_MIXED). Nền tảng của từng
// màn do AGENT quyết từ cách tài liệu viết — daemon chỉ validate giá trị và
// sự khớp với thư mục, không suy từ heading, không ghi đè.
export const SCREEN_FLOW_ID_RE = /^SCREEN-FLOW(--(app|web))?$/;

export function isScreenFlowId(id: string): boolean {
  return SCREEN_FLOW_ID_RE.test(id);
}

/** `SCREEN-FLOW--app` → `app`; `SCREEN-FLOW--web` → `web`; `SCREEN-FLOW`/khác → null. */
export function screenFlowPlatformOf(id: string): ScreenPlatform | null {
  const m = SCREEN_FLOW_ID_RE.exec(id);
  return m?.[2] === 'app' || m?.[2] === 'web' ? m[2] : null;
}

/** `app` → `SCREEN-FLOW--app`, `web` → `SCREEN-FLOW--web`, null → `SCREEN-FLOW`. */
export function screenFlowIdFor(platform: ScreenPlatform | null | undefined): string {
  return platform ? `${SCREEN_FLOW_ID}--${platform}` : SCREEN_FLOW_ID;
}

export function screenFlowPlatformLabel(platform: ScreenPlatform | null | undefined): string | null {
  return platform === 'app' ? 'App' : platform === 'web' ? 'Web' : null;
}

/** Tiêu đề entry index/manifest: flow tách → "Luồng màn hình (App) — <tên>"
 *  (title agent đã có "(App)"/"(Web)" thì giữ); flow đơn → nguyên văn. */
export function screenFlowTitleFor(title: string, platform: ScreenPlatform | null): string {
  const label = screenFlowPlatformLabel(platform);
  if (!label) return title;
  if (/\((App|Web)\)/.test(title)) return title;
  const m = /^Luồng màn hình\s*(.*)$/u.exec(title);
  if (m) return `Luồng màn hình (${label})${m[1] ? ` ${m[1]}` : ''}`;
  return `Luồng màn hình (${label}) — ${title}`;
}

export class ScreenFlowMixedError extends Error {
  readonly code = 'SCREEN_FLOW_MIXED';
  constructor(ids: string[]) {
    super(
      `SCREEN_FLOW_MIXED: trộn lẫn flows/${SCREEN_FLOW_ID}/ với flow tách theo nền tảng (${ids.join(', ')}) — tài liệu ≥2 nền tảng CHỈ dùng flows/${SCREEN_FLOW_ID}--app/ + flows/${SCREEN_FLOW_ID}--web/, một nền tảng CHỈ dùng flows/${SCREEN_FLOW_ID}/`,
    );
  }
}

/** Các id khớp `SCREEN_FLOW_ID_RE` dưới `flows/` có `screen-flow.cells.xml`
 *  hoặc `as-is.drawio` — thứ tự ổn định (`SCREEN-FLOW`, `--app`, `--web`).
 *  Trộn `SCREEN-FLOW` với `--app/--web` → throw `ScreenFlowMixedError`. */
export async function listScreenFlowIds(cwd: string): Promise<string[]> {
  const flowsDir = path.join(cwd, 'flows');
  const dirents = await fs.readdir(flowsDir, { withFileTypes: true }).catch(() => []);
  const ids: string[] = [];
  for (const d of dirents) {
    if (!d.isDirectory() || !isScreenFlowId(d.name)) continue;
    const dir = path.join(flowsDir, d.name);
    const has = async (f: string) => fs.stat(path.join(dir, f)).then((s) => s.isFile()).catch(() => false);
    if ((await has(SCREEN_FLOW_CELLS_FILE)) || (await has('as-is.drawio'))) ids.push(d.name);
  }
  ids.sort((a, b) => a.localeCompare(b));
  if (ids.includes(SCREEN_FLOW_ID) && ids.length > 1) throw new ScreenFlowMixedError(ids);
  return ids;
}

// ── WP dr-flow-improve (2026-08-27): file trạng thái của bản "Cải thiện" ──
// Đặt ở đây (không phải screen-flow-improve.ts) vì cả finalizeFlowUx
// (index.ts) lẫn saveScreenFlowEdit bên dưới cần đọc/ghi chúng, mà
// screen-flow-improve.ts lại import finalizeFlowUx — tránh import vòng.
/** `{ variant, source, at }` — bản đang dùng để chạy tiếp. Không có = original. */
export const SELECTION_FILE = 'selection.json';
/** `{ at }` — người dùng đã sửa TAY trang Cải thiện: finalize KHÔNG áp lại patch. */
export const PROPOSED_EDITED_FILE = 'proposed.edited.json';
/** Danh sách màn của bản cải thiện (daemon sinh ở finalize improve). */
export const SCREENS_IMPROVED_FILE = 'screens.improved.json';

export type ScreenFlowVariant = 'original' | 'improved';
export type ScreenFlowSelectionSource = 'user' | 'run-all';
export interface ScreenFlowSelection {
  variant: ScreenFlowVariant;
  source: ScreenFlowSelectionSource;
  at: string;
}

/** Một màn của bản cải thiện. `provenance: 'document'` = màn có sẵn trong
 *  screens.json (giữ nguyên key/name/cell); `'proposed'` = màn mới do
 *  `addNode.screen` khai — không có anchorText thì persist discovery nhận
 *  theo nhánh riêng (không qua validateDocScreenExtract). */
export interface ImprovedScreen {
  key: string;
  name: string;
  /** id node trên TRANG 1 (proposed) — null khi màn không có node riêng. */
  cell: string | null;
  provenance: 'document' | 'proposed';
  anchorText?: string;
  source?: string;
  why?: string;
  /** Finding đề xuất màn này (chỉ `proposed`). */
  finding?: string;
  /** Node của màn bị `mark removed` trong đề xuất — màn VẪN được giữ. */
  removedByProposal?: true;
}
export interface ScreensImprovedDoc {
  schema_version: 1;
  generatedAt: string;
  screens: ImprovedScreen[];
}

export function screenFlowDir(cwd: string, flowId: string = SCREEN_FLOW_ID): string {
  return path.join(cwd, 'flows', flowId);
}

/** Đọc khoan dung: file thiếu/hỏng/variant lạ → null (= original).
 *  WP screen-flow-platform-split: selection là CỦA TỪNG FLOW (`flowId`). */
export async function readScreenFlowSelection(cwd: string, flowId: string = SCREEN_FLOW_ID): Promise<ScreenFlowSelection | null> {
  const raw = await readJson<Record<string, unknown>>(path.join(screenFlowDir(cwd, flowId), SELECTION_FILE));
  if (!raw || typeof raw !== 'object') return null;
  const variant: ScreenFlowVariant | null = raw.variant === 'improved' ? 'improved' : raw.variant === 'original' ? 'original' : null;
  if (!variant) return null;
  const source: ScreenFlowSelectionSource = raw.source === 'run-all' ? 'run-all' : 'user';
  return { variant, source, at: typeof raw.at === 'string' ? raw.at : '' };
}

export async function writeScreenFlowSelection(
  cwd: string,
  sel: { variant: ScreenFlowVariant; source: ScreenFlowSelectionSource; at?: string },
  flowId: string = SCREEN_FLOW_ID,
): Promise<ScreenFlowSelection> {
  const doc: ScreenFlowSelection = { variant: sel.variant, source: sel.source, at: sel.at ?? new Date().toISOString() };
  await fs.mkdir(screenFlowDir(cwd, flowId), { recursive: true });
  await fs.writeFile(path.join(screenFlowDir(cwd, flowId), SELECTION_FILE), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return doc;
}

export async function hasProposedEditedMarker(cwd: string, flowId: string = SCREEN_FLOW_ID): Promise<boolean> {
  return fs
    .stat(path.join(screenFlowDir(cwd, flowId), PROPOSED_EDITED_FILE))
    .then((s) => s.isFile())
    .catch(() => false);
}

export async function readScreensImproved(cwd: string, flowId: string = SCREEN_FLOW_ID): Promise<ScreensImprovedDoc | null> {
  const raw = await readJson<Record<string, unknown>>(path.join(screenFlowDir(cwd, flowId), SCREENS_IMPROVED_FILE));
  if (!raw || !Array.isArray(raw.screens)) return null;
  const screens: ImprovedScreen[] = [];
  for (const s of raw.screens as unknown[]) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!key || !name) continue;
    const entry: ImprovedScreen = {
      key,
      name,
      cell: typeof o.cell === 'string' && o.cell ? o.cell : null,
      provenance: o.provenance === 'proposed' ? 'proposed' : 'document',
    };
    if (typeof o.anchorText === 'string' && o.anchorText) entry.anchorText = o.anchorText;
    if (typeof o.source === 'string' && o.source) entry.source = o.source;
    if (typeof o.why === 'string' && o.why) entry.why = o.why;
    if (typeof o.finding === 'string' && o.finding) entry.finding = o.finding;
    if (o.removedByProposal === true) entry.removedByProposal = true;
    screens.push(entry);
  }
  return { schema_version: 1, generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '', screens };
}

export interface ScreenFlowXmlResult {
  /** `false` = không có fragment nào — caller bỏ qua, không phải lỗi. */
  found: boolean;
  /** Lỗi CHẶN (XML không dùng được) — caller fail stage kèm danh sách này. */
  errors: string[];
  /** Không chặn — nhập chung vào warnings của finalizeFlowUx. */
  warnings: string[];
  /** WP dr-screens-merge: CHỈ khi screens.json là v2 (`screens[]`) — danh
   *  sách màn có thẩm quyền đã dẫn xuất sang contract screens-discovered.json,
   *  caller persist (persistScreenDiscovery) sau khi finalizeFlowUx xong.
   *  v1 → undefined (dr-comp lùi về lớp regex như trước dr-screens).
   *  WP screen-flow-platform-split: HỢP của mọi flow (mỗi màn `key` +
   *  `platform` + `groupKey` suy từ hậu tố). */
  discovery?: DiscoveredDoc;
  /** WP screen-flow-platform-split: id các flow đã finalize (thứ tự manifest). Chỉ khi found. */
  flowIds?: string[];
}

/** Điểm uốn (waypoint) của cạnh trong draw.io là `<mxPoint x y/>` bên trong
 *  `<Array as="points">`. LLM hay viết `<Object x y/>` — mxCodec decode
 *  `Object` thành object trần (không phải mxPoint) nên orthogonalEdgeStyle
 *  lỗi khi vẽ và BỎ LUÔN cạnh đó (sự cố dr-flow 2026-08-27: 7 cạnh có
 *  waypoint biến mất, "Kết thúc" trông như node cô lập dù flowchart.json đủ
 *  cạnh). Sửa tại chỗ — chỉ đụng thẻ Object NẰM TRONG Array points, không
 *  chạm `<object>` (wrapper UserObject, chữ thường) hay chỗ khác. Áp cho cả
 *  bản agent lẫn bản editor lưu về (editor giữ nguyên Object khi round-trip). */
export function normalizeWaypoints(xml: string): string {
  return xml.replace(/<Array\s+as="points">([\s\S]*?)<\/Array>/g, (m, inner: string) =>
    m.replace(inner, inner.replace(/<Object\b([^>]*?)\/>/g, '<mxPoint$1/>').replace(/<Object\b([^>]*)>\s*<\/Object>/g, '<mxPoint$1/>')),
  );
}

/** Bọc fragment mxCell trần thành `<mxGraphModel>` — đúng việc app
 *  next-ai-draw-io làm quanh output của LLM. Fragment PHẢI trần: agent lỡ tự
 *  bọc wrapper thì trả lỗi thay vì bọc lồng nhau thành XML hỏng. */
export function wrapScreenFlowCells(fragment: string): { graphXml: string } | { error: string } {
  const raw = fragment.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!raw) return { error: 'fragment rỗng' };
  if (/<\s*(mxfile|mxGraphModel|root)\b/i.test(raw)) {
    return { error: 'fragment phải là mxCell TRẦN — không tự bọc <mxfile>/<mxGraphModel>/<root>' };
  }
  // LLM hay viết nhãn nhiều dòng bằng thẻ HTML thô trong value="…"
  // ("Thất bại,<br>Hoàn tiền"). XML không cho `<`/`&` trần trong attribute:
  // DOMParser của browser fail ở đó, mxGraph rơi về HTML-parse lỏng và RỚT
  // TOÀN BỘ cạnh dù parser daemon (cheerio, lỏng) vẫn đọc được — sự cố
  // dr-flow 2026-08-27. draw.io biểu diễn xuống dòng bằng chuỗi đã escape
  // `&lt;br&gt;` (html=1 render lại thành <br>), nên escape-tại-chỗ vừa sửa
  // vừa giữ đúng ý agent. Chỉ đụng phần trong dấu nháy kép — fragment mxCell
  // chỉ có text nằm trong attribute, giữa các thẻ không có gì để mất.
  const escaped = raw.replace(/"([^"]*)"/g, (_m, inner: string) =>
    `"${inner
      .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}"`,
  );
  const body = normalizeWaypoints(escaped);
  const graphXml = [
    '<mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="850" math="0" shadow="0">',
    '  <root>',
    '    <mxCell id="0" />',
    '    <mxCell id="1" parent="0" />',
    body.split('\n').map((l) => (l.length ? `    ${l}` : l)).join('\n'),
    '  </root>',
    '</mxGraphModel>',
  ].join('\n');
  return { graphXml };
}

function rectsOverlap(a: MxCellInfo, b: MxCellInfo): boolean {
  if (a.x == null || a.y == null || a.width == null || a.height == null) return false;
  if (b.x == null || b.y == null || b.width == null || b.height == null) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export interface ScreenFlowValidation {
  errors: string[];
  warnings: string[];
  vertexCount: number;
  edgeCount: number;
}

/** Validate deterministic — vai trò của vòng "validator → regenerate" trong
 *  next-ai-draw-io, nhưng chạy một lần sau khi agent xong: lỗi cấu trúc là
 *  ERROR (fail stage để chạy lại với thông điệp cụ thể), lỗi trình bày
 *  (reachability) là WARNING. */
export function validateScreenFlowGraph(graphXml: string): ScreenFlowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let cells: MxCellInfo[];
  try {
    cells = listCells(graphXml);
  } catch (error) {
    return { errors: [`XML không parse được: ${error instanceof Error ? error.message : String(error)}`], warnings, vertexCount: 0, edgeCount: 0 };
  }
  const vertices = cells.filter((c) => c.kind === 'vertex');
  const edges = cells.filter((c) => c.kind === 'edge');
  if (vertices.length === 0) errors.push('không có node (vertex) nào');

  const seen = new Set<string>();
  for (const c of cells) {
    if (seen.has(c.id)) errors.push(`id trùng: ${c.id}`);
    seen.add(c.id);
  }
  const vertexIds = new Set(vertices.map((v) => v.id));
  for (const e of edges) {
    if (!e.source || !vertexIds.has(e.source)) errors.push(`cạnh ${e.id}: source "${e.source ?? '∅'}" không tồn tại`);
    if (!e.target || !vertexIds.has(e.target)) errors.push(`cạnh ${e.id}: target "${e.target ?? '∅'}" không tồn tại`);
  }
  for (const v of vertices) {
    if (v.x == null || v.y == null || v.width == null || v.height == null) errors.push(`node ${v.id}: thiếu geometry (x/y/width/height)`);
  }
  for (let i = 0; i < vertices.length; i += 1) {
    for (let j = i + 1; j < vertices.length; j += 1) {
      // Khung chú thích: các mẫu nằm TRONG hộp legend (đè lên hộp) là chủ ý —
      // chỉ soát legend đè lên node thật.
      if (isLegendCellId(vertices[i]!.id) && isLegendCellId(vertices[j]!.id)) continue;
      if (rectsOverlap(vertices[i]!, vertices[j]!)) errors.push(`node đè nhau: ${vertices[i]!.id} ↔ ${vertices[j]!.id}`);
    }
  }
  // Hai cạnh "trùng path" = cùng source+target+bộ exit/entry — luật "NEVER let
  // multiple edges share the same path" của conventions.
  const pathOf = (e: MxCellInfo) =>
    [e.source, e.target, styleGet(e.style, 'exitX'), styleGet(e.style, 'exitY'), styleGet(e.style, 'entryX'), styleGet(e.style, 'entryY')].join('|');
  const paths = new Map<string, string>();
  for (const e of edges) {
    const key = pathOf(e);
    const prev = paths.get(key);
    if (prev) errors.push(`cạnh trùng path: ${prev} ↔ ${e.id} (đặt exit/entry khác nhau)`);
    paths.set(key, e.id);
  }
  // Reachability từ tập node vào (indegree 0 VÀ có cạnh đi ra — node cô lập
  // không được tự làm gốc, nó chính là thứ cần cảnh báo). Toàn đồ thị là chu
  // trình (không có node vào) thì bỏ qua — không có gốc nào để đo.
  const indeg = new Map<string, number>(vertices.map((v) => [v.id, 0]));
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!e.source || !e.target || !vertexIds.has(e.source) || !vertexIds.has(e.target)) continue;
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const roots = vertices
    .filter((v) => (indeg.get(v.id) ?? 0) === 0 && (adj.get(v.id)?.length ?? 0) > 0)
    .map((v) => v.id);
  if (roots.length > 0) {
    const reach = new Set<string>(roots);
    const queue = [...roots];
    while (queue.length) {
      for (const next of adj.get(queue.shift()!) ?? []) {
        if (!reach.has(next)) { reach.add(next); queue.push(next); }
      }
    }
    for (const v of vertices) if (!reach.has(v.id) && !isLegendCellId(v.id)) warnings.push(`node không reachable từ điểm vào: ${v.id}`);
  }
  return { errors, warnings, vertexCount: vertices.length, edgeCount: edges.length };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const X_NUMBER_RE = /__X(\d+)(--(?:app|web))?$/;

/** A6 — key duy nhất xuyên flow (thứ tự flow `--app` → `--web`, thứ tự entry
 *  trong file):
 *   (1) màn `code: null` key `<stem>__X<n>` (daemon đánh theo luật cũ) TRÙNG
 *       với flow trước → đánh lại `X<n>` LIÊN TỤC toàn cục (tiếp sau số X lớn
 *       nhất đang dùng ở mọi flow, kể cả hậu tố) — ghi lại vào doc (screens,
 *       meta/groups/partOf) để screens.json/cells/index/flowchart tự theo;
 *   (2) key trùng mà có `code` thật (hoặc không theo khuôn X<n>) → LỖI nêu key
 *       — biến thể cùng màn nghiệp vụ phải mang hậu tố `--app`/`--web`;
 *   (3) cặp hậu tố hợp lệ (`X2--app` / `X2--web`) không trùng nhau → giữ nguyên.
 *  Không đụng key không trùng — quyết định của agent được giữ. */
export function reconcileKeysAcrossFlows(flows: Array<{ id: string; doc: ScreensV2 }>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let nextN = 0;
  for (const f of flows) {
    for (const s of f.doc.screens) {
      const m = X_NUMBER_RE.exec(s.key);
      if (m) nextN = Math.max(nextN, Number(m[1]));
    }
  }
  nextN += 1;
  const owner = new Map<string, string>();
  for (const f of flows) {
    const renames = new Map<string, string>();
    for (const s of f.doc.screens) {
      const prev = owner.get(s.key);
      if (prev && prev !== f.id) {
        const m = /^(.*__)X\d+$/.exec(s.key);
        if (s.code == null && m) {
          const next = `${m[1]}X${nextN++}`;
          renames.set(s.key, next);
          owner.set(next, f.id);
          continue;
        }
        errors.push(
          `${f.id}: key "${s.key}" trùng với flow ${prev} — cùng màn nghiệp vụ ở hai nền tảng phải là hai entry hậu tố "${s.key}--app" / "${s.key}--web" (cùng code), màn khác nhau phải khác key`,
        );
        continue;
      }
      if (!prev) owner.set(s.key, f.id);
    }
    if (!renames.size) continue;
    const rk = (k: string) => renames.get(k) ?? k;
    f.doc.screens = f.doc.screens.map((s) => (renames.has(s.key) ? { ...s, key: rk(s.key) } : s));
    f.doc.excluded = f.doc.excluded.map((e) => (e.partOf && renames.has(e.partOf) ? { ...e, partOf: rk(e.partOf) } : e));
    if (f.doc.meta) f.doc.meta = Object.fromEntries(Object.entries(f.doc.meta).map(([k, v]) => [rk(k), v]));
    if (f.doc.groups) {
      f.doc.groups = Object.fromEntries(
        Object.entries(f.doc.groups).map(([k, v]) => [rk(k), Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? rk(x) : x)) : v]),
      );
    }
    warnings.push(
      `${f.id}: ${renames.size} màn code null trùng key với flow khác — đánh lại X<n> liên tục toàn cục: ${[...renames].map(([a, b]) => `${a.slice(a.lastIndexOf('__') + 2)}→${b.slice(b.lastIndexOf('__') + 2)}`).join(', ')}`,
    );
  }
  return { errors, warnings };
}

/** Bước dịch chính — xem docblock đầu file. Idempotent: chạy lại ghi đè
 *  as-is.drawio và thay các entry SCREEN-FLOW* trong _inputs.json tại chỗ.
 *  WP screen-flow-platform-split: lặp MỌI id từ `listScreenFlowIds` (flow đơn
 *  `SCREEN-FLOW` hoặc cặp `--app`/`--web`); validate từng cells.xml + kiểm
 *  `platform` của screens.json theo thư mục; MỌI lỗi gom lại rồi mới trả (không
 *  ghi nửa chừng); discovery = hợp các flow. */
export async function finalizeScreenFlowXml(cwd: string): Promise<ScreenFlowXmlResult> {
  let ids: string[];
  try {
    ids = await listScreenFlowIds(cwd);
  } catch (error) {
    if (error instanceof ScreenFlowMixedError) return { found: true, errors: [error.message], warnings: [] };
    throw error;
  }
  // Chỉ thư mục có fragment mới là "agent vừa viết"; as-is.drawio còn sót từ
  // lượt trước mà không có cells.xml → coi như không có (như trước WP).
  const withCells: Array<{ id: string; fragment: string }> = [];
  for (const id of ids) {
    const fragment = await fs.readFile(path.join(screenFlowDir(cwd, id), SCREEN_FLOW_CELLS_FILE), 'utf8').catch(() => null);
    if (fragment != null) withCells.push({ id, fragment });
  }
  if (withCells.length === 0) return { found: false, errors: [], warnings: [] };

  const errors: string[] = [];
  const warnings: string[] = [];
  interface Prepared {
    id: string;
    platform: ScreenPlatform | null;
    title: string;
    source: string;
    graphXml: string;
    allCells: MxCellInfo[];
    validation: ScreenFlowValidation;
    /** screens.json v2 đã chuẩn hoá (undefined = v1/không có file). */
    normalized?: ScreensV2 & { cells: Record<string, string>; names: Record<string, string> };
    doc?: ScreensV2;
  }
  const prepared: Prepared[] = [];

  for (const { id, fragment } of withCells) {
    const prefix = (msg: string) => `${id}: ${msg}`;
    const platform = screenFlowPlatformOf(id);
    const wrapped = wrapScreenFlowCells(fragment);
    if ('error' in wrapped) {
      errors.push(prefix(wrapped.error));
      continue;
    }
    const validation = validateScreenFlowGraph(wrapped.graphXml);
    if (validation.errors.length) {
      errors.push(...validation.errors.map(prefix));
      warnings.push(...validation.warnings.map(prefix));
      continue;
    }
    warnings.push(...validation.warnings.map(prefix));

    const dir = screenFlowDir(cwd, id);
    const screensRaw = await readJson<unknown>(path.join(dir, 'screens.json'));
    const screensFile = (screensRaw && typeof screensRaw === 'object' ? (screensRaw as { title?: unknown; source?: unknown }) : {});
    const rawTitle = typeof screensFile.title === 'string' && screensFile.title.trim() ? screensFile.title.trim() : 'Luồng màn hình';
    const title = screenFlowTitleFor(rawTitle, platform);
    const source = typeof screensFile.source === 'string' ? screensFile.source : '';
    const allCells = listCells(wrapped.graphXml);
    const entry: Prepared = { id, platform, title, source, graphXml: wrapped.graphXml, allCells, validation };

    // WP dr-screens-merge: screens.json v2 (`screens[]`) là nguồn duy nhất agent
    // ghi — dẫn xuất `cells`/`names` (contract v1 finalizeFlowUx đọc) rồi ghi
    // lại file đã chuẩn hoá; cell không có trong XML / trùng → null + warning.
    // v1 (không `screens[]`) → không đụng file, không discovery.
    if (screensRaw != null) {
      const parsed = parseScreenFlowScreensV2(screensRaw);
      if ('errors' in parsed) {
        errors.push(...parsed.errors.map(prefix));
        continue;
      }
      if ('doc' in parsed) {
        warnings.push(...parsed.warnings.map(prefix));
        // WP screen-flow-platform-split: kiểm `platform` theo thư mục.
        //  - flow tách: MỌI màn phải có platform == nền tảng thư mục;
        //  - flow đơn: vắng được, có thì đồng nhất MỘT giá trị (≥2 → phải tách);
        //  - hậu tố key `--app`/`--web` phải khớp platform của màn.
        const seenPlatforms = new Set<ScreenPlatform>();
        for (const s of parsed.doc.screens) {
          if (s.platform) seenPlatforms.add(s.platform);
          if (platform) {
            if (!s.platform) errors.push(prefix(`màn "${s.key}" thiếu \`platform\` — flow ${id} bắt buộc \`platform: "${platform}"\` cho mọi màn`));
            else if (s.platform !== platform) errors.push(prefix(`màn "${s.key}" khai platform "${s.platform}" lệch với thư mục flow (${platform}) — chuyển sang flows/${screenFlowIdFor(s.platform)}/`));
          }
          const suffix = PLATFORM_KEY_SUFFIX_RE.exec(s.key)?.[1] as ScreenPlatform | undefined;
          const expect = platform ?? s.platform;
          if (suffix && expect && suffix !== expect) {
            errors.push(prefix(`key "${s.key}" mang hậu tố --${suffix} nhưng màn thuộc nền tảng ${expect}`));
          }
        }
        if (!platform && seenPlatforms.size > 1) {
          errors.push(
            prefix(
              `flow đơn có màn thuộc ${[...seenPlatforms].map((p) => `"${p}"`).join(' và ')} — tài liệu ≥2 nền tảng phải tách thành flows/${screenFlowIdFor('app')}/ + flows/${screenFlowIdFor('web')}/ (không dùng flows/${SCREEN_FLOW_ID}/)`,
            ),
          );
        }
        entry.doc = parsed.doc;
      }
    }
    prepared.push(entry);
  }
  if (errors.length) return { found: true, errors, warnings };

  // A6 (2026-08-28): key phải DUY NHẤT xuyên mọi flow — agent hay đánh
  // `X1..Xn` lại từ đầu ở flow thứ hai (dữ liệu thật: app X1..X18, web X1..X12
  // → 12 màn web rơi khỏi discovery vì trùng key). Chỉ khi ≥2 flow.
  if (prepared.length >= 2) {
    const r = reconcileKeysAcrossFlows(prepared.filter((p): p is Prepared & { doc: ScreensV2 } => p.doc != null));
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (errors.length) return { found: true, errors, warnings };
  }

  // Dẫn xuất cells/names (contract v1) + bản chuẩn hoá để ghi lại — SAU khi
  // key đã ổn định toàn cục.
  for (const p of prepared) {
    if (!p.doc) continue;
    const prefix = (msg: string) => `${p.id}: ${msg}`;
    const vertexIds = new Set(p.allCells.filter((c) => c.kind === 'vertex').map((c) => c.id));
    const derived = deriveCellsAndNames(p.doc, vertexIds);
    warnings.push(...derived.warnings.map(prefix));
    p.normalized = {
      ...(p.doc.title ? { title: p.doc.title } : {}),
      ...(p.doc.source ? { source: p.doc.source } : {}),
      cells: derived.cells,
      names: derived.names,
      ...(p.doc.note ? { note: p.doc.note } : {}),
      screens: derived.screens,
      excluded: p.doc.excluded,
      ...(p.doc.meta ? { meta: p.doc.meta } : {}),
      ...(p.doc.groups ? { groups: p.doc.groups } : {}),
    };
    p.doc = { ...p.doc, screens: derived.screens };
  }

  // ── Ghi (mọi flow đã qua validate) ──
  const generatedAt = new Date().toISOString();
  for (const p of prepared) {
    const dir = screenFlowDir(cwd, p.id);
    if (p.normalized) await fs.writeFile(path.join(dir, 'screens.json'), `${JSON.stringify(p.normalized, null, 2)}\n`, 'utf8');
    const drawio = encodeMxfile([{ id: p.id.toLowerCase(), name: p.title, graphXml: p.graphXml }]);
    await fs.writeFile(path.join(dir, 'as-is.drawio'), drawio, 'utf8');
    // cells.json cùng format prepareFlowUxInputs ghi cho sơ đồ nguồn — nhánh
    // auto-link của dr-comp đọc file này làm bằng chứng node id khi gắn thêm màn.
    const cellDump = p.allCells.map(({ style: _style, ...rest }) => rest);
    await fs.writeFile(path.join(dir, 'cells.json'), `${JSON.stringify(cellDump, null, 2)}\n`, 'utf8');
  }
  const flowDocs = prepared.filter((p): p is Prepared & { doc: ScreensV2 } => p.doc != null);
  const discovery = flowDocs.length ? toDiscoveredDocs(flowDocs.map((p) => ({ id: p.id, doc: p.doc })), { generatedAt }) : undefined;

  // Sơ đồ seed (prepareFlowUxInputs giải nén cho agent đọc) phải RỜI flows/
  // trước khi finalizeFlowUx dựng index: để lại thì index có entry screens
  // rỗng → recovery loop của đường dr-flow cũ + assertDocsReviewCoverageComplete
  // chặn receipt, và nhánh auto-pickup text-only còn nhặt lại as-is.mmd mồ
  // côi. Chuyển vào flows/_seeds/ (tiền tố `_` = finalizeFlowUx bỏ qua) thay
  // vì xoá — giữ dấu vết "agent đã nhìn thấy sơ đồ nguồn nào". Mọi id khớp
  // SCREEN_FLOW_ID_RE đều ở lại.
  const flowsDir = path.join(cwd, 'flows');
  const seedsDir = path.join(flowsDir, '_seeds');
  const dirents = await fs.readdir(flowsDir, { withFileTypes: true }).catch(() => []);
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith('_') || isScreenFlowId(d.name)) continue;
    await fs.mkdir(seedsDir, { recursive: true });
    await fs.rm(path.join(seedsDir, d.name), { recursive: true, force: true });
    await fs.rename(path.join(flowsDir, d.name), path.join(seedsDir, d.name));
  }

  // Manifest thu về đúng các flow SCREEN-FLOW* — đó là toàn bộ deliverable
  // của stage; finalizeFlowUx xử lý từng cái như một sơ đồ drawio bình thường
  // (nó CHỈ đọc manifest cho kind drawio; nhánh tự-quét chỉ nhặt as-is.mmd).
  // Flow tách mang thêm `platform`; flow đơn KHÔNG có field (byte-identical).
  const inputsPath = path.join(flowsDir, '_inputs.json');
  const manifest = (await readJson<Record<string, unknown>>(inputsPath)) ?? {};
  const entries = prepared.map((p) => ({
    id: p.id,
    title: p.title,
    kind: 'drawio',
    source: p.source,
    diagram: `flows/${p.id}/as-is.drawio`,
    files: { asIs: `flows/${p.id}/as-is.drawio`, cells: `flows/${p.id}/cells.json` },
    counts: { nodes: p.validation.vertexCount, edges: p.validation.edgeCount },
    ...(p.platform ? { platform: p.platform } : {}),
  }));
  await fs.writeFile(inputsPath, `${JSON.stringify({ ...manifest, flows: entries }, null, 2)}\n`, 'utf8');

  // WP dr-flow-result-split (2026-08-27): dr-flow KHÔNG ghi ux-review.json
  // tối thiểu nữa — file đó là output RIÊNG của dr-flow-improve (agent review
  // ghi). Ghi ở đây từng làm dr-flow-improve tự "Xong" ké qua attribution và
  // làm Quick result dr-flow mở nhầm khung so sánh. finalizeFlowUx bỏ qua
  // warning "thiếu/hỏng ux-review.json" cho SCREEN-FLOW* (entry không có
  // verdict/findings — consumer đều đọc khoan dung).

  return { found: true, errors: [], warnings, ...(discovery ? { discovery } : {}), flowIds: prepared.map((p) => p.id) };
}

export interface ScreenFlowSaveResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** WP dr-flow-improve: lượt lưu này có ghi trang Cải thiện (trang 1) không. */
  savedProposed?: boolean;
  /** …và trang 1 có KHÁC bản trước không (→ marker proposed.edited.json). */
  proposedEdited?: boolean;
}

/** Dấu vân cấu trúc của một trang — so "người dùng có đổi gì không" mà không
 *  dính whitespace/thứ tự attribute mà editor round-trip hay xáo. */
function pageFingerprint(graphXml: string): string {
  try {
    return JSON.stringify(listCells(graphXml));
  } catch {
    return graphXml;
  }
}

/** Lưu bản chỉnh TAY từ editor nhúng (embed.diagrams.net postMessage): nhận
 *  mxfile đầy đủ do editor xuất, giữ trang đầu, validate MỀM rồi ghi đè
 *  as-is.drawio + cells.json. "Mềm" vì đây là con người kéo-thả chứ không phải
 *  agent: node tạm đè nhau / cạnh trùng path là quyền của người sửa — mọi phát
 *  hiện cấu trúc hạ thành warning, chỉ XML không đọc được / không còn node nào
 *  mới chặn. Caller PHẢI chạy lại finalizeFlowUx cho flowchart.json/index.json
 *  đuổi kịp bản sửa.
 *
 *  WP dr-flow-improve: mxfile có thể 2 trang (Nguyên bản | Cải thiện). Trang 0
 *  → as-is.drawio như cũ. Có trang 1 → ghi proposed.drawio đủ 2 trang (trang 0
 *  mới + trang 1 mới); trang 1 khác bản cũ → ghi marker proposed.edited.json
 *  (finalizeFlowUx sẽ KHÔNG áp lại patch). Chỉ 1 trang nhưng proposed.drawio
 *  đang có → thay trang 0 của nó, giữ trang 1. Trang 0 đổi khi đang có
 *  proposed → warning "đề xuất có thể lệch". */
export async function saveScreenFlowEdit(cwd: string, mxfileXml: string, flowId: string = SCREEN_FLOW_ID): Promise<ScreenFlowSaveResult> {
  const dir = screenFlowDir(cwd, flowId);
  const asIsPath = path.join(dir, 'as-is.drawio');
  const prevAsIs = await fs.readFile(asIsPath, 'utf8').catch(() => null);
  if (prevAsIs == null) return { ok: false, errors: [`chưa có flows/${flowId}/as-is.drawio — chạy stage Luồng màn hình trước`], warnings: [] };

  let pages;
  try {
    pages = decodeMxfile(mxfileXml);
  } catch (error) {
    return { ok: false, errors: [`XML từ editor không đọc được: ${error instanceof Error ? error.message : String(error)}`], warnings: [] };
  }
  const first = pages[0];
  if (!first?.graphXml) return { ok: false, errors: ['XML từ editor không có trang nào'], warnings: [] };
  // Editor round-trip giữ nguyên `<Object>` waypoint sai của agent (xem
  // normalizeWaypoints) — chuẩn hoá lại ở đây để lần lưu sau sửa luôn file.
  const page = { ...first, graphXml: normalizeWaypoints(first.graphXml) };

  const validation = validateScreenFlowGraph(page.graphXml);
  const blocking = validation.errors.filter((e) => e.startsWith('XML không parse được') || e === 'không có node (vertex) nào');
  if (blocking.length) return { ok: false, errors: blocking, warnings: [] };
  const warnings = [...validation.errors.filter((e) => !blocking.includes(e)), ...validation.warnings];

  // Trang 0 có đổi so với as-is.drawio đang có không (để cảnh báo lệch đề xuất).
  let prevAsIsPage: string | null = null;
  try {
    prevAsIsPage = decodeMxfile(prevAsIs)[0]?.graphXml ?? null;
  } catch {
    prevAsIsPage = null;
  }
  const asIsChanged = prevAsIsPage == null || pageFingerprint(prevAsIsPage) !== pageFingerprint(page.graphXml);

  await fs.writeFile(asIsPath, encodeMxfile([page]), 'utf8');
  const cellDump = listCells(page.graphXml).map(({ style: _style, ...rest }) => rest);
  await fs.writeFile(path.join(dir, 'cells.json'), `${JSON.stringify(cellDump, null, 2)}\n`, 'utf8');

  // Trang Cải thiện.
  const proposedPath = path.join(dir, 'proposed.drawio');
  const prevProposedRaw = await fs.readFile(proposedPath, 'utf8').catch(() => null);
  let prevProposedPages: MxPage[] = [];
  if (prevProposedRaw != null) {
    try {
      prevProposedPages = decodeMxfile(prevProposedRaw);
    } catch {
      prevProposedPages = [];
    }
  }
  const prevProposedPage = prevProposedPages[1] ?? null;
  const second = pages[1];
  let savedProposed = false;
  let proposedEdited = false;
  if (second?.graphXml) {
    const proposedPage: MxPage = {
      id: second.id || `${page.id}-proposed`,
      name: second.name?.trim() || 'Cải thiện',
      graphXml: normalizeWaypoints(second.graphXml),
    };
    const pv = validateScreenFlowGraph(proposedPage.graphXml);
    if (pv.errors.some((e) => e.startsWith('XML không parse được'))) {
      warnings.push(`trang Cải thiện không đọc được — bỏ qua, giữ bản cũ: ${pv.errors.join('; ')}`);
    } else {
      proposedEdited = prevProposedPage == null || pageFingerprint(prevProposedPage.graphXml) !== pageFingerprint(proposedPage.graphXml);
      await fs.writeFile(proposedPath, encodeMxfile([{ ...page, name: prevProposedPages[0]?.name ?? page.name }, proposedPage]), 'utf8');
      savedProposed = true;
      if (proposedEdited) {
        await fs.writeFile(path.join(dir, PROPOSED_EDITED_FILE), `${JSON.stringify({ at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      }
      warnings.push(...pv.errors.filter((e) => !e.startsWith('XML không parse được')).map((e) => `trang Cải thiện: ${e}`));
    }
  } else if (prevProposedPage) {
    // Chỉ gửi trang 0 nhưng đang có đề xuất → giữ trang 1, cập nhật trang 0
    // để proposed.drawio không lệch as-is (khi có marker, finalize không dựng lại).
    await fs.writeFile(proposedPath, encodeMxfile([{ ...page, name: prevProposedPages[0]?.name ?? page.name }, prevProposedPage]), 'utf8');
  }
  if (asIsChanged && prevProposedPage) {
    warnings.push('Bản Nguyên bản đã sửa tay — đề xuất có thể lệch, cân nhắc Chạy lại "Cải thiện luồng".');
  }
  return { ok: true, errors: [], warnings, savedProposed, proposedEdited };
}
