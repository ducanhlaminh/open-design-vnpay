// WP dr-screens-merge (2026-08-27) — "Phát hiện màn hình" (dr-screens, skill
// docs-screen-discovery) GỘP vào "Luồng màn hình" (dr-flow, skill
// docs-screen-flow): agent vẽ luồng ĐÃ phải trả lời "heading nào là màn", nên
// nó ghi luôn danh sách màn có thẩm quyền vào `flows/SCREEN-FLOW/screens.json`
// v2 (`screens[]` với key/code/name/anchorText/cell/why/blocks) thay vì để một
// lượt agent thứ hai đọc lại toàn bộ tài liệu và cho kết quả lệch (SIM du
// lịch: flow 8 màn, discovery 9 màn).
//
// Module này THUẦN (không fs, không Date): parse v2 khoan dung → dẫn xuất
// `cells`/`names` (contract v1 mà finalizeFlowUx đọc — KHÔNG đổi) → chuyển
// sang `DiscoveredDoc` (contract cũ của screens-discovered.json — dr-comp /
// ScreensDiscoveredPreview / ScreenListManager KHÔNG đổi) + render bản
// người-đọc `screens-discovered.md` cùng bố cục cũ. Caller (screen-flow-xml.ts
// + server.ts) lo phần đọc/ghi và đưa `generatedAt` vào để test tất định.
import type { DiscoveredDoc, DiscoveredExcludedEntry, DiscoveredPageEntry, DiscoveredScreenEntry } from '../screen-components.js';
import { deriveSuffixGroupKeys } from '../screen-groups.js';

/** WP screen-flow-platform-split (2026-08-28): nền tảng của màn — AGENT quyết
 *  từ cách tài liệu viết (MB/IB/BO… chỉ là gợi ý ngữ cảnh); daemon CHỈ kiểm
 *  giá trị, không suy từ heading, không ghi đè. */
export type ScreenPlatform = 'app' | 'web';
export const SCREEN_PLATFORMS: readonly ScreenPlatform[] = ['app', 'web'];
export function isScreenPlatform(v: unknown): v is ScreenPlatform {
  return v === 'app' || v === 'web';
}

export interface ScreenFlowBlock {
  name: string;
  anchorText: string;
  why?: string;
}

export interface ScreenFlowScreen {
  /** `<file-stem>__<code>` — luật SCREEN-KEY cũ. */
  key: string;
  /** Mã màn tài liệu ghi; `null` → daemon (validateDocScreenExtract) tự đánh X1, X2… */
  code: string | null;
  name: string;
  /** MỘT dòng nguyên văn DUY NHẤT trong trang nguồn — đối chiếu tất định ở lớp persist. */
  anchorText: string;
  /** id node `od-…` trong XML, hoặc `null` khi màn không có node riêng trên luồng. */
  cell: string | null;
  why?: string;
  /** Trang nguồn riêng (tài liệu nhiều trang); mặc định = `source` cấp file. */
  source?: string;
  blocks?: ScreenFlowBlock[];
  /** WP screen-flow-platform-split: bắt buộc trong flow đã tách
   *  (`flows/SCREEN-FLOW--app|--web`, phải khớp thư mục); flow đơn có thể
   *  vắng (byte-identical) hoặc đồng nhất một giá trị. */
  platform?: ScreenPlatform;
}

export interface ScreenFlowExcluded {
  name: string;
  reason: string;
  source?: string;
  partOf?: string;
}

export interface ScreensV2 {
  title?: string;
  source?: string;
  note?: string;
  screens: ScreenFlowScreen[];
  excluded: ScreenFlowExcluded[];
  /** Pass-through các field v1 tuỳ chọn mà finalizeFlowUx vẫn đọc (WP-V3 groups, recovery meta). */
  meta?: Record<string, unknown>;
  groups?: Record<string, unknown>;
}

