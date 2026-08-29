// docs-review reports — gom mọi bản xác nhận docs-review (dr-confirm) trên
// media store thành báo cáo tổng hợp cho trang "Phản hồi" (`/feedback`) của
// open-design web (wp-docs-review-confirm-v2, Executor K).
//
// Nguồn: mỗi folder media = một project (name == projectId). Trong folder:
//   docs-review-feedback/<install>/<confirmId>.json         → v1 (legacy, chỉ số dr-review)
//   docs-review-feedback/<install>/<confirmId>/report.json  → v2 (5 bước + output + comment)
//   docs-review-feedback/<install>/<confirmId>/outputs/<p>  → file output (mediaPath trong report)
//
// App của bản v1 (không có `app`) lấy từ `project.json` của folder
// (`studioConfig.appId/appName`, cùng nguồn remote-registry dùng); không có
// → `null` (UI hiện "Chưa gắn App"). Tên tính năng v1 = `project.json.name`
// hoặc projectId.
//
// Đọc là chậm (1 list folder + 1 list/folder + N download) nên cache in-memory
// 60 s; `?refresh=1` bỏ cache. Không bao giờ ném lỗi lên route: media không
// tới được → `storeReachable:false` + mảng rỗng (200) — giống
// readAllFeedbackSubmissions.

import type { Express, Request, Response } from 'express';
import path from 'node:path';
import type {
  DocsReviewAiOutcome,
  DocsReviewCompletedRow,
  DocsReviewFeedbackArtifactV2,
  DocsReviewReportAppRow,
  DocsReviewReportDetailResponse,
  DocsReviewReportHistoryEntry,
  DocsReviewReportSummary,
  DocsReviewReportsResponse,
  DocsReviewSkippedFile,
  DocsReviewStageReport,
  ScreenPlatformScope,
} from '@open-design/contracts';
import { MediaClient, mediaConfigFromEnv, type MediaFile } from './kg-sync/media-client.js';
import { studioConfigOf } from './kg-sync/push-dest.js';

const FEEDBACK_PREFIX = 'docs-review-feedback/';
const PROJECT_CONFIG_PATH = 'project.json';
export const DOCS_REVIEW_REPORTS_TTL_MS = 60_000;

/** Phần MediaClient collector cần — inject fake trong test, không gọi mạng. */
export type DocsReviewReportsMediaClient = Pick<MediaClient, 'listFolders' | 'listAllFiles' | 'downloadById'>;

interface ParsedV1 {
  schemaVersion: 1;
  confirmationId: string;
  installationId: string;
  user: string;
  confirmedAt: number;
  agent: { total: number; accepted: number; editedByUser: number; dismissed: number };
  userChanges: { total: number };
}

export interface DocsReviewReportRecord {
  projectId: string;
  confirmationId: string;
  installationId: string;
  user: string;
  confirmedAt: number;
  legacy: boolean;
  app: { id: string; name: string } | null;
  feature: { id: string; name: string };
  screenPlatform: ScreenPlatformScope | null;
  summary: DocsReviewReportSummary;
  /** Chỉ v2. */
  report: DocsReviewFeedbackArtifactV2 | null;
}

interface ProjectIndex {
  folderId: string;
  /** path → file (bản đầu tiên khi trùng path). */
  filesByPath: Map<string, MediaFile>;
}

export interface DocsReviewReportsSnapshot {
  storeReachable: boolean;
  records: DocsReviewReportRecord[];
  skippedFiles: DocsReviewSkippedFile[];
  projects: Map<string, ProjectIndex>;
  loadedAt: number;
  /** Client đã dùng để list — output() tải bằng đúng client này (id file gắn với nó). */
  client: DocsReviewReportsMediaClient | null;
}

// ── parse ───────────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function feedbackPathOf(filePath: string): { installationId: string; confirmationId: string; version: 1 | 2 } | null {
  if (!filePath.startsWith(FEEDBACK_PREFIX)) return null;
  const [installationId = '', second = '', third = '', ...more] = filePath.slice(FEEDBACK_PREFIX.length).split('/');
  if (!installationId || more.length) return null;
  if (!third && second.endsWith('.json') && second.length > 5) {
    return { installationId, confirmationId: second.slice(0, -5), version: 1 };
  }
  if (second && third === 'report.json') {
    return { installationId, confirmationId: second, version: 2 };
  }
  return null;
}

