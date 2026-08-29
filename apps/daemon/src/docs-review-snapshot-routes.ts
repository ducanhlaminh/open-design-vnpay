// docs-review snapshot routes — "dự án ảo" CHỈ ĐỌC cho trang báo cáo
// `/feedback/docs-review/:projectId/:confirmationId` (wp-docs-review-report-quick-result).
//
// Trang chi tiết dựng lại đúng Quick result của từng bước bằng CÙNG các viewer
// pipeline (FileViewer → MarkdownViewer / FlowUxReviewPreview / MockupsPreview /
// DocRedlinePreview…). Các viewer đó đọc qua `/api/projects/:id/files`,
// `/api/projects/:id/raw/<name>` và `/api/projects/:id/docs-review/comments/:stageId`,
// nên daemon phục vụ một project id ảo `drsnap.<confirmationId>.<projectId>`:
//   - file  = snapshot output của bản xác nhận trên media (qua collector),
//             tên file = `docs-review/<output.path>` (prefix bắt buộc vì các
//             viewer nhận diện trang theo `docs-review/...`);
//   - comment cấp bước = `stages[].comments` trong report.json;
//   - mọi request ghi → 405. Id thật → next() ngay, không đụng dự án thật.
//
// Phải mount TRƯỚC registerProjectRoutes (route thật reject id không tồn tại
// trước) và SAU các middleware auth `app.use('/api', …)` của server.ts.

import type { Express, NextFunction, Request, Response } from 'express';
import type { DocsReviewStageCommentsResponse, ProjectFile, ProjectFileKind } from '@open-design/contracts';
import { parseDocsReviewSnapshotProjectId } from '@open-design/contracts';
import { isDocsReviewStageId } from './docs-review-comments.js';
import { DocsReviewReportsCollector, docsReviewOutputMime } from './docs-review-reports.js';
import { kindFor, mimeFor as projectMimeFor } from './projects.js';

/** Prefix tên file trong dự án ảo — khớp `fileInWorkflow(name, 'docs-review')` bên web. */
export const DOCS_REVIEW_SNAPSHOT_FILE_PREFIX = 'docs-review/';

export interface DocsReviewSnapshotRouteDeps {
  collector: DocsReviewReportsCollector;
  /** Fallback mime cho `/raw` khi đuôi không có trong bảng của docs-review-reports. */
  mimeFor?: (filePath: string) => string;
}

const RAW_RE = /^\/raw\/(.+)$/;

/** Bỏ prefix `docs-review/`; thiếu prefix → null (404). */
export function snapshotOutputPathOf(name: string): string | null {
  if (!name.startsWith(DOCS_REVIEW_SNAPSHOT_FILE_PREFIX)) return null;
  const rest = name.slice(DOCS_REVIEW_SNAPSHOT_FILE_PREFIX.length);
  return rest ? rest : null;
}

export function registerDocsReviewSnapshotRoutes(app: Express, deps: DocsReviewSnapshotRouteDeps): void {
  const { collector } = deps;

  const fail = (res: Response, err: unknown) => {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  };
  const notFoundReport = (res: Response, error: 'not-found' | 'legacy') => {
    if (error === 'legacy') return res.status(404).json({ error: 'Bản xác nhận cũ (v1) không có chi tiết' });
    return res.status(404).json({ error: 'Không tìm thấy bản xác nhận' });
  };

  const handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idParam = (req.params as Record<string, unknown>).id;
    const parsed = typeof idParam === 'string' ? parseDocsReviewSnapshotProjectId(idParam) : null;
    if (!parsed) { next(); return; }
    const { projectId, confirmationId } = parsed;

    // iframe srcdoc (PreviewModal) gửi Origin "null" — cho phép như route raw thật.
    if (req.headers.origin === 'null') res.header('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
      if (req.headers.origin === 'null') {
        res.header('Access-Control-Allow-Methods', 'GET');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
      }
      res.sendStatus(204);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).json({ error: 'Bản xác nhận chỉ đọc' });
      return;
    }

    // `/raw/<name>` — nội dung 1 output, tải từ media qua collector.
    const raw = RAW_RE.exec(req.path);
    if (raw) {
      let name: string;
      try {
        name = decodeURIComponent(raw[1] ?? '');
      } catch {
        res.status(404).json({ error: 'File không thuộc bản xác nhận này' });
        return;
      }
      const outputPath = snapshotOutputPathOf(name);
      if (!outputPath) {
        res.status(404).json({ error: 'File không thuộc bản xác nhận này' });
        return;
      }
      const result = await collector.output(projectId, confirmationId, outputPath);
      if (!result.ok) {
        // File không nằm trong outputs của bản xác nhận → 404 (KHÔNG 403): viewer
        // Quick result dò file tuỳ chọn (as-is.mmd/.svg, proposed.edited.json…)
        // như trên dự án thật — 404 là "không có", 403 làm console đỏ vô cớ.
        if (result.error === 'forbidden') { res.status(404).json({ error: 'File không thuộc bản xác nhận này' }); return; }
        if (result.error === 'missing') { res.status(404).json({ error: 'File output không còn trên media' }); return; }
        notFoundReport(res, result.error);
        return;
      }
      const mime = docsReviewOutputMime(result.path, deps.mimeFor);
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'private, max-age=300');
      if (mime.startsWith('text/html')) res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
      res.send(result.content);
      return;
    }

    const found = await collector.find(projectId, confirmationId);
    if (!found) { notFoundReport(res, 'not-found'); return; }
    const report = found.record.report;
    if (!report) { notFoundReport(res, 'legacy'); return; }

    // `/files` — union output mọi bước, dedupe theo path; kind/mime tính bằng
    // đúng helper listFiles dùng cho dự án thật (kindFor/mimeFor theo tên).
    if (req.path === '/files') {
      const seen = new Set<string>();
      const files: ProjectFile[] = [];
      for (const stage of report.stages) {
        for (const output of stage.outputs) {
          if (seen.has(output.path)) continue;
          seen.add(output.path);
          const name = DOCS_REVIEW_SNAPSHOT_FILE_PREFIX + output.path;
          files.push({
            name,
            path: name,
            type: 'file',
            size: output.size,
            mtime: report.confirmedAt,
            kind: kindFor(name) as ProjectFileKind,
            mime: projectMimeFor(name) as string,
          });
        }
      }
      res.json({ files });
      return;
    }

    // `/docs-review/comments/:stageId` — comment cấp bước đã đóng băng trong report.
    const comments = /^\/docs-review\/comments\/([^/]+)$/.exec(req.path);
    if (comments) {
      const stageId = comments[1] ?? '';
      if (!isDocsReviewStageId(stageId)) {
        res.status(404).json({ error: `Bước "${stageId}" không thuộc workflow docs-review` });
        return;
      }
      const body: DocsReviewStageCommentsResponse = {
        stageId,
        comments: report.stages.find((s) => s.stageId === stageId)?.comments ?? [],
      };
      res.json(body);
      return;
    }

    // `/` — thông tin dự án tối thiểu, phòng viewer nào gọi.
    if (req.path === '/' || req.path === '') {
      res.json({ id: idParam, name: report.feature.name, metadata: {}, readOnly: true });
      return;
    }

    res.status(404).json({ error: 'not available for snapshot' });
  };

  app.use('/api/projects/:id', (req, res, next) => {
    handler(req, res, next).catch((err) => fail(res, err));
  });
}
