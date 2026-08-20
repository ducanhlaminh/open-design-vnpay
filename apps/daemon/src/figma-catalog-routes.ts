// App-level Figma component catalogue — what the App's DS tab shows when the
// component source is "Link Figma". Stored under
// `<PROJECTS_DIR>/<appId>/figma-catalog/components.{json,md}` (same snapshot
// shape the dr-comp preparation phase freezes into a workflow dir; that
// phase also refreshes this copy so the tab never lags a run).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { AppFigmaCatalogResponse, AppFigmaGuideJob, DocsReviewComponentSource } from '@open-design/contracts';

import { getPipelineApp, getProject, insertConversation, insertProject, updateProject, upsertMessage } from './db.js';
import { readFigmaConfig } from './figma-config.js';
import { renderFigmaComponentsMarkdown, type FigmaComponentCatalogSnapshot } from './figma-component-catalog.js';
import { buildFigmaComponentCatalog, fetchNodeImages, fetchNodeSubtrees } from './figma-rest.js';
import { computeGuideCoverage, computeMissingDescriptions, generateComponentDescriptions } from './figma-guide-generate.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterFigmaCatalogRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'design' | 'chat' | 'agents'> {}

export function appFigmaCatalogDir(projectsDir: string, appId: string): string {
  return path.join(projectsDir, appId, 'figma-catalog');
}

const appCatalogWrites = new Map<string, Promise<void>>();

function serializeAppCatalogWrite(key: string, task: () => Promise<void>): Promise<void> {
  const previous = appCatalogWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  appCatalogWrites.set(key, current);
  return current.finally(() => {
    if (appCatalogWrites.get(key) === current) appCatalogWrites.delete(key);
  });
}

/** Persist a snapshot as the App's catalogue (json + rendered markdown).
 *  Atomic per file (tmp → rename). Shared with the dr-comp fan-out. */
export async function writeAppFigmaCatalog(projectsDir: string, appId: string, snapshot: FigmaComponentCatalogSnapshot): Promise<void> {
  const dir = appFigmaCatalogDir(projectsDir, appId);
  return serializeAppCatalogWrite(dir, async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    const generation = randomUUID();
    const jsonTmp = path.join(dir, `components.${generation}.json.tmp`);
    const mdTmp = path.join(dir, `components.${generation}.md.tmp`);
    try {
      await fs.promises.writeFile(jsonTmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await fs.promises.writeFile(mdTmp, renderFigmaComponentsMarkdown(snapshot), 'utf8');
      // Markdown first, JSON last: components.json is the commit marker.
      await fs.promises.rename(mdTmp, path.join(dir, 'components.md'));
      await fs.promises.rename(jsonTmp, path.join(dir, 'components.json'));
    } finally {
      await Promise.all([
        fs.promises.rm(jsonTmp, { force: true }),
        fs.promises.rm(mdTmp, { force: true }),
      ]);
    }
  });
}

/** Persist the App-level fallback description guide (WP19a — hạ tầng; nội
 *  dung do WP-B sinh sau). Atomic (tmp → rename), và dùng CHUNG khoá ghi với
 *  {@link writeAppFigmaCatalog} (cùng `dir`) — guide và catalog.json/md sống
 *  cạnh nhau trong cùng thư mục App, hai bên không được ghi chồng nhau. */
export async function writeAppComponentsGuide(projectsDir: string, appId: string, markdown: string): Promise<void> {
  const dir = appFigmaCatalogDir(projectsDir, appId);
  return serializeAppCatalogWrite(dir, async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `components-guide.${randomUUID()}.md.tmp`);
    try {
      await fs.promises.writeFile(tmp, markdown, 'utf8');
      await fs.promises.rename(tmp, path.join(dir, 'components-guide.md'));
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  });
}

/** Read the App-level fallback description guide, or `null` if the App
 *  never had one written (old projects, or WP-B never ran — same "guide
 *  missing" fallback shape as `readAppFigmaCatalog` returning `null`). */
export async function readAppComponentsGuide(projectsDir: string, appId: string): Promise<string | null> {
  const dir = appFigmaCatalogDir(projectsDir, appId);
  return fs.promises.readFile(path.join(dir, 'components-guide.md'), 'utf8').catch(() => null);
}

