// HTTP surface for design-v3 KG sync (pull/push/status).
//
// open-design-vnpay is a consumer+producer of the central KGS (app_id =
// design-v3): pull a remote project into the local SQLite mirror, work on it,
// push locally-authored rows back. KGS connection comes from the environment
// (KGS_URL / KGS_APP_ID / KGS_TENANT / KGS_API_KEY) — see kgs-client.ts.
//
// Dual-track: these endpoints back both the web UI and `od kg …` (cli.ts).
// See docs/sync-design-v3-spec-plan.md.

import type { Express } from 'express';
import type { RouteDeps } from './server-context.js';
import { KgsClient, kgsConfigFromEnv } from './kg-sync/kgs-client.js';
import { pullProject } from './kg-sync/pull.js';
import { pushProject } from './kg-sync/push.js';
import { KgSyncRepo } from './kg-sync/persistence.js';
import { listProjects } from './db.js';

export interface RegisterKgSyncRoutesDeps extends RouteDeps<'db' | 'http' | 'ids' | 'projectStore'> {}

// Derive a pull-able project id from a DP_UI_WORKSPACE entity: prefer the
// explicit projectId property, else the conventional `ws-project-<ID>` entity
// id. Returns null for non-project workspaces (e.g. shared `ws-catalog-*`).
function projectIdFromWorkspace(ws: { entityId?: string; properties?: Record<string, unknown> }): string | null {
  const pid = ws.properties?.projectId;
  if (typeof pid === 'string' && pid.trim()) return pid.trim();
  const m = /^ws-project-(.+)$/i.exec(ws.entityId ?? '');
  return m && m[1] ? m[1] : null;
}

// A locally-mirrored KGS app — an open-design project pulled from KGS.
function isKgPullProject(p: { metadata?: unknown }): boolean {
  const m = p?.metadata;
  return Boolean(
    m && typeof m === 'object' && !Array.isArray(m) &&
    (m as Record<string, unknown>).source === 'kg-pull',
  );
}

export function registerKgSyncRoutes(app: Express, ctx: RegisterKgSyncRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { randomId } = ctx.ids;
  const { getProject, insertProject } = ctx.projectStore;

  // Ensure a local projects row exists so kg_nodes' FK is satisfied. A pulled
  // remote project the user hasn't otherwise created gets a placeholder row.
  function ensureProject(projectId: string, now: number) {
    if (getProject(db, projectId)) return;
    insertProject(db, {
      id: projectId,
      name: projectId,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { source: 'kg-pull' },
      createdAt: now,
      updatedAt: now,
    });
  }

  // POST /api/projects/:id/kg-pull — KGS (design-v3) → local SQLite mirror.
  app.post('/api/projects/:id/kg-pull', async (req, res) => {
    const projectId = req.params.id;
    if (!projectId) return sendApiError(res, 400, 'BAD_REQUEST', 'project id required');
    const now = Date.now();
    try {
      ensureProject(projectId, now);
      const result = await pullProject(db, projectId, kgsConfigFromEnv(), now, randomId());
      res.json({ ok: result.status === 'ok', data: result });
    } catch (err) {
      sendApiError(res, 502, 'KG_PULL_FAILED', (err as Error).message);
    }
  });

  // POST /api/projects/:id/kg-push — local locally-authored rows → KGS.
  app.post('/api/projects/:id/kg-push', async (req, res) => {
    const projectId = req.params.id;
    if (!projectId) return sendApiError(res, 400, 'BAD_REQUEST', 'project id required');
    if (!getProject(db, projectId)) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    const now = Date.now();
    try {
      const result = await pushProject(db, projectId, kgsConfigFromEnv(), now, randomId());
      res.json({ ok: result.status === 'ok', data: result });
    } catch (err) {
      sendApiError(res, 502, 'KG_PUSH_FAILED', (err as Error).message);
    }
  });

  // GET /api/projects/:id/kg-status — mirror counts (for UI/CLI status).
  app.get('/api/projects/:id/kg-status', (req, res) => {
    const projectId = req.params.id;
    if (!projectId) return sendApiError(res, 400, 'BAD_REQUEST', 'project id required');
    const counts = new KgSyncRepo(db).counts(projectId);
    res.json({ ok: true, data: { projectId, ...counts } });
  });

  // POST /api/kg/pull-all — pull EVERY KGS app/project at once. Enumerates the
  // workspaces in the KGS app graph, derives each one's project id, and mirrors
  // each into a local kg-pull project. One button, not per-project.
  app.post('/api/kg/pull-all', async (_req, res) => {
    const now = Date.now();
    try {
      const cfg = kgsConfigFromEnv();
      const client = new KgsClient(cfg);
      const workspaces = await client.queryEntities(['DP_UI_WORKSPACE'], {});
      const projectIds = Array.from(
        new Set(
          workspaces
            .map((ws) => projectIdFromWorkspace(ws as { entityId?: string; properties?: Record<string, unknown> }))
            .filter((x): x is string => Boolean(x)),
        ),
      );
      const results = [];
      for (const projectId of projectIds) {
        ensureProject(projectId, now);
        try {
          const r = await pullProject(db, projectId, cfg, Date.now(), randomId());
          results.push({ projectId, nodes: r.nodes, edges: r.edges, status: r.status });
        } catch (err) {
          results.push({ projectId, status: 'error', error: (err as Error).message });
        }
      }
      res.json({ ok: true, data: { pulled: results.length, projectIds, results } });
    } catch (err) {
      sendApiError(res, 502, 'KG_PULL_FAILED', (err as Error).message);
    }
  });

  // POST /api/kg/push-all — push EVERY locally-mirrored KGS app back at once.
  app.post('/api/kg/push-all', async (_req, res) => {
    try {
      const cfg = kgsConfigFromEnv();
      const projects = listProjects(db).filter((p: { metadata?: unknown }) => isKgPullProject(p));
      const results = [];
      for (const p of projects as Array<{ id: string }>) {
        try {
          const r = await pushProject(db, p.id, cfg, Date.now(), randomId());
          results.push({ projectId: p.id, nodesPushed: r.nodesPushed, edgesPushed: r.edgesPushed, status: r.status });
        } catch (err) {
          results.push({ projectId: p.id, status: 'error', error: (err as Error).message });
        }
      }
      res.json({ ok: true, data: { pushed: results.length, results } });
    } catch (err) {
      sendApiError(res, 502, 'KG_PUSH_FAILED', (err as Error).message);
    }
  });
}
