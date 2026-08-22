import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type {
  FigmaDesignSystemSource,
  FigmaDesignSystemCatalogSummary,
  FigmaDesignSystemComponentItem,
  FigmaDesignSystemGuideJob,
  FigmaDesignSystemGuideJobItem,
  FigmaDesignSystemImageCacheInfo,
  FigmaDesignSystemLastGuideRun,
  FigmaDesignSystemRefreshChanges,
  FigmaDesignSystemRefreshProgress,
  FigmaGuideActiveJob,
  GenerateFigmaDesignSystemGuideResponse,
  GetFigmaDesignSystemSourceResponse,
  ListActiveFigmaGuideJobsResponse,
  ListFigmaDesignSystemComponentsResponse,
} from '@open-design/contracts';

import {
  commitFigmaDesignSystemSourceCatalog,
  deleteFigmaDesignSystemSource,
  getFigmaDesignSystemSource,
  getProject,
  insertConversation,
  insertFigmaDesignSystemSource,
  insertProject,
  listFigmaDesignSystemSources,
  recoverInterruptedFigmaDesignSystemRefreshes,
  setFigmaDesignSystemSourceRefreshState,
  updateFigmaDesignSystemSource,
  updateProject,
  upsertMessage,
} from './db.js';
import { readFigmaConfig } from './figma-config.js';
import {
  anchorFor,
  renderFigmaComponentsMarkdown,
  type FigmaComponentCatalogSnapshot,
} from './figma-component-catalog.js';
import {
  parseComponentsGuide,
  renderComponentsGuideMarkdown,
  type ComponentsGuideEntry,
} from './figma-component-guide.js';
import { downloadFigmaImage, runDescribeChunk } from './figma-catalog-routes.js';
// WP20: "Sinh mô tả component thiếu" (WP19b) áp cho nguồn Figma DÙNG CHUNG —
// tái dùng NGUYÊN engine tất định của WP19b (không chép lại một bản song
// song có thể trôi lệch), chỉ khác nơi lưu (kho nguồn thay vì App-level).
import {
  classifyComponentKind,
  computeGuideCoverage,
  computeMissingDescriptions,
  generateComponentDescriptions,
  isJunkComponentName,
} from './figma-guide-generate.js';
import { buildFigmaComponentCatalog, describeFigmaError, fetchNodeImages, fetchNodeSubtrees } from './figma-rest.js';
import { mineDesignTokens, renderTokensDtcg, renderTokensMd, type MineTokensInput } from './figma-tokens.js';
import { mineComponentSlots, renderSlotsMd, type MineSlotsInput } from './figma-slots.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterFigmaDesignSystemRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'design' | 'chat' | 'agents'> {
  buildCatalog?: typeof buildFigmaComponentCatalog;
  timeoutMs?: number;
  now?: () => number;
}

type SourceRow = NonNullable<ReturnType<typeof getFigmaDesignSystemSource>>;
const activeRefreshes = new Set<string>();
const refreshProgress = new Map<string, FigmaDesignSystemRefreshProgress>();
// WP23a mục 4: một task prefetch ảnh tại một thời điểm CHO MỖI sourceId —
// trigger mới trong lúc một task đang chạy là no-op (xem prefetchComponentImages).
const prefetchTasks = new Map<string, Promise<void>>();

/** Durable Markdown materialization of a reusable Figma catalogue. SQLite
 * remains the structured source of truth; this file is the human/agent-facing
 * closed catalogue and is replaced atomically after every successful refresh. */
export function figmaDesignSystemComponentsPath(runtimeDataDir: string, sourceId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceId)) {
    throw new Error('invalid Figma design-system source id');
  }
  return path.join(runtimeDataDir, 'figma-design-systems', sourceId, 'criteria', 'components.md');
}

async function writeFigmaDesignSystemComponents(
  runtimeDataDir: string,
  sourceId: string,
  snapshot: FigmaComponentCatalogSnapshot,
): Promise<void> {
  const target = figmaDesignSystemComponentsPath(runtimeDataDir, sourceId);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, renderFigmaComponentsMarkdown(snapshot), 'utf8');
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

async function readFigmaDesignSystemComponents(
  runtimeDataDir: string,
  sourceId: string,
  snapshot: FigmaComponentCatalogSnapshot | null,
): Promise<string | null> {
  const target = figmaDesignSystemComponentsPath(runtimeDataDir, sourceId);
  const stored = await fs.promises.readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // Older catalogues may predate the durable Markdown materialization. They
  // can still be previewed immediately; the next refresh writes this content
  // to disk as well.
  return stored ?? (snapshot ? renderFigmaComponentsMarkdown(snapshot) : null);
}

async function removeFigmaDesignSystemFiles(runtimeDataDir: string, sourceId: string): Promise<void> {
  const componentsPath = figmaDesignSystemComponentsPath(runtimeDataDir, sourceId);
  await fs.promises.rm(path.dirname(path.dirname(componentsPath)), { recursive: true, force: true });
}

/* ── WP20: kho nguồn cho components-guide.md của nguồn Figma dùng chung ────
 * Mirror ĐÚNG khuôn App-level của WP19a (readAppComponentsGuide/
 * writeAppComponentsGuide, figma-catalog-routes.ts) — khác duy nhất ở NƠI
 * lưu: cạnh `criteria/components.md` của NGUỒN (figma-design-systems/<id>/
 * criteria/components-guide.md) thay vì `figma-catalog/` của một App, vì
 * guide này DÙNG CHUNG giữa mọi App gắn cùng nguồn — không App nào sở hữu
 * riêng. */
export function figmaDesignSystemGuidePath(runtimeDataDir: string, sourceId: string): string {
  return path.join(path.dirname(figmaDesignSystemComponentsPath(runtimeDataDir, sourceId)), 'components-guide.md');
}

/* ── WP23a mục 4: kho ảnh PNG prefetch của nguồn ────────────────────────────
 * `figma-design-systems/<sourceId>/images/<anchor>.png` — CẠNH `criteria/`
 * (dirname hai lần từ components.md = thư mục gốc của nguồn), KHÔNG dưới
 * `criteria/` (ảnh không phải nội dung agent-facing, chỉ là cache phục vụ
 * engine + route serve bên dưới). `anchor` ổn định qua rename/refresh (xem
 * `anchorFor`) nên cache sống sót qua nhiều lần refresh catalog. */
export function figmaDesignSystemImagesDir(runtimeDataDir: string, sourceId: string): string {
  const componentsPath = figmaDesignSystemComponentsPath(runtimeDataDir, sourceId);
  return path.join(path.dirname(path.dirname(componentsPath)), 'images');
}

/** WP23a mục 4: tải ảnh PNG (render 2x) cho MỌI component của nguồn CHƯA có
 *  file cache — chạy nền (fire-and-forget, caller KHÔNG await), gọi SAU khi
 *  refresh/tạo catalog commit thành công (xem hai call site ở route
 *  POST /refresh). Gỡ điểm flaky "Figma phản hồi quá lâu" của job sinh mô tả
 *  (nó không còn phải tự tải ảnh trong lúc job chạy — chunk 'normal' đọc cache
 *  này qua deps.imageCache, xem generateComponentDescriptions).
 *
 *  Một task/nguồn: `prefetchTasks` là guard — trigger mới trong lúc một task
 *  CÙNG sourceId đang chạy là no-op (không xếp hàng, không hủy task cũ — lần
 *  refresh tiếp theo sẽ tự trigger lại nếu còn ảnh thiếu). Lỗi từng ảnh chỉ
 *  đếm lại (console.warn), KHÔNG retry loop, KHÔNG throw — bọc catch nội bộ
 *  đúng nghĩa "fire-and-forget" caller yêu cầu. */
