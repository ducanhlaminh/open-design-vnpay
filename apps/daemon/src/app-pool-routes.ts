// App Docs Pool — HTTP routes (docs/app-docs-pool-spec.md §2.2 / §WP-1).
// One deterministic Confluence import per App + a gate-readable pool view +
// page deletion + the distill trigger (actual distill logic in
// app-distill.ts; this file only wires the HTTP surface to it).

import fs from 'node:fs';

import type { Express } from 'express';

import { listPipelineApps, listProjects } from './db.js';
import {
  deletePoolPages,
  importConfluenceIntoPool,
  isPoolClean,
  overviewPath,
  pendingCount,
  readManifest,
  type ManifestPage,
} from './app-pool.js';
import { DistillConflictError, getDistillProgress, startDistill, type AppDistillDeps } from './app-distill.js';

export interface RegisterAppPoolRoutesDeps {
  db: any;
  paths: {
    PROJECTS_DIR: string;
    RUNTIME_DATA_DIR: string;
  };
  /** Wired in server.ts to the real fan-out agent runner (see app-distill.ts's
   *  docblock); the route layer only starts/reads progress. */
  distill: AppDistillDeps;
}

/** An App is "known" locally when it either has its own `pipeline_apps` row
 *  (created via POST /api/pipelines/apps, including a brand-new 0-feature
 *  App) or is denormalized onto ≥1 local feature's `studioConfig.appId` —
 *  the SAME union `collectLocalApps` (pipeline-routes.ts) uses for the App
 *  picker, reduced here to a plain existence check (this route only needs
 *  "does this id name a real App", not the full {id,name,origin} listing). */
function appExistsLocally(db: any, appId: string): boolean {
  if (listPipelineApps(db).some((a: { id: string }) => a.id === appId)) return true;
  return listProjects(db).some((p: { metadata?: Record<string, unknown> }) => {
    const sc = p.metadata?.studioConfig;
    const scAppId = sc && typeof sc === 'object' && !Array.isArray(sc) ? (sc as Record<string, unknown>).appId : undefined;
    return scAppId === appId;
  });
}

export function registerAppPoolRoutes(app: Express, ctx: RegisterAppPoolRoutesDeps) {
  const { db, paths } = ctx;

  // POST /api/pipelines/apps/:appId/import-confluence — §2.2.
  app.post('/api/pipelines/apps/:appId/import-confluence', async (req, res) => {
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    if (!appId || !appExistsLocally(db, appId)) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }
    const refs = Array.isArray(req.body?.refs)
      ? (req.body.refs as unknown[]).filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];
    if (refs.length === 0) return res.status(400).json({ error: 'refs (Confluence URLs/ids) is required' });
    // Pool App là kho do USER tự chọn từng trang — mặc định KHÔNG kéo thêm
    // trang được link (depth-1): trang link-followed thường nằm nhánh wiki
    // khác (PRD, ID-Safe…), lôi vào vừa làm pool phình ngoài ý muốn vừa phá
    // gốc chung của cây (path tuyệt đối theo tổ tiên). Muốn theo link thì
    // client gửi followLinks:true tường minh. (Đường dr-docs legacy giữ
    // default follow như cũ — khác mục đích.)
    const followLinks = req.body?.followLinks === true;
    const includeDescendants = req.body?.includeDescendants === true;
    try {
      const result = await importConfluenceIntoPool({
        projectsDir: paths.PROJECTS_DIR,
        runtimeDataDir: paths.RUNTIME_DATA_DIR,
        appId,
        refs,
        followLinks,
        includeDescendants,
      });
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: String(err?.message ?? err) });
    }
  });

  // GET /api/pipelines/apps/:appId/pool — §2.2.
  app.get('/api/pipelines/apps/:appId/pool', async (req, res) => {
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    if (!appId || !appExistsLocally(db, appId)) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }
    try {
      const manifest = await readManifest(paths.PROJECTS_DIR, appId);
      const progress = getDistillProgress(appId);
      const overviewExists = await fs.promises
        .access(overviewPath(paths.PROJECTS_DIR, appId))
        .then(() => true)
        .catch(() => false);
      const pages: ManifestPage[] = manifest.pages;
      res.json({
        pages,
        distill: {
          clean: isPoolClean(manifest),
          pending: pendingCount(manifest),
          running: progress?.running === true,
          ...(progress ? { progress: { done: progress.done, total: progress.total } } : {}),
        },
        overviewExists,
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // DELETE /api/pipelines/apps/:appId/pool/pages — §2.2.
  app.delete('/api/pipelines/apps/:appId/pool/pages', async (req, res) => {
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    if (!appId || !appExistsLocally(db, appId)) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }
    const pageIds = Array.isArray(req.body?.pageIds)
      ? (req.body.pageIds as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : [];
    if (pageIds.length === 0) return res.status(400).json({ error: 'pageIds is required' });
    try {
      const manifest = await deletePoolPages(paths.PROJECTS_DIR, appId, pageIds);
      res.json({ ok: true, pages: manifest.pages });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/pipelines/apps/:appId/distill — §2.2.
  app.post('/api/pipelines/apps/:appId/distill', async (req, res) => {
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    if (!appId || !appExistsLocally(db, appId)) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }
    try {
      const result = await startDistill(appId, ctx.distill);
      res.json(result);
    } catch (err: any) {
      if (err instanceof DistillConflictError) {
        return res.status(409).json({ error: err.message });
      }
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });
}