export async function readAppFigmaCatalog(projectsDir: string, appId: string): Promise<{ snapshot: FigmaComponentCatalogSnapshot; markdown: string | null } | null> {
  const dir = appFigmaCatalogDir(projectsDir, appId);
  const raw = await fs.promises.readFile(path.join(dir, 'components.json'), 'utf8').catch(() => null);
  if (raw == null) return null;
  try {
    const snapshot = JSON.parse(raw) as FigmaComponentCatalogSnapshot;
    if (!snapshot || !Array.isArray(snapshot.files)) return null;
    const storedMarkdown = await fs.promises.readFile(path.join(dir, 'components.md'), 'utf8').catch(() => null);
    const renderedMarkdown = renderFigmaComponentsMarkdown(snapshot);
    // A reader can land between the two renames. JSON is the commit marker,
    // so never return Markdown from another generation.
    const markdown = storedMarkdown === renderedMarkdown ? storedMarkdown : renderedMarkdown;
    return { snapshot, markdown };
  } catch {
    return null;
  }
}

function toResponse(
  source: DocsReviewComponentSource,
  hasToken: boolean,
  stored: { snapshot: FigmaComponentCatalogSnapshot; markdown: string | null } | null,
  guideMarkdown: string | null,
): AppFigmaCatalogResponse {
  const files = stored?.snapshot.files.map((file) => ({
    fileKey: file.fileKey,
    name: file.name,
    url: file.url,
    componentCount: file.components.length,
  })) ?? [];
  return {
    links: source.mode === 'figma-links' ? source.links : null,
    hasToken,
    generatedAt: stored?.snapshot.generatedAt ?? null,
    files,
    componentCount: files.reduce((sum, file) => sum + file.componentCount, 0),
    markdown: stored?.markdown ?? null,
    // Optional field (contract WP19a): omit the key entirely rather than
    // sending `null` when the App has no guide yet, so the response shape
    // for every project that predates this field stays byte-for-byte
    // identical to before (existing exact-match tests/clients unaffected).
    ...(guideMarkdown != null ? { guideMarkdown } : {}),
    // WP19b: coverage only makes sense once there is a snapshot to count
    // against — omit (not zeroed) before the first read, same "optional
    // field" contract as guideMarkdown above.
    ...(stored ? { coverage: computeGuideCoverage(stored.snapshot, guideMarkdown) } : {}),
  };
}