function prefetchComponentImages(
  sourceId: string,
  snapshot: FigmaComponentCatalogSnapshot,
  token: string,
  runtimeDataDir: string,
): void {
  if (prefetchTasks.has(sourceId)) return;
  const task = (async () => {
    const imagesDir = figmaDesignSystemImagesDir(runtimeDataDir, sourceId);
    await fs.promises.mkdir(imagesDir, { recursive: true });
    const existing = new Set(await fs.promises.readdir(imagesDir).catch(() => [] as string[]));
    const byFile = new Map<string, string[]>();
    for (const file of snapshot.files) {
      for (const component of file.components) {
        const anchor = anchorFor(file.fileKey, component.nodeId);
        if (existing.has(`${anchor}.png`)) continue;
        const list = byFile.get(file.fileKey) ?? [];
        list.push(component.nodeId);
        byFile.set(file.fileKey, list);
      }
    }
    let errors = 0;
    for (const [fileKey, nodeIds] of byFile) {
      // fetchNodeImages (figma-rest.ts) đã tự chia lô ≤40 nodeId/request —
      // trong ngưỡng "≤50/request" của contract mục 4, không cần chia lại.
      const images = await fetchNodeImages(token, fileKey, nodeIds).catch(() => new Map<string, string>());
      for (const nodeId of nodeIds) {
        const anchor = anchorFor(fileKey, nodeId);
        const url = images.get(nodeId);
        if (!url) {
          errors += 1;
          continue;
        }
        const ok = await downloadFigmaImage(url, path.join(imagesDir, `${anchor}.png`)).catch(() => false);
        if (!ok) errors += 1;
      }
    }
    if (errors > 0) {
      console.warn(`[figma-design-system-guide] prefetch ảnh cho nguồn "${sourceId}": ${errors} ảnh lỗi (bỏ qua, không retry).`);
    }
  })();
  prefetchTasks.set(sourceId, task);
  void task.catch((err) => {
    console.warn(`[figma-design-system-guide] prefetch ảnh cho nguồn "${sourceId}" thất bại:`, err);
  }).finally(() => {
    if (prefetchTasks.get(sourceId) === task) prefetchTasks.delete(sourceId);
  });
}

/** WP23a mục 4: `imageCache` của GET detail — đủ rẻ để tính live (đếm số file
 *  `.png`, không đọc nội dung) với quy mô thực tế (~600 file/nguồn). */
async function computeImageCacheInfo(
  runtimeDataDir: string,
  sourceId: string,
  catalog: FigmaComponentCatalogSnapshot,
): Promise<FigmaDesignSystemImageCacheInfo> {
  const total = catalog.files.reduce((sum, file) => sum + file.components.length, 0);
  const imagesDir = figmaDesignSystemImagesDir(runtimeDataDir, sourceId);
  const files = await fs.promises.readdir(imagesDir).catch(() => [] as string[]);
  const cached = files.filter((name) => name.endsWith('.png')).length;
  return { total, cached, running: prefetchTasks.has(sourceId) };
}

// Serialize writes theo sourceId — cùng lý do writeAppFigmaCatalog/
// writeAppComponentsGuide dùng `appCatalogWrites` (figma-catalog-routes.ts):
// job POST /generate-guide VÀ vòng sinh bù của dr-comp (server.ts) có thể
// ghi kho nguồn gần như đồng thời cho CÙNG một nguồn khi hai App dùng chung
// nó chạy dr-comp song song.
const guideWrites = new Map<string, Promise<void>>();
function serializeGuideWrite(sourceId: string, task: () => Promise<void>): Promise<void> {
  const previous = guideWrites.get(sourceId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  guideWrites.set(sourceId, current);
  return current.finally(() => {
    if (guideWrites.get(sourceId) === current) guideWrites.delete(sourceId);
  });
}

export async function writeFigmaDesignSystemGuide(runtimeDataDir: string, sourceId: string, markdown: string): Promise<void> {
  const target = figmaDesignSystemGuidePath(runtimeDataDir, sourceId);
  return serializeGuideWrite(sourceId, async () => {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, markdown, 'utf8');
      await fs.promises.rename(temporary, target);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  });
}

/** `null` khi nguồn chưa từng sinh guide (chưa bấm nút, hoặc nguồn mới) —
 *  cùng "guide vắng mặt" fallback shape với mọi chỗ đọc guide App-level. */
export async function readFigmaDesignSystemGuide(runtimeDataDir: string, sourceId: string): Promise<string | null> {
  const target = figmaDesignSystemGuidePath(runtimeDataDir, sourceId);
  return fs.promises.readFile(target, 'utf8').catch(() => null);
}

/* ── WP-ds-tokens: token de-facto đào từ node tree của component ───────────
 * Sống CẠNH `components-guide.md` ở kho nguồn (source-level, dùng chung mọi
 * App gắn cùng nguồn) — `tokens.md` (người/agent đọc) + `tokens.json` (W3C
 * DTCG, cho máy). Đào TẤT ĐỊNH bằng {@link mineDesignTokens} (figma-
 * tokens.ts, module thuần), KHÔNG gọi AI. Sinh tự động sau mỗi refresh commit
 * thành công, best-effort — lỗi mining KHÔNG được làm hỏng refresh (xem
 * `mineAndWriteFigmaDesignSystemTokens` + call site trong route POST
 * /refresh), cùng khuôn "phụ phẩm chạy nền" với prefetch ảnh 0.8.86
 * (prefetchComponentImages). */
export function figmaDesignSystemTokensMdPath(runtimeDataDir: string, sourceId: string): string {
  return path.join(path.dirname(figmaDesignSystemGuidePath(runtimeDataDir, sourceId)), 'tokens.md');
}

export function figmaDesignSystemTokensJsonPath(runtimeDataDir: string, sourceId: string): string {
  return path.join(path.dirname(figmaDesignSystemGuidePath(runtimeDataDir, sourceId)), 'tokens.json');
}

