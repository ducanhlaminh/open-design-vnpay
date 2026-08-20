import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type {
  FigmaDesignSystemSource,
  FigmaDesignSystemCatalogSummary,
  FigmaDesignSystemGuideJob,
  FigmaDesignSystemRefreshChanges,
  FigmaDesignSystemRefreshProgress,
  GenerateFigmaDesignSystemGuideResponse,
  GetFigmaDesignSystemSourceResponse,
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
import { computeGuideCoverage, computeMissingDescriptions, generateComponentDescriptions } from './figma-guide-generate.js';
import { buildFigmaComponentCatalog, describeFigmaError, fetchNodeImages, fetchNodeSubtrees } from './figma-rest.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterFigmaDesignSystemRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'design' | 'chat' | 'agents'> {
  buildCatalog?: typeof buildFigmaComponentCatalog;
  timeoutMs?: number;
  now?: () => number;
}

type SourceRow = NonNullable<ReturnType<typeof getFigmaDesignSystemSource>>;
const activeRefreshes = new Set<string>();
const refreshProgress = new Map<string, FigmaDesignSystemRefreshProgress>();

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
    const body: GetFigmaDesignSystemSourceResponse = {
      source: figmaDesignSystemSourceToContract(source),
      componentsMarkdown: await readFigmaDesignSystemComponents(deps.paths.RUNTIME_DATA_DIR, source.id, catalog),
      // WP20: optional fields — omit (not `null`/zeroed) khi chưa có gì, giữ
      // đúng "compatibility" đã chốt ở WP19a cho response này (client cũ
      // không thấy field lạ, không cần đổi shape mặc định).
      ...(guideMarkdown != null ? { guideMarkdown } : {}),
      ...(catalog ? { coverage: computeGuideCoverage(catalog, guideMarkdown) } : {}),
    };
    res.json(body);
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

  const toGuideJobResponse = (job: FigmaDesignSystemGuideJobState): FigmaDesignSystemGuideJob => ({
    id: job.id,
    status: job.status,
    message: job.message,
    generated: job.generated,
    rejected: job.rejected,
    remaining: job.remaining,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });

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
    const conversationId = `figma-guide-source-conv-${randomUUID()}`;
    insertConversation(db, {
      id: conversationId,
      projectId,
      title: `Sinh mô tả component · ${new Date(rowNow).toLocaleString('vi-VN')}`,
      createdAt: rowNow,
      updatedAt: rowNow,
    });

    const job: FigmaDesignSystemGuideJobState = {
      id: randomUUID(),
      sourceId,
      status: 'queued',
      message: 'Đã xếp hàng',
      generated: 0,
      rejected: 0,
      remaining: 0,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    figmaGuideJobs.set(job.id, job);
    figmaGuideJobBySource.set(sourceId, job.id);
    const touch = () => { job.updatedAt = nowIso(); };

    void (async () => {
      job.status = 'running';
      job.message = 'Đang tính danh sách component thiếu mô tả…';
      touch();
      try {
        const existingGuideMd = await readFigmaDesignSystemGuide(deps.paths.RUNTIME_DATA_DIR, sourceId);
        const missingCount = computeMissingDescriptions(snapshot, existingGuideMd).length;
        if (missingCount === 0) {
          job.status = 'succeeded';
          job.message = 'Không có gì để sinh — mọi component đã có mô tả.';
          touch();
          return;
        }
        let chunkCounter = 0;
        const result = await generateComponentDescriptions(snapshot, existingGuideMd, {
          baseDir: describeDir,
          fetchTree: (fileKey, ids) => fetchNodeSubtrees(token, fileKey, ids),
          fetchImages: (fileKey, ids) => fetchNodeImages(token, fileKey, ids),
          downloadImage: (url, destPath) => downloadFigmaImage(url, destPath),
          runAgentChunk: async (input, chunkDir, index) => {
            chunkCounter = index + 1;
            return runDescribeChunk(
              { design: deps.design, startChatRun: deps.chat.startChatRun, db: deps.db, getAgentDef: deps.agents?.getAgentDef },
              { projectId, conversationId, chunkDir, index, totalChunks: Math.ceil(missingCount / 12), execution },
            );
          },
          onProgress: (info) => { job.message = info.note; touch(); },
        });
        await writeFigmaDesignSystemGuide(deps.paths.RUNTIME_DATA_DIR, sourceId, result.guideMarkdown);
        job.status = 'succeeded';
        job.generated = result.generated;
        job.rejected = result.rejected;
        job.remaining = result.remaining;
        job.message = result.chunkErrors.length > 0
          ? `Đã sinh ${result.generated} mô tả (loại ${result.rejected}, còn ${result.remaining} chưa xử lý) — ${result.chunkErrors.length}/${chunkCounter} lượt lỗi, đã bỏ qua.`
          : `Đã sinh ${result.generated} mô tả, loại ${result.rejected}, còn ${result.remaining} chưa xử lý.`;
        touch();
      } catch (error: any) {
        const detail = String(error && error.message ? error.message : error);
        job.status = 'failed';
        job.error = detail;
        job.message = detail;
        touch();
        console.warn(`[figma-design-system-guide] sinh mô tả cho nguồn "${sourceId}" thất bại:`, detail);
      } finally {
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
}

/* ── WP20 internals: job state (khuôn FigmaGuideJobState App-level) ───────── */
interface FigmaDesignSystemGuideJobState {
  id: string;
  sourceId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  message: string;
  generated: number;
  rejected: number;
  remaining: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
