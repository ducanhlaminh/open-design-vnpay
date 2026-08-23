// ds-lab / lab-map — "Bản đồ màn": stage MỚI (2026-08-23, WP-lab-map, xem
// .tmp/pipeline/wp-lab-map.yaml) chen giữa lab-docs và lab-kit-plan trong
// workflow "DS → Màn hình sáng tạo (Lab)".
//
// Bối cảnh: dự án dich-vu-mua-sim (docs-review, 23/08) đã có
// flows/FLOW-*.flowchart.json (node có `screen` key + edge có nhãn nhánh),
// flows/FLOW-*/ux-review.json + proposed.mmd, comp/_screens.json (kho màn
// theo key `<doc>__<code>`), comp/<key>.screen.json 2.1 (elements role/label/
// content, nav, notes trạng thái) — nhưng lab-docs/lab-compose KHÔNG đọc gì
// trong đó: lab-compose tự đọc docs và tự đặt key mỗi lần chạy (SCR-01 ≠
// 6.1.1), key không ổn định giữa các lần chạy, thiếu/thừa nội dung tuỳ hứng.
//
// Stage này là một phiên agent CHỈ ĐỌC (giống lab-kit-plan): agent đọc
// `map-src/` (bản sao staging của docs-review's flows/ + comp/ liên quan,
// xem `pickDocsReviewMapSources`) rồi docs, biên ra `screen-map.json` (máy
// đọc, dùng bởi lab-compose qua `summarizeScreenMapForCompose`) +
// `screen-map.md` (người duyệt). Bản đồ nói CÁI GÌ (màn nào, mục đích, mustHave
// role+content, trạng thái, nav, luồng chính) — KHÔNG nói LÀM THẾ NÀO (không
// toạ độ/thứ tự/bố cục, giữ nguyên luật cấm chép mockup của lab-screen-compose).
// Không có docs-review (project chưa từng chạy workflow đó, hoặc map-src rỗng)
// → agent tự phân tích từ docs, ghi `generatedFrom: "docs"`.
//
// Daemon KHÔNG tự parse flowchart.json/screen.json thành bản đồ (agent làm
// việc đó) — daemon chỉ staging file nguồn vào map-src/ + validate output.
// Module này chỉ chứa phần THUẦN (không fs/network): types, parse/render/
// pick/summarize + brief builder. server.ts (`runLabMap`) sở hữu mọi
// fs/DB/agent-spawn thật (staging map-src/, spawn run, đọc kết quả).

import { checkMark, renderLabBrief } from './lab-brief.js';

/** File kết quả agent PHẢI ghi trước khi kết thúc phiên — output khai báo của
 *  `lab-map` trong pipelines.ts. */
export const SCREEN_MAP_FILE_REL = 'screen-map.json';

/** Bảng markdown cho người duyệt — output khai báo thứ hai của `lab-map`. */
export const SCREEN_MAP_MD_REL = 'screen-map.md';

/** Thư mục staging bản sao các file docs-review liên quan (flows/ + comp/ đã
 *  lọc qua `pickDocsReviewMapSources`) — CỐ Ý KHÔNG khai trong `outputs` của
 *  `lab-map` (pipelines.ts): không phải sản phẩm của lần chạy, chỉ là vật
 *  liệu đọc trong phiên, và server.ts ghi đè (`rm -rf` rồi copy lại) ở ĐẦU
 *  MỖI lần chạy `lab-map`, không phải re-run clear generic. Agent chỉ được
 *  đọc dưới cwd của mình — map-src/ là cách DUY NHẤT agent tiếp cận nội dung
 *  docs-review mà không phải đọc chéo sang thư mục workflow khác. */
export const MAP_SRC_DIR_REL = 'map-src';

/** Một mục "phải có" của một màn — checklist COVERAGE (vai trò + nội dung
 *  phải xuất hiện), KHÔNG phải toạ độ/bố cục. */
export interface ScreenMapMustHave {
  role: string;
  label?: string;
  content?: unknown;
  note?: string;
}

