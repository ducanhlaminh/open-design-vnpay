// App Docs Pool — HTTP routes (docs/app-docs-pool-spec.md §2.2 / §WP-1).
// One deterministic Confluence import per App + a gate-readable pool view +
// page deletion.

import type { Express } from 'express';

import fs from 'node:fs';
import path from 'node:path';

import { getPipelineApp, listPipelineApps, listProjects } from './db.js';
import { createAppContextVersion } from './app-context-version.js';
import {
  deletePoolPages,
  importConfluenceIntoPool,
  readManifest,
  type ManifestPage,
} from './app-pool.js';
import { discoverLinkedConfluencePages, resolveConfluenceCreds } from './bas/bas-client.js';

export interface RegisterAppPoolRoutesDeps {
  db: any;
  paths: {
    PROJECTS_DIR: string;
    RUNTIME_DATA_DIR: string;
    DESIGN_SYSTEMS_DIR: string;
    USER_DESIGN_SYSTEMS_DIR: string;
  };
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

  const versionAfterMutation = async (appId: string) => {
    const app = getPipelineApp(db, appId);
    const linked = listProjects(db).find((p: { metadata?: Record<string, unknown> }) => {
      const sc = p.metadata?.studioConfig;
      return sc && typeof sc === 'object' && !Array.isArray(sc) && (sc as Record<string, unknown>).appId === appId;
    }) as { metadata?: Record<string, unknown> } | undefined;
    const sc = linked?.metadata?.studioConfig as Record<string, unknown> | undefined;
    const appName = app?.name ?? (typeof sc?.appName === 'string' ? sc.appName : appId);
    const designSystemId = app?.designSystemId ?? (typeof sc?.designSystemId === 'string' ? sc.designSystemId : null);
    let designSystemDir: string | null = null;
    if (designSystemId) {
      const bare = designSystemId.replace(/^user:/, '');
      if (bare && !bare.includes('/') && !bare.includes('\\') && !bare.includes('..')) {
        for (const root of [paths.USER_DESIGN_SYSTEMS_DIR, paths.DESIGN_SYSTEMS_DIR]) {
          const candidate = path.join(root, bare);
          if (await fs.promises.stat(candidate).then((s) => s.isDirectory(), () => false)) {
            designSystemDir = candidate;
            break;
          }
        }
      }
    }
    return createAppContextVersion({
      projectsDir: paths.PROJECTS_DIR,
      appId,
      appName,
      designSystemId,
      docsReviewComponentSource: app?.docsReviewComponentSource ?? { mode: 'app-design-system' },
      designSystemDir,
    });
  };

  // POST /api/pipelines/confluence/linked-pages — discover depth-1 linked pages.
  app.post('/api/pipelines/confluence/linked-pages', async (req, res) => {
    const refs = req.body?.refs;
    if (!Array.isArray(refs) || refs.length === 0 || !refs.every((ref: unknown) => typeof ref === 'string' && ref.trim())) {
      return res.status(400).json({ error: 'refs (Confluence URLs/ids) is required' });
    }
    try {
      const creds = await resolveConfluenceCreds(paths.RUNTIME_DATA_DIR);
      if (!creds) {
        throw new Error(
          'Chưa có credential Confluence: thêm CONFLUENCE_URL + CONFLUENCE_PERSONAL_TOKEN (Settings → MCP) hoặc cấu hình BAS gateway.',
        );
      }
      const pages = await discoverLinkedConfluencePages(creds, refs as string[]);
      res.json({ pages });
    } catch (err: any) {
      res.status(502).json({ error: String(err?.message ?? err) });
    }
  });

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
    const relatedRefs = Array.isArray(req.body?.relatedRefs)
      ? (req.body.relatedRefs as unknown[]).filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];
    try {
      const result = await importConfluenceIntoPool({
        projectsDir: paths.PROJECTS_DIR,
        runtimeDataDir: paths.RUNTIME_DATA_DIR,
        appId,
        refs,
        relatedRefs,
        followLinks,
        includeDescendants,
      });
      const contextVersion = await versionAfterMutation(appId);
      res.json({ ...result, contextVersion: contextVersion.manifest });
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
      const pages: ManifestPage[] = manifest.pages;
      res.json({ pages });
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
      const contextVersion = await versionAfterMutation(appId);
      res.json({ ok: true, pages: manifest.pages, contextVersion: contextVersion.manifest });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

}