// Serialize ghi tokens.md/tokens.json theo sourceId — cùng lý do
// `serializeGuideWrite` tồn tại (tránh hai lượt ghi gần nhau cho CÙNG nguồn
// giẫm lên nhau giữa các file tmp/rename).
const tokenWrites = new Map<string, Promise<void>>();
function serializeTokenWrite(sourceId: string, task: () => Promise<void>): Promise<void> {
  const previous = tokenWrites.get(sourceId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  tokenWrites.set(sourceId, current);
  return current.finally(() => {
    if (tokenWrites.get(sourceId) === current) tokenWrites.delete(sourceId);
  });
}

async function writeFileAtomic(target: string, contents: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, contents, 'utf8');
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

export async function writeFigmaDesignSystemTokens(
  runtimeDataDir: string,
  sourceId: string,
  markdown: string,
  dtcg: unknown,
): Promise<void> {
  return serializeTokenWrite(sourceId, async () => {
    await writeFileAtomic(figmaDesignSystemTokensMdPath(runtimeDataDir, sourceId), markdown);
    await writeFileAtomic(figmaDesignSystemTokensJsonPath(runtimeDataDir, sourceId), JSON.stringify(dtcg, null, 2));
  });
}

/** `null` khi nguồn chưa từng sinh token (chưa refresh lần nào từ khi WP-ds-
 *  tokens ra mắt, hoặc mining lỗi liên tục) — cùng "vắng mặt" fallback shape
 *  với `readFigmaDesignSystemGuide`. `generatedAt` lấy từ mtime file (không
 *  cần một file meta riêng — tokens.md tự thay thế nguyên khối mỗi lần sinh
 *  nên mtime luôn đúng thời điểm sinh gần nhất). */
export async function readFigmaDesignSystemTokens(
  runtimeDataDir: string,
  sourceId: string,
): Promise<{ markdown: string; generatedAt: string } | null> {
  const target = figmaDesignSystemTokensMdPath(runtimeDataDir, sourceId);
  const markdown = await fs.promises.readFile(target, 'utf8').catch(() => null);
  if (markdown == null) return null;
  const stat = await fs.promises.stat(target).catch(() => null);
  return { markdown, generatedAt: stat ? stat.mtime.toISOString() : new Date(0).toISOString() };
}

/** WP-ds-tokens mục "Giao criteria": copy `tokens.md` (nguyên văn, source-
 *  level) vào `<criteriaDir>/tokens.md` của một App — ĐÚNG khuôn
 *  `writeFilteredComponentsGuideToCriteria` (components-guide.md): nguồn
 *  CHƯA có tokens.md → không ghi, không lỗi (không phải "giữ bản cũ" — một
 *  App trước đó có bản cũ nhưng nguồn nay không còn thì bản cũ cũng bị dọn,
 *  tránh tokens ma). KHÔNG giao tokens.json vào criteria (JSON cho máy ở
 *  source-level là đủ).
 *
 *  Call site thật: server.ts, ngay sau `writeFilteredComponentsGuideToCriteria`
 *  ở bước staging vô điều kiện trước run (chỉ MỘT chỗ — tokens không đổi trong
 *  vòng sinh bù mô tả nên không lặp lại ở call site sinh bù). */
export async function writeTokensMarkdownToCriteria(
  criteriaDir: string,
  tokensMarkdown: string | null,
): Promise<{ delivered: boolean }> {
  const target = path.join(criteriaDir, 'tokens.md');
  if (tokensMarkdown == null) {
    await fs.promises.rm(target, { force: true });
    return { delivered: false };
  }
  await fs.promises.mkdir(criteriaDir, { recursive: true });
  await fs.promises.writeFile(target, tokensMarkdown, 'utf8');
  return { delivered: true };
}

/* ── WP-slots: hồ sơ SLOT de-facto đào từ node tree của component ──────────
 * Sống CẠNH `tokens.md` ở kho nguồn (source-level, dùng chung mọi App gắn
 * cùng nguồn) — `slots.md` (người/agent đọc, KHÔNG có bản .json cho máy —
 * xem `.tmp/pipeline/wp-slots.yaml`: chỉ markdown cho agent, không sinh DTCG
 * gì cả). Đào TẤT ĐỊNH bằng {@link mineComponentSlots} (figma-slots.ts, module
 * thuần) NGAY TRONG CÙNG task mining token (xem `mineAndWriteFigmaDesignSystemTokens`
 * bên dưới) — tái dùng CHÍNH `inputs` đã fetch cho token, không thêm lượt
 * REST nào. Đúng khuôn path/write/read/giao-criteria với tokens.md ở trên. */
export function figmaDesignSystemSlotsMdPath(runtimeDataDir: string, sourceId: string): string {
  return path.join(path.dirname(figmaDesignSystemGuidePath(runtimeDataDir, sourceId)), 'slots.md');
}

export async function writeFigmaDesignSystemSlots(
  runtimeDataDir: string,
  sourceId: string,
  markdown: string,
): Promise<void> {
  return serializeTokenWrite(sourceId, async () => {
    await writeFileAtomic(figmaDesignSystemSlotsMdPath(runtimeDataDir, sourceId), markdown);
  });
}

/** `null` khi nguồn chưa từng sinh hồ sơ slot (chưa refresh lần nào từ khi
 *  WP-slots ra mắt, catalog không có component nào có slot, hoặc mining lỗi
 *  liên tục) — cùng "vắng mặt" fallback shape với `readFigmaDesignSystemTokens`. */
export async function readFigmaDesignSystemSlots(
  runtimeDataDir: string,
  sourceId: string,
): Promise<{ markdown: string; generatedAt: string } | null> {
  const target = figmaDesignSystemSlotsMdPath(runtimeDataDir, sourceId);
  const markdown = await fs.promises.readFile(target, 'utf8').catch(() => null);
  if (markdown == null) return null;
  const stat = await fs.promises.stat(target).catch(() => null);
  return { markdown, generatedAt: stat ? stat.mtime.toISOString() : new Date(0).toISOString() };
}

/** WP-slots mục "Giao criteria": copy `slots.md` (nguyên văn, source-level)
 *  vào `<criteriaDir>/slots.md` của một App — ĐÚNG khuôn
 *  `writeTokensMarkdownToCriteria`: nguồn CHƯA có slots.md → không ghi
 *  (không phải "giữ bản cũ" — dọn bản cũ nếu có, tránh slots ma). */
export async function writeSlotsMarkdownToCriteria(
  criteriaDir: string,
  slotsMarkdown: string | null,
): Promise<{ delivered: boolean }> {
  const target = path.join(criteriaDir, 'slots.md');
  if (slotsMarkdown == null) {
    await fs.promises.rm(target, { force: true });
    return { delivered: false };
  }
  await fs.promises.mkdir(criteriaDir, { recursive: true });
  await fs.promises.writeFile(target, slotsMarkdown, 'utf8');
  return { delivered: true };
}

// Một task đào token tại một thời điểm CHO MỖI sourceId — cùng guard đơn
// giản `prefetchTasks` dùng (trigger mới trong lúc một task đang chạy là
// no-op, lần refresh sau tự trigger lại).
const tokenMiningTasks = new Map<string, Promise<void>>();

/** Đào token de-facto SAU KHI refresh commit thành công — fire-and-forget,
 *  caller (route POST /refresh) KHÔNG await, cùng lý do prefetch ảnh không
 *  được ảnh hưởng timeout 120s của route. Lỗi mining (REST lỗi, node thiếu…)
 *  chỉ console.warn — KHÔNG throw ra ngoài task, KHÔNG retry loop; token chỉ
 *  là phụ phẩm, một lần refresh lỗi mining không được làm mất tác dụng cả
 *  luồng refresh catalog chính. */
export function mineAndWriteFigmaDesignSystemTokens(
  sourceId: string,
  snapshot: FigmaComponentCatalogSnapshot,
  token: string,
  runtimeDataDir: string,
  deps?: { fetchNodeSubtrees?: typeof fetchNodeSubtrees },
): void {
  if (tokenMiningTasks.has(sourceId)) return;
  const fetchSubtrees = deps?.fetchNodeSubtrees ?? fetchNodeSubtrees;
  const task = (async () => {
    const inputs: MineTokensInput[] = [];
    let componentCount = 0;
    for (const file of snapshot.files) {
      if (file.components.length === 0) continue;
      const nodeIds = file.components.map((component) => component.nodeId);
      const subtrees = await fetchSubtrees(token, file.fileKey, nodeIds);
      for (const component of file.components) {
        componentCount += 1;
        const node = subtrees.get(component.nodeId);
        if (node !== undefined) inputs.push({ name: component.name, node });
      }
    }
    const profile = mineDesignTokens(inputs);
    // Không tìm thấy GÌ ở cả 5 nhóm — hầu như luôn là dấu hiệu REST trả rỗng
    // bất thường cho MỌI node (không phải "DS thật sự không có token nào"),
    // ví dụ Figma trả 200 nhưng thiếu `document` cho từng id trong response
    // `/v1/files/:key/nodes`. Bỏ qua ghi thay vì đè một bản `tokens.md` rỗng
    // lên bản trước đó (nếu có) — giữ nguyên bản tốt nhất đã có cho tới lần
    // refresh sau.
    const isEmpty =
      profile.colors.length === 0 &&
      profile.gradients.length === 0 &&
      profile.typography.length === 0 &&
      profile.radii.length === 0 &&
      profile.shadows.length === 0 &&
      profile.spacing.length === 0;
    if (!isEmpty) {
      const markdown = renderTokensMd(profile, { generatedAt: new Date().toISOString(), componentCount });
      const dtcg = renderTokensDtcg(profile);
      await writeFigmaDesignSystemTokens(runtimeDataDir, sourceId, markdown, dtcg);
    }
    // WP-slots: đào hồ sơ SLOT de-facto NGAY SAU khi tokens đã ghi xong (hoặc
    // bị bỏ qua vì rỗng) — tái dùng CHÍNH `inputs` vừa fetch cho token, không
    // thêm lượt REST nào. Độc lập với nhánh tokens ở trên: một catalog có thể
    // không có token nào (mọi màu/chữ/radius/shadow/spacing = 0) nhưng vẫn có
    // component chứa slot, hoặc ngược lại — hai empty-guard tách biệt nhau.
    // Lỗi ở nhánh này (nếu có) rơi vào đúng `task.catch` best-effort bên dưới,
    // không cần try/catch riêng — không làm hỏng phần tokens đã ghi ở trên.
    const slotProfiles = mineComponentSlots(inputs);
    if (slotProfiles.length > 0) {
      const slotsMarkdown = renderSlotsMd(slotProfiles, { generatedAt: new Date().toISOString(), componentCount });
      await writeFigmaDesignSystemSlots(runtimeDataDir, sourceId, slotsMarkdown);
    }
  })();
  tokenMiningTasks.set(sourceId, task);
  void task.catch((err) => {
    console.warn(`[figma-design-system-tokens] đào token de-facto cho nguồn "${sourceId}" thất bại (bỏ qua, không retry):`, err);
  }).finally(() => {
    if (tokenMiningTasks.get(sourceId) === task) tokenMiningTasks.delete(sourceId);
  });
}

/** WP20b (fix review WP20 blocking): lọc `guideMarkdown` của nguồn Figma
 *  dùng chung theo `snapshot` hiện tại (chỉ giữ anchor CÒN THẬT — component
 *  đã bị xoá khỏi Figma kể từ lần guide được sinh thì rớt), rồi ghi/xoá
 *  `<criteriaDir>/components-guide.md`. VÔ ĐIỀU KIỆN theo nghĩa: guide có
 *  entry sau khi lọc → ghi (đè bản cũ nếu có — kho nguồn luôn mới nhất);
 *  không còn entry nào (guide `null`, hoặc lọc xong rỗng) → rm(force), đồng
 *  bộ với hành vi nhánh figma-links App-level (WP19a): guide vắng mặt nghĩa
 *  là "chưa có mô tả nào", không phải "giữ nguyên bản cũ" — nếu không rm thì
 *  một lần bind trước còn guide, rồi component bị xoá khỏi Figma, sẽ để lại
 *  mô tả ma vĩnh viễn trong cwd.
 *
 *  Tách thành hàm thuần (chỉ nhận dữ liệu đã đọc sẵn, không tự đọc DB/kho
 *  nguồn) để server.ts gọi được từ HAI nơi — staging vô điều kiện ngay sau
 *  `stageBoundAppContextForRun` VÀ sau vòng sinh bù mô tả — mà không trôi
 *  lệch giữa hai bản sao logic lọc, và để test được ở mức hàm (server.ts có
 *  `@ts-nocheck`, không export gì để import thẳng). */
export async function writeFilteredComponentsGuideToCriteria(
  criteriaDir: string,
  snapshot: FigmaComponentCatalogSnapshot,
  guideMarkdown: string | null,
): Promise<{ entryCount: number }> {
  const target = path.join(criteriaDir, 'components-guide.md');
  const validAnchors = new Set(
    snapshot.files.flatMap((file) => file.components.map((component) => anchorFor(file.fileKey, component.nodeId))),
  );
  const filtered: ComponentsGuideEntry[] = [];
  if (guideMarkdown) {
    for (const [anchor, entry] of parseComponentsGuide(guideMarkdown)) {
      if (validAnchors.has(anchor)) filtered.push({ anchor, name: entry.name, description: entry.description });
    }
  }
  if (filtered.length > 0) {
    await fs.promises.mkdir(criteriaDir, { recursive: true });
    await fs.promises.writeFile(target, renderComponentsGuideMarkdown(filtered), 'utf8');
  } else {
    await fs.promises.rm(target, { force: true });
  }
  return { entryCount: filtered.length };
}

/* ── WP21a: GET /components — structured per-component view ────────────────
 * Preview markdown 564 component không dùng được (người dùng duyệt
 * 2026-08-20) — hàm THUẦN (không đọc đĩa/DB, test được thẳng) dựng danh sách
 * có cấu trúc từ đúng snapshot (row.catalog) + guide kho nguồn hiện có, theo
 * contract mục 1 (`.tmp/pipeline/wp21-contract.md`): KHÔNG re-sort, giữ thứ
 * tự snapshot (file → component). */
export function buildFigmaDesignSystemComponentItems(
  snapshot: FigmaComponentCatalogSnapshot,
  guideMarkdown: string | null,
): FigmaDesignSystemComponentItem[] {
  const guide = guideMarkdown != null ? parseComponentsGuide(guideMarkdown) : new Map<string, { name: string; description: string }>();
  const items: FigmaDesignSystemComponentItem[] = [];
  for (const file of snapshot.files) {
    for (const component of file.components) {
      const anchor = anchorFor(file.fileKey, component.nodeId);
      // Bất biến Figma LUÔN thắng (cùng {@link mergeCatalogueWithGuide}):
      // mô tả Figma thật có trước; guide chỉ là fallback khi Figma KHÔNG có.
      // `description` trả ra verbatim — KHÔNG kèm hậu tố "(AI sinh)" (đó là
      // quy ước hiển thị của bảng dr-review, không phải của API JSON này).
      let description: string | undefined;
      let descriptionSource: FigmaDesignSystemComponentItem['descriptionSource'];
      if (component.description) {
        description = component.description;
        descriptionSource = 'figma';
      } else {
        const guideEntry = guide.get(anchor);
        if (guideEntry?.description) {
          description = guideEntry.description;
          descriptionSource = 'ai';
        } else {
          descriptionSource = 'none';
        }
      }
      items.push({
        anchor,
        name: component.name,
        nodeId: component.nodeId,
        fileKey: file.fileKey,
        fileName: file.name,
        ...(component.page ? { page: component.page } : {}),
        ...(description !== undefined ? { description } : {}),
        descriptionSource,
        properties: component.properties,
        // WP23a mục 2: đúng NGUỒN SỰ THẬT của engine (figma-guide-generate.ts)
        // — daemon LUÔN set (client cũ vẫn thấy field lạ vô hại, optional chỉ
        // để không phá contract cũ).
        needsRename: isJunkComponentName(component.name),
        kind: classifyComponentKind(component.page, component.name),
      });
    }
  }
  return items;
}

/* ── WP21a: persist lượt "Sinh mô tả" gần nhất (qua restart) ────────────────
 * `components-guide.meta.json` cạnh `components-guide.md`, cùng thư mục
 * `criteria/` của nguồn — bất biến "kết thúc job → ghi atomic" (contract mục
 * 3), độc lập với `figmaGuideJobs` (Map trong bộ nhớ, mất khi daemon restart)
 * để GET detail vẫn hiện được kết quả lượt gần nhất sau khi restart. */
export function figmaDesignSystemGuideMetaPath(runtimeDataDir: string, sourceId: string): string {
  return path.join(path.dirname(figmaDesignSystemGuidePath(runtimeDataDir, sourceId)), 'components-guide.meta.json');
}

export async function writeFigmaDesignSystemGuideMeta(
  runtimeDataDir: string,
  sourceId: string,
  meta: FigmaDesignSystemLastGuideRun,
): Promise<void> {
  const target = figmaDesignSystemGuideMetaPath(runtimeDataDir, sourceId);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(meta, null, 2), 'utf8');
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

/** `null` khi chưa từng có lượt "Sinh mô tả" nào kết thúc CHO NGUỒN NÀY, hoặc
 *  file hỏng/không đọc được — best-effort đúng nghĩa contract mục 3 ("GET
 *  detail đọc meta best-effort"): một file meta hỏng không được làm hỏng GET
 *  detail của cả nguồn. */
export async function readFigmaDesignSystemGuideMeta(
  runtimeDataDir: string,
  sourceId: string,
): Promise<FigmaDesignSystemLastGuideRun | null> {
  const target = figmaDesignSystemGuideMetaPath(runtimeDataDir, sourceId);
  const raw = await fs.promises.readFile(target, 'utf8').catch(() => null);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed && typeof parsed === 'object' &&
      typeof parsed.finishedAt === 'string' &&
      typeof parsed.generated === 'number' &&
      typeof parsed.failed === 'number' &&
      Array.isArray(parsed.failures)
    ) {
      // WP23a: `skipped` là field mới — meta ghi TRƯỚC WP23a không có field
      // này. Chuẩn hoá về 0 thay vì coi cả file là hỏng (best-effort đọc
      // ngược tương thích, không phải một field bắt buộc để tin file này).
      return { ...parsed, skipped: typeof parsed.skipped === 'number' ? parsed.skipped : 0 } as FigmaDesignSystemLastGuideRun;
    }
  } catch {
    // best-effort: JSON hỏng → coi như chưa có lượt nào (không throw, không
    // làm hỏng GET detail).
  }
  return null;
}