/** Một điều hướng ra khỏi màn (CTA/tab/back…) — `to` là key màn đích trong
 *  cùng `ScreenMap.screens` (có thể chưa tồn tại nếu docs-review chỉ vẽ tới
 *  đó mà chưa map — `lab-screen-compose` ghi chú lại trong `notes` khi gặp
 *  trường hợp này, không phải lỗi của bản đồ). */
export interface ScreenMapNav {
  el?: string;
  to: string;
  label?: string;
}

/** Một màn trong bản đồ. `key`: NGUYÊN VĂN key docs-review khi có
 *  (`<doc>__<code>`, ví dụ `2.1.-PRD-Detail-Mua-SIM-du-lich__6.2.1`) — giữ
 *  key ổn định giữa các lần chạy để lab-compose's replace-by-name/trích kit
 *  bám đúng frame cũ; không có docs-review thì `SCR-<code-hoặc-số-thứ-tự>`. */
export interface ScreenMapScreen {
  key: string;
  name: string;
  purpose?: string;
  flowId?: string;
  mustHave: ScreenMapMustHave[];
  states?: string[];
  nav?: ScreenMapNav[];
  source?: { doc?: string; line?: number };
  dsHints?: string[];
}

/** Một luồng — `mainPath` là đường đi CHÍNH (không phải mọi nhánh) từ điểm
 *  bắt đầu tới kết thúc thành công, biểu diễn bằng dãy `ScreenMapScreen.key`.
 *  `basis`: `'proposed'` khi luồng lấy theo bản đề xuất UX (ux-review.json có
 *  proposed.mmd) thay vì hiện trạng — agent PHẢI ghi rõ để người đọc biết bản
 *  đồ đang phản ánh trạng thái nào. */
export interface ScreenMapFlow {
  id: string;
  title?: string;
  basis?: 'as-is' | 'proposed';
  mainPath: string[];
  branches?: { from: string; to: string; label?: string }[];
}

export interface ScreenMap {
  schema_version: 1;
  generatedFrom: 'docs-review' | 'docs' | 'mixed';
  flows: ScreenMapFlow[];
  screens: ScreenMapScreen[];
}

/** Parse `screen-map.json` do agent lab-map ghi. `null` khi JSON hỏng, không
 *  phải object, hoặc thiếu field `screens` (mảng) — server.ts (`runLabMap`)
 *  coi đây là "agent không ghi bản đồ hợp lệ" và fail cả stage.
 *
 *  Một MÀN bị DROP (kèm warning, không fail cả file) khi thiếu `key` HOẶC
 *  thiếu `name`; trùng `key` với một màn đã giữ trước đó (giữ mục XUẤT HIỆN
 *  ĐẦU TIÊN, bỏ các mục sau, kèm warning — key phải duy nhất để lab-compose
 *  đối chiếu đúng). `mustHave` thiếu/không phải mảng → `[]`; một mục
 *  `mustHave` thiếu `role` → bỏ mục đó (warning), KHÔNG bỏ cả màn.
 *
 *  `flows` thiếu/không phải mảng → `[]`. Một luồng thiếu `id` → bỏ (warning).
 *  `mainPath` tham chiếu một key KHÔNG có trong `screens` đã giữ → GIỮ
 *  NGUYÊN key đó trong mainPath (kèm warning) — không tự ý xoá, vì đó có thể
 *  là dấu hiệu agent quên dựng bản đồ cho màn đó, không phải lỗi mainPath. */
