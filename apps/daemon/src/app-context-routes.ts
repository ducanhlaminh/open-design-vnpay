import fs from 'node:fs';
import path from 'node:path';

import type { Express } from 'express';
import type {
  AppContextManifest,
  BindFeatureContextRequest,
  FeatureContextBinding,
  PullAppContextResult,
  PublishAppContextResult,
} from '@open-design/contracts';

import { getMachineIdentityUser, identityAccessTokenOf, identityUserIdOf } from './auth-routes.js';
import {
  getPipelineApp,
  getProject,
  listProjects,
  setPipelineAppDesignSystem,
  setPipelineAppDocsReviewComponentSource,
  upsertPipelineAppName,
  updateProject,
} from './db.js';
import {
  createAppContextVersion,
  appContextManifestDigestIsValid,
  featureContextBindingFromMetadata,
  filesForAppContextPublish,
  installAppContextVersion,
  listAppContextVersions,
  materializeAppContextVersion,
  metadataWithFeatureContextBinding,
  parseAppContextManifest,
  parseManifestComponentSource,
  readCurrentAppContextManifest,
  readAppContextManifest,
} from './app-context-version.js';
import { MediaClient, mediaConfigFromEnv, type LocalSyncFile } from './kg-sync/media-client.js';
import { ensureProjectRegistered } from './kg-sync/identity-registry.js';
import { studioConfigOf } from './kg-sync/push-dest.js';
import type { RouteDeps } from './server-context.js';

interface AppContextPublishState {
  schemaVersion: 1;
  appId: string;
  approvedAppId?: string;
  pendingId?: string;
  rejected?: { requestId: string; reason: string; decidedAt: string };
}

export interface RegisterAppContextRoutesDeps extends RouteDeps<'db' | 'paths' | 'http'> {}

function publishStatePath(projectsDir: string, appId: string): string {
  return path.join(projectsDir, appId, 'context', 'publish.json');
}

async function readPublishState(projectsDir: string, appId: string): Promise<AppContextPublishState> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(publishStatePath(projectsDir, appId), 'utf8')) as Record<string, unknown>;
    const rejectedRaw = raw.rejected && typeof raw.rejected === 'object' && !Array.isArray(raw.rejected)
      ? raw.rejected as Record<string, unknown>
      : null;
    const rejected = rejectedRaw
      && typeof rejectedRaw.requestId === 'string'
      && typeof rejectedRaw.reason === 'string'
      && typeof rejectedRaw.decidedAt === 'string'
      ? { requestId: rejectedRaw.requestId, reason: rejectedRaw.reason, decidedAt: rejectedRaw.decidedAt }
      : null;
    return {
      schemaVersion: 1,
      appId,
      ...(typeof raw.approvedAppId === 'string' && raw.approvedAppId ? { approvedAppId: raw.approvedAppId } : {}),
      ...(typeof raw.pendingId === 'string' && raw.pendingId ? { pendingId: raw.pendingId } : {}),
      ...(rejected ? { rejected } : {}),
    };
  } catch {
    return { schemaVersion: 1, appId };
  }
}

async function writePublishState(projectsDir: string, appId: string, state: AppContextPublishState): Promise<void> {
  const target = publishStatePath(projectsDir, appId);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.promises.rename(temp, target);
}

function appRemoteIdFromFeatures(db: any, appId: string): string | null {
  for (const feature of listProjects(db)) {
    const sc = studioConfigOf(feature.metadata);
    if (sc.appId === appId && sc.approvedMapping?.approvedAppId) return sc.approvedMapping.approvedAppId;
  }
  return null;
}

async function designSystemDir(
  id: string | null,
  roots: { USER_DESIGN_SYSTEMS_DIR: string; DESIGN_SYSTEMS_DIR: string },
): Promise<string | null> {
  if (!id) return null;
  const bare = id.replace(/^user:/, '');
  if (!bare || bare.includes('/') || bare.includes('\\') || bare.includes('..')) return null;
  for (const root of [roots.USER_DESIGN_SYSTEMS_DIR, roots.DESIGN_SYSTEMS_DIR]) {
    const candidate = path.join(root, bare);
    if (await fs.promises.stat(candidate).then((s) => s.isDirectory(), () => false)) return candidate;
  }
  return null;
}