function canonicalLinks(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    let parsed: URL;
    try { parsed = new URL(raw.trim()); } catch { return null; }
    if (!['figma.com', 'www.figma.com'].includes(parsed.hostname.toLowerCase())) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (!['design', 'file'].includes(parts[0] ?? '') || !/^[A-Za-z0-9]+$/.test(parts[1] ?? '')) return null;
    const key = parts[1]!;
    if (seen.has(key)) return null;
    seen.add(key);
    const canonical = new URL(`https://www.figma.com/design/${key}`);
    const nodeId = parsed.searchParams.get('node-id')?.trim();
    if (nodeId && /^[0-9]+[-:][0-9]+$/.test(nodeId)) canonical.searchParams.set('node-id', nodeId.replace(':', '-'));
    result.push(canonical.toString());
  }
  return result;
}

function catalogSummary(snapshot: FigmaComponentCatalogSnapshot, digest: string): FigmaDesignSystemCatalogSummary {
  const files = snapshot.files.map((file) => ({
    fileKey: file.fileKey,
    name: file.name,
    url: file.url,
    componentCount: file.components.length,
  }));
  return {
    generatedAt: snapshot.generatedAt,
    digest,
    fileCount: files.length,
    componentCount: files.reduce((sum, file) => sum + file.componentCount, 0),
    files,
  };
}

function componentMap(snapshot: FigmaComponentCatalogSnapshot | null): Map<string, string> {
  const components = new Map<string, string>();
  for (const file of snapshot?.files ?? []) {
    for (const component of file.components) {
      components.set(`${file.fileKey}\0${component.nodeId}`, JSON.stringify(component));
    }
  }
  return components;
}

export function diffFigmaComponentCatalogs(
  previous: FigmaComponentCatalogSnapshot | null,
  current: FigmaComponentCatalogSnapshot,
): FigmaDesignSystemRefreshChanges {
  const before = componentMap(previous);
  const after = componentMap(current);
  let addedComponents = 0;
  let changedComponents = 0;
  let unchangedComponents = 0;
  for (const [key, component] of after) {
    const previousComponent = before.get(key);
    if (previousComponent === undefined) addedComponents += 1;
    else if (previousComponent !== component) changedComponents += 1;
    else unchangedComponents += 1;
  }
  let removedComponents = 0;
  for (const key of before.keys()) {
    if (!after.has(key)) removedComponents += 1;
  }
  return {
    previousComponentCount: before.size,
    currentComponentCount: after.size,
    addedComponents,
    removedComponents,
    changedComponents,
    unchangedComponents,
  };
}