export function parseScreenMap(raw: string): { map: ScreenMap; warnings: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const rawScreens = obj.screens;
  if (!Array.isArray(rawScreens)) return null;

  const warnings: string[] = [];
  const seenKeys = new Set<string>();
  const screens: ScreenMapScreen[] = [];
  for (const entry of rawScreens) {
    const e = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!key || !name) {
      warnings.push(`Bỏ qua một màn trong screen-map.json: thiếu "${!key ? 'key' : 'name'}".`);
      continue;
    }
    if (seenKeys.has(key)) {
      warnings.push(`Màn "${key}" trùng key với một mục đã có — giữ mục xuất hiện đầu tiên, bỏ mục này.`);
      continue;
    }
    seenKeys.add(key);

    const mustHave: ScreenMapMustHave[] = [];
    const rawMustHave = Array.isArray(e.mustHave) ? e.mustHave : [];
    for (const m of rawMustHave) {
      const mm = m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
      const role = typeof mm.role === 'string' ? mm.role.trim() : '';
      if (!role) {
        warnings.push(`Màn "${key}": bỏ một mục "mustHave" thiếu "role".`);
        continue;
      }
      const item: ScreenMapMustHave = { role };
      if (typeof mm.label === 'string' && mm.label.trim()) item.label = mm.label.trim();
      if ('content' in mm) item.content = mm.content;
      if (typeof mm.note === 'string' && mm.note.trim()) item.note = mm.note.trim();
      mustHave.push(item);
    }

    const screen: ScreenMapScreen = { key, name, mustHave };
    if (typeof e.purpose === 'string' && e.purpose.trim()) screen.purpose = e.purpose.trim();
    if (typeof e.flowId === 'string' && e.flowId.trim()) screen.flowId = e.flowId.trim();
    if (Array.isArray(e.states) && e.states.every((s) => typeof s === 'string')) {
      const states = (e.states as string[]).map((s) => s.trim()).filter(Boolean);
      if (states.length > 0) screen.states = states;
    }
    if (Array.isArray(e.nav)) {
      const nav: ScreenMapNav[] = [];
      for (const n of e.nav) {
        const nn = n && typeof n === 'object' && !Array.isArray(n) ? (n as Record<string, unknown>) : {};
        const to = typeof nn.to === 'string' ? nn.to.trim() : '';
        if (!to) continue;
        const item: ScreenMapNav = { to };
        if (typeof nn.el === 'string' && nn.el.trim()) item.el = nn.el.trim();
        if (typeof nn.label === 'string' && nn.label.trim()) item.label = nn.label.trim();
        nav.push(item);
      }
      if (nav.length > 0) screen.nav = nav;
    }
    if (e.source && typeof e.source === 'object' && !Array.isArray(e.source)) {
      const s = e.source as Record<string, unknown>;
      const doc = typeof s.doc === 'string' ? s.doc.trim() : '';
      const line = typeof s.line === 'number' && Number.isFinite(s.line) ? s.line : undefined;
      if (doc || line !== undefined) {
        screen.source = {};
        if (doc) screen.source.doc = doc;
        if (line !== undefined) screen.source.line = line;
      }
    }
    if (Array.isArray(e.dsHints) && e.dsHints.every((h) => typeof h === 'string')) {
      const dsHints = (e.dsHints as string[]).map((h) => h.trim()).filter(Boolean);
      if (dsHints.length > 0) screen.dsHints = dsHints;
    }
    screens.push(screen);
  }

  const screenKeySet = new Set(screens.map((s) => s.key));
  const rawFlows = Array.isArray(obj.flows) ? obj.flows : [];
  const flows: ScreenMapFlow[] = [];
  for (const f of rawFlows) {
    const ff = f && typeof f === 'object' && !Array.isArray(f) ? (f as Record<string, unknown>) : {};
    const id = typeof ff.id === 'string' ? ff.id.trim() : '';
    if (!id) {
      warnings.push('Bỏ qua một luồng trong screen-map.json: thiếu "id".');
      continue;
    }
    const mainPath =
      Array.isArray(ff.mainPath) && ff.mainPath.every((k) => typeof k === 'string')
        ? (ff.mainPath as string[]).map((k) => k.trim()).filter(Boolean)
        : [];
    for (const k of mainPath) {
      if (!screenKeySet.has(k)) {
        warnings.push(`Luồng "${id}": mainPath tham chiếu key "${k}" không có trong danh sách màn — vẫn giữ.`);
      }
    }
    const flow: ScreenMapFlow = { id, mainPath };
    if (typeof ff.title === 'string' && ff.title.trim()) flow.title = ff.title.trim();
    if (ff.basis === 'as-is' || ff.basis === 'proposed') flow.basis = ff.basis;
    if (Array.isArray(ff.branches)) {
      const branches: { from: string; to: string; label?: string }[] = [];
      for (const b of ff.branches) {
        const bb = b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
        const from = typeof bb.from === 'string' ? bb.from.trim() : '';
        const to = typeof bb.to === 'string' ? bb.to.trim() : '';
        if (!from || !to) continue;
        const branch: { from: string; to: string; label?: string } = { from, to };
        if (typeof bb.label === 'string' && bb.label.trim()) branch.label = bb.label.trim();
        branches.push(branch);
      }
      if (branches.length > 0) flow.branches = branches;
    }
    flows.push(flow);
  }

  const rawGeneratedFrom = obj.generatedFrom;
  const generatedFrom: ScreenMap['generatedFrom'] =
    rawGeneratedFrom === 'docs-review' || rawGeneratedFrom === 'docs' || rawGeneratedFrom === 'mixed'
      ? rawGeneratedFrom
      : 'docs';

  return { map: { schema_version: 1, generatedFrom, flows, screens }, warnings };
}

