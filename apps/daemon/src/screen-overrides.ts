// Lớp 3 của kiến trúc 3 lớp đã duyệt (19/08): người dùng phải nhìn thấy máy
// đoán màn nào (comp/_screens.json — manifest, kèm nguồn gốc từng màn) và
// sửa được khi máy sai (docs-review/screens-overrides.json), thay vì sửa
// prompt hay sửa tài liệu gốc.
//
// Pure (không DB, không agent). WP14 đã nối module này vào server.ts (gọi
// `applyScreenOverrides` sau lượt trích lớp 2, `buildScreensManifest` trước
// role-map, 2 route HTTP GET/PUT) và hợp nhất helper anchor (`findAnchorLine`
// nay chỉ còn quyết định "đúng 1 lần") + origin 'user' vào union chính thức
// của `ScreenInput` — không còn cast cục bộ như bản WP13a song song.

import path from 'node:path';

import type {
  ScreensManifest,
  ScreensManifestEntry,
  ScreensOverrides,
  ScreensOverrideAdd,
  ScreensOverrideEntry,
} from '@open-design/contracts';

import type { ScreenPlatformScope } from '@open-design/contracts';

import { findAnchorTextLines, resolveInputPlatform, type ScreenInput } from './screen-components.js';
import { autoGroupScreens, deriveSuffixGroupKeys, PLATFORM_KEY_SUFFIX_RE, type GroupSuggestion } from './screen-groups.js';

/** `comp/<key>.screen.json` sibling — manifest của LẦN CHẠY HIỆN TẠI (sau khi
 *  áp overrides lên danh sách máy đoán). Nằm DƯỚI `comp/` nên bị "Run lại"
 *  (re-run clear) dọn cùng stage — ĐÚNG Ý: nó mô tả riêng lần chạy này, không
 *  phải nơi lưu sửa đổi của người dùng. */
export const SCREENS_MANIFEST_FILE = 'comp/_screens.json';

/** Nằm NGAY DƯỚI cwd của run (`docs-review/`), NGOÀI `comp/` — cùng lý do
 *  `criteria/` sống sót re-run clear: đây là nguồn sự thật do NGƯỜI DÙNG giữ,
 *  không được phép bị dọn theo mỗi lần "Run lại" stage. WP14 sẽ có test tích
 *  hợp chứng minh việc này qua cơ chế re-run clear thật; ở đây chỉ khai hằng
 *  số đường dẫn. */
export const SCREENS_OVERRIDES_REL = 'screens-overrides.json';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** WP docs-review-screen-platform: override `add` mang thêm `platform`
 *  ('mobile' | 'web') — mở rộng CỤC BỘ daemon trên contract (contracts không
 *  đổi trong WP này); reader cũ bỏ qua field lạ. */
export type ScreensOverrideAddWithPlatform = ScreensOverrideAdd & { platform?: 'mobile' | 'web' };

const ACTIONS = new Set(['add', 'rename', 'remove']);

/** Đọc `screens-overrides.json` một cách KHOAN DUNG: JSON hỏng hoặc
 *  `schema_version` lạ → coi như rỗng (không throw, kèm 1 warning); từng
 *  entry sai hình dạng (action lạ, thiếu field bắt buộc) → bỏ RIÊNG entry đó
 *  kèm warning, các entry hợp lệ khác vẫn được giữ. Người dùng không nên mất
 *  toàn bộ override chỉ vì gõ tay sai một mục. */