export function figmaDesignSystemSourceToContract(row: SourceRow): FigmaDesignSystemSource {
  const snapshot = row.catalog as FigmaComponentCatalogSnapshot | null;
  return {
    id: row.id,
    name: row.name,
    kind: 'figma-links',
    links: row.links,
    status: row.status,
    refreshProgress: refreshProgress.get(row.id) ?? null,
    catalog: snapshot && row.catalogDigest ? catalogSummary(snapshot, row.catalogDigest) : null,
    lastError: row.lastError,
    hasShowcase: false,
    hasReactBundle: false,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function fileKeyOf(url: string): string {
  return new URL(url).pathname.split('/').filter(Boolean)[1]!;
}

export function registerFigmaDesignSystemRoutes(app: Express, deps: RegisterFigmaDesignSystemRoutesDeps): void {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  recoverInterruptedFigmaDesignSystemRefreshes(db, now());
  const guard = (req: any, res: any): boolean => {
    if (deps.http.isLocalSameOrigin(req, deps.http.resolvedPortRef.current)) return true;
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'cross-origin request rejected' } });
    return false;
  };
  const notFound = (res: any) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy Design system Figma.' } });

  app.get('/api/figma-design-systems', (req, res) => {
    if (!guard(req, res)) return;
    res.json({ sources: listFigmaDesignSystemSources(db).map(figmaDesignSystemSourceToContract) });
  });

  app.post('/api/figma-design-systems', (req, res) => {
    if (!guard(req, res)) return;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const links = canonicalLinks(req.body?.links);
    if (!name || name.length > 120 || !links) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Tên và 1–5 link file Figma hợp lệ là bắt buộc.' } });
    }
    const timestamp = now();
    const source = insertFigmaDesignSystemSource(db, { id: randomUUID(), name, links, createdAt: timestamp, updatedAt: timestamp });
    res.status(201).json({ source: figmaDesignSystemSourceToContract(source!) });
  });

  app.get('/api/figma-design-systems/:id', async (req, res) => {
    if (!guard(req, res)) return;
    const source = getFigmaDesignSystemSource(db, req.params.id);
    if (!source) return notFound(res);
    const catalog = source.catalog as FigmaComponentCatalogSnapshot | null;
    const guideMarkdown = await readFigmaDesignSystemGuide(deps.paths.RUNTIME_DATA_DIR, source.id);
    // WP21a: best-effort — meta hỏng/vắng mặt không được làm hỏng GET detail
    // (xem readFigmaDesignSystemGuideMeta).
    const lastGuideRun = await readFigmaDesignSystemGuideMeta(deps.paths.RUNTIME_DATA_DIR, source.id);
    const body: GetFigmaDesignSystemSourceResponse = {
      source: figmaDesignSystemSourceToContract(source),
      componentsMarkdown: await readFigmaDesignSystemComponents(deps.paths.RUNTIME_DATA_DIR, source.id, catalog),
      // WP20/WP21a: optional fields — omit (not `null`/zeroed) khi chưa có gì,
      // giữ đúng "compatibility" đã chốt ở WP19a cho response này (client cũ
      // không thấy field lạ, không cần đổi shape mặc định).
      ...(guideMarkdown != null ? { guideMarkdown } : {}),
      ...(catalog ? { coverage: computeGuideCoverage(catalog, guideMarkdown) } : {}),
      ...(lastGuideRun ? { lastGuideRun } : {}),
      ...(catalog ? { imageCache: await computeImageCacheInfo(deps.paths.RUNTIME_DATA_DIR, source.id, catalog) } : {}),
    };
    res.json(body);
  });

  // ── WP23a mục 4: route serve ảnh prefetch cho một component — anchor xác
  // thực bằng regex CHẶT (chữ "figma-" cố định + đúng 10 hex, đúng shape
  // `anchorFor` sinh ra) trước khi path.join, nên không thể escape thư mục
  // images/ dù input có "../".
  app.get('/api/figma-design-systems/:id/component-image/:anchor', async (req, res) => {
    if (!guard(req, res)) return;
    const source = getFigmaDesignSystemSource(db, req.params.id);
    if (!source) return notFound(res);
    const anchor = String(req.params.anchor ?? '');
    if (!/^figma-[0-9a-f]{10}$/.test(anchor)) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'anchor không hợp lệ' } });
    }
    const target = path.join(figmaDesignSystemImagesDir(deps.paths.RUNTIME_DATA_DIR, source.id), `${anchor}.png`);
    const exists = await fs.promises.access(target).then(() => true).catch(() => false);
    if (!exists) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Chưa có ảnh cho component này.' } });
    }
    const buffer = await fs.promises.readFile(target);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=300');
    res.status(200).send(buffer);
  });

  // ── WP21a: GET /components — API JSON có cấu trúc thay preview markdown
  // 564 comp không dùng được (contract mục 1). 404 nguồn không tồn tại; 409
  // CATALOG_REQUIRED khi nguồn chưa từng refresh (đúng khuôn lỗi POST
  // /generate-guide bên dưới).
  app.get('/api/figma-design-systems/:id/components', async (req, res) => {
    if (!guard(req, res)) return;
    const source = getFigmaDesignSystemSource(db, req.params.id);
    if (!source) return notFound(res);
    const catalog = source.catalog as FigmaComponentCatalogSnapshot | null;
    if (!catalog) {
      return res.status(409).json({ error: { code: 'CATALOG_REQUIRED', message: 'Nguồn chưa có danh mục component — làm mới trước khi xem chi tiết.' } });
    }
    const guideMarkdown = await readFigmaDesignSystemGuide(deps.paths.RUNTIME_DATA_DIR, source.id);
    const body: ListFigmaDesignSystemComponentsResponse = {
      components: buildFigmaDesignSystemComponentItems(catalog, guideMarkdown),
    };
    res.json(body);
  });

  // ── WP-ds-tokens: GET tokens.md de-facto — mirror khuôn "guide vắng mặt"
  // (readFigmaDesignSystemGuide/GET /:id ở trên): 404 rõ lời khi nguồn chưa
  // từng refresh THÀNH CÔNG với mining chạy xong (chưa bấm Làm mới, hoặc lần
  // mining gần nhất lỗi hết) — không phải lỗi hệ thống, chỉ là "chưa có".
  app.get('/api/figma-design-systems/:id/tokens', async (req, res) => {
    if (!guard(req, res)) return;
    const source = getFigmaDesignSystemSource(db, req.params.id);
    if (!source) return notFound(res);
    const tokens = await readFigmaDesignSystemTokens(deps.paths.RUNTIME_DATA_DIR, source.id);
    if (!tokens) {
      return res.status(404).json({
        error: { code: 'TOKENS_NOT_GENERATED', message: 'Chưa có token de-facto cho nguồn này — làm mới nguồn để đào token.' },
      });
    }
    res.json(tokens);
  });

  // WP-slots (tab Slots trong DS detail): GET slots.md — mirror y hệt route
  // tokens ở trên, cùng lý do 404 "chưa có" (nguồn chưa refresh từ khi
  // WP-slots ra mắt, hoặc catalog không có component nào chứa slot).
  app.get('/api/figma-design-systems/:id/slots', async (req, res) => {
    if (!guard(req, res)) return;
    const source = getFigmaDesignSystemSource(db, req.params.id);
    if (!source) return notFound(res);
    const slots = await readFigmaDesignSystemSlots(deps.paths.RUNTIME_DATA_DIR, source.id);
    if (!slots) {
      return res.status(404).json({
        error: { code: 'SLOTS_NOT_GENERATED', message: 'Chưa có hồ sơ slot cho nguồn này — làm mới nguồn để đào (chỉ component có slot mới vào hồ sơ).' },
      });
    }
    res.json(slots);
  });

  app.patch('/api/figma-design-systems/:id', async (req, res) => {
    if (!guard(req, res)) return;
    const current = getFigmaDesignSystemSource(db, req.params.id);
    if (!current) return notFound(res);
    const name = req.body?.name === undefined ? current.name : typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const links = req.body?.links === undefined ? current.links : canonicalLinks(req.body.links);
    if (!name || name.length > 120 || !links) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Tên và 1–5 link file Figma hợp lệ là bắt buộc.' } });
    }
    const linksChanged = JSON.stringify(links) !== JSON.stringify(current.links);
    if (linksChanged) await removeFigmaDesignSystemFiles(deps.paths.RUNTIME_DATA_DIR, current.id);
    const source = updateFigmaDesignSystemSource(db, current.id, { name, links, linksChanged, updatedAt: now() });
    res.json({ source: figmaDesignSystemSourceToContract(source!) });
  });

  app.delete('/api/figma-design-systems/:id', async (req, res) => {
    if (!guard(req, res)) return;
    if (activeRefreshes.has(req.params.id)) {
      return res.status(409).json({ error: { code: 'REFRESH_IN_PROGRESS', message: 'Design system đang được làm mới.' } });
    }
    const current = getFigmaDesignSystemSource(db, req.params.id);
    if (!current) return notFound(res);
    if (!deleteFigmaDesignSystemSource(db, req.params.id)) return notFound(res);
    await removeFigmaDesignSystemFiles(deps.paths.RUNTIME_DATA_DIR, current.id);
    res.status(204).send();
  });

  app.post('/api/figma-design-systems/:id/refresh', async (req, res) => {
    if (!guard(req, res)) return;
    const current = getFigmaDesignSystemSource(db, req.params.id);
    if (!current) return notFound(res);
    if (activeRefreshes.has(current.id)) {
      return res.status(409).json({ error: { code: 'REFRESH_IN_PROGRESS', message: 'Design system đang được làm mới.' } });
    }
    activeRefreshes.add(current.id);
    setFigmaDesignSystemSourceRefreshState(db, current.id, { status: 'refreshing', updatedAt: now() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Figma catalogue refresh timed out')), deps.timeoutMs ?? 120_000);
    try {
      const config = await readFigmaConfig(deps.paths.RUNTIME_DATA_DIR);
      if (!config?.token) {
        const message = 'Chưa cấu hình Personal Access Token Figma trên máy này.';
        const source = setFigmaDesignSystemSourceRefreshState(db, current.id, { status: 'error', lastError: message, updatedAt: now() });
        return res.status(400).json({ error: { code: 'FIGMA_TOKEN_REQUIRED', message }, source: figmaDesignSystemSourceToContract(source!) });
      }
      const links = current.links.map((url) => ({ url, fileKey: fileKeyOf(url) }));
      const snapshot = await (deps.buildCatalog ?? buildFigmaComponentCatalog)({
        token: config.token,
        links,
        signal: controller.signal,
        onProgress(progress) {
          refreshProgress.set(current.id, {
            completedFiles: progress.phase === 'done' ? progress.index : progress.index - 1,
            totalFiles: progress.total,
            phase: progress.phase,
            currentFileKey: progress.fileKey,
            ...(progress.name ? { currentFileName: progress.name } : {}),
          });
        },
      });
      const serialized = JSON.stringify(snapshot);
      const digest = createHash('sha256').update(serialized).digest('hex');
      const changes = diffFigmaComponentCatalogs(current.catalog as FigmaComponentCatalogSnapshot | null, snapshot);
      await writeFigmaDesignSystemComponents(deps.paths.RUNTIME_DATA_DIR, current.id, snapshot);
      const source = commitFigmaDesignSystemSourceCatalog(db, current.id, { catalog: snapshot, digest, updatedAt: now() });
      // WP23a mục 4: fire-and-forget SAU KHI commit catalog thành công — job
      // sinh mô tả (chạy sau, riêng lượt) đọc thẳng cache này qua imageCache,
      // không tự tải ảnh trong lúc chạy nữa (gỡ điểm flaky "Figma phản hồi
      // quá lâu"). KHÔNG await — không được ảnh hưởng timeout 120s của chính
      // route /refresh này.
      prefetchComponentImages(current.id, snapshot, config.token, deps.paths.RUNTIME_DATA_DIR);
      // WP-ds-tokens: đào token de-facto — cùng lý do fire-and-forget của
      // prefetchComponentImages ngay ở trên (phụ phẩm, không được ảnh hưởng
      // timeout 120s của route này; lỗi mining chỉ console.warn bên trong).
      mineAndWriteFigmaDesignSystemTokens(current.id, snapshot, config.token, deps.paths.RUNTIME_DATA_DIR);
      res.json({ source: figmaDesignSystemSourceToContract(source!), changes });
    } catch (error) {
      const message = controller.signal.aborted ? 'Hết thời gian chờ Figma phản hồi.' : describeFigmaError(error);
      const source = setFigmaDesignSystemSourceRefreshState(db, current.id, { status: 'error', lastError: message, updatedAt: now() });
      res.status(502).json({ error: { code: controller.signal.aborted ? 'FIGMA_TIMEOUT' : 'FIGMA_REFRESH_FAILED', message }, source: figmaDesignSystemSourceToContract(source!) });
    } finally {
      clearTimeout(timer);
      activeRefreshes.delete(current.id);
      refreshProgress.delete(current.id);
    }
  });

  // ── WP20: nút "Sinh mô tả (N thiếu)" cho nguồn Figma DÙNG CHUNG — khuôn Y
  // HỆT job App-level (figma-catalog-routes.ts, WP19b): POST trả 202
  // {jobId, job} ngay, job chạy nền, UI poll GET job. Chống double-submit
  // theo SOURCE ID (không phải appId) — hai App gắn CÙNG nguồn bấm gần nhau
  // vẫn chỉ tạo một job cho nguồn đó, y hệt hai lần check existing/raced
  // quanh resolveAgent của khuôn gốc.
  const figmaGuideJobs = new Map<string, FigmaDesignSystemGuideJobState>();
  const figmaGuideJobBySource = new Map<string, string>();

  const toGuideJobResponse = (job: FigmaDesignSystemGuideJobState): FigmaDesignSystemGuideJob => {
    const items = [...job.items.values()];
    return {
      id: job.id,
      status: job.status,
      message: job.message,
      generated: job.generated,
      rejected: job.rejected,
      remaining: job.remaining,
      // WP23a mục 3: tính LIVE từ job.items (không phải một counter riêng) —
      // item 'skipped' được đánh ngay khi job bắt đầu (trước cả chunk đầu
      // tiên), nên luôn đúng dù job vẫn 'running'.
      skipped: items.filter((item) => item.status === 'skipped').length,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      // WP21a: snapshot Map items → mảng LÚC SERIALIZE (job.items đổi live qua
      // callback onItemStatus mỗi khi trạng thái một comp đổi) — GET job vì vậy
      // luôn trả trạng thái mới nhất tại thời điểm poll.
      items,
      remainingAfterCap: job.remainingAfterCap,
    };
  };

  const startFigmaDesignSystemGuideJob = (
    sourceId: string,
    snapshot: FigmaComponentCatalogSnapshot,
    token: string,
    execution: { agentId: string; modelPrefs: { model?: string | null; reasoning?: string | null } },
  ): FigmaDesignSystemGuideJobState => {
    const nowIso = () => new Date().toISOString();
    const rowNow = Date.now();
    const projectId = `figma-guide-source-${sourceId}`;
    // Thư mục riêng theo job id — cạnh criteria/ của nguồn, tự dọn ở finally
    // (kho nguồn `components-guide.md` mới là nơi lưu kết quả lâu dài).
    const describeDir = path.join(
      path.dirname(figmaDesignSystemGuidePath(deps.paths.RUNTIME_DATA_DIR, sourceId)),
      '_describe',
      randomUUID(),
    );

    const existingProject = getProject(db, projectId);
    if (!existingProject) {
      insertProject(db, {
        id: projectId,
        name: `Sinh mô tả component (nguồn dùng chung) · ${sourceId}`,
        skillId: null,
        designSystemId: null,
        pendingPrompt: null,
        metadata: { kind: 'figma-guide-source', baseDir: describeDir, sourceId },
        createdAt: rowNow,
        updatedAt: rowNow,
      });
    } else {
      updateProject(db, projectId, {
        metadata: { ...(existingProject.metadata ?? {}), kind: 'figma-guide-source', baseDir: describeDir, sourceId },
      });
    }

    const job: FigmaDesignSystemGuideJobState = {
      id: randomUUID(),
      sourceId,
      status: 'queued',
      message: 'Đã xếp hàng',
      generated: 0,
      rejected: 0,
      remaining: 0,
      remainingAfterCap: 0,
      items: new Map(),
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      // WP23a mục 5: dùng bởi GET /api/figma-guide-jobs/active (số nguyên,
      // không parse lại createdAt/updatedAt ISO mỗi lần liệt kê).
      startedAtMs: rowNow,
    };
    figmaGuideJobs.set(job.id, job);
    figmaGuideJobBySource.set(sourceId, job.id);
    const touch = () => { job.updatedAt = nowIso(); };

    // Một hội thoại DUY NHẤT cho cả job — giữ ĐÚNG hành vi/thời điểm tạo của
    // bản trước WP21a (tạo NGAY, đồng bộ, trước khi job async bắt đầu chạy).
    // Từng thử tách hội thoại RIÊNG theo từng nhóm trang (lười, tạo bên
    // trong closure `runAgentChunk`) để 3 nhóm chạy song song (concurrency=3
    // bên dưới) không xen lượt agent vào CÙNG một hội thoại của
    // `runDescribeChunk` (figma-catalog-routes.ts, không sửa được — giả định
    // "nhiều lượt = nhiều run NỐI TIẾP trong CÙNG hội thoại") — nhưng việc
    // đó dời thời điểm gọi `insertConversation` sang SAU nhiều `await`, tạo
    // race với `afterEach` đóng DB giữa các test (lộ ra ở test hiện có "GET
    // /generate-guide/:jobId…" — ENOTEMPTY vì job mồ côi của test trước vẫn
    // ghi file sau khi DB/thư mục test đó đã bị dọn). Quay lại MỘT hội
    // thoại, giữ đúng bất biến gốc — theo dõi xen lượt thật giữa 3 nhóm song
    // song (nếu phát sinh vấn đề thật khi vận hành) là việc của backlog,
    // không phải scope WP21a.
    const groupKeyOfKind = (fileKey: string, page: string | undefined, kind: 'asset' | 'normal') => `${fileKey} ${page ?? ''} ${kind}`;
    const conversationId = `figma-guide-source-conv-${randomUUID()}`;
    insertConversation(db, {
      id: conversationId,
      projectId,
      title: `Sinh mô tả component · ${new Date(rowNow).toLocaleString('vi-VN')}`,
      createdAt: rowNow,
      updatedAt: rowNow,
    });

    void (async () => {
      job.status = 'running';
      job.message = 'Đang tính danh sách component thiếu mô tả…';
      touch();
      try {
        const existingGuideMd = await readFigmaDesignSystemGuide(deps.paths.RUNTIME_DATA_DIR, sourceId);
        const missingList = computeMissingDescriptions(snapshot, existingGuideMd);
        if (missingList.length === 0) {
          job.status = 'succeeded';
          job.finishedAtMs = Date.now();
          job.message = 'Không có gì để sinh — mọi component đã có mô tả.';
          touch();
          return;
        }
        // Tra `name`/`page` cho items[] từ callback onItemStatus (callback chỉ
        // truyền `anchor`) — nút "Sinh mô tả" KHÔNG cap (xem `cap: null` bên
        // dưới) nên `missingList` ĐÚNG BẰNG tập comp thật sự được xử lý, dùng
        // được luôn để suy ra tổng số lượt của TỪNG nhóm cho kickoff message.
        const missingByAnchor = new Map(missingList.map((m) => [m.anchor, { name: m.name, page: m.page }] as const));
        // WP23a: bỏ item tên rác (isJunkComponentName) khỏi ước lượng số lượt —
        // chúng bị bypass 'skipped' NGAY, không bao giờ vào một chunk nào (xem
        // generateComponentDescriptions), tính chúng vào đây sẽ thổi phồng
        // totalChunks hiển thị trong kickoff message của agent.
        const groupTotalChunks = new Map<string, number>();
        {
          const counts = new Map<string, number>();
          for (const item of missingList) {
            if (isJunkComponentName(item.name)) continue;
            const kind = classifyComponentKind(item.page, item.name);
            const key = groupKeyOfKind(item.fileKey, item.page, kind);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          for (const [key, count] of counts) {
            const size = key.endsWith(' asset') ? 100 : 12;
            groupTotalChunks.set(key, Math.ceil(count / size));
          }
        }
        let chunkCounter = 0;
        const imagesDir = figmaDesignSystemImagesDir(deps.paths.RUNTIME_DATA_DIR, sourceId);
        const result = await generateComponentDescriptions(snapshot, existingGuideMd, {
          baseDir: describeDir,
          // WP21a (người dùng chốt 2026-08-20): nút "Sinh mô tả" phải sinh
          // ĐỦ TOÀN BỘ comp thiếu trong MỘT lần bấm — không cap, fan-out 3
          // nhóm trang song song. Vòng sinh bù dr-comp (server.ts, gọi
          // generateComponentDescriptions TRỰC TIẾP, không qua route này)
          // KHÔNG truyền cap/concurrency nên vẫn giữ mặc định cũ (60, tuần
          // tự) — không cần và không được sửa server.ts.
          cap: null,
          concurrency: 3,
          fetchTree: (fileKey, ids) => fetchNodeSubtrees(token, fileKey, ids),
          fetchImages: (fileKey, ids) => fetchNodeImages(token, fileKey, ids),
          downloadImage: (url, destPath) => downloadFigmaImage(url, destPath),
          // WP23a mục 1.d/2.b: chunk 'normal' đọc cache ảnh đã prefetch (sau
          // refresh, xem prefetchComponentImages) TRƯỚC khi gọi REST — nguồn
          // dùng chung có tới ~600 component, tải ảnh giữa lúc job chạy là
          // đúng điểm flaky "Figma phản hồi quá lâu" cũ.
          imageCache: {
            pathFor: (anchor) => path.join(imagesDir, `${anchor}.png`),
            has: (anchor) => fs.promises.access(path.join(imagesDir, `${anchor}.png`)).then(() => true).catch(() => false),
          },
          runAgentChunk: async (input, chunkDir, index, group) => {
            chunkCounter = Math.max(chunkCounter, index + 1);
            const isAssetChunk = input.components.length > 0 && 'kind' in input.components[0]! && input.components[0]!.kind === 'asset';
            const totalChunks = groupTotalChunks.get(groupKeyOfKind(group.fileKey, group.page, isAssetChunk ? 'asset' : 'normal')) ?? 1;
            return runDescribeChunk(
              { design: deps.design, startChatRun: deps.chat.startChatRun, db: deps.db, getAgentDef: deps.agents?.getAgentDef },
              { projectId, conversationId, chunkDir, index, totalChunks, execution },
            );
          },
          onProgress: (info) => { job.message = info.note; touch(); },
          // WP21a: dựng items[] từ callback — Map anchor→item, snapshot vào
          // job state (job.items) mỗi lần một comp đổi trạng thái; GET job
          // (toGuideJobResponse) đọc lại Map này mỗi lần poll. WP23a: `status`
          // giờ có thêm 'skipped' (tên rác) — callback không cần đổi gì, mọi
          // status đều đi qua CÙNG đường gán này.
          onItemStatus: (anchor, status, reason) => {
            const known = missingByAnchor.get(anchor);
            const existingItem = job.items.get(anchor);
            const name = known?.name ?? existingItem?.name ?? '';
            const page = known?.page ?? existingItem?.page;
            job.items.set(anchor, { anchor, name, ...(page ? { page } : {}), status, ...(reason !== undefined ? { reason } : {}) });
            touch();
          },
        });
        await writeFigmaDesignSystemGuide(deps.paths.RUNTIME_DATA_DIR, sourceId, result.guideMarkdown);
        job.status = 'succeeded';
        job.finishedAtMs = Date.now();
        job.generated = result.generated;
        job.rejected = result.rejected;
        job.remaining = result.remaining;
        // WP21a: nút "Sinh mô tả" không cap (cap: null ở trên) nên
        // result.remaining luôn 0 — remainingAfterCap CHỈ còn ý nghĩa cho
        // vòng sinh bù dr-comp (cap 60, không đi qua field JSON này). Giữ
        // đồng bộ với `remaining` thay vì hard-code 0 để không rời khỏi kết
        // quả thật của engine nếu sau này route này đổi cap.
        job.remainingAfterCap = result.remaining;
        job.message = result.chunkErrors.length > 0
          ? `Đã sinh ${result.generated} mô tả (loại ${result.rejected}, còn ${result.remaining} chưa xử lý) — ${result.chunkErrors.length}/${chunkCounter} lượt lỗi, đã bỏ qua.`
          : `Đã sinh ${result.generated} mô tả, loại ${result.rejected}, còn ${result.remaining} chưa xử lý.`;
        touch();
      } catch (error: any) {
        const detail = String(error && error.message ? error.message : error);
        job.status = 'failed';
        job.finishedAtMs = Date.now();
        job.error = detail;
        job.message = detail;
        touch();
        console.warn(`[figma-design-system-guide] sinh mô tả cho nguồn "${sourceId}" thất bại:`, detail);
      } finally {
        // WP21a: ghi components-guide.meta.json khi JOB KẾT THÚC — kể cả
        // partial/failed (contract mục 3) — để GET detail vẫn hiện được kết
        // quả lượt gần nhất sau khi daemon restart (figmaGuideJobs chỉ sống
        // trong bộ nhớ). Tính từ `job.items` (trạng thái CUỐI của TỪNG comp)
        // thay vì job.generated/job.rejected: hai field đó chỉ được gán ở
        // nhánh THÀNH CÔNG, không phản ánh đúng khi job.status === 'failed'
        // (generateComponentDescriptions throw) — nhưng job.items đã đúng
        // trong CẢ hai trường hợp vì mọi item của một chunk lỗi được đánh
        // 'failed' TRƯỚC KHI throw (xem catch trong figma-guide-generate.ts).
        //
        // WP21-fix điểm 2 (review WP21a): CHỈ ghi khi engine THẬT SỰ chạy —
        // `job.items` có ít nhất 1 item, tức generateComponentDescriptions đã
        // gọi onItemStatus ít nhất một lần (chunk đầu tiên đã 'queued'/
        // 'running'…). Job kết thúc SỚM trước khi engine chạy (nhánh
        // `missingList.length === 0` ở trên — "Không có gì để sinh", hoặc lỗi
        // ném ra TRƯỚC generateComponentDescriptions, ví dụ readFigmaDesignSystemGuide
        // throw) thì `job.items` rỗng — KHÔNG được ghi đè file meta cũ bằng
        // zeros, vì đó không phải một lượt sinh thật, chỉ là job rỗng.
        const finishedItems = [...job.items.values()];
        if (finishedItems.length > 0) {
          const failures = finishedItems
            .filter((item) => item.status === 'failed')
            .map((item) => ({ anchor: item.anchor, name: item.name, reason: item.reason ?? '' }));
          const generatedCount = finishedItems.filter((item) => item.status === 'succeeded').length;
          // WP23a mục 3: đếm 'skipped' (tên rác, bypass — xem
          // figma-guide-generate.ts) riêng, không lẫn vào `failed`.
          const skippedCount = finishedItems.filter((item) => item.status === 'skipped').length;
          await writeFigmaDesignSystemGuideMeta(deps.paths.RUNTIME_DATA_DIR, sourceId, {
            finishedAt: new Date().toISOString(),
            generated: generatedCount,
            failed: failures.length,
            failures,
            skipped: skippedCount,
          }).catch((err) => {
            console.warn(`[figma-design-system-guide] ghi components-guide.meta.json cho nguồn "${sourceId}" thất bại:`, err);
          });
        }
        await fs.promises.rm(describeDir, { recursive: true, force: true }).catch(() => {});
      }
    })();

    return job;
  };

  app.post('/api/figma-design-systems/:id/generate-guide', async (req, res) => {
    if (!guard(req, res)) return;
    const current = getFigmaDesignSystemSource(db, req.params.id);
    if (!current) return notFound(res);
    const existingId = figmaGuideJobBySource.get(current.id);
    const existing = existingId ? figmaGuideJobs.get(existingId) : undefined;
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return res.status(202).json({ jobId: existing.id, job: toGuideJobResponse(existing) });
    }
    const snapshot = current.catalog as FigmaComponentCatalogSnapshot | null;
    if (!snapshot) {
      return res.status(409).json({ error: { code: 'CATALOG_REQUIRED', message: 'Nguồn chưa có danh mục component — làm mới trước khi sinh mô tả.' } });
    }
    try {
      const cfg = await readFigmaConfig(deps.paths.RUNTIME_DATA_DIR);
      if (!cfg?.token) {
        return res.status(400).json({ error: { code: 'FIGMA_TOKEN_REQUIRED', message: 'Chưa có token Figma trên máy này.' } });
      }
      if (typeof deps.agents?.resolveAgent !== 'function') {
        return res.status(501).json({ error: { code: 'AGENT_UNAVAILABLE', message: 'Chưa cấu hình agent cho việc sinh mô tả.' } });
      }
      const execution = await deps.agents.resolveAgent();
      // resolveAgent async (đọc app-config, detect agent) — re-check sau khi
      // await để hai POST gần nhau (race) không tạo hai job song song.
      const racedId = figmaGuideJobBySource.get(current.id);
      const raced = racedId ? figmaGuideJobs.get(racedId) : undefined;
      if (raced && (raced.status === 'queued' || raced.status === 'running')) {
        return res.status(202).json({ jobId: raced.id, job: toGuideJobResponse(raced) });
      }
      const job = startFigmaDesignSystemGuideJob(current.id, snapshot, cfg.token, execution);
      const body: GenerateFigmaDesignSystemGuideResponse = { jobId: job.id, job: toGuideJobResponse(job) };
      res.status(202).json(body);
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL', message: String(err && err.message ? err.message : err) } });
    }
  });

  app.get('/api/figma-design-systems/:id/generate-guide/:jobId', (req, res) => {
    if (!guard(req, res)) return;
    const job = figmaGuideJobs.get(req.params.jobId);
    if (!job || job.sourceId !== req.params.id) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'job not found' } });
    }
    res.json({ job: toGuideJobResponse(job) });
  });

  // ── WP23a mục 5: GET /api/figma-guide-jobs/active — re-attach cross-source.
  // Path CỐ Ý không nằm dưới /figma-design-systems/:id (job có thể thuộc BẤT
  // KỲ nguồn nào — hook web hỏi TRƯỚC khi biết sourceId nào có job) — Express
  // khớp theo path chữ nguyên văn ("figma-guide-jobs" khác "figma-design-
  // systems"), không đụng route pattern nào khác trong file này.
  app.get('/api/figma-guide-jobs/active', (req, res) => {
    if (!guard(req, res)) return;
    const nowMs = now();
    const jobs: FigmaGuideActiveJob[] = [];
    for (const job of [...figmaGuideJobs.values()]) {
      const isFinished = job.status === 'succeeded' || job.status === 'failed';
      if (isFinished && job.finishedAtMs !== undefined && nowMs - job.finishedAtMs > ACTIVE_GUIDE_JOB_RETENTION_MS) {
        // Dọn lười: job kết thúc >10' trước bị loại khỏi registry ở ĐÂY (lần
        // GET active kế tiếp) — GET-by-jobId cho job này 404 sau đó, kết quả
        // đã persist ở components-guide.meta.json (đúng contract mục 5).
        figmaGuideJobs.delete(job.id);
        if (figmaGuideJobBySource.get(job.sourceId) === job.id) figmaGuideJobBySource.delete(job.sourceId);
        continue;
      }
      const items = [...job.items.values()];
      jobs.push({
        jobId: job.id,
        sourceId: job.sourceId,
        status: job.status,
        done: items.filter((item) => item.status === 'succeeded' || item.status === 'failed' || item.status === 'skipped').length,
        total: items.length,
        startedAt: job.startedAtMs,
        ...(job.finishedAtMs !== undefined ? { finishedAt: job.finishedAtMs } : {}),
      });
    }
    const body: ListActiveFigmaGuideJobsResponse = { jobs };
    res.json(body);
  });
}