/** Render `screen-map.md` — bảng cho NGƯỜI duyệt. Dùng làm fallback khi agent
 *  không tự ghi file này (server.ts's `runLabMap`), NÊN đơn giản/tất định:
 *  "# Bản đồ màn" → mỗi luồng một khối (tiêu đề + basis + mainPath "a → b →
 *  c" + nhánh) → một bảng màn (key | tên | mục đích | phải có (cap 8 mục rồi
 *  "+N") | trạng thái | đi tới) → dòng "Nguồn: <generatedFrom>". */
export function renderScreenMapMd(map: ScreenMap): string {
  const lines: string[] = ['# Bản đồ màn', ''];

  for (const flow of map.flows) {
    const heading = flow.title ? `${flow.id} — ${flow.title}` : flow.id;
    const basisNote = flow.basis ? ` (${flow.basis})` : '';
    lines.push(`## ${heading}${basisNote}`);
    if (flow.mainPath.length > 0) {
      lines.push(`Luồng chính: ${flow.mainPath.join(' → ')}`);
    }
    for (const branch of flow.branches ?? []) {
      lines.push(`- Nhánh: ${branch.from} → ${branch.to}${branch.label ? ` (${branch.label})` : ''}`);
    }
    lines.push('');
  }

  lines.push('| Key | Tên | Mục đích | Phải có | Trạng thái | Đi tới |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const screen of map.screens) {
    const mustHaveParts = screen.mustHave
      .slice(0, 8)
      .map((m) => (m.label ? `${m.role}: ${m.label}` : m.role));
    const extra = screen.mustHave.length > 8 ? ` +${screen.mustHave.length - 8}` : '';
    const mustHaveCell = `${mustHaveParts.join(', ')}${extra}`;
    const statesCell = screen.states && screen.states.length > 0 ? screen.states.join(', ') : '';
    const navCell = screen.nav && screen.nav.length > 0 ? screen.nav.map((n) => n.to).join(', ') : '';
    lines.push(`| ${screen.key} | ${screen.name} | ${screen.purpose ?? ''} | ${mustHaveCell} | ${statesCell} | ${navCell} |`);
  }
  lines.push('');
  lines.push(`Nguồn: ${map.generatedFrom}`);
  return lines.join('\n');
}

// Cho phép cả `flows/<FLOW-ID>.flowchart.json` (file gốc) lẫn
// `flows/<FLOW-ID>/ux-review.json` + `flows/<FLOW-ID>/screens.json` (bên
// trong thư mục con của flow) — TÁCH bằng regex riêng vì đường dẫn khác cấp.
const FLOWCHART_RE = /^flows\/[^/]+\.flowchart\.json$/;
const UX_REVIEW_RE = /^flows\/[^/]+\/ux-review\.json$/;
const FLOW_SCREENS_RE = /^flows\/[^/]+\/screens\.json$/;
const SCREEN_JSON_RE = /^comp\/[^/]+\.screen\.json$/;