export function registerFigmaCatalogRoutes(app: Express, ctx: RegisterFigmaCatalogRoutesDeps) {
  const { isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { PROJECTS_DIR, RUNTIME_DATA_DIR } = ctx.paths;
  const db = ctx.db;

  const resolveApp = (rawId: unknown): { id: string; source: DocsReviewComponentSource } | null => {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) return null;
    const row = getPipelineApp(db, id) as { docsReviewComponentSource?: DocsReviewComponentSource } | null | undefined;
    if (!row) return null;
    return { id, source: row.docsReviewComponentSource ?? { mode: 'app-design-system' } };
  };

  app.get('/api/pipelines/apps/:appId/figma-catalog', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const target = resolveApp(req.params.appId);
    if (!target) return res.status(404).json({ error: `app "${String(req.params.appId)}" not found` });
    try {
      const [cfg, stored, guideMarkdown] = await Promise.all([
        readFigmaConfig(RUNTIME_DATA_DIR),
        readAppFigmaCatalog(PROJECTS_DIR, target.id),
        readAppComponentsGuide(PROJECTS_DIR, target.id),
      ]);
      res.json(toResponse(target.source, Boolean(cfg?.token), stored, guideMarkdown));
    } catch (err: any) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/pipelines/apps/:appId/figma-catalog/refresh', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const target = resolveApp(req.params.appId);
    if (!target) return res.status(404).json({ error: `app "${String(req.params.appId)}" not found` });
    if (target.source.mode !== 'figma-links' || target.source.links.length === 0) {
      return res.status(400).json({ error: 'App này không dùng nguồn Link Figma.' });
    }
    try {
      const cfg = await readFigmaConfig(RUNTIME_DATA_DIR);
      if (!cfg?.token) {
        return res.status(400).json({ error: 'Chưa có token Figma. Mở Sửa dự án → Nguồn đối chiếu component → dán Personal Access Token.' });
      }
      const snapshot = await buildFigmaComponentCatalog({ token: cfg.token, links: target.source.links });
      await writeAppFigmaCatalog(PROJECTS_DIR, target.id, snapshot);
      const [stored, guideMarkdown] = await Promise.all([
        readAppFigmaCatalog(PROJECTS_DIR, target.id),
        readAppComponentsGuide(PROJECTS_DIR, target.id),
      ]);
      res.json(toResponse(target.source, true, stored, guideMarkdown));
    } catch (err: any) {
      res.status(502).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  // ── WP19b: nút "Sinh mô tả (N thiếu)" của tab Design System ─────────────
  //
  // Khuôn job THEO ĐÚNG `dsCriteriaJobs` (server.ts, ~dòng 7361-7600): POST
  // trả 202 {jobId, job} ngay, job chạy nền (không await ở request handler),
  // UI poll GET job. Khác `dsCriteriaJobs` ở chỗ MỘT job có thể spawn NHIỀU
  // lượt agent tuần tự (một lượt/chunk 12 component, tối đa 5 lượt = cap
  // 60/click) trong CÙNG một conversation, thay vì một agent run duy nhất.
  //
  // Chống double-submit: `figmaGuideJobByApp` giữ id job GẦN NHẤT theo appId.
  // Cả nhánh nhanh (existing, trước khi resolveAgent — network/IO) LẪN nhánh
  // sau khi đã await resolveAgent đều re-check map (giống hệt hai lần check
  // existing/raced của dsCriteriaJobs) — resolveAgent có thể mất vài trăm ms
  // (đọc app-config, detect agent), đủ để hai request POST gần nhau lọt qua
  // check đầu nếu chỉ check một lần.
  const figmaGuideJobs = new Map<string, FigmaGuideJobState>();
  const figmaGuideJobByApp = new Map<string, string>();

  const toGuideJobResponse = (job: FigmaGuideJobState): AppFigmaGuideJob => ({
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

  const startFigmaGuideJob = (
    appId: string,
    snapshot: FigmaComponentCatalogSnapshot,
    token: string,
    execution: { agentId: string; modelPrefs: { model?: string | null; reasoning?: string | null } },
  ): FigmaGuideJobState => {
    const now = () => new Date().toISOString();
    const rowNow = Date.now();
    const projectId = `figma-guide-${appId}`;
    const catalogDir = appFigmaCatalogDir(PROJECTS_DIR, appId);
    // Thư mục riêng theo job id: tránh hai lần bấm liên tiếp (job trước vừa
    // xong, job sau bắt đầu) giẫm lên input/output/ảnh của nhau, và dọn sạch
    // gọn — xong việc xoá cả thư mục (finally bên dưới), guide App-level
    // (components-guide.md) mới là nơi lưu kết quả lâu dài.
    const describeDir = path.join(catalogDir, '_describe', randomUUID());

    const existingProject = getProject(db, projectId);
    if (!existingProject) {
      insertProject(db, {
        id: projectId,
        name: `Sinh mô tả component · ${appId}`,
        skillId: null,
        designSystemId: null,
        pendingPrompt: null,
        metadata: { kind: 'figma-guide', baseDir: describeDir, appId },
        createdAt: rowNow,
        updatedAt: rowNow,
      });
    } else {
      updateProject(db, projectId, {
        metadata: { ...(existingProject.metadata ?? {}), kind: 'figma-guide', baseDir: describeDir, appId },
      });
    }
    const conversationId = `figma-guide-conv-${randomUUID()}`;
    insertConversation(db, {
      id: conversationId,
      projectId,
      title: `Sinh mô tả component · ${new Date(rowNow).toLocaleString('vi-VN')}`,
      createdAt: rowNow,
      updatedAt: rowNow,
    });

    const job: FigmaGuideJobState = {
      id: randomUUID(),
      appId,
      status: 'queued',
      message: 'Đã xếp hàng',
      generated: 0,
      rejected: 0,
      remaining: 0,
      error: null,
      createdAt: now(),
      updatedAt: now(),
      projectId,
      conversationId,
    };
    figmaGuideJobs.set(job.id, job);
    figmaGuideJobByApp.set(appId, job.id);
    const touch = () => { job.updatedAt = now(); };

    void (async () => {
      job.status = 'running';
      job.message = 'Đang tính danh sách component thiếu mô tả…';
      touch();
      try {
        const existingGuideMd = await readAppComponentsGuide(PROJECTS_DIR, appId);
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
            return runDescribeChunk({ design: ctx.design, startChatRun: ctx.chat.startChatRun, db: ctx.db, getAgentDef: ctx.agents?.getAgentDef }, {
              projectId,
              conversationId,
              chunkDir,
              index,
              totalChunks: Math.ceil(missingCount / 12),
              execution,
            });
          },
          onProgress: (info) => { job.message = info.note; touch(); },
        });
        await writeAppComponentsGuide(PROJECTS_DIR, appId, result.guideMarkdown);
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
        console.warn(`[figma-guide] sinh mô tả cho app "${appId}" thất bại:`, detail);
      } finally {
        await fs.promises.rm(describeDir, { recursive: true, force: true }).catch(() => {});
      }
    })();

    return job;
  };

  app.post('/api/pipelines/apps/:appId/figma-catalog/generate-guide', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const target = resolveApp(req.params.appId);
    if (!target || target.source.mode !== 'figma-links') {
      return res.status(404).json({ error: `App "${String(req.params.appId)}" không tồn tại hoặc không dùng nguồn Link Figma.` });
    }
    const existingId = figmaGuideJobByApp.get(target.id);
    const existing = existingId ? figmaGuideJobs.get(existingId) : undefined;
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return res.status(202).json({ jobId: existing.id, job: toGuideJobResponse(existing) });
    }
    try {
      const stored = await readAppFigmaCatalog(PROJECTS_DIR, target.id);
      if (!stored) {
        return res.status(404).json({ error: 'Chưa có danh mục component — bấm "Đọc lại từ Figma" trước.' });
      }
      const cfg = await readFigmaConfig(RUNTIME_DATA_DIR);
      if (!cfg?.token) {
        return res.status(400).json({ error: 'Chưa có token Figma. Mở Sửa dự án → Nguồn đối chiếu component → dán Personal Access Token.' });
      }
      if (typeof ctx.agents?.resolveAgent !== 'function') {
        return res.status(501).json({ error: 'Chưa cấu hình agent cho việc sinh mô tả.' });
      }
      const execution = await ctx.agents.resolveAgent();
      // resolveAgent ở trên là async (đọc app-config, detect agent) — re-check
      // sau khi await để hai POST gần nhau (race) không tạo hai job song song.
      const racedId = figmaGuideJobByApp.get(target.id);
      const raced = racedId ? figmaGuideJobs.get(racedId) : undefined;
      if (raced && (raced.status === 'queued' || raced.status === 'running')) {
        return res.status(202).json({ jobId: raced.id, job: toGuideJobResponse(raced) });
      }
      const job = startFigmaGuideJob(target.id, stored.snapshot, cfg.token, execution);
      res.status(202).json({ jobId: job.id, job: toGuideJobResponse(job) });
    } catch (err: any) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.get('/api/pipelines/apps/:appId/figma-catalog/generate-guide/:jobId', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const job = figmaGuideJobs.get(req.params.jobId);
    if (!job || job.appId !== req.params.appId) {
      return res.status(404).json({ error: 'job not found' });
    }
    res.json({ job: toGuideJobResponse(job) });
  });
}