// WP23a mục 5: dọn lười — job kết thúc >10' trước bị loại khỏi registry lần
// GET /active kế tiếp.
const ACTIVE_GUIDE_JOB_RETENTION_MS = 10 * 60 * 1000;

/* ── WP20/WP21a internals: job state (khuôn FigmaGuideJobState App-level) ── */
interface FigmaDesignSystemGuideJobState {
  id: string;
  sourceId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  message: string;
  generated: number;
  rejected: number;
  remaining: number;
  /** WP21a: xem `FigmaDesignSystemGuideJob.remainingAfterCap` — job từ nút
   *  "Sinh mô tả" không cap nên field này luôn 0 (nhưng vẫn gán từ
   *  `result.remaining` thật, không hard-code, xem call site). */
  remainingAfterCap: number;
  /** WP21a: Map anchor→trạng thái, đổi LIVE qua callback `onItemStatus`
   *  (generateComponentDescriptions) — toGuideJobResponse snapshot Map này
   *  thành mảng mỗi lần GET job được gọi. */
  items: Map<string, FigmaDesignSystemGuideJobItem>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** WP23a mục 5: dùng bởi GET /api/figma-guide-jobs/active — số nguyên
   *  (epoch ms), tách khỏi `createdAt`/`updatedAt` (ISO string, giữ nguyên
   *  cho tương thích ngược) để route active không phải parse lại mỗi lần. */
  startedAtMs: number;
  /** Gán khi job đạt trạng thái cuối ('succeeded'/'failed') — dùng để dọn lười
   *  registry + trả `finishedAt` cho GET /active. */
  finishedAtMs?: number;
}
