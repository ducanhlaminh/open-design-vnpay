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
  type PublishResult,
  type PullApplyRequest,
  type PullResolution,
  type RemoteDeleteScope,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import { getMachineIdentityUser, identityAccessTokenOf, identityUserIdOf } from './auth-routes.js';
import { KgsClient, kgsConfigFromEnv } from './kg-sync/kgs-client.js';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';
import { pullProject } from './kg-sync/pull.js';
import { pushProject } from './kg-sync/push.js';
import { KgSyncRepo } from './kg-sync/persistence.js';
import {
  filterVisibleProjects,
  isProjectVisible,
  loadRemoteProjects,
  projectIdFromWorkspace,
} from './kg-sync/remote-registry.js';
import { ensureProjectRegistered, memberProjectAccess, pullScopeFor } from './kg-sync/identity-registry.js';
import { planPush } from './kg-sync/push-plan.js';
import { StagingBlockedError, studioConfigOf } from './kg-sync/push-dest.js';
import { resolveAppId } from './app-context.js';
import { featureContextBindingFromMetadata, parseAppContextManifest } from './app-context-version.js';
import { WORKFLOWS } from './pipelines.js';
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

  // Optional string[] body field ("projectIds"/"stages" pickers) → trimmed
  // list, or null when absent/empty (= no filter, legacy behavior).
  const stringList = (v: unknown): string[] | null => {
    if (!Array.isArray(v)) return null;
    const list = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    return list.length > 0 ? list : null;
  };

  // Resolve the effective stage filter for pull-all/push-all: explicit `stages`
  // wins; else `workflow` expands to that workflow's pipeline ids (CLI/API
  // convenience — the UI modals always send explicit stages). Throws on an
  // unknown workflow id so a typo doesn't silently sync everything.
  const stageFilterOf = (body: any): string[] | undefined => {
    const stages = stringList(body?.stages);
    if (stages) return stages;
    const workflowId = typeof body?.workflow === 'string' && body.workflow.trim() ? body.workflow.trim() : null;
    if (!workflowId) return undefined;
    const wf = WORKFLOWS.find((w) => w.id === workflowId);
    if (!wf) throw new Error(`unknown workflow: ${workflowId} (có: ${WORKFLOWS.map((w) => w.id).join(', ')})`);
    return [...wf.pipelineIds];
  };

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

  async function identityActor(): Promise<{ id: string; email: string; name: string; accessToken: string } | null> {
    const machine = await getMachineIdentityUser();
    const id = identityUserIdOf(machine);
    const accessToken = identityAccessTokenOf(machine);
    return machine && id && accessToken ? { id, email: machine.email, name: machine.name, accessToken } : null;
  }

  async function publishOne(
    project: { id: string; name?: string },
    stages?: string[],
  ): Promise<PublishResult> {
    const owner = await identityActor();
    // Local work remains usable during an identity outage, but every sync
    // operation requires the shared UUID. This keeps provider subjects out of
    // media, KGS and role/membership APIs and prevents orphaned submissions.
    if (!owner) {
      return {
        status: 'auth_required',
        projectId: project.id,
        code: 'SYNC_IDENTITY_REQUIRED',
        message: 'Tài khoản Google chưa được kết nối với kho dự án. Hãy kết nối lại rồi thử lại.',
        caveats: [],
      };
    }

    const cfg = kgsConfigFromEnv();
    const kgs = new KgsClient(cfg);
    const media = new MediaClient({
      ...mediaConfigFromEnv(),
      ...(owner ? { userId: owner.id } : {}),
    });
    try {
      const plan = await planPush({ db, projectId: project.id, kgs, media, submitter: owner });
      if (plan.reconciled?.status === 'rejected') {
        return {
          status: 'rejected',
          projectId: project.id,
          requestId: plan.reconciled.pendingId,
          reason: plan.reconciled.reason ?? 'Yêu cầu chia sẻ đã bị từ chối.',
          caveats: [],
        };
      }

      let workspace: 'created' | 'exists' | 'error' = 'exists';
      let nodesPushed = 0;
      let edgesPushed = 0;
      const caveats: string[] = [];
      if (!plan.staged) {
        try {
          workspace = await kgs.ensureWorkspace(plan.destId, project.name ?? project.id, owner);
        } catch (err) {
          workspace = 'error';
          caveats.push(`workspace: ${(err as Error).message}`);
        }
        const graph = await pushProject(db, project.id, cfg, Date.now(), randomId(), plan.destId);
        nodesPushed = graph.nodesPushed;
        edgesPushed = graph.edgesPushed;
        caveats.push(...graph.caveats, ...graph.errors);

        // A direct push needs registry membership as well as KGS/media data,
        // otherwise it would not appear in another user's Shared Projects list.
        const studio = studioConfigOf((getProject(db, project.id) as { metadata?: unknown } | null)?.metadata);
        if (studio.appId && studio.appId !== plan.destId) {
          try {
            await kgs.ensureWorkspace(studio.appId, studio.appName ?? studio.appId, owner);
          } catch (err) {
            caveats.push(`app workspace: ${(err as Error).message}`);
          }
          if (await ensureProjectRegistered(studio.appId, studio.appName ?? studio.appId, owner) === 'error') {
            caveats.push('app registry: không thể đăng ký Shared Project');
          }
        }
        if (await ensureProjectRegistered(plan.destId, project.name ?? project.id, owner) === 'error') {
          caveats.push('project registry: không thể đăng ký Shared Project');
        }
      }

      let filesUploaded = 0;
      let filesConverted = 0;
      try {
        const uploaded = await pipelines.uploadFiles(project.id, stages, plan);
        filesUploaded = uploaded.uploaded;
        filesConverted = uploaded.converted;
      } catch (err) {
        caveats.push(`files: ${(err as Error).message}`);
      }

      if (plan.staged) {
        return {
          status: 'pending_approval',
          projectId: project.id,
          requestId: plan.destId,
          requestedProjectId: project.id,
          filesUploaded,
          filesConverted,
          caveats,
        };
      }
      const current = getProject(db, project.id) as { metadata?: unknown } | null;
      const mapping = studioConfigOf(current?.metadata).approvedMapping;
      return {
        status: 'published',
        projectId: project.id,
        approvedProjectId: plan.destId,
        filesUploaded,
        filesConverted,
        nodesPushed,
        edgesPushed,
        workspace,
        ...(mapping ? { mapping } : {}),
        caveats,
      };
    } catch (err) {
      if (err instanceof StagingBlockedError) {
        return {
          status: 'auth_required',
          projectId: project.id,
          code: 'SYNC_IDENTITY_REQUIRED',
          message: err.message,
          caveats: [],
        };
      }
      return {
        status: 'error',
        projectId: project.id,
        message: (err as Error).message,
        caveats: [],
      };
    }
  }

  // POST /api/projects/:id/kg-pull — KGS (design-v3) → local SQLite mirror.
  app.post('/api/projects/:id/kg-pull', async (req, res) => {
    const projectId = req.params.id;
    if (!projectId) return sendApiError(res, 400, 'BAD_REQUEST', 'project id required');
    const now = Date.now();
    try {
      const actor = await identityActor();
      const scope = await pullScopeFor(actor?.id ?? null, actor?.accessToken);
      const appId = scope.all || scope.ids.has(projectId) ? null : await resolveAppId(projectId);
      if (!isProjectVisible(projectId, appId, scope)) {
        return sendApiError(res, 403, 'PROJECT_FORBIDDEN', scope.reason ?? 'Bạn không có quyền lấy dự án này.');
      }
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
    const project = getProject(db, projectId) as { id: string; name?: string };
    const result = await publishOne(project, stageFilterOf(req.body));
    res.json({ ok: result.status !== 'error', data: result });
  });

  // GET /api/projects/:id/kg-status — mirror counts (for UI/CLI status).
  app.get('/api/projects/:id/kg-status', (req, res) => {
    const projectId = req.params.id;
    if (!projectId) return sendApiError(res, 400, 'BAD_REQUEST', 'project id required');
    const counts = new KgSyncRepo(db).counts(projectId);
    res.json({ ok: true, data: { projectId, ...counts } });
  });

  // POST /api/kg/pull-all — pull KGS apps/projects into the local mirror.
  // Enumerates the workspaces in the KGS app graph, derives each one's project
  // id, and mirrors each into a local kg-pull project. Optional body filters
  // (both from the UI's Pull all modal): `projectIds` narrows WHICH projects,
  // `stages` narrows WHICH pipelines' output files travel (the graph pull
  // stays whole-project). Absent/empty → everything (legacy).
  app.post('/api/kg/pull-all', async (req, res) => {
    const now = Date.now();
    try {
      const requestedList = stringList(req.body?.projectIds);
      const requested = requestedList ? new Set(requestedList) : null;
      const stages = stageFilterOf(req.body);
      // Membership scope: dự án khai sinh ở studio → máy này chỉ pull các dự
      // án mà machine user (Google login gần nhất) được add vào; app admin
      // thấy tất; identity chưa cấu hình → legacy pull-everything.
      const actor = await identityActor();
      const scope = await pullScopeFor(actor?.id ?? null, actor?.accessToken);
      if (!scope.all && scope.ids.size === 0) {
        return res.json({
          ok: true,
          data: { pulled: 0, projectIds: [], results: [], ...(scope.reason ? { reason: scope.reason } : {}) },
        });
      }
      const cfg = kgsConfigFromEnv();
      const client = new KgsClient(cfg);
      const workspaces = await client.queryEntities(['DP_UI_WORKSPACE'], {});
      const candidateIds = Array.from(
        new Set(
          workspaces
            .map((ws) => projectIdFromWorkspace(ws as { entityId?: string; properties?: Record<string, unknown> }))
            .filter((x): x is string => Boolean(x)),
        ),
      ).filter((id) => !requested || requested.size === 0 || requested.has(id));
      // Membership cascades App → Feature (see isProjectVisible) — resolve
      // each candidate's appId only when actually needed (scope.all skips
      // this entirely; a direct scope.ids hit also skips the network call).
      const projectIds = scope.all
        ? candidateIds
        : (
            await Promise.all(
              candidateIds.map(async (id) => {
                const appId = scope.ids.has(id) ? null : await resolveAppId(id);
                return isProjectVisible(id, appId, scope) ? id : null;
              }),
            )
          ).filter((id): id is string => id != null);
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
            files = (await pipelines.pullFiles(projectId, stages)).pulled;
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

  // POST /api/kg/push-all — push pipeline-eligible KGS apps back at once.
  // Covers both pulled mirrors and locally-created (`kind: 'pipeline'`) projects.
  // Optional body filters (the UI's Push all modal): `projectIds` narrows WHICH
  // local projects, `stages` narrows WHICH pipelines' output files travel (the
  // graph push stays whole-project). Absent/empty → everything (legacy).
  app.post('/api/kg/push-all', async (req, res) => {
    try {
      const requestedList = stringList(req.body?.projectIds);
      const requested = requestedList ? new Set(requestedList) : null;
      const stages = stageFilterOf(req.body);
      const projects = listProjects(db)
        .filter((p: { metadata?: unknown }) => isKgsProject(p))
        .filter((p: { id: string }) => !requested || requested.has(p.id));
      const results = [];
      for (const p of projects as Array<{ id: string; name?: string }>) {
        results.push(await publishOne(p, stages));
      }
      res.json({ ok: true, data: { pushed: results.length, results } });
    } catch (err) {
      sendApiError(res, 502, 'KG_PUSH_FAILED', (err as Error).message);
    }
  });

  // POST /api/kg/sync-status { projectIds? } — per-stage local↔remote file diff
  // for the Pull all / Push all modals' "≠ remote" badges and `od kg diff`.
  // Read-only; per-project failures degrade to an `error` row so one broken
  // project can't blank the whole panel.
  app.post('/api/kg/sync-status', async (req, res) => {
    try {
      const requestedList = stringList(req.body?.projectIds);
      const requested = requestedList ? new Set(requestedList) : null;
      const projects = listProjects(db)
        .filter((p: { metadata?: unknown }) => isKgsProject(p))
        .filter((p: { id: string }) => !requested || requested.has(p.id));
      const results = [];
      for (const p of projects as Array<{ id: string }>) {
        try {
          results.push(await pipelines.syncStatus(p.id));
        } catch (err) {
          results.push({ projectId: p.id, stages: [], error: (err as Error).message });
        }
      }
      res.json({ ok: true, data: { results } });
    } catch (err) {
      sendApiError(res, 502, 'KG_SYNC_STATUS_FAILED', (err as Error).message);
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

  // GET /api/kg/remote-projects — list the remote projects (KGS graph ⊕ media
  // files, merged by projectId) VISIBLE TO THIS MACHINE'S USER: dự án khai
  // sinh ở studio nên user thường chỉ thấy dự án mình được add vào; app admin
  // thấy tất; identity chưa cấu hình → mọi thứ (legacy). Drives the Pull all
  // modal + `od kg remote list`.
  app.get('/api/kg/remote-projects', async (_req, res) => {
    try {
      const kgs = new KgsClient(kgsConfigFromEnv());
      const media = new MediaClient(mediaConfigFromEnv());
      const actor = await identityActor();
      const scope = await pullScopeFor(actor?.id ?? null, actor?.accessToken);
      // `scope.all` is an app-admin discovery override, not a project-level
      // role. Never fabricate `admin` in summaries; only surface roles that
      // identity actually returned for this caller.
      const roles = !scope.all && actor ? await memberProjectAccess(actor.id, actor.accessToken) : null;
      const data = await loadRemoteProjects(kgs, media);
      // App → Feature grouping (mirrors pipeline-studio's App concept): a
      // feature's project.json optionally carries an appId linking it to its
      // parent App. Resolved for EVERY feature (not just the ones already in
      // scope) so membership can cascade below — pipeline-studio's own App
      // detail page shows every linked feature once you can see the app, with
      // no separate per-feature membership check; Open Design must match that
      // or a feature under an app you own/are a member of is invisible here
      // even though you can see it fine in the studio. Best-effort per
      // project — one project.json read failing must not fail the whole list.
      await Promise.all(
        data
          .filter((p) => !p.isApp)
          .map(async (p) => {
            p.appId = await resolveAppId(p.projectId);
          }),
      );
      const visible = filterVisibleProjects(data, scope);
      const localIds = new Set(listProjects(db).map((p: { id: string }) => p.id));
      const byId = new Map(data.map((p) => [p.projectId, p]));
      const summaries = await Promise.all(
        visible.map(async (project) => {
          const files = await media.listFiles(project.projectId).catch(() => []);
          const availableOutputs = [
            ...new Set(
              files
                .map((f) => (typeof f.stage === 'string' ? f.stage : ''))
                .filter((stage) => stage && stage !== 'staging'),
            ),
          ].sort();
          let lastPublishedAt: string | null = null;
          let version: string | null = null;
          try {
            const raw = JSON.parse(
              (await media.downloadFile(project.projectId, 'changelog.json')).toString('utf8'),
            ) as Array<{ at?: string; verId?: string }>;
            const latest = Array.isArray(raw) ? raw.at(-1) : null;
            lastPublishedAt = typeof latest?.at === 'string' ? latest.at : null;
            version = typeof latest?.verId === 'string' ? latest.verId : null;
          } catch {
            // Legacy projects may not have a changelog yet.
          }
          let appContext: {
            current: NonNullable<ReturnType<typeof parseAppContextManifest>>;
            localCurrentDigest?: `sha256:${string}` | null;
          } | undefined;
          if (project.isApp) {
            try {
              const pointer = JSON.parse(
                (await media.downloadFile(project.projectId, 'context/current.json')).toString('utf8'),
              ) as Record<string, unknown>;
              const contextVersion = typeof pointer.contextVersion === 'string' && /^v[1-9]\d*$/.test(pointer.contextVersion)
                ? pointer.contextVersion
                : null;
              if (contextVersion) {
                const current = parseAppContextManifest(JSON.parse(
                  (await media.downloadFile(project.projectId, `context/versions/${contextVersion}/manifest.json`)).toString('utf8'),
                ));
                if (current) appContext = { current, localCurrentDigest: null };
              }
            } catch {
              // Legacy App without versioned context.
            }
          }
          let appContextBinding;
          if (!project.isApp) {
            try {
              const config = JSON.parse(
                (await media.downloadFile(project.projectId, 'project.json')).toString('utf8'),
              ) as Record<string, unknown>;
              appContextBinding = featureContextBindingFromMetadata({ appContextBinding: config.appContextBinding });
            } catch {
              // Legacy Feature without a binding.
            }
          }
          return {
            ...project,
            displayName: project.name || project.projectId,
            appName: project.appId ? (byId.get(project.appId)?.name ?? project.appId) : null,
            ownerName: null,
            lastPublishedAt,
            version,
            availableOutputs,
            alreadyOnThisDevice: localIds.has(project.projectId),
            accessRole: roles?.get(project.projectId)
              ?? (project.appId ? roles?.get(project.appId) : undefined)
              ?? ('viewer' as const),
            ...(appContext ? { appContext } : {}),
            ...(appContextBinding ? { appContextBinding } : {}),
          };
        }),
      );
      res.json({ ok: true, data: summaries, ...(scope.reason ? { reason: scope.reason } : {}) });
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