/* ── WP19b internals: job state + agent spawn (khuôn dsCriteriaJobs) ──────── */

interface FigmaGuideJobState {
  id: string;
  appId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  message: string;
  generated: number;
  rejected: number;
  remaining: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  conversationId: string;
}

const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Chặn ảnh quá khổ trước khi buffer hoá — S3 pre-signed URL không đáng tin
 *  100% (có thể trỏ nhầm asset khác, hoặc Figma trả ảnh render bất thường
 *  lớn). 15MB đủ rộng cho PNG component thường (vài trăm KB–vài MB), review
 *  điểm 4 `.tmp/pipeline/wp19b-fix.yaml`. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Tải một URL ảnh render Figma (S3, pre-signed, KHÔNG cần token Figma —
 *  đúng như mọi URL `GET /v1/images` trả về) về `destPath`. `false` (không
 *  throw) khi lỗi/timeout — caller (`generateComponentDescriptions`) coi đây
 *  là "ảnh lỗi", bỏ qua phần ảnh của component đó và vẫn sinh từ cây node
 *  (quyết định đã chốt — fail-soft, không fail cả chunk). KHÔNG log URL: nó
 *  có thể mang query string mang tính truy vết nội bộ Figma.
 *
 *  Cũng reject (trả `false`, cùng đường "ảnh hỏng" ở trên, KHÔNG throw) khi
 *  Content-Type không phải ảnh (`image/*`) hoặc kích thước vượt
 *  {@link MAX_IMAGE_BYTES} — kiểm `Content-Length` trước (khi server trả
 *  header này, tránh tải hết một file khổng lồ) RỒI kiểm lại `byteLength`
 *  thật sau khi tải xong (phòng server không gửi/gửi sai Content-Length).
 *
 *  Exported: dùng chung bởi job POST /generate-guide (trên) VÀ vòng sinh bù
 *  của dr-comp (server.ts, khối docs-comp prep, sau freeze) — "tái dùng hàm
 *  của job" theo quyết định đã chốt, không viết lại một bản tải-ảnh song
 *  song trong server.ts. */