export type ParseScreensV2Result =
  | { doc: ScreensV2; warnings: string[] }
  | { v1: true }
  | { errors: string[] };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function optStr(v: unknown): string | undefined {
  const s = str(v);
  return s ? s : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Parse `screens.json` (raw JSON đã parse). Ba kết cục:
 *  - không có field `screens` → `{ v1: true }` (file cũ `cells`+`names`, caller
 *    KHÔNG đụng file, không sinh discovery — dr-comp lùi về lớp regex);
 *  - `screens` là mảng → `{ doc, warnings }`, KHOAN DUNG như parseScreensDiscovered:
 *    entry thiếu key/name/anchorText bị bỏ kèm warning; `cell`/`code` không
 *    phải chuỗi → null; block thiếu name/anchorText bị bỏ; excluded thiếu
 *    name/reason bị bỏ;
 *  - shape không dùng được (không phải object, `screens` không phải mảng, hoặc
 *    không còn entry hợp lệ nào) → `{ errors }` — caller chặn stage với thông
 *    điệp cụ thể (agent vẽ luồng nhưng khai màn hỏng = chạy lại). */
export function parseScreenFlowScreensV2(raw: unknown): ParseScreensV2Result {
  if (!isRecord(raw)) return { errors: ['screens.json không phải một object JSON'] };
  if (raw.screens === undefined) return { v1: true };
  if (!Array.isArray(raw.screens)) return { errors: ['screens.json: "screens" phải là một mảng'] };

  const warnings: string[] = [];
  const platformErrors: string[] = [];
  const screens: ScreenFlowScreen[] = [];
  raw.screens.forEach((rs, i) => {
    if (!isRecord(rs)) {
      warnings.push(`screens[${i}] không phải object — bỏ qua`);
      return;
    }
    const key = str(rs.key);
    const name = str(rs.name);
    const anchorText = str(rs.anchorText);
    if (!key || !name || !anchorText) {
      const label = key || name || anchorText || `#${i}`;
      warnings.push(`screens[${i}] "${label}" thiếu key/name/anchorText — bỏ qua`);
      return;
    }
    const code = typeof rs.code === 'string' ? str(rs.code) || null : null;
    const cell = typeof rs.cell === 'string' ? str(rs.cell) || null : null;
    if (rs.cell != null && typeof rs.cell !== 'string') warnings.push(`screens[${i}] "${key}": cell không phải chuỗi — coi như null`);
    const blocks: ScreenFlowBlock[] = [];
    if (Array.isArray(rs.blocks)) {
      for (const rb of rs.blocks) {
        if (!isRecord(rb)) continue;
        const bName = str(rb.name);
        const bAnchor = str(rb.anchorText);
        if (!bName || !bAnchor) {
          warnings.push(`screens[${i}] "${key}": block thiếu name/anchorText — bỏ qua`);
          continue;
        }
        const why = optStr(rb.why);
        blocks.push({ name: bName, anchorText: bAnchor, ...(why ? { why } : {}) });
      }
    }
    const why = optStr(rs.why);
    const source = optStr(rs.source);
    // platform: chỉ nhận `app`|`web`; giá trị khác → LỖI chặn (agent phải sửa,
    // daemon không đoán hộ). Vắng/null → không có field.
    let platform: ScreenPlatform | undefined;
    if (rs.platform != null && rs.platform !== '') {
      if (isScreenPlatform(rs.platform)) platform = rs.platform;
      else platformErrors.push(`screens[${i}] "${key}": platform "${String(rs.platform)}" không hợp lệ — chỉ nhận ${SCREEN_PLATFORMS.map((p) => `"${p}"`).join(' | ')}`);
    }
    screens.push({
      key,
      code,
      name,
      anchorText,
      cell,
      ...(why ? { why } : {}),
      ...(source ? { source } : {}),
      ...(blocks.length ? { blocks } : {}),
      ...(platform ? { platform } : {}),
    });
  });
  if (platformErrors.length) return { errors: platformErrors };
  if (screens.length === 0) return { errors: ['screens.json: "screens" không có entry hợp lệ nào (cần key + name + anchorText)', ...warnings] };

  const excluded: ScreenFlowExcluded[] = [];
  if (Array.isArray(raw.excluded)) {
    raw.excluded.forEach((rx, i) => {
      if (!isRecord(rx)) return;
      const name = str(rx.name);
      const reason = str(rx.reason);
      if (!name || !reason) {
        warnings.push(`excluded[${i}] thiếu name/reason — bỏ qua`);
        return;
      }
      const source = optStr(rx.source);
      const partOf = optStr(rx.partOf);
      excluded.push({ name, reason, ...(source ? { source } : {}), ...(partOf ? { partOf } : {}) });
    });
  }

  const title = optStr(raw.title);
  const source = optStr(raw.source);
  const note = optStr(raw.note);
  const doc: ScreensV2 = {
    ...(title ? { title } : {}),
    ...(source ? { source } : {}),
    ...(note ? { note } : {}),
    screens,
    excluded,
    ...(isRecord(raw.meta) ? { meta: raw.meta } : {}),
    ...(isRecord(raw.groups) ? { groups: raw.groups } : {}),
  };
  return { doc, warnings };
}

export interface DeriveCellsResult {
  /** node id → SCREEN-KEY — chỉ entry có `cell`. */
  cells: Record<string, string>;
  /** SCREEN-KEY → tên — MỌI entry (kể cả cell null). */
  names: Record<string, string>;
  /** `screens[]` đã chuẩn hoá (cell trùng → null ở entry sau). */
  screens: ScreenFlowScreen[];
  warnings: string[];
}

/** Dẫn xuất contract v1 (`cells`/`names`) từ `screens[]`. Cells là map 1-1:
 *  hai entry cùng `cell` → giữ entry đầu, entry sau về `cell: null` + warning
 *  (biến thể nền tảng đúng luật là entry phụ đã null sẵn). Key trùng → giữ
 *  entry đầu + warning. Có `knownCells` → cell không có trong XML cũng về
 *  null + warning (finalizeFlowUx sẽ không còn gì để "screensDropped"). */
export function deriveCellsAndNames(doc: ScreensV2, knownCells?: ReadonlySet<string>): DeriveCellsResult {
  const cells: Record<string, string> = {};
  const names: Record<string, string> = {};
  const warnings: string[] = [];
  const screens: ScreenFlowScreen[] = [];
  const seenKeys = new Set<string>();
  for (const s of doc.screens) {
    if (seenKeys.has(s.key)) {
      warnings.push(`screens.json: key "${s.key}" khai hai lần — giữ entry đầu`);
      continue;
    }
    seenKeys.add(s.key);
    let cell = s.cell;
    if (cell && knownCells && !knownCells.has(cell)) {
      warnings.push(`screens.json: màn "${s.key}" trỏ cell "${cell}" không có trong XML — coi như không có node`);
      cell = null;
    }
    if (cell && cells[cell]) {
      warnings.push(`screens.json: cell "${cell}" gắn cho cả "${cells[cell]}" lẫn "${s.key}" — giữ entry đầu, entry sau về null`);
      cell = null;
    }
    if (cell) cells[cell] = s.key;
    names[s.key] = s.name;
    screens.push({ ...s, cell });
  }
  return { cells, names, screens, warnings };
}

/** Chuyển v2 → `DiscoveredDoc` (contract screens-discovered.json, xem
 *  screen-components.ts) — `pages[]` nhóm theo `source` (entry không có
 *  source riêng → source cấp file), thứ tự trang theo lần xuất hiện đầu;
 *  `code` giữ nguyên (null vẫn null) NHƯNG `key` đi kèm (A0: key trong
 *  screens.json đã finalize là thẩm quyền duy nhất — persist không đánh lại
 *  `X<n>`); `platform` pass-through khi agent khai; `groupKey` suy từ cặp hậu
 *  tố `--app`/`--web`; `blocks`/`why`/`excluded` pass-through,
 *  `excluded[].source` mặc định = source cấp file. */
export function toDiscoveredDoc(doc: ScreensV2, opts: { generatedAt: string }): DiscoveredDoc {
  return toDiscoveredDocs([{ doc }], opts);
}

/** WP screen-flow-platform-split: HỢP nhiều flow (`SCREEN-FLOW--app` +
 *  `SCREEN-FLOW--web`) thành MỘT DiscoveredDoc — trang nhóm theo `source`
 *  xuyên flow (thứ tự lần xuất hiện đầu, flow theo thứ tự truyền vào), màn
 *  giữ thứ tự agent trong từng flow; key trùng xuyên flow → giữ entry đầu.
 *  `groupKey` suy trên TOÀN tập key (cặp `--app`/`--web` ở hai flow). Một
 *  flow → kết quả y hệt `toDiscoveredDoc` trước WP (không field mới rỗng). */
export function toDiscoveredDocs(flows: Array<{ id?: string; doc: ScreensV2 }>, opts: { generatedAt: string }): DiscoveredDoc {
  const pages: DiscoveredPageEntry[] = [];
  const bySource = new Map<string, DiscoveredPageEntry>();
  const excluded: DiscoveredExcludedEntry[] = [];
  const seenKeys = new Set<string>();
  const seenExcluded = new Set<string>();
  const groupKeys = deriveSuffixGroupKeys(flows.flatMap((f) => f.doc.screens.map((s) => s.key)));
  for (const { doc } of flows) {
    const fileSource = doc.source ?? '';
    for (const s of doc.screens) {
      if (seenKeys.has(s.key)) continue;
      seenKeys.add(s.key);
      const source = s.source ?? fileSource;
      let page = bySource.get(source);
      if (!page) {
        page = { source, screens: [] };
        bySource.set(source, page);
        pages.push(page);
      }
      const groupKey = groupKeys.get(s.key);
      const entry: DiscoveredScreenEntry = {
        key: s.key,
        code: s.code,
        name: s.name,
        anchorText: s.anchorText,
        ...(s.why ? { why: s.why } : {}),
        ...(s.blocks?.length ? { blocks: s.blocks.map((b) => ({ ...b })) } : {}),
        ...(s.platform ? { platform: s.platform } : {}),
        ...(groupKey ? { groupKey } : {}),
      };
      page.screens.push(entry);
    }
    for (const e of doc.excluded) {
      const source = e.source ?? fileSource;
      const dedupe = `${source}::${e.name}`;
      if (seenExcluded.has(dedupe)) continue;
      seenExcluded.add(dedupe);
      excluded.push({ name: e.name, source, reason: e.reason, ...(e.partOf ? { partOf: e.partOf } : {}) });
    }
  }
  return { schema_version: 1, generatedAt: opts.generatedAt, pages, excluded };
}

function codeLabel(code: string | null, name: string, platform?: 'app' | 'web'): string {
  const base = code ? `\`${code}\` — ${name}` : name;
  return platform ? `${base} (${platform === 'app' ? 'App' : 'Web'})` : base;
}

/** Bản người-đọc `screens-discovered.md` — cùng ba mục như bản agent
 *  dr-screens từng viết ("## Màn hình thật" / "## Khối bổ sung" /
 *  "## Mục tài liệu bị loại") để người review quen mắt; luôn đủ ba mục. */
export function renderDiscoveredMd(
  doc: DiscoveredDoc,
  title: string,
  opts: {
    proposed?: Array<{ key: string; name: string; why?: string }>;
    /** WP screen-flow-platform-split: id các flow nguồn — vắng/1 flow `SCREEN-FLOW` → dòng nguồn như cũ. */
    flowIds?: string[];
  } = {},
): string {
  const lines: string[] = [`# Phát hiện màn hình — ${title}`, ''];
  const flowIds = opts.flowIds?.length ? opts.flowIds : ['SCREEN-FLOW'];
  lines.push(`_Sinh cùng bước Luồng màn hình (dr-flow) từ ${flowIds.map((id) => `\`flows/${id}/screens.json\``).join(' + ')}._`, '');
  const multiPage = doc.pages.length > 1;
  if (!multiPage && doc.pages[0]?.source) lines.push(`Nguồn: \`${doc.pages[0].source}\``, '');

  lines.push('## Màn hình thật', '');
  let n = 0;
  for (const page of doc.pages) {
    if (multiPage) lines.push(`Nguồn: \`${page.source}\``, '');
    for (const s of page.screens) {
      n += 1;
      lines.push(`${n}. ${codeLabel(s.code, s.name, s.platform)}`);
    }
    if (multiPage) lines.push('');
  }
  if (n === 0) lines.push('_Không có._');
  lines.push('');

  lines.push('## Khối bổ sung', '');
  let anyBlock = false;
  for (const page of doc.pages) {
    for (const s of page.screens) {
      if (!s.blocks?.length) continue;
      anyBlock = true;
      lines.push(`- ${codeLabel(s.code, s.name)}`);
      for (const b of s.blocks) {
        lines.push(`  - Khối bổ sung: ${b.name}`);
        if (b.why) lines.push(`    - Lý do: ${b.why}`);
      }
    }
  }
  if (!anyBlock) lines.push('_Không có._');
  lines.push('');

  lines.push('## Mục tài liệu bị loại', '');
  if (doc.excluded.length === 0) lines.push('_Không có._');
  for (const e of doc.excluded) {
    lines.push(`- \`${e.name}\` — ${e.reason}${e.partOf ? ` (thuộc: ${e.partOf})` : ''}`);
  }
  lines.push('');
  // WP dr-flow-improve: màn chỉ có ở bản "Cải thiện" (đang được chọn chạy tiếp).
  if (opts.proposed?.length) {
    lines.push('## Màn đề xuất (bản cải thiện)', '');
    for (const p of opts.proposed) lines.push(`- ${p.name} (\`${p.key}\`)${p.why ? ` — ${p.why}` : ''}`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
