// screen-variants WP-V5, subplan T8 (docs/screen-variants-spec.md §WP-V5) —
// nối `diffVariantDescriptions` (variant-drift.ts, T5) vào dữ liệu thật:
// manifest `comp/_screens.json` (v2, có `platform`/`groupKey` — T6) + nội
// dung markdown nguồn. Module này CHỈ đọc, không ghi; caller (server.ts,
// stage dr-comp) quyết định ghi `comp/_variant-drift.json` ở đâu.
//
// Zero-cost khi tài liệu một-nền-tảng: không có entry nào mang `groupKey`
// (hoặc manifest vắng/`schema_version` 1) → trả `{ findings: [], warnings: [] }`
// NGAY, không đọc bất kỳ file markdown nào (spec G6 + acceptance "0 nhóm = 0
// chi phí").
//
// Vị trí "dòng tên đậm + dòng kế" của một biến thể lấy từ CHÍNH
// `ScreensManifestEntry.line` (dòng 1-based nơi máy đã xác định section của
// màn đó) — đây đã là đúng dòng bold-khai-màn trong bảng
// `Hiện trạng | Thay đổi | Mô tả` (screen-extract layer 2 đặt anchor tại đó).
// Dùng lại `line` thay vì tự dò tên tránh ăn nhầm dòng khi 2 biến thể trùng
// tên HỆT nhau trong CÙNG một file (MB/IB) — đúng trường hợp phổ biến nhất.

import fs from 'node:fs';
import path from 'node:path';

import type { ScreensManifest, ScreensManifestEntry } from '@open-design/contracts';

import { diffVariantDescriptions, type VariantDescription, type VariantDriftFinding, type VariantPlatform } from './variant-drift.js';
import { SCREENS_MANIFEST_FILE } from './screen-overrides.js';

export type { VariantDriftFinding } from './variant-drift.js';

/** `comp/<...>` sibling của `_screens.json` — ẢNH của lần chạy dr-comp gần
 *  nhất (bị dọn cùng `comp/` khi re-run, đúng ý: mô tả kết quả lần này). */
export const VARIANT_DRIFT_FILE = 'comp/_variant-drift.json';

/** Hình dạng file `comp/_variant-drift.json`. */
export interface VariantDriftReport {
  schema_version: 1;
  findings: VariantDriftFinding[];
}

export interface VariantDriftScanResult {
  findings: VariantDriftFinding[];
  /** Cảnh báo fail-soft (thiếu source/line/platform, không đọc/parse được
   *  cột "Mô tả"…) — không throw, chỉ để caller log. */
  warnings: string[];
}

const EMPTY_RESULT: VariantDriftScanResult = { findings: [], warnings: [] };

function isTableRow(line: string | undefined): line is string {
  return line !== undefined && line.trim().startsWith('|');
}

/** Tách một dòng bảng markdown thành các cell, bỏ cell rỗng đầu/cuối sinh ra
 *  do dòng bắt đầu/kết thúc bằng `|` (bản sao cục bộ của cùng thuật toán ở
 *  mockup-order.ts — module đó không export nó, và WP này không được sửa
 *  file screen-*.ts đã ship). */
function tableCellsOf(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  const raw = trimmed.split('|');
  const first = raw[0];
  const lastEntry = raw[raw.length - 1];
  if (first !== undefined && first.trim() === '') raw.shift();
  if (raw.length > 0 && lastEntry !== undefined && lastEntry.trim() === '') raw.pop();
  return raw;
}

function normalizeHeaderCell(cell: string): string {
  return cell.replace(/\*\*/g, '').trim().toLowerCase();
}

const HEADING_LINE_RE = /^#{1,6}\s/;

/** Tìm cột "Mô tả" bằng cách leo NGƯỢC từ `fromIdx` (0-based, dòng bold-khai-
 *  màn) tới dòng header bảng gần nhất — dừng sớm nếu đụng một heading (nghĩa
 *  là section không còn cùng bảng). */
function findDescriptionColumnIndex(lines: string[], fromIdx: number): number | null {
  for (let i = fromIdx; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (HEADING_LINE_RE.test(line.trim())) return null;
    const cells = tableCellsOf(line);
    if (cells.length < 2) continue;
    const idx = cells.findIndex((c) => normalizeHeaderCell(c) === 'mô tả');
    if (idx !== -1) return idx;
  }
  return null;
}

/** Bỏ marker đầu dòng (`•`, `-`, `*`) của MỘT bullet — spec §WP-V5: "bullet
 *  tách theo `<br>` và marker •/-/*". Giữ nguyên phần còn lại (kể cả hoa/
 *  thường, dấu câu) — `diffVariantDescriptions` tự chuẩn hoá tiếp khi so. */
function stripBulletMarker(raw: string): string {
  return raw.trim().replace(/^[•\-*]\s*/, '').trim();
}

/** Tách cell "Mô tả" thành các bullet theo `<br>`. */
function splitDescriptionBullets(cell: string): string[] {
  return cell
    .split(/<br\s*\/?>/i)
    .map((part) => stripBulletMarker(part))
    .filter((part) => part.length > 0);
}