/** Từ danh sách đường dẫn TƯƠNG ĐỐI (tính từ gốc `docs-review/` của cùng dự
 *  án — ví dụ đầu ra của một liệt kê đệ quy `flows/` + `comp/`), chọn ĐÚNG
 *  các nguồn "nói CÁI GÌ" cho bản đồ màn:
 *
 *  - `flows/<FLOW-ID>.flowchart.json` — sơ đồ hiện trạng (node có `screen`
 *    key + edge có nhãn nhánh = mainPath/branches).
 *  - `flows/<FLOW-ID>/ux-review.json` — luồng ĐỀ XUẤT (basis 'proposed' khi dùng).
 *  - `flows/<FLOW-ID>/screens.json` — danh sách màn của riêng luồng đó.
 *  - `flows/index.json` — mục lục mọi luồng.
 *  - `comp/_screens.json` — kho màn + key ổn định (nguồn CHÍNH của `key`).
 *  - `comp/*.screen.json` — elements role/label/content/nav/notes trạng thái.
 *
 *  CỐ Ý loại: `wireframes/` (bố cục thi công, thứ bản đồ này cấm nói tới),
 *  `review/` (bản đã sửa của dr-review, không phải nguồn màn), mọi thư mục
 *  bắt đầu bằng `docs` (`docs/`, `docs-feature/` — tài liệu gốc, không phải
 *  đầu ra docs-review), `figma-build/` (input dựng THI CÔNG, khác mục đích
 *  SÁNG TÁC của lab), và hai file nội bộ của dr-comp (`comp/_role-map.json`,
 *  `comp/_inputs.json` — không phải dữ liệu màn). Trả về mảng đã SẮP XẾP ổn
 *  định (bảng chữ cái) để việc staging/đếm trong brief không đổi thứ tự giữa
 *  các lần chạy. */
