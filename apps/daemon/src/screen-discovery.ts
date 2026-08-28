// WP dr-screens-merge (2026-08-27) — hậu xử lý "Phát hiện màn hình" tách
// khỏi `runScreenDiscovery` (server.ts) thành hàm dùng chung, vì nay có HAI
// nguồn cho cùng một kết quả:
//   1. dr-screens chạy tay (skill docs-screen-discovery, agent ghi
//      screens-discovered.json + .md — caller KHÔNG đưa `md`, giữ bản agent);
//   2. dr-flow (skill docs-screen-flow, screens.json v2) — finalizeScreenFlowXml
//      dẫn xuất `DiscoveredDoc`, caller đưa `md` = renderDiscoveredMd(...).
// Cả hai đi qua đúng một đường: validateDocScreenExtract (đối chiếu anchorText
// tất định với trang thật) → screens-discovered.json (+ .md) →
// mergeExtractedScreens → applyScreenGrouping → buildScreensManifest →
// comp/_screens.json. Bất biến cũ giữ nguyên: 0 màn hợp lệ → `ok:false`, KHÔNG
// ghi gì đè lên kết quả cũ (manifest của lần chạy trước sống sót).
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ScreenPlatformScope } from '@open-design/contracts';

import { resolveInputPlatform, screenPlatformToInput } from './screen-components.js';
import { validateDocScreenExtract, mergeExtractedScreens } from './screen-extract.js';
import { applyScreenGrouping, buildScreensManifest, SCREENS_MANIFEST_FILE } from './screen-overrides.js';

export const SCREENS_DISCOVERED_FILE = 'screens-discovered.json';
export const SCREENS_DISCOVERED_MD_FILE = 'screens-discovered.md';

export interface PersistScreenDiscoveryOptions {
  cwd: string;
  /** Trang tài liệu của lượt chạy (listDocPages) — chỉ cần `mdPath`. */
  pages: { mdPath: string }[];
  /** Nội dung screens-discovered.json (contract `DiscoveredDoc`, chưa tin cậy). */
  doc: unknown;
  /** Có → ghi screens-discovered.md; không → bỏ qua (agent tự ghi như dr-screens cũ). */
  md?: string;
  /** Đọc trang theo đường dẫn tương đối cwd; mặc định đọc fs. Trả null = bỏ trang. */
  readMd?: (rel: string) => Promise<string | null>;
  /** Giá trị `generatedAt` khi doc chưa có — mặc định now (test đưa vào cho tất định). */
  generatedAt?: string;
  /** WP dr-flow-improve: màn CHỈ có ở bản "Cải thiện" của SCREEN-FLOW
   *  (`addNode.screen`, không có anchor tài liệu) — KHÔNG qua
   *  validateDocScreenExtract; nối vào sau các màn đã nhận với
   *  `origin: 'flow'`, `provenance: 'proposed'`, section rỗng. Ghi kèm vào
   *  screens-discovered.json dưới field `proposed` (parseScreensDiscovered
   *  bỏ qua field lạ). */
  proposed?: Array<{ key: string; name: string; source?: string; why?: string; platform?: 'app' | 'web' }>;
  /** WP docs-review-screen-platform: phạm vi người dùng chọn — quyết
   *  `platform`/`platformHint` của mọi màn trong manifest (xem
   *  `resolveInputPlatform`). Cả hai + màn thiếu `platform` → `ok:false`. */
  screenPlatform?: ScreenPlatformScope | undefined;
}

export type PersistScreenDiscoveryResult =
  | { ok: true; accepted: number; rejected: string[]; suggestions: string[]; excludedCount: number }
  | { ok: false; error: string; rejected: string[] };