/** Đọc cột "Mô tả" của MỘT biến thể: `boldLine` là dòng tên đậm (1-based,
 *  đúng `ScreensManifestEntry.line`); dòng kế là dòng dữ liệu 2 ảnh + mô tả.
 *  `null` khi không parse được (không phải dòng bảng, không tìm thấy cột) —
 *  fail-soft, caller ghi warning rồi bỏ qua biến thể này. */
function extractDescriptionBulletsAt(md: string, boldLine: number): string[] | null {
  const lines = md.split(/\r?\n/);
  const boldIdx = boldLine - 1;
  const dataIdx = boldIdx + 1;
  const boldRow = lines[boldIdx];
  const dataRow = lines[dataIdx];
  if (!isTableRow(boldRow) || !isTableRow(dataRow)) return null;

  const columnIdx = findDescriptionColumnIndex(lines, boldIdx);
  if (columnIdx == null) return null;

  const cell = tableCellsOf(dataRow)[columnIdx];
  if (cell === undefined) return null;
  return splitDescriptionBullets(cell);
}

/** So cột "Mô tả" giữa các biến thể của mỗi nhóm (`groupKey`) trong
 *  `manifest`, dùng nội dung markdown đã có sẵn trong `mdBySource` (key =
 *  `ScreensManifestEntry.source`, relative cwd — giống `mdBySource` các
 *  module screen-*.ts khác dùng). Hàm THUẦN — không đọc đĩa; dùng trực tiếp
 *  trong test hoặc khi caller đã có sẵn nội dung trang trong bộ nhớ. */
export function scanVariantDriftFromDocs(
  manifest: ScreensManifest | null | undefined,
  mdBySource: Map<string, string>,
): VariantDriftScanResult {
  if (!manifest || manifest.schema_version !== 2) return EMPTY_RESULT;
  const groupable = manifest.screens.filter((s): s is ScreensManifestEntry & { groupKey: string } => !!s.groupKey);
  if (groupable.length === 0) return EMPTY_RESULT;

  const byGroup = new Map<string, ScreensManifestEntry[]>();
  for (const entry of groupable) {
    const list = byGroup.get(entry.groupKey) ?? [];
    list.push(entry);
    byGroup.set(entry.groupKey, list);
  }

  const findings: VariantDriftFinding[] = [];
  const warnings: string[] = [];

  for (const [groupKey, members] of byGroup) {
    const entries: VariantDescription[] = [];
    for (const member of members) {
      const platform: VariantPlatform | undefined = member.platform;
      if (!platform || !member.source || member.line == null) {
        warnings.push(`variant-drift: bỏ qua "${member.key}" (nhóm "${groupKey}") — thiếu platform/source/line.`);
        continue;
      }
      const md = mdBySource.get(member.source);
      if (md === undefined) {
        warnings.push(`variant-drift: không có nội dung markdown cho "${member.source}" (màn "${member.key}").`);
        continue;
      }
      const bullets = extractDescriptionBulletsAt(md, member.line);
      if (bullets == null) {
        warnings.push(`variant-drift: không parse được cột "Mô tả" cho "${member.key}" (dòng ${member.line} của "${member.source}").`);
        continue;
      }
      entries.push({ key: member.key, platform, descriptionBullets: bullets });
    }
    if (entries.length < 2) continue;
    findings.push(...diffVariantDescriptions(groupKey, entries));
  }

  return { findings, warnings };
}

/** Đọc nội dung markdown của mọi `source` xuất hiện trong `manifest`
 *  (relative `cwd`) — trang đọc lỗi bị bỏ qua lặng lẽ (fail-soft), scan sẽ tự
 *  ghi warning cho từng biến thể thiếu nội dung. */
export async function readMdBySourceForManifest(cwd: string, manifest: ScreensManifest): Promise<Map<string, string>> {
  const sources = new Set(manifest.screens.map((s) => s.source).filter((s): s is string => !!s));
  const out = new Map<string, string>();
  await Promise.all(
    [...sources].map(async (source) => {
      const md = await fs.promises.readFile(path.join(cwd, source), 'utf8').catch(() => null);
      if (md != null) out.set(source, md);
    }),
  );
  return out;
}

/** Quét variant-drift cho một cwd docs-review: đọc `comp/_screens.json` rồi
 *  các trang nguồn của nó. Manifest thiếu/hỏng JSON/v1/không nhóm → trả rỗng
 *  NGAY (không đọc thêm trang nào). Dùng cho wiring vào stage dr-comp
 *  (server.ts) khi chưa có sẵn manifest/mdBySource trong bộ nhớ. */
export async function scanVariantDriftForCwd(cwd: string): Promise<VariantDriftScanResult> {
  const raw = await fs.promises.readFile(path.join(cwd, SCREENS_MANIFEST_FILE), 'utf8').catch(() => null);
  if (raw == null) return EMPTY_RESULT;
  let manifest: ScreensManifest;
  try {
    manifest = JSON.parse(raw) as ScreensManifest;
  } catch {
    return EMPTY_RESULT;
  }
  if (!manifest || manifest.schema_version !== 2 || !Array.isArray(manifest.screens) || !manifest.screens.some((s) => s.groupKey)) {
    return EMPTY_RESULT;
  }
  const mdBySource = await readMdBySourceForManifest(cwd, manifest);
  return scanVariantDriftFromDocs(manifest, mdBySource);
}
