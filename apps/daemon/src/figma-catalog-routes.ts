// App-level Figma component catalogue — what the App's DS tab shows when the
// component source is "Link Figma". Stored under
// `<PROJECTS_DIR>/<appId>/figma-catalog/components.{json,md}` (same snapshot
// shape the dr-comp preparation phase freezes into a workflow dir; that
// phase also refreshes this copy so the tab never lags a run).
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type { AppFigmaCatalogResponse, DocsReviewComponentSource } from '@open-design/contracts';

import { getPipelineApp } from './db.js';
import { readFigmaConfig } from './figma-config.js';
import { renderFigmaComponentsMarkdown, type FigmaComponentCatalogSnapshot } from './figma-component-catalog.js';
import { buildFigmaComponentCatalog } from './figma-rest.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterFigmaCatalogRoutesDeps extends RouteDeps<'db' | 'http' | 'paths'> {}

export function appFigmaCatalogDir(projectsDir: string, appId: string): string {
  return path.join(projectsDir, appId, 'figma-catalog');
}

/** Persist a snapshot as the App's catalogue (json + rendered markdown).
 *  Atomic per file (tmp → rename). Shared with the dr-comp fan-out. */
export async function writeAppFigmaCatalog(projectsDir: string, appId: string, snapshot: FigmaComponentCatalogSnapshot): Promise<void> {
  const dir = appFigmaCatalogDir(projectsDir, appId);
  await fs.promises.mkdir(dir, { recursive: true });
  const jsonTmp = path.join(dir, `components.${process.pid}.json.tmp`);
  const mdTmp = path.join(dir, `components.${process.pid}.md.tmp`);
  await fs.promises.writeFile(jsonTmp, JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.promises.writeFile(mdTmp, renderFigmaComponentsMarkdown(snapshot), 'utf8');
  await fs.promises.rename(jsonTmp, path.join(dir, 'components.json'));
  await fs.promises.rename(mdTmp, path.join(dir, 'components.md'));
}

export async function readAppFigmaCatalog(projectsDir: string, appId: string): Promise<{ snapshot: FigmaComponentCatalogSnapshot; markdown: string | null } | null> {
  const dir = appFigmaCatalogDir(projectsDir, appId);
  const raw = await fs.promises.readFile(path.join(dir, 'components.json'), 'utf8').catch(() => null);
  if (raw == null) return null;
  try {
    const snapshot = JSON.parse(raw) as FigmaComponentCatalogSnapshot;
    if (!snapshot || !Array.isArray(snapshot.files)) return null;
    const markdown = await fs.promises.readFile(path.join(dir, 'components.md'), 'utf8').catch(() => null);
    return { snapshot, markdown };
  } catch {
    return null;
  }
}

function toResponse(
  source: DocsReviewComponentSource,
  hasToken: boolean,
  stored: { snapshot: FigmaComponentCatalogSnapshot; markdown: string | null } | null,
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
      const [cfg, stored] = await Promise.all([readFigmaConfig(RUNTIME_DATA_DIR), readAppFigmaCatalog(PROJECTS_DIR, target.id)]);
      res.json(toResponse(target.source, Boolean(cfg?.token), stored));
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
      const stored = await readAppFigmaCatalog(PROJECTS_DIR, target.id);
      res.json(toResponse(target.source, true, stored));
    } catch (err: any) {
      res.status(502).json({ error: String(err && err.message ? err.message : err) });
    }
  });
}
