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
import {
  ERR_PLAN_EXPIRED,
  type PullApplyRequest,
  type PullResolution,
  type RemoteDeleteScope,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import { KgsClient, kgsConfigFromEnv } from './kg-sync/kgs-client.js';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';
import { pullProject } from './kg-sync/pull.js';
import { pushProject } from './kg-sync/push.js';
import { KgSyncRepo } from './kg-sync/persistence.js';
import { loadRemoteProjects, projectIdFromWorkspace } from './kg-sync/remote-registry.js';
import { listProjects } from './db.js';

export interface RegisterKgSyncRoutesDeps
  extends RouteDeps<'db' | 'http' | 'ids' | 'projectStore' | 'pipelines'> {}

// projectIdFromWorkspace now lives in kg-sync/remote-registry.ts (shared with the
// remote registry) and is imported above.

// A pipeline-eligible KGS app: either pulled from KGS (`source: 'kg-pull'`) OR
// created fresh for pipelines (`kind: 'pipeline'`). push-all must cover BOTH —
// a locally-created project is `kind: 'pipeline'` and would otherwise never be
// pushed (and so never become discoverable on another device). Mirrors
// pipeline-routes' isKgsProject.
function isKgsProject(p: { metadata?: unknown }): boolean {
  const m = p?.metadata;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const meta = m as Record<string, unknown>;
  return meta.source === 'kg-pull' || meta.kind === 'pipeline';
}

export function registerKgSyncRoutes(app: Express, ctx: RegisterKgSyncRoutesDeps) {
  const { db, pipelines } = ctx;
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
          // Also restore the project's pipeline output files from the KGS file
          // store, so pull-all is a full graph + files round-trip. Best-effort:
          // a file-pull failure must not fail the already-succeeded graph pull.
          let files = 0;
          let filesError: string | undefined;
          try {
            files = (await pipelines.pullFiles(projectId)).pulled;
          } catch (err) {
            filesError = (err as Error).message;
          }
          results.push({
            projectId,
            nodes: r.nodes,
            edges: r.edges,
            files,
            status: r.status,
            ...(filesError ? { filesError } : {}),
          });
        } catch (err) {
          results.push({ projectId, status: 'error', error: (err as Error).message });
        }
      }
      res.json({ ok: true, data: { pulled: results.length, projectIds, results } });
    } catch (err) {
      sendApiError(res, 502, 'KG_PULL_FAILED', (err as Error).message);
    }
  });

  // POST /api/kg/push-all — push EVERY pipeline-eligible KGS app back at once.
  // Covers both pulled mirrors and locally-created (`kind: 'pipeline'`) projects.
  app.post('/api/kg/push-all', async (_req, res) => {
    try {
      const cfg = kgsConfigFromEnv();
      const client = new KgsClient(cfg);
      const projects = listProjects(db).filter((p: { metadata?: unknown }) => isKgsProject(p));
      const results = [];
      for (const p of projects as Array<{ id: string; name?: string }>) {
        try {
          // Ensure the project's DP_UI_WORKSPACE node exists so another device's
          // pull-all (which discovers projects by enumerating DP_UI_WORKSPACE) can
          // find it. A locally-created project has no workspace node until now.
          let workspace: 'created' | 'exists' | 'error' = 'exists';
          try {
            workspace = await client.ensureWorkspace(p.id, p.name ?? p.id);
          } catch {
            workspace = 'error';
          }
          const r = await pushProject(db, p.id, cfg, Date.now(), randomId());
          // Also upload the project's current output files to the KGS file store
          // (and B2-convert convertToGraph stages), so push-all sends graph +
          // files. Best-effort: a file-upload failure must not fail the
          // already-succeeded graph push.
          let filesUploaded = 0;
          let filesConverted = 0;
          let filesError: string | undefined;
          try {
            const u = await pipelines.uploadFiles(p.id);
            filesUploaded = u.uploaded;
            filesConverted = u.converted;
          } catch (err) {
            filesError = (err as Error).message;
          }
          results.push({
            projectId: p.id,
            workspace,
            nodesPushed: r.nodesPushed,
            edgesPushed: r.edgesPushed,
            filesUploaded,
            filesConverted,
            status: r.status,
            ...(filesError ? { filesError } : {}),
          });
        } catch (err) {
          results.push({ projectId: p.id, status: 'error', error: (err as Error).message });
        }
      }
      res.json({ ok: true, data: { pushed: results.length, results } });
    } catch (err) {
      sendApiError(res, 502, 'KG_PUSH_FAILED', (err as Error).message);
    }
  });

  // POST /api/kg/pull-plan { projectId } — classify a project's media-service
  // files against the local cwd WITHOUT writing (PLAN phase). Returns a PullPlan
  // with a planId the matching pull-apply binds to. See
  // docs/guides/pull-conflict-resolution-spec.md.
  app.post('/api/kg/pull-plan', async (req, res) => {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId) return sendApiError(res, 400, 'BAD_REQUEST', 'projectId required');
    if (!getProject(db, projectId)) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    try {
      const plan = await pipelines.pullConflict.plan(projectId);
      res.json({ ok: true, data: plan });
    } catch (err) {
      sendApiError(res, 502, 'KG_PULL_FAILED', (err as Error).message);
    }
  });

  // POST /api/kg/pull-apply (PullApplyRequest) — APPLY phase: download chosen-
  // remote + new files for a prior plan, keep chosen-local untouched. A stale/
  // unknown planId → 409 PLAN_EXPIRED (client re-plans). Files whose remote
  // checksum drifted since PLAN land in `stale` (not written).
  app.post('/api/kg/pull-apply', async (req, res) => {
    const body = (req.body ?? {}) as Partial<PullApplyRequest>;
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
    if (!projectId) return sendApiError(res, 400, 'BAD_REQUEST', 'projectId required');
    if (!planId) return sendApiError(res, 400, 'BAD_REQUEST', 'planId required');
    if (!getProject(db, projectId)) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    const resolutions: Record<string, PullResolution> =
      body.resolutions && typeof body.resolutions === 'object' ? body.resolutions : {};
    const onConflictDefault: PullResolution = body.onConflictDefault === 'remote' ? 'remote' : 'local';
    try {
      const result = await pipelines.pullConflict.apply(projectId, planId, resolutions, onConflictDefault);
      res.json({ ok: true, data: result });
    } catch (err) {
      if ((err as { code?: string }).code === ERR_PLAN_EXPIRED) {
        return sendApiError(res, 409, ERR_PLAN_EXPIRED, 'plan expired — re-plan and retry');
      }
      sendApiError(res, 502, 'KG_PULL_FAILED', (err as Error).message);
    }
  });

  // GET /api/kg/remote-projects — list every project living on the remote stores
  // (KGS graph ⊕ media-service files), merged by projectId. Independent of what
  // is mirrored locally, so the user can see + prune server-side leftovers.
  app.get('/api/kg/remote-projects', async (_req, res) => {
    try {
      const kgs = new KgsClient(kgsConfigFromEnv());
      const media = new MediaClient(mediaConfigFromEnv());
      const data = await loadRemoteProjects(kgs, media);
      res.json({ ok: true, data });
    } catch (err) {
      sendApiError(res, 502, 'KG_REMOTE_FAILED', (err as Error).message);
    }
  });

  // DELETE /api/kg/remote-projects/:id?scope=files — remove a project's remote
  // data. Phase 1 supports `files` only (media folder); `graph`/`all` are
  // reserved (KgsClient has no delete yet) and rejected with 400.
  app.delete('/api/kg/remote-projects/:id', async (req, res) => {
    const projectId = req.params.id;
    if (!projectId) return sendApiError(res, 400, 'BAD_REQUEST', 'project id required');
    const scope = (typeof req.query.scope === 'string' ? req.query.scope : 'files') as RemoteDeleteScope;
    if (scope !== 'files') {
      return sendApiError(res, 400, 'BAD_REQUEST', `scope "${scope}" not supported yet (only "files")`);
    }
    try {
      const media = new MediaClient(mediaConfigFromEnv());
      const result = await media.deleteProjectFiles(projectId);
      res.json({ ok: true, data: { projectId, scope, ...result } });
    } catch (err) {
      sendApiError(res, 502, 'KG_REMOTE_FAILED', (err as Error).message);
    }
  });
}