function parseV1(raw: unknown): ParsedV1 | null {
  if (!isObject(raw) || raw.schemaVersion !== 1) return null;
  if (!str(raw.confirmationId) || typeof raw.confirmedAt !== 'number' || !isObject(raw.agent)) return null;
  const agent = raw.agent;
  const userChanges = isObject(raw.userChanges) ? raw.userChanges : {};
  return {
    schemaVersion: 1,
    confirmationId: str(raw.confirmationId),
    installationId: str(raw.installationId),
    user: str(raw.user),
    confirmedAt: raw.confirmedAt,
    agent: { total: num(agent.total), accepted: num(agent.accepted), editedByUser: num(agent.editedByUser), dismissed: num(agent.dismissed) },
    userChanges: { total: num(userChanges.total) },
  };
}

function parseAiOutcome(raw: unknown): DocsReviewAiOutcome {
  const value = isObject(raw) ? raw : {};
  return { proposals: num(value.proposals), accepted: num(value.accepted), edited: num(value.edited), dismissed: num(value.dismissed) };
}

function parseStage(raw: unknown): DocsReviewStageReport | null {
  if (!isObject(raw) || !str(raw.stageId) || !isObject(raw.metrics)) return null;
  const outputs = Array.isArray(raw.outputs)
    ? raw.outputs.filter((o): o is { path: string; size: number; mediaPath: string } =>
        isObject(o) && !!str(o.path) && !!str(o.mediaPath))
      .map((o) => ({ path: o.path, size: num(o.size), mediaPath: o.mediaPath }))
    : [];
  const comments = Array.isArray(raw.comments)
    ? raw.comments.filter((c) => isObject(c) && !!str(c.id) && typeof c.text === 'string')
    : [];
  const skipped = Array.isArray(raw.skipped)
    ? raw.skipped.filter((s) => isObject(s) && !!str(s.path)).map((s) => ({ path: str((s as Record<string, unknown>).path), reason: str((s as Record<string, unknown>).reason) }))
    : [];
  return {
    stageId: raw.stageId as DocsReviewStageReport['stageId'],
    name: str(raw.name) || str(raw.stageId),
    ...(str(raw.runId) ? { runId: str(raw.runId) } : {}),
    status: 'succeeded',
    outputs,
    ...(skipped.length ? { skipped } : {}),
    comments: comments as DocsReviewStageReport['comments'],
    metrics: raw.metrics as DocsReviewStageReport['metrics'],
  };
}

function parseV2(raw: unknown): DocsReviewFeedbackArtifactV2 | null {
  if (!isObject(raw) || raw.schemaVersion !== 2) return null;
  if (!str(raw.confirmationId) || typeof raw.confirmedAt !== 'number' || !Array.isArray(raw.stages)) return null;
  const feature = isObject(raw.feature) ? { id: str(raw.feature.id), name: str(raw.feature.name) } : null;
  if (!feature || !feature.id) return null;
  const app = isObject(raw.app) && str(raw.app.id) ? { id: str(raw.app.id), name: str(raw.app.name) || str(raw.app.id) } : null;
  const stages = raw.stages.map(parseStage).filter((s): s is DocsReviewStageReport => !!s);
  const summary = isObject(raw.summary) ? raw.summary : {};
  const platform = raw.screenPlatform;
  const agent = isObject(raw.agent) ? raw.agent : {};
  const userChanges = isObject(raw.userChanges) ? raw.userChanges : {};
  return {
    schemaVersion: 2,
    confirmationId: str(raw.confirmationId),
    projectId: str(raw.projectId),
    workflowId: 'docs-review',
    installationId: str(raw.installationId),
    user: str(raw.user),
    channel: raw.channel === 'packaged' ? 'packaged' : 'dev',
    confirmedAt: raw.confirmedAt,
    app,
    feature: { id: feature.id, name: feature.name || feature.id },
    screenPlatform: platform === 'mobile' || platform === 'web' || platform === 'both' ? platform : null,
    stages,
    summary: {
      agentProposals: num(summary.agentProposals),
      humanEdits: num(summary.humanEdits),
      comments: num(summary.comments),
      aiOutcome: parseAiOutcome(summary.aiOutcome),
    },
    agent: {
      add: num(agent.add), edited: num(agent.edited), delete: num(agent.delete), total: num(agent.total),
      accepted: num(agent.accepted), editedByUser: num(agent.editedByUser), dismissed: num(agent.dismissed),
    },
    userChanges: { add: num(userChanges.add), edited: num(userChanges.edited), delete: num(userChanges.delete), total: num(userChanges.total) },
    pages: Array.isArray(raw.pages) ? (raw.pages as DocsReviewFeedbackArtifactV2['pages']) : [],
  };
}