export function parseScreensOverrides(raw: string): { doc: ScreensOverrides; warnings: string[] } {
  const empty: ScreensOverrides = { schema_version: 1, overrides: [] };
  const warnings: string[] = [];

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    warnings.push(`screens-overrides.json không phải JSON hợp lệ: ${(e as Error).message} — coi như rỗng.`);
    return { doc: empty, warnings };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    warnings.push('screens-overrides.json phải là một object — coi như rỗng.');
    return { doc: empty, warnings };
  }
  const o = json as Record<string, unknown>;
  if (o.schema_version !== 1) {
    warnings.push(`screens-overrides.json có "schema_version" lạ (nhận "${String(o.schema_version)}", chỉ hỗ trợ 1) — coi như rỗng.`);
    return { doc: empty, warnings };
  }

  const overrides: ScreensOverrideEntry[] = [];
  const rawList = Array.isArray(o.overrides) ? o.overrides : [];
  rawList.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      warnings.push(`overrides[${i}]: không phải object — bỏ qua.`);
      return;
    }
    const e = item as Record<string, unknown>;
    if (!ACTIONS.has(str(e.action))) {
      warnings.push(`overrides[${i}]: "action" không hợp lệ (nhận "${String(e.action)}") — bỏ qua.`);
      return;
    }
    if (e.action === 'add') {
      const source = str(e.source);
      const code = str(e.code);
      const name = str(e.name);
      if (!source || !code || !name) {
        warnings.push(`overrides[${i}] (add): thiếu "source"/"code"/"name" — bỏ qua.`);
        return;
      }
      const entry: ScreensOverrideAddWithPlatform = { action: 'add', source, code, name };
      if (str(e.anchorText)) entry.anchorText = str(e.anchorText);
      // WP docs-review-screen-platform: nền tảng của màn thêm tay — BẮT BUỘC
      // khi phạm vi = Cả hai (kiểm ở applyScreenOverrides); giá trị lạ → bỏ
      // field kèm warning (không bỏ cả entry).
      const platform = str(e.platform);
      if (platform === 'mobile' || platform === 'web') entry.platform = platform;
      else if (platform) warnings.push(`overrides[${i}] (add): "platform" không hợp lệ (nhận "${platform}", chỉ 'mobile' | 'web') — bỏ field.`);
      overrides.push(entry);
      return;
    }
    if (e.action === 'rename') {
      const key = str(e.key);
      const name = str(e.name);
      if (!key || !name) {
        warnings.push(`overrides[${i}] (rename): thiếu "key"/"name" — bỏ qua.`);
        return;
      }
      overrides.push({ action: 'rename', key, name });
      return;
    }
    // 'remove'
    const key = str(e.key);
    if (!key) {
      warnings.push(`overrides[${i}] (remove): thiếu "key" — bỏ qua.`);
      return;
    }
    overrides.push({ action: 'remove', key });
  });

  return { doc: { schema_version: 1, overrides }, warnings };
}

// ── Anchor (add) ─────────────────────────────────────────────────────────
// Luật anchor TRÙNG với WP12 (screen-extract.ts — máy tự chọn anchor khi
// phát hiện màn từ tài liệu): một dòng NGUYÊN VĂN, DUY NHẤT trong trang,
// NGOÀI code fence (```/~~~). WP14 hợp nhất về `findAnchorTextLines`
// (screen-components.ts) — module này chỉ còn quyết định "đúng 1 lần mới
// hợp lệ", còn thuật toán fence-walk sống ở một nơi duy nhất.
function findAnchorLine(md: string, anchorText: string): number | null {
  const hits = findAnchorTextLines(md, anchorText);
  return hits.length === 1 ? hits[0]! : null;
}

/** Tính section từ một anchor hợp lệ: từ dòng anchor tới HẾT TRANG (không
 *  dừng ở heading kế tiếp như `findScreenSection` của screen-components.ts —
 *  overrides không biết cấu trúc heading của màn người dùng đang thêm, chỉ
 *  biết một dòng mô tả nó). */
function sectionFromAnchor(md: string, anchorLine: number): ScreenInput['section'] {
  const lines = md.split(/\r?\n/);
  const body = lines.slice(anchorLine); // sau dòng anchor tới hết trang
  const excerptSrc = body.join('\n').trim();
  return {
    heading: lines[anchorLine - 1]!,
    startLine: anchorLine,
    endLine: lines.length,
    excerpt: excerptSrc.length > 900 ? `${excerptSrc.slice(0, 900)}…` : excerptSrc,
  };
}

function resolveAnchor(source: string, anchorText: string, md: string | null): { section?: ScreenInput['section']; warning?: string } {
  if (!md) return { warning: `anchorText của "${source}" không kiểm được — daemon không đọc được nội dung trang này.` };
  const line = findAnchorLine(md, anchorText);
  if (line == null) return { warning: `anchorText không khớp đúng MỘT dòng ngoài code fence trong "${source}" — bỏ qua section.` };
  return { section: sectionFromAnchor(md, line) };
}

/** SCREEN-KEY quy ước `<file-stem>__<code>` dùng chung với dr-flow /
 *  screen-components.ts. */
function screenKey(source: string, code: string): string {
  return `${path.posix.basename(source, '.md')}__${code}`;
}

/** Trích mã màn từ một SCREEN-KEY đã có (đầu ra của screen-components.ts) —
 *  chép cục bộ thay vì import `splitScreenKey` (không phải type, phạm vi
 *  cho phép của WP này chỉ import TYPE-ONLY `ScreenInput`). */
function codeOfKey(key: string): string {
  const i = key.lastIndexOf('__');
  return i >= 0 && i + 2 < key.length ? key.slice(i + 2) : key;
}

/** Áp `overrides` lên danh sách màn máy đoán (`screens`, đầu ra
 *  `prepareScreenComponentInputs`), NGƯỜI DÙNG THẮNG máy khi trùng
 *  SCREEN-KEY. `mdBySource` = nội dung markdown từng trang (key = `source`,
 *  relative cwd) để kiểm anchorText của các override `add`. Trả về danh sách
 *  mới (không sửa `screens` gốc) + warnings gộp từ mọi override. */