function mimeForContext(filePath: string): string {
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.md')) return 'text/markdown';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

export function registerAppContextRoutes(app: Express, deps: RegisterAppContextRoutesDeps): void {
  const { db, paths } = deps;
  const { sendApiError } = deps.http;

  async function snapshot(appId: string, expectedCurrentDigest?: `sha256:${string}` | null) {
    const localApp = getPipelineApp(db, appId);
    if (!localApp) throw Object.assign(new Error('App not found'), { code: 'APP_NOT_FOUND' });
    return createAppContextVersion({
      projectsDir: paths.PROJECTS_DIR,
      appId,
      appName: localApp.name,
      designSystemId: localApp.designSystemId,
      docsReviewComponentSource: localApp.docsReviewComponentSource,
      designSystemDir: await designSystemDir(localApp.designSystemId, paths),
      ...(expectedCurrentDigest !== undefined ? { expectedCurrentDigest } : {}),
    });
  }

  app.get('/api/pipelines/apps/:appId/context', async (req, res) => {
    try {
      const appId = req.params.appId;
      const localApp = getPipelineApp(db, appId);
      if (!localApp) return sendApiError(res, 404, 'APP_NOT_FOUND', 'App not found');
      const [current, versions] = await Promise.all([
        readCurrentAppContextManifest(paths.PROJECTS_DIR, appId),
        listAppContextVersions(paths.PROJECTS_DIR, appId),
      ]);
      const bindings = listProjects(db).flatMap((feature) => {
        const binding = featureContextBindingFromMetadata(feature.metadata);
        return binding?.appId === appId ? [{ featureId: feature.id, featureName: feature.name, binding }] : [];
      });
      res.json({ ok: true, data: { appId, appName: localApp.name, current, versions, bindings } });
    } catch (error) {
      sendApiError(res, 500, 'APP_CONTEXT_READ_FAILED', (error as Error).message);
    }
  });

  app.post('/api/pipelines/apps/:appId/context/versions', async (req, res) => {
    try {
      const expected = typeof req.body?.expectedCurrentDigest === 'string'
        ? req.body.expectedCurrentDigest as `sha256:${string}`
        : req.body?.expectedCurrentDigest === null ? null : undefined;
      const result = await snapshot(req.params.appId, expected);
      res.status(result.status === 'created' ? 201 : 200).json({ ok: true, data: result });
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      sendApiError(res, code === 'APP_NOT_FOUND' ? 404 : code === 'APP_CONTEXT_CHANGED' ? 409 : 500, code ?? 'APP_CONTEXT_SNAPSHOT_FAILED', (error as Error).message);
    }
  });

  app.post('/api/projects/:featureId/context-binding', async (req, res) => {
    const feature = getProject(db, req.params.featureId);
    if (!feature) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Feature not found');
    const body = req.body as Partial<BindFeatureContextRequest>;
    if (!body.appId || !body.contextVersion || !body.contentDigest) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'appId, contextVersion and contentDigest are required');
    }
    try {
      const manifest = await readAppContextManifest(paths.PROJECTS_DIR, body.appId, body.contextVersion);
      if (!manifest || manifest.contentDigest !== body.contentDigest) {
        return sendApiError(res, 409, 'APP_CONTEXT_VERSION_MISMATCH', 'App Context version/digest is unavailable');
      }
      const featureAppId = studioConfigOf(feature.metadata).appId;
      if (featureAppId && featureAppId !== body.appId) {
        return sendApiError(res, 409, 'APP_CONTEXT_APP_MISMATCH', 'Feature belongs to a different App');
      }
      const binding: FeatureContextBinding = {
        schemaVersion: 1,
        appId: body.appId,
        contextVersion: body.contextVersion,
        contentDigest: body.contentDigest,
        boundAt: new Date().toISOString(),
      };
      updateProject(db, feature.id, { metadata: metadataWithFeatureContextBinding(feature.metadata, binding) });
      res.json({ ok: true, data: { featureId: feature.id, binding } });
    } catch (error) {
      sendApiError(res, 500, 'APP_CONTEXT_BIND_FAILED', (error as Error).message);
    }
  });

  app.post('/api/pipelines/apps/:appId/context/push', async (req, res) => {
    const appId = req.params.appId;
    try {
      const machine = await getMachineIdentityUser();
      const userId = identityUserIdOf(machine);
      const accessToken = identityAccessTokenOf(machine);
      if (!machine || !userId || !accessToken) {
        const data: PublishAppContextResult = {
          status: 'auth_required', appId, code: 'SYNC_IDENTITY_REQUIRED',
          message: 'Tài khoản chưa được kết nối với kho dự án.',
        };
        return res.json({ ok: true, data });
      }
      const localApp = getPipelineApp(db, appId);
      if (!localApp) return sendApiError(res, 404, 'APP_NOT_FOUND', 'App not found');
      const media = new MediaClient({ ...mediaConfigFromEnv(), userId });
      let state = await readPublishState(paths.PROJECTS_DIR, appId);
      // A pending id from the former approval workflow must never keep a new
      // App Context push off Shared Projects.
      if (state.pendingId) {
        state = { schemaVersion: 1, appId, ...(state.approvedAppId ? { approvedAppId: state.approvedAppId } : {}) };
        await writePublishState(paths.PROJECTS_DIR, appId, state);
      }
      const requestedVersion = typeof req.body?.contextVersion === 'string' && /^v[1-9]\d*$/.test(req.body.contextVersion)
        ? req.body.contextVersion as `v${number}`
        : null;
      const current = requestedVersion
        ? await readAppContextManifest(paths.PROJECTS_DIR, appId, requestedVersion)
        : (await snapshot(appId)).manifest;
      if (!current) return sendApiError(res, 404, 'APP_CONTEXT_VERSION_NOT_FOUND', 'App Context version not found');
      const packageFiles = await filesForAppContextPublish({ projectsDir: paths.PROJECTS_DIR, appId, contextVersion: current.contextVersion });
      const appJson = Buffer.from(`${JSON.stringify({
        kind: 'app', name: localApp.name, designSystemId: localApp.designSystemId,
        docsReviewComponentSource: localApp.docsReviewComponentSource,
        contextVersion: current.contextVersion, contextDigest: current.contentDigest,
      }, null, 2)}\n`);
      const approvedAppId = state.approvedAppId ?? appRemoteIdFromFeatures(db, appId);
      const destination = approvedAppId ?? appId;
      const syncFiles: LocalSyncFile[] = [
        { path: 'app.json', stage: 'app-context', mime: 'application/json', content: appJson },
        ...packageFiles.map((file) => ({ path: file.path, stage: 'app-context', mime: mimeForContext(file.path), content: file.content })),
      ];
      await media.syncProjectFiles(destination, syncFiles);
      const owner = { id: userId, email: machine.email, name: machine.name, accessToken };
      await ensureProjectRegistered(destination, localApp.name, owner).catch((error) => {
        console.warn(`[app-context] identity registration failed for ${destination}:`, error);
      });
      await writePublishState(paths.PROJECTS_DIR, appId, { schemaVersion: 1, appId, approvedAppId: destination });
      const data: PublishAppContextResult = { status: 'published', appId, manifest: current };
      res.json({ ok: true, data });
    } catch (error) {
      const data: PublishAppContextResult = { status: 'error', appId, message: (error as Error).message };
      res.status(502).json({ ok: false, data });
    }
  });

  app.post('/api/pipelines/apps/:appId/context/pull', async (req, res) => {
    const appId = req.params.appId;
    try {
      const machine = await getMachineIdentityUser();
      const userId = identityUserIdOf(machine);
      if (!userId) return sendApiError(res, 401, 'SYNC_IDENTITY_REQUIRED', 'Tài khoản chưa được kết nối với kho dự án.');
      const state = await readPublishState(paths.PROJECTS_DIR, appId);
      const remoteAppId = typeof req.body?.remoteAppId === 'string' && req.body.remoteAppId
        ? req.body.remoteAppId
        : state.approvedAppId ?? appRemoteIdFromFeatures(db, appId) ?? appId;
      const media = new MediaClient({ ...mediaConfigFromEnv(), userId });
      const remoteAppJson = await media.downloadFile(remoteAppId, 'app.json').then(
        (content) => JSON.parse(content.toString('utf8')) as Record<string, unknown>,
        () => ({} as Record<string, unknown>),
      );
      const pointerRaw = JSON.parse((await media.downloadFile(remoteAppId, 'context/current.json')).toString('utf8')) as Record<string, unknown>;
      const version = typeof req.body?.contextVersion === 'string' && /^v[1-9]\d*$/.test(req.body.contextVersion)
        ? req.body.contextVersion as `v${number}`
        : typeof pointerRaw.contextVersion === 'string' && /^v[1-9]\d*$/.test(pointerRaw.contextVersion)
          ? pointerRaw.contextVersion as `v${number}`
          : null;
      if (!version) {
        const data: PullAppContextResult = { status: 'not_found', appId };
        return res.status(404).json({ ok: false, data });
      }
      const manifestRaw = JSON.parse((await media.downloadFile(remoteAppId, `context/versions/${version}/manifest.json`)).toString('utf8'));
      const manifest = parseAppContextManifest(manifestRaw);
      if (!manifest || !appContextManifestDigestIsValid(manifest)) throw new Error('Remote App Context manifest is malformed');
      const local = await readCurrentAppContextManifest(paths.PROJECTS_DIR, appId);
      const expected = typeof req.body?.expectedLocalDigest === 'string' ? req.body.expectedLocalDigest : req.body?.expectedLocalDigest === null ? null : undefined;
      if (expected !== undefined && (local?.contentDigest ?? null) !== expected) {
        const data: PullAppContextResult = {
          status: 'conflict', appId, localDigest: local?.contentDigest ?? '', remoteDigest: manifest.contentDigest, bindingChanged: false,
        };
        return res.status(409).json({ ok: false, data });
      }
      if (local?.contentDigest === manifest.contentDigest) {
        const data: PullAppContextResult = { status: 'unchanged', appId, manifest, bindingChanged: false };
        return res.json({ ok: true, data });
      }
      const contents = new Map<string, Buffer>();
      for (const file of manifest.files) {
        contents.set(file.path, await media.downloadFile(remoteAppId, `context/versions/${version}/files/${file.path}`));
      }
      await installAppContextVersion({ projectsDir: paths.PROJECTS_DIR, appId, manifest, files: contents });
      await materializeAppContextVersion({ projectsDir: paths.PROJECTS_DIR, appId, contextVersion: manifest.contextVersion });
      // App-only Pull must materialize the container as well as its files; this
      // is what lets a zero-Feature remote App appear on the Apps route.
      const pulledName = typeof remoteAppJson.name === 'string' && remoteAppJson.name
        ? remoteAppJson.name
        : manifest.appName || appId;
      const pulledDesignSystemId = typeof remoteAppJson.designSystemId === 'string' && remoteAppJson.designSystemId
        ? remoteAppJson.designSystemId
        : manifest.designSystem.id;
      upsertPipelineAppName(db, { id: appId, name: pulledName, createdAt: Date.now() });
      setPipelineAppDesignSystem(db, {
        id: appId,
        name: pulledName,
        designSystemId: pulledDesignSystemId,
        createdAt: Date.now(),
      });
      setPipelineAppDocsReviewComponentSource(db, {
        id: appId,
        name: pulledName,
        source: parseManifestComponentSource(
          remoteAppJson.docsReviewComponentSource ?? manifest.docsReviewComponentSource,
        ),
        createdAt: Date.now(),
      });
      if (remoteAppId !== appId) {
        await writePublishState(paths.PROJECTS_DIR, appId, { schemaVersion: 1, appId, approvedAppId: remoteAppId });
      }
      const data: PullAppContextResult = { status: 'pulled', appId, manifest, bindingChanged: false };
      res.json({ ok: true, data });
    } catch (error) {
      const data: PullAppContextResult = { status: 'error', appId, message: (error as Error).message };
      res.status(502).json({ ok: false, data });
    }
  });
}