export function pickDocsReviewMapSources(relPaths: readonly string[]): string[] {
  const picked = relPaths.filter((raw) => {
    const p = raw.replace(/\\/g, '/');
    if (p === 'flows/index.json') return true;
    if (p === 'comp/_screens.json') return true;
    if (FLOWCHART_RE.test(p)) return true;
    if (UX_REVIEW_RE.test(p)) return true;
    if (FLOW_SCREENS_RE.test(p)) return true;
    if (SCREEN_JSON_RE.test(p)) return true;
    return false;
  });
  return picked.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Tóm tắt bản đồ cho `buildComposeBrief` (lab-compose.ts) dùng — KHÔNG lộ
 *  toàn bộ `ScreenMap` cho brief compose (đã có brief riêng của lab-map cho
 *  việc đó), chỉ đưa đúng phần cần cho việc CHỌN màn dựng lần này.
 *
 *  `scoped`: nếu `scopeHint` (ô input của stage "Sáng tác màn") chứa NGUYÊN
 *  VĂN một `key` của bản đồ, HOẶC chứa hậu tố sau `__` của key đó (đồng thời
 *  cũng là `code` kiểu "6.2.1" khi key có dạng `<doc>__<code>`) → lấy các key
 *  đó, theo thứ tự chúng XUẤT HIỆN trong `map.screens`. Không khớp gì (kể cả
 *  `scopeHint` rỗng/absent) → 3 key đầu của `mainPath` luồng ĐẦU TIÊN; luồng
 *  đầu tiên không có `mainPath` (hoặc không có luồng nào) → 3 màn đầu của
 *  `map.screens`. */
export function summarizeScreenMapForCompose(
  map: ScreenMap,
  scopeHint?: string | null,
): { screens: { key: string; name: string; mustHaveCount: number }[]; mainPath: string[]; scoped: string[] } {
  const screens = map.screens.map((s) => ({ key: s.key, name: s.name, mustHaveCount: s.mustHave.length }));
  const mainPath = map.flows[0]?.mainPath ?? [];

  const hint = scopeHint && scopeHint.trim() ? scopeHint.trim() : '';
  let scoped: string[] = [];
  if (hint) {
    for (const s of map.screens) {
      const suffix = s.key.includes('__') ? s.key.slice(s.key.lastIndexOf('__') + 2) : '';
      if (hint.includes(s.key) || (suffix && hint.includes(suffix))) {
        scoped.push(s.key);
      }
    }
  }
  if (scoped.length === 0) {
    scoped = mainPath.length > 0 ? mainPath.slice(0, 3) : map.screens.slice(0, 3).map((s) => s.key);
  }

  return { screens, mainPath, scoped };
}

export interface BuildMapBriefOptions {
  /** Tên file tài liệu (tương đối từ cwd của agent, dưới `docs/`) đáng chú ý
   *  nhất — agent tự duyệt cả thư mục `docs/`. Rỗng → brief chỉ trỏ vào
   *  "docs/". */
  docsIndex: readonly string[];
  scopeHint?: string | null;
  appFeature: string;
  /** Số lượng file docs-review đã staging vào `map-src/` (server.ts đã đếm
   *  trước khi gọi) — rỗng cả bốn mục (0 flowchart, 0 ux-review, không có
   *  _screens.json, 0 screen.json) nghĩa là KHÔNG có docs-review cho dự án
   *  này, brief chuyển sang câu "tự phân tích từ docs". */
  mapSrc: {
    flowcharts: readonly string[];
    uxReviews: readonly string[];
    screensIndex: boolean;
    screenJsonCount: number;
  };
}

/** Message kickoff cho phiên agent duy nhất của stage `lab-map`. Thuần —
 *  không đọc đĩa/DB; server.ts (`runLabMap`) đã staging `map-src/` và đếm nội
 *  dung trước khi gọi hàm này. Phiên này KHÔNG có tool Figma (KHÔNG MCP nào
 *  gắn — Symbol INTERNAL_MCP_SERVER_IDS rỗng, giống lab-kit-plan) — brief
 *  PHẢI nói rõ điều đó. Dùng khuôn chung `renderLabBrief` (lab-brief.ts). */
export function buildMapBrief(opts: BuildMapBriefOptions): string {
  const docsLine =
    opts.docsIndex.length > 0
      ? `- Tài liệu: \`docs/\` (đáng chú ý: ${opts.docsIndex.map((p) => `"${p}"`).join(', ')}; đọc cả thư mục)`
      : '- Tài liệu: `docs/` (đọc cả thư mục)';
  const hasMapSrc =
    opts.mapSrc.flowcharts.length > 0 ||
    opts.mapSrc.uxReviews.length > 0 ||
    opts.mapSrc.screensIndex ||
    opts.mapSrc.screenJsonCount > 0;
  const mapSrcLine = hasMapSrc
    ? `- Nguồn docs-review đã staging \`map-src/\`: flowchart ×${opts.mapSrc.flowcharts.length} (${opts.mapSrc.flowcharts.join(', ') || '—'}), ux-review ×${opts.mapSrc.uxReviews.length}, _screens.json ${checkMark(opts.mapSrc.screensIndex)}, screen.json ×${opts.mapSrc.screenJsonCount}`
    : '- Nguồn docs-review: (không có docs-review — tự phân tích từ docs)';
  const figmaLine = '- Figma: không có trong phiên này — chủ đích.';
  const scopeLine =
    opts.scopeHint && opts.scopeHint.trim()
      ? `- Định hướng người dùng: "${opts.scopeHint.trim()}"`
      : '- Định hướng người dùng: (không có)';

  return renderLabBrief({
    title: `# Bản đồ màn · ${opts.appFeature}`,
    skillId: 'lab-map',
    inputLines: [docsLine, mapSrcLine, figmaLine, scopeLine],
    taskLines: [
      '- Đọc `map-src/` trước, `docs/` sau để đối chiếu.',
      '- Liệt kê từng luồng kèm mainPath (đường đi chính, không phải mọi nhánh).',
      '- Với mỗi màn: purpose, mustHave (role + content), states, nav.',
      '- Ghi đúng hai file kết quả trước khi kết thúc phiên.',
    ],
    reminderLines: [
      '- Bản đồ nói CÁI GÌ, không LÀM THẾ NÀO (không toạ độ/thứ tự/bố cục).',
      '- Key nguyên văn docs-review khi có, ổn định giữa các lần chạy.',
      '- Có ux-review → ưu tiên luồng proposed, ghi rõ basis.',
    ],
    endingLines: [
      `- \`${SCREEN_MAP_FILE_REL}\` — \`{"schema_version":1,"generatedFrom","flows":[{"id","mainPath"}],"screens":[{"key","name","mustHave"}]}\``,
      `- \`${SCREEN_MAP_MD_REL}\` — bảng cho người duyệt`,
    ],
  });
}
