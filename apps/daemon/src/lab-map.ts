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
// WP-lab-shell (2026-08-23 — .tmp/pipeline/wp-lab-shell.yaml): "Khung màn"
// (shell) — bảng luật cố định (loại màn → vai trò must/should/avoid) +
// pattern suy kind từ tên sống ở lab-shell.ts (module thuần, không import
// ngược lại module này). ScreenMapScreen.shell re-export type ở đây để
// caller cũ (lab-compose.ts, server.ts) chỉ cần import một chỗ.
import {
  SHELL_KINDS,
  SHELL_ROLES,
  SHELL_RULES,
  SHELL_KIND_NAME_PATTERNS,
  type ScreenMapShell,
  type ShellKind,
  type ShellRole,
} from './lab-shell.js';

export type { ScreenMapShell };

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
  /** WP-lab-shell: khung màn (loại + vai trò must/should/avoid) — agent
   *  lab-map GHI trực tiếp (`source: 'agent'` sau parse) hoặc bỏ trống để
   *  daemon tự suy (`deriveShellDefaults`/`fillShellDefaults`). */
  shell?: ScreenMapShell;
  /** WP-lab-refs-daemon (2026-08-24 — .tmp/pipeline/wp-lab-refs-daemon.yaml):
   *  concept tham khảo agent lab-map đã MAP cho màn này (từ `refs/refs.json`)
   *  — `conceptId` là `<fileKey>:<nodeId>` của concept, `png` là đường dẫn
   *  ảnh đã tải (`refs/<slug>.png`) tại THỜI ĐIỂM map (lab-compose tra lại
   *  refs.json hiện tại theo `conceptId` thay vì tin `png` này cũ). Bỏ trống
   *  khi agent không tìm được concept nào khớp — KHÔNG gán bừa. */
  reference?: { conceptId: string; fileKey: string; nodeId: string; png?: string };
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
    // WP-lab-shell: `shell.kind` phải thuộc SHELL_KINDS — kind lạ (hoặc
    // thiếu) BỎ CẢ shell (kèm warning; daemon tự suy qua deriveShellDefaults
    // ở chỗ khác), không giữ lại một shell với kind rác. must/should/avoid:
    // trim+lowercase, giữ đúng giá trị thuộc SHELL_ROLES — giá trị lạ bị lọc
    // (kèm một warning cho cả màn, không phải một warning/giá-trị).
    if (e.shell && typeof e.shell === 'object' && !Array.isArray(e.shell)) {
      const sh = e.shell as Record<string, unknown>;
      const kindRaw = typeof sh.kind === 'string' ? sh.kind.trim() : '';
      if ((SHELL_KINDS as readonly string[]).includes(kindRaw)) {
        const parseRoles = (raw: unknown, field: string): ShellRole[] => {
          if (!Array.isArray(raw)) return [];
          const roles: ShellRole[] = [];
          let droppedAny = false;
          for (const r of raw) {
            const v = typeof r === 'string' ? r.trim().toLowerCase() : '';
            if (v && (SHELL_ROLES as readonly string[]).includes(v)) {
              roles.push(v as ShellRole);
            } else {
              droppedAny = true;
            }
          }
          if (droppedAny) {
            warnings.push(`Màn "${key}": shell.${field} có vai trò không hợp lệ — đã bỏ giá trị đó.`);
          }
          return roles;
        };
        const shell: ScreenMapShell = {
          kind: kindRaw as ShellKind,
          must: parseRoles(sh.must, 'must'),
          should: parseRoles(sh.should, 'should'),
          avoid: parseRoles(sh.avoid, 'avoid'),
          source: 'agent',
        };
        if (typeof sh.note === 'string' && sh.note.trim()) shell.note = sh.note.trim();
        screen.shell = shell;
      } else {
        warnings.push(`Màn "${key}": shell.kind không hợp lệ — daemon sẽ tự suy.`);
      }
    }
    // WP-lab-refs-daemon: `reference` — hỏng (không phải object, hoặc thiếu
    // conceptId/fileKey/nodeId) → BỎ field (kèm warning), KHÔNG bỏ cả màn
    // (cùng nguyên tắc "một field hỏng không kéo sập cả entry" như `shell`).
    if (e.reference !== undefined) {
      const r = e.reference && typeof e.reference === 'object' && !Array.isArray(e.reference) ? (e.reference as Record<string, unknown>) : null;
      const conceptId = typeof r?.conceptId === 'string' ? r.conceptId.trim() : '';
      const fileKey = typeof r?.fileKey === 'string' ? r.fileKey.trim() : '';
      const nodeId = typeof r?.nodeId === 'string' ? r.nodeId.trim() : '';
      if (conceptId && fileKey && nodeId) {
        const reference: NonNullable<ScreenMapScreen['reference']> = { conceptId, fileKey, nodeId };
        if (typeof r?.png === 'string' && r.png.trim()) reference.png = r.png.trim();
        screen.reference = reference;
      } else {
        warnings.push(`Màn "${key}": reference thiếu/sai định dạng (cần conceptId/fileKey/nodeId) — đã bỏ field này.`);
      }
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

/** Suy khung màn MẶC ĐỊNH cho MỌI màn của bản đồ (kể cả màn đã có `shell` —
 *  caller quyết dùng hay không, xem `resolveScreenShell`/`fillShellDefaults`
 *  bên dưới): `kind` khớp `SHELL_KIND_NAME_PATTERNS` trên `name` trước, rồi
 *  `purpose` nếu `name` không khớp gì (mỗi lượt thử ĐÚNG thứ tự ưu tiên của
 *  mảng patterns) — không khớp gì cả (nghĩa là không phải sheet/modal/
 *  result/fullscreen) thì xét màn đó có đang được một màn KHÁC trỏ tới không
 *  (`nav[].to`, `mainPath[i>0]` của bất kỳ luồng nào, hoặc `branches[].to`):
 *  KHÔNG ai trỏ tới → `'root'` (điểm bắt đầu); CÓ ai trỏ tới → `'child'`.
 *  `must`/`should`/`avoid` copy nguyên bảng `SHELL_RULES[kind]` (mảng mới,
 *  không chia sẻ tham chiếu với hằng số), `source: 'derived'`. */
export function deriveShellDefaults(map: ScreenMap): Map<string, ScreenMapShell> {
  const referenced = new Set<string>();
  for (const screen of map.screens) {
    for (const nav of screen.nav ?? []) referenced.add(nav.to);
  }
  for (const flow of map.flows) {
    for (const key of flow.mainPath.slice(1)) referenced.add(key);
    for (const branch of flow.branches ?? []) referenced.add(branch.to);
  }

  const result = new Map<string, ScreenMapShell>();
  for (const screen of map.screens) {
    let kind: ShellKind | null = null;
    for (const pattern of SHELL_KIND_NAME_PATTERNS) {
      if (pattern.re.test(screen.name)) {
        kind = pattern.kind;
        break;
      }
    }
    if (!kind && screen.purpose) {
      for (const pattern of SHELL_KIND_NAME_PATTERNS) {
        if (pattern.re.test(screen.purpose)) {
          kind = pattern.kind;
          break;
        }
      }
    }
    if (!kind) kind = referenced.has(screen.key) ? 'child' : 'root';

    const rules = SHELL_RULES[kind];
    result.set(screen.key, {
      kind,
      must: [...rules.must],
      should: [...rules.should],
      avoid: [...rules.avoid],
      source: 'derived',
    });
  }
  return result;
}

/** Khung HIỆU LỰC của một màn: `screen.shell` (agent tự ghi) thắng, không có
 *  thì tra `derived` (kết quả `deriveShellDefaults`), cả hai đều vắng (màn
 *  không có trong `derived` — không nên xảy ra khi `derived` được tính từ
 *  CHÍNH map chứa `screen`, nhưng caller có thể truyền map khác) → khung
 *  `child` mặc định (kind cẩn trọng nhất — PHẢI App Bar + back). */
export function resolveScreenShell(screen: ScreenMapScreen, derived: Map<string, ScreenMapShell>): ScreenMapShell {
  return (
    screen.shell ??
    derived.get(screen.key) ?? {
      kind: 'child',
      must: [...SHELL_RULES.child.must],
      should: [...SHELL_RULES.child.should],
      avoid: [...SHELL_RULES.child.avoid],
      source: 'derived',
    }
  );
}

/** Trả một BẢN SAO `map` mà MỌI màn thiếu `shell` được điền theo
 *  `deriveShellDefaults` — màn ĐÃ có `shell` (agent tự ghi) giữ NGUYÊN,
 *  không bị derive ghi đè. `filled`: key các màn VỪA được điền (để server.ts
 *  quyết định có cần ghi lại `screen-map.json` hay không, và log số màn đã
 *  điền). Thuần — không fs; server.ts (`runLabMap`) gọi hàm này rồi tự ghi
 *  file nếu `filled.length > 0`. */
export function fillShellDefaults(map: ScreenMap): { map: ScreenMap; filled: string[] } {
  const derived = deriveShellDefaults(map);
  const filled: string[] = [];
  const screens = map.screens.map((screen) => {
    if (screen.shell) return screen;
    filled.push(screen.key);
    return { ...screen, shell: resolveScreenShell(screen, derived) };
  });
  return { map: { ...map, screens }, filled };
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

  // WP-lab-shell: cột "Khung" — dùng derive nội bộ (không phải server.ts's
  // đã-điền) để một map CHƯA từng qua `fillShellDefaults` vẫn hiện cột này
  // (renderScreenMapMd cũng được gọi làm fallback ngay sau parse, trước khi
  // server.ts quyết định ghi lại file).
  const derivedShells = deriveShellDefaults(map);
  // WP-lab-refs-daemon: cột "Concept" — CHỈ thêm khi ÍT NHẤT MỘT màn có
  // `reference` (must_not: dự án không refs phải BYTE-IDENTICAL với bản
  // trước WP này — thêm cột vô điều kiện sẽ phá bất biến đó).
  const hasReference = map.screens.some((screen) => screen.reference != null);
  const headerCells = ['Key', 'Tên', 'Mục đích', 'Phải có', 'Khung', ...(hasReference ? ['Concept'] : []), 'Trạng thái', 'Đi tới'];
  lines.push(`| ${headerCells.join(' | ')} |`);
  lines.push(`| ${headerCells.map(() => '---').join(' | ')} |`);
  for (const screen of map.screens) {
    const mustHaveParts = screen.mustHave
      .slice(0, 8)
      .map((m) => (m.label ? `${m.role}: ${m.label}` : m.role));
    const extra = screen.mustHave.length > 8 ? ` +${screen.mustHave.length - 8}` : '';
    const mustHaveCell = `${mustHaveParts.join(', ')}${extra}`;
    const statesCell = screen.states && screen.states.length > 0 ? screen.states.join(', ') : '';
    const navCell = screen.nav && screen.nav.length > 0 ? screen.nav.map((n) => n.to).join(', ') : '';
    const shell = resolveScreenShell(screen, derivedShells);
    const shellParts = [shell.kind as string];
    if (shell.must.length > 0) shellParts.push(`phải: ${shell.must.join(', ')}`);
    if (shell.should.length > 0) shellParts.push(`nên: ${shell.should.join(', ')}`);
    if (shell.avoid.length > 0) shellParts.push(`tránh: ${shell.avoid.join(', ')}`);
    const shellCell = shellParts.join(' · ');
    const rowCells = [
      screen.key,
      screen.name,
      screen.purpose ?? '',
      mustHaveCell,
      shellCell,
      ...(hasReference ? [screen.reference?.conceptId ?? '—'] : []),
      statesCell,
      navCell,
    ];
    lines.push(`| ${rowCells.join(' | ')} |`);
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
 *  `map.screens`.
 *
 *  WP-lab-shell: `shells` — khung màn HIỆU LỰC (agent tự ghi thắng, derive
 *  khi bỏ trống — xem `resolveScreenShell`) cho ĐÚNG các màn trong `scoped`,
 *  theo CÙNG thứ tự — đủ để `buildComposeBrief` in dòng "Khung <key>" mà
 *  không cần lộ toàn bộ `ScreenMap`.
 *
 *  WP-lab-refs-daemon: `references` — `reference` THÔ (nguyên văn agent
 *  lab-map ghi) của các màn trong `scoped` CÓ field đó (màn không có bị lọc
 *  ra, khác `shells` luôn có đủ mọi màn scoped) — server.ts's `runLabCompose`
 *  tự tra lại `refs/refs.json` hiện tại theo `reference.conceptId` để lấy
 *  `conceptName`/`png` mới nhất (KHÔNG tin `reference.png` có thể đã cũ) rồi
 *  mới ráp `BuildComposeBriefOptions.map.references`. */
export function summarizeScreenMapForCompose(
  map: ScreenMap,
  scopeHint?: string | null,
): {
  screens: { key: string; name: string; mustHaveCount: number }[];
  mainPath: string[];
  scoped: string[];
  shells: { key: string; kind: string; must: string[]; should: string[]; avoid: string[] }[];
  references: { key: string; reference: NonNullable<ScreenMapScreen['reference']> }[];
} {
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

  const screenByKey = new Map(map.screens.map((s) => [s.key, s]));
  const derivedShells = deriveShellDefaults(map);
  const shells = scoped
    .map((key) => screenByKey.get(key))
    .filter((s): s is ScreenMapScreen => s != null)
    .map((s) => {
      const shell = resolveScreenShell(s, derivedShells);
      return { key: s.key, kind: shell.kind as string, must: shell.must, should: shell.should, avoid: shell.avoid };
    });
  const references = scoped
    .map((key) => screenByKey.get(key))
    .filter((s): s is ScreenMapScreen => s != null && s.reference != null)
    .map((s) => ({ key: s.key, reference: s.reference! }));

  return { screens, mainPath, scoped, shells, references };
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
  /** WP-lab-refs-daemon: concept đã quét được (server.ts đã `readLabRefs`
   *  trước khi gọi) — `null`/rỗng (chưa quét link tham khảo nào cho dự án
   *  này) → brief Y HỆT hành vi trước WP này (không dòng nào về concept).
   *  WP-lab-refs-v2: `structure` — đường dẫn `refs/<slug>.structure.json`
   *  (cây bố cục) của concept, LUÔN có khi concept có — chỉ optional ở đây vì
   *  registry cũ (quét trước WP này) có thể thiếu field. */
  concepts?: { id: string; name: string; png: string; structure?: string }[] | null;
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
  // WP-lab-refs-daemon: concept tham khảo — chỉ có dòng khi server.ts đã đọc
  // được ≥1 concept từ `refs/refs.json` (null/rỗng → không dòng nào, brief Y
  // HỆT trước WP này). WP-lab-refs-v2: nhắc thêm structure.json (cây bố cục)
  // — nguồn CẤU TRÚC thật để agent lab-map/lab-compose đối chiếu thay vì chỉ
  // nhìn ảnh đoán bố cục.
  const concepts = opts.concepts ?? null;
  const conceptsLine =
    concepts && concepts.length > 0
      ? `- Concept tham khảo: refs/refs.json — ${concepts.length} concept (ảnh refs/*.png, Read được; mỗi concept có structure.json (cây bố cục) — Read khi cần đối chiếu)`
      : null;

  return renderLabBrief({
    title: `# Bản đồ màn · ${opts.appFeature}`,
    skillId: 'lab-map',
    inputLines: [docsLine, mapSrcLine, figmaLine, scopeLine, ...(conceptsLine ? [conceptsLine] : [])],
    taskLines: [
      '- Đọc `map-src/` trước, `docs/` sau để đối chiếu.',
      '- Liệt kê từng luồng kèm mainPath (đường đi chính, không phải mọi nhánh).',
      '- Với mỗi màn: purpose, mustHave (role + content), states, nav.',
      '- Với mỗi màn: shell (kind + must/should/avoid) theo bảng luật skill; bỏ trống thì daemon tự suy.',
      ...(concepts && concepts.length > 0
        ? ['- Map mỗi màn ↔ một concept khớp nhất (field `reference`, theo tên/ngữ nghĩa/ảnh); không concept nào khớp → bỏ trống field.']
        : []),
      '- Ghi đúng hai file kết quả trước khi kết thúc phiên.',
    ],
    reminderLines: [
      '- Bản đồ nói CÁI GÌ, không LÀM THẾ NÀO (không toạ độ/thứ tự/bố cục).',
      '- Key nguyên văn docs-review khi có, ổn định giữa các lần chạy.',
      '- Có ux-review → ưu tiên luồng proposed, ghi rõ basis.',
    ],
    endingLines: [
      `- \`${SCREEN_MAP_FILE_REL}\` — \`{"schema_version":1,"generatedFrom","flows":[{"id","mainPath"}],"screens":[{"key","name","mustHave","shell"}]}\``,
      `- \`${SCREEN_MAP_MD_REL}\` — bảng cho người duyệt`,
    ],
  });
}