export function applyScreenOverrides(
  screens: ScreenInput[],
  overrides: ScreensOverrides,
  mdBySource: Map<string, string>,
  /** WP docs-review-screen-platform: phạm vi người dùng chọn. Màn thêm tay:
   *  phạm vi đơn → `platform` = phạm vi; Cả hai → cần `ov.platform`, thiếu →
   *  warning + bỏ override đó (không throw: các override khác vẫn áp). */
  opts?: { screenPlatform?: ScreenPlatformScope | undefined },
): { screens: ScreenInput[]; warnings: string[] } {
  const warnings: string[] = [];
  let out: ScreenInput[] = screens.map((s) => ({ ...s }));
  const byKey = new Map(out.map((s) => [s.key, s]));
  const scope = opts?.screenPlatform;

  for (const ov of overrides.overrides) {
    if (ov.action === 'add') {
      const key = screenKey(ov.source, ov.code);
      const ovPlatform = (ov as ScreensOverrideAddWithPlatform).platform;
      if (scope === 'both' && !ovPlatform && !byKey.has(key)) {
        warnings.push(`add "${key}": màn thêm tay cần nền tảng ("platform": "mobile" | "web") khi phạm vi = Cả hai — bỏ qua.`);
        continue;
      }
      const md = mdBySource.get(ov.source) ?? null;
      let section: ScreenInput['section'] | undefined;
      if (ov.anchorText) {
        const resolved = resolveAnchor(ov.source, ov.anchorText, md);
        section = resolved.section;
        if (resolved.warning) warnings.push(`add "${key}": ${resolved.warning}`);
      }
      const existing = byKey.get(key);
      if (existing) {
        // Trùng key màn máy đã có — NGƯỜI DÙNG THẮNG: tên/origin của user;
        // section của user CHỈ KHI có anchor hợp lệ, ngược lại GIỮ NGUYÊN
        // section máy đã đoán (đừng xoá thông tin máy chỉ vì override không
        // kèm anchor — máy có thể đã đoán đúng, người dùng chỉ sửa tên).
        existing.name = ov.name;
        // WP14: 'user' nay là thành viên chính thức của ScreenInput['origin']
        // — không còn cần cast cục bộ như WP13a.
        existing.origin = 'user';
        if (section) existing.section = section;
        continue;
      }
      const added: ScreenInput = {
        key,
        name: ov.name,
        order: 0, // đánh lại liên tục ở cuối
        flowId: '',
        flowTitle: '',
        source: ov.source,
        steps: [],
        navOut: [],
        navIn: [],
        findings: [],
        // Nền tảng = phạm vi người dùng chọn (Mobile/Web) hoặc `platform`
        // người dùng khai trong override (Cả hai — đã kiểm có ở trên).
        ...resolveInputPlatform(scope, ovPlatform ?? null, key),
        origin: 'user',
      };
      if (section) added.section = section;
      out.push(added);
      byKey.set(key, added);
      continue;
    }
    if (ov.action === 'rename') {
      const s = byKey.get(ov.key);
      if (!s) {
        warnings.push(`rename "${ov.key}": không tìm thấy màn — bỏ qua.`);
        continue;
      }
      s.name = ov.name;
      continue;
    }
    // 'remove'
    if (!byKey.has(ov.key)) {
      warnings.push(`remove "${ov.key}": không tìm thấy màn — bỏ qua.`);
      continue;
    }
    byKey.delete(ov.key);
    out = out.filter((s) => s.key !== ov.key);
  }

  // navIn lọc bỏ key đã remove; navOut GIỮ NGUYÊN (SCREEN-mode kickoff chịu
  // được key vắng — xem docblock đầu file). order đánh lại LIÊN TỤC sau khi
  // add/remove, bất kể thứ tự các override được áp.
  const remainingKeys = new Set(out.map((s) => s.key));
  out = out.map((s, i) => ({ ...s, order: i, navIn: s.navIn.filter((k) => remainingKeys.has(k)) }));

  return { screens: out, warnings };
}

export interface ScreenGroupingResult {
  screens: ScreenInput[];
  groupCount: number;
  suggestions: GroupSuggestion[];
  changed: boolean;
}

/** screen-variants WP-V2 (docs/screen-variants-spec.md): gắn `groupKey` cho
 *  các biến thể nền tảng của cùng màn nghiệp vụ (autoGroupScreens — chỉ
 *  trùng-hệt tên chuẩn hóa + khác platform). Hậu tố key `--app`/`--web` CHỈ áp
 *  cho màn origin 'doc'/'agent' — màn 'flow'/'user' giữ key nguyên để không
 *  phá liên kết flowchart node.screen / overrides đã trỏ theo key cũ; nhóm
 *  vẫn nhận groupKey ở CẢ hai thành viên. navOut/navIn được quét lại theo
 *  map key cũ→mới. Tài liệu một-nền-tảng: 0 nhóm, trả `changed: false`,
 *  danh sách nguyên trạng (spec G6). */