export async function persistScreenDiscovery(opts: PersistScreenDiscoveryOptions): Promise<PersistScreenDiscoveryResult> {
  const { cwd, pages, doc } = opts;
  const readMd = opts.readMd ?? ((rel: string) => fs.readFile(path.join(cwd, rel), 'utf8').catch(() => null));
  const mdBySource = new Map<string, string>();
  for (const page of pages) {
    const md = await readMd(page.mdPath);
    if (md != null) mdBySource.set(page.mdPath, md);
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: `"${SCREENS_DISCOVERED_FILE}" không phải một object JSON.`, rejected: [] };
  }

  // validateDocScreenExtract đối chiếu tất định pages[].screens[].anchorText
  // với nội dung trang thật — cùng hàm dr-comp lớp 2 dùng (screen-extract.ts);
  // shape CONTRACT của discovery khớp thẳng chữ ký hàm này (source/screens/
  // code/name/anchorText), không cần lớp chuyển đổi riêng.
  const { accepted, rejected } = validateDocScreenExtract(mdBySource, doc);
  const rejectedReasons = rejected.map((r) => r.reason);
  if (accepted.length === 0) {
    return {
      ok: false,
      error: 'Agent không xuất được màn hình hợp lệ nào (mọi "anchorText" phải là một dòng nguyên văn, duy nhất trong trang).',
      rejected: rejectedReasons,
    };
  }

  // excluded — validate khoan dung: chỉ đếm mục có "name" khác rỗng; các field
  // khác optional. Không chặn, chỉ để log — phần "excluded" giữ nguyên như nhận.
  const o = doc as Record<string, unknown>;
  const excludedCount = Array.isArray(o.excluded)
    ? o.excluded.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as Record<string, unknown>).name === 'string' && !!(e as Record<string, unknown>).name).length
    : 0;

  const generatedAt = typeof o.generatedAt === 'string' && o.generatedAt.trim() ? o.generatedAt : (opts.generatedAt ?? new Date().toISOString());
  const proposed = (opts.proposed ?? []).filter((p) => p && typeof p.key === 'string' && p.key && typeof p.name === 'string' && p.name);
  const persisted = { ...o, schema_version: 1, generatedAt, ...(proposed.length ? { proposed } : {}) };
  await fs.writeFile(path.join(cwd, SCREENS_DISCOVERED_FILE), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  if (typeof opts.md === 'string') {
    await fs.writeFile(path.join(cwd, SCREENS_DISCOVERED_MD_FILE), opts.md, 'utf8');
  }

  // Dựng ScreenInput[] tối thiểu từ accepted rồi build manifest — TÁI DÙNG
  // mergeExtractedScreens (bắt đầu từ mảng rỗng) + buildScreensManifest, đúng
  // cặp hàm dr-comp lớp 2/3 đã dùng — để comp/_screens.json (route GET
  // /docs-review/screens + ScreenListManager) đọc được ngay, không đợi dr-comp.
  let mergedScreens: ReturnType<typeof mergeExtractedScreens>['screens'];
  try {
    mergedScreens = mergeExtractedScreens([], accepted, mdBySource, { screenPlatform: opts.screenPlatform }).screens;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), rejected: rejectedReasons };
  }
  // Màn đề xuất (bản cải thiện) — sau màn tài liệu, không có section/anchor;
  // key trùng màn đã nhận thì màn tài liệu thắng (không nhân đôi).
  const seenKeys = new Set(mergedScreens.map((s) => s.key));
  let nextOrder = mergedScreens.reduce((max, s) => Math.max(max, s.order), -1) + 1;
  for (const p of proposed) {
    if (seenKeys.has(p.key)) continue;
    seenKeys.add(p.key);
    // Màn đề xuất (bản Cải thiện) không có anchor tài liệu: nền tảng = phạm
    // vi người dùng chọn, hoặc nền tảng của flow tách (`--app|--web`) khi Cả
    // hai; thiếu cả hai → manifest KHÔNG chặn (chỉ kiểm kê), dr-comp/dr-mockup
    // mới fail-fast qua `assertScreensHavePlatform`.
    let platformFields: { platform?: 'mobile' | 'web'; platformHint: 'mobile' | 'web' };
    try {
      platformFields = resolveInputPlatform(opts.screenPlatform, p.platform ? screenPlatformToInput(p.platform) : null, p.key);
    } catch {
      platformFields = { platformHint: 'web' };
    }
    mergedScreens.push({
      key: p.key,
      name: p.name,
      order: nextOrder++,
      flowId: '',
      flowTitle: '',
      source: p.source ?? null,
      steps: [],
      navOut: [],
      navIn: [],
      findings: [],
      ...platformFields,
      origin: 'flow',
      provenance: 'proposed',
    });
  }
  // screen-variants WP-V2: nhóm biến thể trước khi ghi manifest — đây là nơi
  // kiểm kê nên nhóm phải hiện ngay từ đây. WP screen-flow-platform-split:
  // khi AGENT đã quyết `platform` (screens.json v2 của flow tách) thì KHÔNG
  // chạy autoGroupScreens đè lên — groupKey chỉ suy từ hậu tố `--app/--web`
  // (đã gắn sẵn ở lớp discovery).
  const agentDecided = accepted.some((a) => a.platform != null);
  const grouping = agentDecided ? null : applyScreenGrouping(mergedScreens);
  const suggestions = grouping ? grouping.suggestions.map((g) => `${g.a.name} ↔ ${g.b.name}`) : [];
  const manifest = buildScreensManifest(grouping?.changed ? grouping.screens : mergedScreens);
  await fs.mkdir(path.join(cwd, 'comp'), { recursive: true });
  await fs.writeFile(path.join(cwd, SCREENS_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');

  return { ok: true, accepted: accepted.length, rejected: rejectedReasons, suggestions, excludedCount };
}
