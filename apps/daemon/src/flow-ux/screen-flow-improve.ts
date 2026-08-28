// WP dr-flow-improve (2026-08-27) — stage `dr-flow-improve` ("Cải thiện
// luồng", skill docs-screen-flow-improve) chạy SAU dr-flow, TRƯỚC dr-comp:
// agent review `flows/SCREEN-FLOW` (as-is.drawio do docs-screen-flow sinh)
// và ghi `patch.json` + `ux-review.json` — ĐÚNG cơ chế "Đề xuất" của dr-flow
// cũ (docs-flow-ux): finalizeFlowUx áp patch → `proposed.drawio` 2 trang
// (Nguyên bản | Cải thiện). Module này thêm phần MỚI quanh cơ chế đó:
//
//   selection.json        — bản đang dùng để chạy tiếp (dr-comp, discovery…):
//                           `{ variant: 'original'|'improved', source: 'user'|'run-all', at }`.
//                           Không có file = original. Chạy lẻ không đụng; run-all
//                           mặc định improved TRỪ KHI người dùng đã tự chọn.
//   proposed.edited.json  — người dùng đã sửa TAY trang Cải thiện trong editor
//                           → finalizeFlowUx KHÔNG áp lại patch, giữ proposed.drawio.
//   screens.improved.json — danh sách màn của bản cải thiện = màn hiện có (screens.json)
//                           + màn từ `addNode.screen` (`provenance: 'proposed'`)
//                           − KHÔNG loại màn có node `mark removed` (chỉ gắn
//                           `removedByProposal: true` — dr-comp vẫn cần biết).
//
// finalizeFlowUx (index.ts) đọc selection + screens.improved.json để dựng
// flowchart/index từ TRANG 1 khi bản cải thiện được chọn; server.ts gọi
// finalizeScreenFlowImprove ở khối finalize của stage và route PUT selection.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { finalizeFlowUx, type FinalizeResult, type FlowIndexEntry, type UxReview } from './index.js';
import { parsePatchDoc, type PatchDoc, type PatchOp } from './patch.js';
import {
  PROPOSED_EDITED_FILE,
  SCREEN_FLOW_ID,
  SCREENS_IMPROVED_FILE,
  listScreenFlowIds,
  readScreenFlowSelection,
  screenFlowDir,
  writeScreenFlowSelection,
  type ImprovedScreen,
  type ScreenFlowSelection,
  type ScreensImprovedDoc,
} from './screen-flow-xml.js';

// Re-export để server.ts/test chỉ cần import một chỗ cho mọi thứ "improve".
export {
  PROPOSED_EDITED_FILE,
  SCREENS_IMPROVED_FILE,
  SELECTION_FILE,
  hasProposedEditedMarker,
  isScreenFlowId,
  listScreenFlowIds,
  readScreenFlowSelection,
  readScreensImproved,
  screenFlowDir,
  screenFlowPlatformOf,
  writeScreenFlowSelection,
  type ImprovedScreen,
  type ScreenFlowSelection,
  type ScreenFlowSelectionSource,
  type ScreenFlowVariant,
  type ScreensImprovedDoc,
} from './screen-flow-xml.js';

export type AddNodeOp = Extract<PatchOp, { op: 'addNode' }>;

/** Luật SCREEN-KEY `<file-stem>__<code>` — stem và code đều khác rỗng, không
 *  khoảng trắng; `<stem>__NEW-<slug>` cũng qua (code = `NEW-<slug>`). */
const SCREEN_KEY_RE = /^[^\s_][^\s]*?__[^\s_][^\s]*$/;