/** v1 chỉ đóng góp số dr-review — quy ước gộp ghi ở spec (Executor K). */
export function summaryFromV1(v1: Pick<ParsedV1, 'agent' | 'userChanges'>): DocsReviewReportSummary {
  return {
    agentProposals: v1.agent.total,
    humanEdits: v1.userChanges.total + v1.agent.editedByUser,
    comments: 0,
    aiOutcome: { proposals: v1.agent.total, accepted: v1.agent.accepted, edited: v1.agent.editedByUser, dismissed: v1.agent.dismissed },
  };
}

// ── aggregate ───────────────────────────────────────────────────────────────

const emptyOutcome = (): DocsReviewAiOutcome => ({ proposals: 0, accepted: 0, edited: 0, dismissed: 0 });
function addOutcome(target: DocsReviewAiOutcome, source: DocsReviewAiOutcome): void {
  target.proposals += source.proposals;
  target.accepted += source.accepted;
  target.edited += source.edited;
  target.dismissed += source.dismissed;
}

/** dr-confirm v2 vẫn ghi file v1 `<confirmId>.json` cạnh `<confirmId>/report.json`
 *  (tương thích reader cũ) → cùng một lần xác nhận xuất hiện 2 lần. Bỏ bản v1
 *  khi đã có v2 cùng (projectId, confirmationId) để không đếm đôi lượt xác
 *  nhận và không lặp dòng trong Lịch sử. */
export function dropShadowedV1(records: readonly DocsReviewReportRecord[]): DocsReviewReportRecord[] {
  const v2Keys = new Set(records.filter((r) => !r.legacy).map((r) => `${r.projectId} ${r.confirmationId}`));
  return records.filter((r) => !r.legacy || !v2Keys.has(`${r.projectId} ${r.confirmationId}`));
}

/** Bản mới nhất mỗi projectId (confirmedAt lớn nhất; hoà → confirmationId lớn hơn). */
export function latestPerProject(records: readonly DocsReviewReportRecord[]): DocsReviewReportRecord[] {
  const latest = new Map<string, DocsReviewReportRecord>();
  for (const record of records) {
    const current = latest.get(record.projectId);
    if (!current || record.confirmedAt > current.confirmedAt
      || (record.confirmedAt === current.confirmedAt && record.confirmationId > current.confirmationId)) {
      latest.set(record.projectId, record);
    }
  }
  return [...latest.values()].sort((a, b) => b.confirmedAt - a.confirmedAt);
}

