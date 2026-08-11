import type { Express, RequestHandler } from 'express';
import multer from 'multer';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { DesignSystemCriteriaKind } from '@open-design/contracts';

import { LocalDesignSystemImportError } from './design-system-import.js';
import { decodeMultipartFilename } from './projects.js';
import {
  approveDesignSystemCriteriaDraft,
  approveFigmaDesignSystemUpdate,
  DesignSystemUpdateError,
  discardDesignSystemCriteriaDraft,
  readDesignSystemUpdateState,
  startFigmaDesignSystemUpdate,
  type DesignSystemContextUpdate,
} from './design-system-update.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024, files: 16 } });

export interface RegisterDesignSystemUpdateRoutesDeps {
  userDesignSystemsDir: string;
  isLocalSameOrigin: (req: unknown, port: number) => boolean;
  resolvedPortRef: { current: number };
  versionAppContexts: (designSystemId: string, dsDir: string) => Promise<DesignSystemContextUpdate[]>;
}

function criterion(value: string): DesignSystemCriteriaKind | null {
  return value === 'components' || value === 'rules' ? value : null;
}

function booleanField(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

function statusFor(error: unknown): number {
  if (error instanceof LocalDesignSystemImportError) return error.code === 'BAD_REQUEST' ? 400 : 500;
  if (!(error instanceof DesignSystemUpdateError)) return 500;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'STALE_CRITERIA_CONFIRMATION_REQUIRED' || error.code === 'DRAFT_CRITERIA_PENDING') return 409;
  return 400;
}

function sendError(res: any, error: unknown) {
  const known = error instanceof DesignSystemUpdateError || error instanceof LocalDesignSystemImportError;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof DesignSystemUpdateError ? error.details : undefined;
  return res.status(statusFor(error)).json({ error: message, code, ...(details ?? {}) });
}

export function registerDesignSystemUpdateRoutes(app: Express, deps: RegisterDesignSystemUpdateRoutesDeps): void {
  const dsDir = (id: string) => path.join(deps.userDesignSystemsDir, id.replace(/^user:/, ''));
  const idOf = (req: { params: Record<string, string | string[] | undefined> }) => String(req.params.id ?? '');
  const requireLocal = (req: any, res: any): boolean => {
    if (deps.isLocalSameOrigin(req, deps.resolvedPortRef.current)) return true;
    res.status(403).json({ error: 'local origin required', code: 'FORBIDDEN' });
    return false;
  };
  const uploadMiddleware: RequestHandler = (req, res, next) => {
    upload.array('files', 16)(req, res, (error: any) => {
      if (!error) return next();
      const code = error?.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
      return res.status(error?.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: String(error.message ?? error), code });
    });
  };

  app.post('/api/design-systems/:id/figma-update', uploadMiddleware, async (req, res) => {
    if (!requireLocal(req, res)) return;
    try {
      const files = ((req.files ?? []) as Array<{ originalname: string; buffer: Buffer }>).map((file) => ({
        filename: decodeMultipartFilename(file.originalname), content: file.buffer,
      }));
      if (!files.length) throw new DesignSystemUpdateError('BAD_REQUEST', 'at least one Figma ZIP or IR file is required');
      const id = idOf(req);
      const result = await startFigmaDesignSystemUpdate({
        dsDir: dsDir(id), designSystemId: id, files,
        deleteOldSourceAfterApproval: booleanField(req.body?.deleteOldSourceAfterApproval),
      });
      res.status(201).json(result);
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/design-systems/:id/update-state', async (req, res) => {
    try {
      const id = idOf(req); const dir = dsDir(id);
      if (!await stat(dir).then((item) => item.isDirectory()).catch(() => false)) {
        throw new DesignSystemUpdateError('NOT_FOUND', 'design system not found');
      }
      const state = await readDesignSystemUpdateState(dir, id);
      res.json({ state });
    } catch (error) { sendError(res, error); }
  });

  for (const kind of ['components', 'rules'] as const) {
    app.post(`/api/design-systems/:id/criteria/${kind}/approve`, async (req, res) => {
      if (!requireLocal(req, res)) return;
      try {
        const id = idOf(req); const state = await approveDesignSystemCriteriaDraft(dsDir(id), id, kind);
        res.json({ state, approved: kind });
      } catch (error) { sendError(res, error); }
    });
  }

  app.delete('/api/design-systems/:id/criteria/:kind/draft', async (req, res) => {
    if (!requireLocal(req, res)) return;
    try {
      const kind = criterion(String(req.params.kind ?? ''));
      if (!kind) throw new DesignSystemUpdateError('BAD_REQUEST', 'criteria kind must be components or rules');
      const id = idOf(req); const state = await discardDesignSystemCriteriaDraft(dsDir(id), id, kind);
      res.json({ state, discarded: kind });
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/design-systems/:id/figma-update/approve', async (req, res) => {
    if (!requireLocal(req, res)) return;
    try {
      const id = idOf(req); const dir = dsDir(id);
      const result = await approveFigmaDesignSystemUpdate({
        dsDir: dir, designSystemId: id,
        confirmStaleCriteria: req.body?.confirmStaleCriteria === true,
        versionAppContexts: () => deps.versionAppContexts(id, dir),
      });
      res.json(result);
    } catch (error) { sendError(res, error); }
  });
}