export function isValidScreenKey(key: string): boolean {
  return SCREEN_KEY_RE.test(key);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Shape tối thiểu của screens.json mà builder cần (v1 lẫn v2 đã chuẩn hoá
 *  đều có `cells`/`names`; v2 còn `screens[]` để lấy anchorText/source/why). */
export interface ScreensFileLike {
  cells?: Record<string, string>;
  names?: Record<string, string>;
  source?: string;
  screens?: Array<{ key?: unknown; name?: unknown; cell?: unknown; anchorText?: unknown; source?: unknown; why?: unknown }>;
}

/** Soát các op `addNode.screen`: key sai luật / thiếu name / trùng key màn có
 *  sẵn → bỏ `screen` (node vẫn được thêm như bước thường) + warning. Hàm
 *  thuần, trả patch mới — không sửa file agent. */
export function validateScreenOps(patch: PatchDoc, existingKeys: ReadonlySet<string>): { patch: PatchDoc; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const ops = patch.ops.map((op) => {
    if (op.op !== 'addNode' || !op.screen) return op;
    const sc = op.screen;
    const key = typeof sc.key === 'string' ? sc.key.trim() : '';
    const name = typeof sc.name === 'string' ? sc.name.trim() : '';
    const drop = (why: string) => {
      warnings.push(`addNode "${op.id}": screen bị bỏ — ${why}`);
      const { screen: _screen, ...rest } = op;
      return rest as AddNodeOp;
    };
    if (!key || !name) return drop('thiếu key/name');
    if (!isValidScreenKey(key)) return drop(`key "${key}" sai luật <file-stem>__<code>`);
    if (existingKeys.has(key)) return drop(`key "${key}" trùng màn có sẵn trong screens.json`);
    if (seen.has(key)) return drop(`key "${key}" khai hai lần trong patch`);
    seen.add(key);
    const cleaned: NonNullable<AddNodeOp['screen']> = { key, name };
    if (typeof sc.anchorText === 'string' && sc.anchorText.trim()) cleaned.anchorText = sc.anchorText.trim();
    return { ...op, screen: cleaned };
  });
  return { patch: { ...patch, ops }, warnings };
}

/** Dựng danh sách màn của bản cải thiện — hàm thuần (test tất định).
 *  `appliedAddNodeIds` (nếu đưa) lọc node `addNode` thật sự vào trang 1 —
 *  op bị daemon skip thì màn đi kèm không tồn tại. */
export function buildImprovedScreens(opts: {
  screensFile: ScreensFileLike;
  patch: PatchDoc;
  review: UxReview | null;
  generatedAt: string;
  appliedAddNodeIds?: ReadonlySet<string>;
}): ScreensImprovedDoc {
  const { screensFile, patch, review } = opts;
  const cells = screensFile.cells ?? {};
  const names = screensFile.names ?? {};
  const cellOfKey = new Map<string, string>();
  for (const [cell, key] of Object.entries(cells)) if (!cellOfKey.has(key)) cellOfKey.set(key, cell);
  const v2 = new Map<string, { anchorText?: string; source?: string; why?: string }>();
  for (const s of screensFile.screens ?? []) {
    if (!s || typeof s.key !== 'string') continue;
    v2.set(s.key, {
      ...(typeof s.anchorText === 'string' && s.anchorText ? { anchorText: s.anchorText } : {}),
      ...(typeof s.source === 'string' && s.source ? { source: s.source } : {}),
      ...(typeof s.why === 'string' && s.why ? { why: s.why } : {}),
    });
  }
  const removedCells = new Set(
    patch.ops.filter((o): o is Extract<PatchOp, { op: 'mark' }> => o.op === 'mark' && o.change === 'removed').map((o) => o.cell),
  );
  const findingTitle = new Map((review?.findings ?? []).map((f) => [f.id, f.title]));

  const out: ImprovedScreen[] = [];
  const seen = new Set<string>();
  // Màn có sẵn — thứ tự `names` (MỌI entry, kể cả cell null) như screens.json.
  const orderedKeys = [...Object.keys(names)];
  for (const key of Object.values(cells)) if (!orderedKeys.includes(key)) orderedKeys.push(key);
  for (const key of orderedKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const cell = cellOfKey.get(key) ?? null;
    const extra = v2.get(key) ?? {};
    const entry: ImprovedScreen = { key, name: names[key] ?? key, cell, provenance: 'document', ...extra };
    if (cell && removedCells.has(cell)) entry.removedByProposal = true;
    out.push(entry);
  }
  // Màn mới từ addNode.screen (đã qua validateScreenOps).
  for (const op of patch.ops) {
    if (op.op !== 'addNode' || !op.screen) continue;
    if (opts.appliedAddNodeIds && !opts.appliedAddNodeIds.has(op.id)) continue;
    if (seen.has(op.screen.key)) continue;
    seen.add(op.screen.key);
    const title = op.finding ? findingTitle.get(op.finding) : undefined;
    const entry: ImprovedScreen = {
      key: op.screen.key,
      name: op.screen.name,
      cell: op.id,
      provenance: 'proposed',
      why: op.finding ? `Đề xuất cải thiện ${op.finding}${title ? `: ${title}` : ''}` : 'Đề xuất cải thiện luồng',
    };
    if (op.screen.anchorText) entry.anchorText = op.screen.anchorText;
    if (screensFile.source) entry.source = screensFile.source;
    if (op.finding) entry.finding = op.finding;
    out.push(entry);
  }
  return { schema_version: 1, generatedAt: opts.generatedAt, screens: out };
}

/* ── finalize của stage ──────────────────────────────────────────────────── */

export interface ScreenFlowImproveResult {
  /** WP screen-flow-platform-split: flow vừa finalize (`SCREEN-FLOW`, `--app`, `--web`). */
  flowId: string;
  /** Có bản cải thiện (proposed.drawio 2 trang) sau lượt này. */
  hasProposal: boolean;
  /** Số finding trong ux-review.json (0 = luồng tốt). */
  findings: number;
  selection: ScreenFlowSelection | null;
  entry: FlowIndexEntry | null;
  warnings: string[];
  /** Kết quả finalizeFlowUx cuối cùng (index đã theo bản được chọn). */
  fin: FinalizeResult;
}

/** Sau khi agent xong (hoặc khi cần dựng lại từ patch.json trên đĩa):
 *  1. không patch VÀ không finding → "luồng tốt": không proposed, selection giữ;
 *  2. có patch → validate `screen`, xoá marker sửa tay (lượt mới áp patch
 *     mới), finalizeFlowUx (áp patch → proposed.drawio), dựng
 *     screens.improved.json (bỏ addNode bị skip), rồi
 *  3. mặc định lựa chọn: `viaRunAll` → improved/run-all TRỪ KHI file đang
 *     `source: 'user'`; chạy lẻ → không đụng;
 *  4. selection hiện hành = improved → finalizeFlowUx lần nữa để index/
 *     flowchart theo trang 1 (screens.improved.json giờ đã có).
 *  Discovery (comp/_screens.json…) là việc của caller (server.ts) — cần
 *  listDocPages + persistScreenDiscovery. */
export async function finalizeScreenFlowImprove(
  cwd: string,
  opts: { flowId?: string; viaRunAll?: boolean; generatedAt?: string } = {},
): Promise<ScreenFlowImproveResult> {
  // WP screen-flow-platform-split: finalize CHO MỘT flow (`flowId`, mặc định
  // `SCREEN-FLOW`); nhiều flow → `finalizeScreenFlowImproveAll`.
  const flowId = opts.flowId ?? SCREEN_FLOW_ID;
  const dir = screenFlowDir(cwd, flowId);
  const warnings: string[] = [];
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const asIsOk = await fs
    .stat(path.join(dir, 'as-is.drawio'))
    .then((s) => s.isFile())
    .catch(() => false);
  if (!asIsOk) throw new Error(`chưa có flows/${flowId}/as-is.drawio — chạy bước "Luồng màn hình" trước`);

  const patchRaw = await fs.readFile(path.join(dir, 'patch.json'), 'utf8').catch(() => null);
  const patchDoc = patchRaw != null ? parsePatchDoc(patchRaw) : null;
  if (patchRaw != null && patchDoc && patchDoc.ops.length === 0) warnings.push('patch.json không có thao tác hợp lệ nào');
  const reviewRaw = await readJson<Record<string, unknown>>(path.join(dir, 'ux-review.json'));
  const findingsCount = Array.isArray(reviewRaw?.findings) ? reviewRaw!.findings.length : 0;
  const screensFile = (await readJson<ScreensFileLike>(path.join(dir, 'screens.json'))) ?? {};

  // (1) Luồng tốt: không patch (hoặc patch rỗng) và không finding.
  if (!patchDoc || patchDoc.ops.length === 0) {
    await fs.rm(path.join(dir, 'proposed.drawio'), { force: true }).catch(() => {});
    await fs.rm(path.join(dir, PROPOSED_EDITED_FILE), { force: true }).catch(() => {});
    await fs.rm(path.join(dir, SCREENS_IMPROVED_FILE), { force: true }).catch(() => {});
    const fin = await finalizeFlowUx(cwd);
    const entry = fin.index.find((e) => e.id === flowId) ?? null;
    return { flowId, hasProposal: false, findings: findingsCount, selection: await readScreenFlowSelection(cwd, flowId), entry, warnings: [...warnings, ...fin.warnings], fin };
  }

  // (2) Có patch — validate `screen`, ghi lại patch.json đã làm sạch (chỉ
  // khi có thay đổi) để finalizeFlowUx lần sau đọc đúng bản này.
  const existingKeys = new Set(Object.keys(screensFile.names ?? {}));
  for (const key of Object.values(screensFile.cells ?? {})) existingKeys.add(key);
  const validated = validateScreenOps(patchDoc, existingKeys);
  warnings.push(...validated.warnings);
  if (validated.warnings.length) await writeJson(path.join(dir, 'patch.json'), validated.patch);
  // Lượt agent mới → bản sửa tay cũ (nếu còn) không còn ý nghĩa.
  await fs.rm(path.join(dir, PROPOSED_EDITED_FILE), { force: true }).catch(() => {});

  let fin = await finalizeFlowUx(cwd);
  let entry = fin.index.find((e) => e.id === flowId) ?? null;
  warnings.push(...fin.warnings);
  if (!entry?.hasProposal) {
    warnings.push('không áp được thao tác nào của patch.json — không có bản cải thiện');
    await fs.rm(path.join(dir, SCREENS_IMPROVED_FILE), { force: true }).catch(() => {});
    return { flowId, hasProposal: false, findings: findingsCount, selection: await readScreenFlowSelection(cwd, flowId), entry, warnings, fin };
  }
  const skippedIds = new Set(
    (entry.patchSkipped ?? []).filter((s) => s.op.op === 'addNode').map((s) => (s.op as AddNodeOp).id),
  );
  const applied = new Set(
    validated.patch.ops.filter((o): o is AddNodeOp => o.op === 'addNode' && !skippedIds.has(o.id)).map((o) => o.id),
  );
  const review = (await readJson<UxReview>(path.join(dir, 'ux-review.json'))) ?? null;
  const improved = buildImprovedScreens({ screensFile, patch: validated.patch, review, generatedAt, appliedAddNodeIds: applied });
  await writeJson(path.join(dir, SCREENS_IMPROVED_FILE), improved);

  // (3) Lựa chọn mặc định (của TỪNG flow).
  let selection = await readScreenFlowSelection(cwd, flowId);
  if (opts.viaRunAll && selection?.source !== 'user') {
    selection = await writeScreenFlowSelection(cwd, { variant: 'improved', source: 'run-all', at: generatedAt }, flowId);
  }

  // (4) Bản cải thiện đang được chọn → index/flowchart theo trang 1.
  if (selection?.variant === 'improved') {
    fin = await finalizeFlowUx(cwd);
    entry = fin.index.find((e) => e.id === flowId) ?? null;
  }
  return { flowId, hasProposal: true, findings: findingsCount, selection, entry, warnings, fin };
}

export interface ScreenFlowImproveAllResult {
  /** Kết quả từng flow (thứ tự `listScreenFlowIds`: `SCREEN-FLOW` | `--app`, `--web`). */
  results: ScreenFlowImproveResult[];
  /** Warnings gộp, MỖI dòng có tiền tố `<flowId>: ` (trừ khi đã có sẵn). */
  warnings: string[];
  /** finalizeFlowUx cuối cùng (index đủ mọi flow theo selection từng flow). */
  fin: FinalizeResult;
}

/** WP screen-flow-platform-split: finalize "Cải thiện luồng" cho MỌI flow
 *  Luồng màn hình hiện có (flow đơn hoặc cặp app/web) — mỗi flow có
 *  patch.json/ux-review.json/selection.json riêng. Không flow nào có
 *  as-is.drawio → throw như hành vi cũ. */
export async function finalizeScreenFlowImproveAll(
  cwd: string,
  opts: { viaRunAll?: boolean; generatedAt?: string } = {},
): Promise<ScreenFlowImproveAllResult> {
  const ids: string[] = [];
  for (const id of await listScreenFlowIds(cwd)) {
    const ok = await fs
      .stat(path.join(screenFlowDir(cwd, id), 'as-is.drawio'))
      .then((s) => s.isFile())
      .catch(() => false);
    if (ok) ids.push(id);
  }
  if (ids.length === 0) throw new Error(`chưa có flows/${SCREEN_FLOW_ID}/as-is.drawio — chạy bước "Luồng màn hình" trước`);
  const results: ScreenFlowImproveResult[] = [];
  const warnings: string[] = [];
  for (const flowId of ids) {
    const r = await finalizeScreenFlowImprove(cwd, { ...opts, flowId });
    results.push(r);
    for (const w of r.warnings) warnings.push(w.startsWith(`${flowId}: `) ? w : `${flowId}: ${w}`);
  }
  return { results, warnings, fin: results[results.length - 1]!.fin };
}