export function buildReportsResponse(snapshot: Pick<DocsReviewReportsSnapshot, 'storeReachable' | 'records' | 'skippedFiles'>): DocsReviewReportsResponse {
  const completed = latestPerProject(snapshot.records);
  const confirmationsByProject = new Map<string, number>();
  for (const record of snapshot.records) {
    confirmationsByProject.set(record.projectId, (confirmationsByProject.get(record.projectId) ?? 0) + 1);
  }
  const summary: DocsReviewReportsResponse['summary'] = {
    apps: new Set(completed.map((r) => r.app?.id).filter((id): id is string => !!id)).size,
    features: completed.length,
    confirmations: snapshot.records.length,
    agentProposals: 0,
    humanEdits: 0,
    comments: 0,
    aiOutcome: emptyOutcome(),
  };
  const byAppMap = new Map<string, DocsReviewReportAppRow>();
  for (const record of completed) {
    summary.agentProposals += record.summary.agentProposals;
    summary.humanEdits += record.summary.humanEdits;
    summary.comments += record.summary.comments;
    addOutcome(summary.aiOutcome, record.summary.aiOutcome);
    const key = record.app?.id ?? '';
    let row = byAppMap.get(key);
    if (!row) {
      row = { appId: record.app?.id ?? null, appName: record.app?.name ?? 'Chưa gắn App', features: 0, confirmations: 0, aiOutcome: emptyOutcome() };
      byAppMap.set(key, row);
    }
    row.features += 1;
    row.confirmations += confirmationsByProject.get(record.projectId) ?? 0;
    addOutcome(row.aiOutcome, record.summary.aiOutcome);
  }
  const byApp = [...byAppMap.values()].sort((a, b) => {
    if (a.appId === null) return 1;
    if (b.appId === null) return -1;
    return a.appName.localeCompare(b.appName, 'vi');
  });
  const rows: DocsReviewCompletedRow[] = completed.map((record) => ({
    projectId: record.projectId,
    feature: record.feature,
    app: record.app,
    screenPlatform: record.screenPlatform,
    confirmedAt: record.confirmedAt,
    user: record.user,
    confirmationId: record.confirmationId,
    installationId: record.installationId,
    summary: record.summary,
    legacy: record.legacy,
  }));
  return { storeReachable: snapshot.storeReachable, summary, byApp, completed: rows, skippedFiles: snapshot.skippedFiles };
}

export function historyOf(records: readonly DocsReviewReportRecord[], projectId: string): DocsReviewReportHistoryEntry[] {
  return records
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => b.confirmedAt - a.confirmedAt)
    .map((r) => ({ confirmationId: r.confirmationId, confirmedAt: r.confirmedAt, user: r.user, legacy: r.legacy }));
}

// ── collector ───────────────────────────────────────────────────────────────

