import path from 'node:path';

import type { Express } from 'express';
import type {
  DesignSystemSyncDigest,
  DesignSystemUsage,
  PublishDesignSystemRequest,
  PublishDesignSystemResult,
  PullDesignSystemPlanRequest,
  PullDesignSystemRequest,
  PullDesignSystemResult,
} from '@open-design/contracts';

import { getMachineIdentityUser, identityUserIdOf } from './auth-routes.js';
import { getPipelineApp, listPipelineApps, listProjects } from './db.js';
import { featureContextBindingFromMetadata } from './app-context-version.js';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';
import {
  designSystemSyncStatus,
  installPulledDesignSystem,
  listRemoteDesignSystems,
  planPullDesignSystem,
  publishDesignSystem,
} from './design-system-sync.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterDesignSystemSyncRoutesDeps extends RouteDeps<'db' | 'paths' | 'http'> {}

function bareId(raw: string): string | null {
  const value = raw.replace(/^user:/, '').trim();
  return value && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..' ? value : null;
}

export function registerDesignSystemSyncRoutes(app: Express, deps: RegisterDesignSystemSyncRoutesDeps): void {
  const { db, paths } = deps;
  const { sendApiError } = deps.http;
  const localDir = (id: string) => {
    const bare = bareId(id);
    return bare ? path.join(paths.USER_DESIGN_SYSTEMS_DIR, bare) : null;
  };
  const authenticatedStore = async () => {
    const machine = await getMachineIdentityUser();
    const userId = identityUserIdOf(machine);
    return userId && machine ? { machine, userId, media: new MediaClient({ ...mediaConfigFromEnv(), userId }) } : null;
  };
  const usageFor = (designSystemId: string): DesignSystemUsage[] => {
    const usages: DesignSystemUsage[] = [];
    for (const localApp of listPipelineApps(db).filter((item) => item.designSystemId === designSystemId)) {
      usages.push({ kind: 'app', appId: localApp.id, appName: localApp.name });
    }
    for (const feature of listProjects(db)) {
      const binding = featureContextBindingFromMetadata(feature.metadata);
      if (!binding) continue;
      const localApp = getPipelineApp(db, binding.appId);
      if (localApp?.designSystemId !== designSystemId) continue;
      usages.push({ kind: 'feature', appId: binding.appId, appName: localApp.name, featureId: feature.id,
        featureName: feature.name, contextVersion: binding.contextVersion, contextDigest: binding.contentDigest });
    }
    return usages;
  };

  app.get('/api/design-systems/sync/remote', async (req, res) => {
    try {
      const auth = await authenticatedStore();
      if (!auth) return sendApiError(res, 401, 'SYNC_IDENTITY_REQUIRED', 'Tài khoản chưa được kết nối với kho dự án.');
      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLocaleLowerCase('vi') : '';
      const all = await listRemoteDesignSystems(auth.media);
      const items = q ? all.filter((item) => `${item.name} ${item.remoteDesignSystemId} ${item.owner.name ?? ''}`.toLocaleLowerCase('vi').includes(q)) : all;
      res.json({ ok: true, data: { items, total: items.length } });
    } catch (error) { sendApiError(res, 502, 'DS_SYNC_REMOTE_LIST_FAILED', (error as Error).message); }
  });

  app.get('/api/design-systems/:id/sync/status', async (req, res) => {
    try {
      const auth = await authenticatedStore();
      if (!auth) return sendApiError(res, 401, 'SYNC_IDENTITY_REQUIRED', 'Tài khoản chưa được kết nối với kho dự án.');
      const id = `user:${bareId(req.params.id) ?? ''}`; const dir = localDir(id);
      if (!dir) return sendApiError(res, 400, 'BAD_REQUEST', 'Design System id is invalid');
      const data = await designSystemSyncStatus({ dsDir: dir, localDesignSystemId: id, store: auth.media, usage: usageFor(id) });
      res.json({ ok: true, data });
    } catch (error) { sendApiError(res, 404, 'DESIGN_SYSTEM_NOT_FOUND', (error as Error).message); }
  });

  app.post('/api/design-systems/:id/sync/push', async (req, res) => {
    const localDesignSystemId = `user:${bareId(req.params.id) ?? ''}`;
    try {
      const auth = await authenticatedStore();
      if (!auth) {
        const data: PublishDesignSystemResult = { status: 'auth_required', code: 'SYNC_IDENTITY_REQUIRED', message: 'Tài khoản chưa được kết nối với kho dự án.' };
        return res.status(401).json({ ok: false, data });
      }
      const dir = localDir(localDesignSystemId);
      if (!dir) return sendApiError(res, 400, 'BAD_REQUEST', 'Design System id is invalid');
      const body = (req.body ?? {}) as PublishDesignSystemRequest;
      const result = await publishDesignSystem({ dsDir: dir, localDesignSystemId, store: auth.media,
        owner: { id: auth.userId, ...(auth.machine.email ? { email: auth.machine.email } : {}), ...(auth.machine.name ? { name: auth.machine.name } : {}) },
        usage: usageFor(localDesignSystemId), ...(body.expectedRemoteDigest !== undefined ? { expectedRemoteDigest: body.expectedRemoteDigest } : {}) });
      const data: PublishDesignSystemResult = result.unchanged
        ? { status: 'unchanged', summary: result.summary, manifest: result.manifest }
        : { status: 'published', summary: result.summary, manifest: result.manifest, uploadedVersions: result.uploadedVersions };
      res.json({ ok: true, data });
    } catch (error) {
      const e = error as Error & { code?: string; reason?: any; remote?: any };
      if (e.code === 'DS_SYNC_BLOCKED') {
        const data: PublishDesignSystemResult = { status: 'blocked', localDesignSystemId, reason: e.reason, message: e.message };
        return res.status(409).json({ ok: false, data });
      }
      if (e.code === 'DS_SYNC_CONFLICT') {
        const localDigest = (await designSystemSyncStatus({ dsDir: localDir(localDesignSystemId)!, localDesignSystemId, store: (await authenticatedStore())!.media, usage: usageFor(localDesignSystemId) })).localDigest;
        const data: PublishDesignSystemResult = { status: 'conflict', localDesignSystemId,
          remoteDesignSystemId: e.remote?.remoteDesignSystemId ?? localDesignSystemId.replace(/^user:/, ''), localDigest,
          remoteDigest: e.remote?.currentDigest ?? 'sha256:' as DesignSystemSyncDigest };
        return res.status(409).json({ ok: false, data });
      }
      const data: PublishDesignSystemResult = { status: 'error', message: e.message };
      res.status(502).json({ ok: false, data });
    }
  });

  app.post('/api/design-systems/sync/pull/plan', async (req, res) => {
    try {
      const auth = await authenticatedStore();
      if (!auth) return sendApiError(res, 401, 'SYNC_IDENTITY_REQUIRED', 'Tài khoản chưa được kết nối với kho dự án.');
      const body = req.body as PullDesignSystemPlanRequest;
      if (!body?.remoteDesignSystemId) return sendApiError(res, 400, 'BAD_REQUEST', 'remoteDesignSystemId is required');
      const plan = await planPullDesignSystem({ userDesignSystemsDir: paths.USER_DESIGN_SYSTEMS_DIR,
        remoteDesignSystemId: body.remoteDesignSystemId, ...(body.version ? { version: body.version } : {}),
        ...(body.localDesignSystemId ? { localDesignSystemId: body.localDesignSystemId } : {}), store: auth.media });
      if (!plan) return sendApiError(res, 404, 'REMOTE_DESIGN_SYSTEM_NOT_FOUND', 'Không tìm thấy bộ Design System trên kho chung.');
      res.json({ ok: true, data: plan });
    } catch (error) { sendApiError(res, 502, 'DS_SYNC_PULL_PLAN_FAILED', (error as Error).message); }
  });

  app.post('/api/design-systems/sync/pull', async (req, res) => {
    try {
      const auth = await authenticatedStore();
      if (!auth) {
        const data: PullDesignSystemResult = { status: 'auth_required', code: 'SYNC_IDENTITY_REQUIRED', message: 'Tài khoản chưa được kết nối với kho dự án.' };
        return res.status(401).json({ ok: false, data });
      }
      const body = req.body as PullDesignSystemRequest;
      if (!body?.remoteDesignSystemId) return sendApiError(res, 400, 'BAD_REQUEST', 'remoteDesignSystemId is required');
      const plan = await planPullDesignSystem({ userDesignSystemsDir: paths.USER_DESIGN_SYSTEMS_DIR,
        remoteDesignSystemId: body.remoteDesignSystemId, ...(body.version ? { version: body.version } : {}),
        ...(body.localDesignSystemId ? { localDesignSystemId: body.localDesignSystemId } : {}), store: auth.media });
      if (!plan) { const data: PullDesignSystemResult = { status: 'not_found', remoteDesignSystemId: body.remoteDesignSystemId }; return res.status(404).json({ ok: false, data }); }
      if (body.resolution === 'keep_local') { const data: PullDesignSystemResult = { status: 'kept_local', localDesignSystemId: plan.localDesignSystemId, remoteDesignSystemId: body.remoteDesignSystemId, bindingsChanged: false, contextCreated: false }; return res.json({ ok: true, data }); }
      if (body.expectedLocalDigest !== undefined && plan.localDigest !== body.expectedLocalDigest) { const data: PullDesignSystemResult = { status: 'conflict', plan }; return res.status(409).json({ ok: false, data }); }
      if (plan.localDigest === plan.manifest.contentDigest) { const data: PullDesignSystemResult = { status: 'unchanged', localDesignSystemId: plan.localDesignSystemId, remoteDesignSystemId: body.remoteDesignSystemId, manifest: plan.manifest, bindingsChanged: false, contextCreated: false }; return res.json({ ok: true, data }); }
      if (plan.conflict && body.resolution !== 'use_remote') { const data: PullDesignSystemResult = { status: 'conflict', plan }; return res.status(409).json({ ok: false, data }); }
      await installPulledDesignSystem({ userDesignSystemsDir: paths.USER_DESIGN_SYSTEMS_DIR, plan, store: auth.media });
      const data: PullDesignSystemResult = { status: 'pulled', localDesignSystemId: plan.localDesignSystemId, remoteDesignSystemId: body.remoteDesignSystemId, manifest: plan.manifest, bindingsChanged: false, contextCreated: false };
      res.json({ ok: true, data });
    } catch (error) { const data: PullDesignSystemResult = { status: 'error', message: (error as Error).message }; res.status(502).json({ ok: false, data }); }
  });
}
