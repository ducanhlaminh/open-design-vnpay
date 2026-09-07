// `POST /api/docs/search` — tìm tài liệu docs-review THEO NGỮ NGHĨA cho agent
// (WP tìm ngữ nghĩa, xem `docs-embed-index.ts`). Cùng khuôn xác thực
// (tool token) + đăng ký route với `figma-desktop-tool-routes.ts`.
import type { Express, Request, Response } from 'express';
import path from 'node:path';

import { EmbedUnavailableError, searchDocsEmbed } from './docs-embed-index.js';
import { recordDocsTracingQuery } from './docs-tracing.js';
import type { ToolTokenGrant } from './tool-tokens.js';

type SendApiError = (
  res: Response,
  status: number,
  code: string,
  message: string,
  extras?: Record<string, unknown>,
) => void;

export interface RegisterDocsEmbedRoutesDeps {
  auth: {
    authorizeToolRequest: (req: Request, res: Response, operation: string) => ToolTokenGrant | null;
    requestProjectOverride: (projectId: unknown, tokenProjectId: string) => boolean;
  };
  http: {
    sendApiError: SendApiError;
  };
  paths: {
    PROJECTS_DIR: string;
    RUNTIME_DATA_DIR: string;
  };
  /** Đọc project theo id (metadata cho `resolveProjectDir` — dự án git-linked
   *  dùng `baseDir` thay vì `PROJECTS_DIR/<id>`). */
  resolveProjectDir: (projectId: string) => Promise<string | null>;
}

type DocsSearchScope = 'feature' | 'app' | 'both';

const DEFAULT_LIMIT = 5; // xem DOCS_SEARCH_DEFAULT_LIMIT (tools-docs-cli.ts)
const MAX_LIMIT = 20;

function normalizeScope(raw: unknown): DocsSearchScope | null {
  if (raw === undefined) return 'both';
  if (raw === 'feature' || raw === 'app' || raw === 'both') return raw;
  return null;
}

function normalizeLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export function registerDocsEmbedRoutes(app: Express, ctx: RegisterDocsEmbedRoutesDeps): void {
  const { authorizeToolRequest, requestProjectOverride } = ctx.auth;
  const { sendApiError } = ctx.http;
  const { RUNTIME_DATA_DIR } = ctx.paths;

  app.post('/api/docs/search', async (req: Request, res: Response) => {
    const grant = authorizeToolRequest(req, res, 'docs:search');
    if (!grant) return;

    const { projectId, wfDir, scope: rawScope, query, limit: rawLimit } = req.body ?? {};
    if (requestProjectOverride(projectId, grant.projectId)) {
      return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
        details: { suppliedProjectId: projectId },
      });
    }
    if (typeof query !== 'string' || query.trim().length === 0) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'query is required');
    }
    const scope = normalizeScope(rawScope);
    if (!scope) {
      return sendApiError(res, 400, 'BAD_REQUEST', "scope must be 'feature', 'app', or 'both'");
    }
    const resolvedWfDir = typeof wfDir === 'string' && wfDir.trim().length > 0 ? wfDir.trim() : 'docs-review';
    // Thư mục workflow LUÔN là một đoạn tên đơn ('docs-review', 'docs-to-ui').
    // Chặn '..' / dấu phân cách để một giá trị bịa từ agent không đọc được
    // thư mục ngoài dự án.
    if (resolvedWfDir.includes('/') || resolvedWfDir.includes('\\') || resolvedWfDir.includes('..')) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'wfDir must be a single directory name');
    }
    const limit = normalizeLimit(rawLimit);

    const projectRoot = await ctx.resolveProjectDir(grant.projectId);
    if (!projectRoot) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    }
    const cwd = path.join(projectRoot, resolvedWfDir);

    const scopedRoots: Array<{ root: string; scope: 'feature' | 'app' }> = [];
    if (scope === 'feature' || scope === 'both') {
      scopedRoots.push({ root: path.join(cwd, 'docs-feature'), scope: 'feature' });
    }
    if (scope === 'app' || scope === 'both') {
      scopedRoots.push({ root: path.join(cwd, 'docs-app'), scope: 'app' });
    }
    const rootByPath = new Map(scopedRoots.map((r) => [r.root, r.scope]));

    try {
      const hits = await searchDocsEmbed(
        scopedRoots.map((r) => r.root),
        query,
        { runtimeDataDir: RUNTIME_DATA_DIR, limit },
      );
      const results = hits.map((hit) => ({
        path: hit.rel,
        line: hit.line,
        crumb: hit.crumb,
        score: hit.score,
        scope: rootByPath.get(hit.root) ?? 'feature',
      }));
      // Gói A (wp-docs-review-tracing): ghi nhật ký "agent đã hỏi gì / dựa
      // trên dẫn chứng nào" cho card Quick result — best-effort, KHÔNG được
      // trì hoãn hay làm hỏng response tìm kiếm thật (route await xong rồi
      // mới trả — hàm này tự nuốt lỗi nên không có nhánh throw ở đây).
      void recordDocsTracingQuery({
        runId: grant.runId,
        query,
        scope,
        limit,
        results,
      });
      res.json({ results });
    } catch (error) {
      if (error instanceof EmbedUnavailableError) {
        return res.status(503).json({ error: 'embed-unavailable', hint: 'grep _sections.md' });
      }
      console.warn('[docs-embed] search failed', error);
      return sendApiError(res, 500, 'DOCS_SEARCH_FAILED', error instanceof Error ? error.message : String(error));
    }
  });
}