export async function downloadFigmaImage(url: string, destPath: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) return false;
    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader != null) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) return false;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) return false;
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.writeFile(destPath, buffer);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Deps tối giản để chạy một lượt agent `figma-comp-describe` — tách khỏi
 *  {@link RegisterFigmaCatalogRoutesDeps} (Express `ctx` đầy đủ) để
 *  server.ts (khối docs-comp prep) gọi được bằng CHÍNH biến cục bộ của nó
 *  (`design`, `startChatRun`, `db`, `agentDeps.getAgentDef`) mà không cần
 *  dựng một `ctx` route giả. */
export interface DescribeChunkRunnerDeps {
  design: { runs: { create: (meta: Record<string, unknown>) => any; start: (run: any, factory: () => unknown) => void; wait: (run: any) => Promise<{ status: string }> } };
  startChatRun: (...args: any[]) => unknown;
  db: any;
  getAgentDef?: (agentId: string) => { name?: string } | null | undefined;
}

/** Chạy MỘT lượt agent (skill `figma-comp-describe`) cho một chunk, trong
 *  CÙNG conversation của job (nhiều lượt = nhiều run nối tiếp, giống một
 *  hội thoại nhiều lượt bình thường) — trả về nội dung thô của
 *  `output-<index>.json` sau khi agent kết thúc `succeeded`, throw nếu agent
 *  không đạt trạng thái đó hoặc không ghi ra file output (chunk đó bị bỏ,
 *  fail-soft ở tầng gọi — xem `generateComponentDescriptions`).
 *
 *  Exported cho cùng lý do với {@link downloadFigmaImage}: server.ts (khối
 *  docs-comp prep) tái dùng CHÍNH hàm này thay vì viết lại glue spawn-agent
 *  một lần nữa. */
export async function runDescribeChunk(
  deps: DescribeChunkRunnerDeps,
  opts: {
    projectId: string;
    conversationId: string;
    chunkDir: string;
    index: number;
    totalChunks: number;
    execution: { agentId: string; modelPrefs: { model?: string | null; reasoning?: string | null } };
  },
): Promise<string> {
  const { design, startChatRun, db, getAgentDef } = deps;
  const inputName = `input-${opts.index}.json`;
  const outputName = `output-${opts.index}.json`;
  const assistantMessageId = `figma-guide-assistant-${randomUUID()}`;
  const kickoff =
    `Áp skill "figma-comp-describe". cwd của bạn LÀ thư mục "_describe" (lượt ${opts.index + 1}/${opts.totalChunks}) — ` +
    `đọc "${inputName}" (+ ảnh PNG cạnh đó nếu field "image" khác null), sinh mô tả cho từng component, ` +
    `ghi ĐÚNG MỘT file "${outputName}" cùng thư mục theo shape [{anchor, description}]. Không sửa file nào khác.`;
  const run = design.runs.create({
    projectId: opts.projectId,
    conversationId: opts.conversationId,
    assistantMessageId,
    clientRequestId: `figma-guide-${randomUUID()}`,
    agentId: opts.execution.agentId,
  });
  upsertMessage(db, opts.conversationId, { id: `figma-guide-user-${run.id}`, role: 'user', content: kickoff });
  upsertMessage(db, opts.conversationId, {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    agentId: opts.execution.agentId,
    agentName: getAgentDef?.(opts.execution.agentId)?.name ?? opts.execution.agentId,
    runId: run.id,
    runStatus: 'queued',
    startedAt: Date.now(),
  });
  design.runs.start(run, () =>
    startChatRun(
      {
        agentId: opts.execution.agentId,
        projectId: opts.projectId,
        conversationId: opts.conversationId,
        assistantMessageId,
        clientRequestId: run.clientRequestId,
        skillId: 'figma-comp-describe',
        model: opts.execution.modelPrefs.model ?? null,
        reasoning: opts.execution.modelPrefs.reasoning ?? null,
        message: kickoff,
        systemPrompt:
          'Bạn đang chạy một job không có người ngồi cạnh. Không hỏi lại, không chờ input — chọn mặc định hợp lý và hoàn thành.',
      },
      run,
    ),
  );
  const final = await design.runs.wait(run);
  db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(final.status, Date.now(), assistantMessageId);
  if (final.status !== 'succeeded') {
    throw new Error(`Agent kết thúc với trạng thái "${final.status}".`);
  }
  return fs.promises.readFile(path.join(opts.chunkDir, outputName), 'utf8');
}