export function applyScreenGrouping(screens: ScreenInput[]): ScreenGroupingResult {
  // WP screen-flow-platform-split (2026-08-28): màn đã có `groupKey` hoặc key
  // đã mang hậu tố `--app`/`--web` là quyết định của AGENT (flow tách theo
  // nền tảng) — KHÔNG đưa vào auto-nhóm (tránh đổi tên thành `…--app--app`),
  // chỉ suy groupKey từ hậu tố khi cặp cùng tồn tại.
  const suffixGroups = deriveSuffixGroupKeys(screens.map((s) => s.key));
  const preGrouped = new Set(screens.filter((s) => s.groupKey || PLATFORM_KEY_SUFFIX_RE.test(s.key)).map((s) => s.key));
  const withSuffixGroup = screens.map((s) => (!s.groupKey && suffixGroups.has(s.key) ? { ...s, groupKey: suffixGroups.get(s.key)! } : s));
  const suffixChanged = withSuffixGroup.some((s, i) => s !== screens[i]);
  const { groups, renamedKeys, suggestions } = autoGroupScreens(
    withSuffixGroup.filter((s) => !preGrouped.has(s.key)).map((s) => ({ key: s.key, name: s.name, platform: s.platform ?? null })),
  );
  if (Object.keys(groups).length === 0) {
    return suffixChanged
      ? { screens: withSuffixGroup, groupCount: suffixGroups.size, suggestions, changed: true }
      : { screens, groupCount: 0, suggestions, changed: false };
  }
  screens = withSuffixGroup;
  // autoGroupScreens trả `groups` theo key ĐÃ đổi tên — đảo renamedKeys để
  // biết key gốc của từng thành viên rồi mới quyết có đổi thật hay không.
  const originalOf = new Map<string, string>(Object.entries(renamedKeys).map(([oldKey, newKey]) => [newKey, oldKey]));
  const finalKeyByOld = new Map<string, string>();
  const groupKeyByOld = new Map<string, string>();
  const byKey = new Map(screens.map((s) => [s.key, s]));
  for (const [groupKey, members] of Object.entries(groups)) {
    for (const renamed of members) {
      const oldKey = originalOf.get(renamed) ?? renamed;
      const screen = byKey.get(oldKey);
      if (!screen) continue;
      groupKeyByOld.set(oldKey, groupKey);
      const mayRename = screen.origin === 'doc' || screen.origin === 'agent';
      finalKeyByOld.set(oldKey, mayRename ? renamed : oldKey);
    }
  }
  const out = screens.map((s) => {
    const groupKey = groupKeyByOld.get(s.key);
    const finalKey = finalKeyByOld.get(s.key) ?? s.key;
    const navOut = s.navOut.map((n) => (finalKeyByOld.has(n.to) ? { ...n, to: finalKeyByOld.get(n.to)! } : n));
    const navIn = s.navIn.map((k) => finalKeyByOld.get(k) ?? k);
    return { ...s, key: finalKey, navOut, navIn, ...(groupKey ? { groupKey } : {}) };
  });
  return { screens: out, groupCount: Object.keys(groups).length, suggestions, changed: true };
}

/** Dựng `comp/_screens.json` từ danh sách màn SAU khi áp overrides — map
 *  1-1, KHÔNG đọc/ghi ngược `screens-overrides.json` (manifest chỉ là ảnh
 *  của lần chạy này, xem docblock đầu file). */
export function buildScreensManifest(screens: ScreenInput[]): ScreensManifest {
  const entries: ScreensManifestEntry[] = screens.map((s) => ({
    key: s.key,
    code: codeOfKey(s.key),
    name: s.name,
    source: s.source,
    // Màn cũ chưa từng khai `origin` (trước khi field này tồn tại) → 'flow',
    // đúng với thực tế hiện tại (mọi màn không khai origin đều tới từ
    // dr-flow).
    origin: s.origin ?? 'flow',
    line: s.section?.startLine ?? null,
    hasSection: !!s.section,
    // screen-variants: field vắng thì KHÔNG serialize — tài liệu
    // một-nền-tảng phải ra manifest byte-identical với trước (spec G6).
    ...(s.platform ? { platform: s.platform } : {}),
    ...(s.groupKey ? { groupKey: s.groupKey } : {}),
  }));
  const hasVariantFields = entries.some((e) => e.platform !== undefined || e.groupKey !== undefined);
  return { schema_version: hasVariantFields ? 2 : 1, screens: entries };
}