export interface DocsReviewReportsCollectorOptions {
  /** Trả `null` khi media chưa cấu hình → storeReachable:false, không gọi mạng. */
  client?: () => DocsReviewReportsMediaClient | null;
  ttlMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export class DocsReviewReportsCollector {
  private cache: DocsReviewReportsSnapshot | null = null;
  private pending: Promise<DocsReviewReportsSnapshot> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly clientFactory: () => DocsReviewReportsMediaClient | null;
  private readonly log: (message: string) => void;

  constructor(opts: DocsReviewReportsCollectorOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DOCS_REVIEW_REPORTS_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.clientFactory = opts.client ?? (() => new MediaClient(mediaConfigFromEnv()));
    this.log = opts.log ?? ((message) => console.warn(`[docs-review-reports] ${message}`));
  }

  invalidate(): void { this.cache = null; }

  async snapshot(opts: { refresh?: boolean } = {}): Promise<DocsReviewReportsSnapshot> {
    if (!opts.refresh && this.cache && this.now() - this.cache.loadedAt < this.ttlMs) return this.cache;
    if (!this.pending) {
      this.pending = this.load().then((snapshot) => {
        this.cache = snapshot;
        return snapshot;
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  private async load(): Promise<DocsReviewReportsSnapshot> {
    const loadedAt = this.now();
    const client = this.clientFactory();
    const empty = (reachable: boolean): DocsReviewReportsSnapshot => ({ storeReachable: reachable, records: [], skippedFiles: [], projects: new Map(), loadedAt, client });
    if (!client) return empty(false);
    let folders: Array<{ id: string; name: string }>;
    try {
      folders = await client.listFolders();
    } catch (err) {
      this.log(`media không tới được: ${(err as Error).message}`);
      return empty(false);
    }
    const records: DocsReviewReportRecord[] = [];
    const skippedFiles: DocsReviewSkippedFile[] = [];
    const projects = new Map<string, ProjectIndex>();
    for (const folder of folders) {
      const projectId = folder.name;
      let files: MediaFile[];
      try {
        files = await client.listAllFiles(folder.id);
      } catch (err) {
        this.log(`không list được folder ${projectId}: ${(err as Error).message}`);
        continue;
      }
      const filesByPath = new Map<string, MediaFile>();
      for (const file of files) if (!filesByPath.has(file.path)) filesByPath.set(file.path, file);
      const feedbackFiles = files.filter((file) => feedbackPathOf(file.path));
      if (feedbackFiles.length === 0) continue;
      projects.set(projectId, { folderId: folder.id, filesByPath });

      // project.json chỉ cần khi có bản v1 (v2 mang sẵn app + feature).
      let projectConfig: Record<string, unknown> | null | undefined;
      const readProjectConfig = async (): Promise<Record<string, unknown> | null> => {
        if (projectConfig !== undefined) return projectConfig;
        const file = filesByPath.get(PROJECT_CONFIG_PATH);
        projectConfig = null;
        if (file) {
          try {
            const parsed = JSON.parse((await client.downloadById(file.id)).toString('utf8')) as unknown;
            projectConfig = isObject(parsed) ? parsed : null;
          } catch (err) {
            this.log(`không đọc được project.json của ${projectId}: ${(err as Error).message}`);
          }
        }
        return projectConfig;
      };

      for (const file of feedbackFiles) {
        const ref = feedbackPathOf(file.path)!;
        let raw: unknown;
        try {
          raw = JSON.parse((await client.downloadById(file.id)).toString('utf8'));
        } catch (err) {
          skippedFiles.push({ projectId, path: file.path, reason: `không đọc/parse được: ${(err as Error).message}` });
          continue;
        }
        if (ref.version === 2) {
          const report = parseV2(raw);
          if (!report) { skippedFiles.push({ projectId, path: file.path, reason: 'report.json không đúng schema v2' }); continue; }
          records.push({
            projectId,
            confirmationId: report.confirmationId || ref.confirmationId,
            installationId: report.installationId || ref.installationId,
            user: report.user,
            confirmedAt: report.confirmedAt,
            legacy: false,
            app: report.app,
            feature: report.feature,
            screenPlatform: report.screenPlatform,
            summary: report.summary,
            report,
          });
          continue;
        }
        const v1 = parseV1(raw);
        if (!v1) { skippedFiles.push({ projectId, path: file.path, reason: 'artifact không đúng schema v1' }); continue; }
        const config = await readProjectConfig();
        const studio = studioConfigOf(config ? { studioConfig: config.studioConfig } : null);
        const app = studio.appId ? { id: studio.appId, name: studio.appName || studio.appId } : null;
        const featureName = config && str(config.name).trim() ? str(config.name) : projectId;
        records.push({
          projectId,
          confirmationId: v1.confirmationId || ref.confirmationId,
          installationId: v1.installationId || ref.installationId,
          user: v1.user,
          confirmedAt: v1.confirmedAt,
          legacy: true,
          app,
          feature: { id: projectId, name: featureName },
          screenPlatform: null,
          summary: summaryFromV1(v1),
          report: null,
        });
      }
    }
    return { storeReachable: true, records: dropShadowedV1(records), skippedFiles, projects, loadedAt, client };
  }

  async reports(opts: { refresh?: boolean } = {}): Promise<DocsReviewReportsResponse> {
    return buildReportsResponse(await this.snapshot(opts));
  }

  async find(projectId: string, confirmationId: string): Promise<{ record: DocsReviewReportRecord; snapshot: DocsReviewReportsSnapshot } | null> {
    let snapshot = await this.snapshot();
    let record = snapshot.records.find((r) => r.projectId === projectId && r.confirmationId === confirmationId);
    // Bản vừa xác nhận có thể chưa vào cache 60 s — thử nạp lại một lần.
    if (!record && snapshot.storeReachable) {
      snapshot = await this.snapshot({ refresh: true });
      record = snapshot.records.find((r) => r.projectId === projectId && r.confirmationId === confirmationId);
    }
    return record ? { record, snapshot } : null;
  }

  async detail(projectId: string, confirmationId: string): Promise<DocsReviewReportDetailResponse | { error: 'not-found' | 'legacy' }> {
    const found = await this.find(projectId, confirmationId);
    if (!found) return { error: 'not-found' };
    if (!found.record.report) return { error: 'legacy' };
    return { report: found.record.report, history: historyOf(found.snapshot.records, projectId) };
  }

  /** Tải MỘT output của bản xác nhận; chỉ path nằm trong `stages[].outputs[].path`. */
  async output(projectId: string, confirmationId: string, outputPath: string): Promise<
    | { ok: true; content: Buffer; path: string }
    | { ok: false; error: 'not-found' | 'legacy' | 'forbidden' | 'missing' }
  > {
    const found = await this.find(projectId, confirmationId);
    if (!found) return { ok: false, error: 'not-found' };
    const report = found.record.report;
    if (!report) return { ok: false, error: 'legacy' };
    const ref = report.stages.flatMap((s) => s.outputs).find((o) => o.path === outputPath);
    if (!ref) return { ok: false, error: 'forbidden' };
    const index = found.snapshot.projects.get(projectId);
    const file = index?.filesByPath.get(ref.mediaPath);
    if (!file) return { ok: false, error: 'missing' };
    const client = found.snapshot.client;
    if (!client) return { ok: false, error: 'missing' };
    return { ok: true, content: await client.downloadById(file.id), path: ref.path };
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

const EXTRA_MIME: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.drawio': 'application/xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function docsReviewOutputMime(filePath: string, fallback?: (p: string) => string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTRA_MIME[ext] ?? (fallback ? fallback(filePath) : 'application/octet-stream');
}

export interface DocsReviewReportRouteDeps {
  collector?: DocsReviewReportsCollector;
  mimeFor?: (filePath: string) => string;
}

export function registerDocsReviewReportRoutes(app: Express, deps: DocsReviewReportRouteDeps = {}): DocsReviewReportsCollector {
  const collector = deps.collector ?? new DocsReviewReportsCollector();
  const param = (req: Request, name: string): string => {
    const value = (req.params as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : '';
  };
  const fail = (res: Response, err: unknown) => {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  };

  app.get('/api/pipelines/docs-review/reports', (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    void collector.reports({ refresh }).then((body) => res.json(body)).catch((err) => fail(res, err));
  });

  app.get('/api/pipelines/docs-review/reports/:projectId/:confirmationId', (req, res) => {
    void collector.detail(param(req, 'projectId'), param(req, 'confirmationId')).then((result) => {
      if ('error' in result) {
        if (result.error === 'legacy') return res.status(404).json({ error: 'Bản xác nhận cũ (v1) không có chi tiết' });
        return res.status(404).json({ error: 'Không tìm thấy bản xác nhận' });
      }
      res.json(result);
    }).catch((err) => fail(res, err));
  });

  app.get('/api/pipelines/docs-review/reports/:projectId/:confirmationId/output', (req, res) => {
    const outputPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!outputPath) return res.status(400).json({ error: 'path is required' });
    void collector.output(param(req, 'projectId'), param(req, 'confirmationId'), outputPath).then((result) => {
      if (!result.ok) {
        if (result.error === 'forbidden') return res.status(403).json({ error: 'File không thuộc bản xác nhận này' });
        if (result.error === 'legacy') return res.status(404).json({ error: 'Bản xác nhận cũ (v1) không có chi tiết' });
        if (result.error === 'missing') return res.status(404).json({ error: 'File output không còn trên media' });
        return res.status(404).json({ error: 'Không tìm thấy bản xác nhận' });
      }
      const mime = docsReviewOutputMime(result.path, deps.mimeFor);
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'private, max-age=300');
      if (mime.startsWith('text/html')) res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
      if (req.query.download === '1') {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(result.path))}"`);
      }
      res.send(result.content);
    }).catch((err) => fail(res, err));
  });

  return collector;
}
