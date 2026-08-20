// App Docs Pool — HTTP routes (docs/app-docs-pool-spec.md §2.2 / §WP-1).
// One deterministic Confluence import per App + a gate-readable pool view +
// page deletion.

import type { Express } from 'express';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AppImportJob } from '@open-design/contracts';

import { getFigmaDesignSystemSource, getPipelineApp, listPipelineApps, listProjects } from './db.js';
import type { FigmaComponentCatalogSnapshot } from './figma-component-catalog.js';
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
  /** Test/instrumentation hook at the non-cancellable pool commit boundary. */
  onImportCommitStart?: (appId: string) => void | Promise<void>;
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
  // Explicit operation ids make cancellation reliable across proxies where
  // aborting the browser's POST does not necessarily close the daemon request.
  type ActiveImport = { controller: AbortController; phase: 'preparing' | 'committing' };
  const activeImports = new Map<string, ActiveImport>();
  const activeImportByApp = new Map<string, string>();
  const cancelledBeforeStart = new Map<string, number>();
  const completedImports = new Map<string, number>();
  const CANCEL_TOMBSTONE_TTL_MS = 60_000;
  const rememberOperationMarker = (store: Map<string, number>, key: string) => {
    const expiresAt = Date.now() + CANCEL_TOMBSTONE_TTL_MS;
    store.set(key, expiresAt);
    const timer = setTimeout(() => {
      if (store.get(key) === expiresAt) store.delete(key);
    }, CANCEL_TOMBSTONE_TTL_MS);
    timer.unref();
  };
  const importKey = (appId: string, operationId: string) => `${appId}\u0000${operationId}`;

  // WP22: background import jobs — daemon-side replacement for the browser's
  // per-batch loop (contract: .tmp/pipeline/wp22-contract.md). Job registry
  // is in-memory only (lost on daemon restart; the pool itself keeps
  // whatever batches already committed) and TTL-pruned lazily on the next
  // request, mirroring `completedImports`/`cancelledBeforeStart` above — no
  // setInterval.
  type ImportJobEntry = { job: AppImportJob; controller: AbortController; stopRequested: boolean };
  const importJobs = new Map<string, ImportJobEntry>();
  const IMPORT_JOB_BATCH_SIZE = 8;
  const IMPORT_JOB_TTL_MS = 10 * 60_000;
  // Marker stored in `activeImportByApp` for a background job — distinct from
  // the sync route's `importKey(appId, operationId)` values but read through
  // the SAME map so the two kinds of import are mutually exclusive per App.
  const jobActiveMarker = (jobId: string) => `job:${jobId}`;
  const pruneImportJobs = () => {
    const now = Date.now();
    for (const [id, entry] of importJobs) {
      if (entry.job.status === 'running') continue;
      if (entry.job.finishedAt !== undefined && now - entry.job.finishedAt > IMPORT_JOB_TTL_MS) importJobs.delete(id);
    }
  };
  const chunkRefs = (refs: string[], size: number): string[][] => {
    const batches: string[][] = [];
    for (let i = 0; i < refs.length; i += size) batches.push(refs.slice(i, i + size));
    return batches;
  };

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
      figmaDesignSystemSource: app?.figmaDesignSystemSourceId
        ? (() => {
            const source = getFigmaDesignSystemSource(db, app.figmaDesignSystemSourceId);
            return source?.catalog ? { id: source.id, catalog: source.catalog as FigmaComponentCatalogSnapshot } : null;
          })()
        : null,
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

  // GET /api/pipelines/app-import-jobs/active — WP22. Registered ahead of the
  // /api/pipelines/apps/:appId/... routes below: the path segments never
  // actually collide ("app-import-jobs" vs "apps"), but the contract calls
  // for this ordering explicitly, so it's kept first for anyone reading
  // route registration order as a guide to precedence.
  app.get('/api/pipelines/app-import-jobs/active', (_req, res) => {
    pruneImportJobs();
    const jobs: AppImportJob[] = [...importJobs.values()].map((entry) => ({ ...entry.job }));
    res.json({ jobs });
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
    const rawOperationId = typeof req.body?.operationId === 'string' ? req.body.operationId.trim() : '';
    if (rawOperationId && !/^[A-Za-z0-9_-]{8,128}$/.test(rawOperationId)) {
      return res.status(400).json({ error: 'operationId is invalid' });
    }
    const operationId = rawOperationId || `server-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = importKey(appId, operationId);
    const now = Date.now();
    for (const [pendingKey, expiresAt] of cancelledBeforeStart) {
      if (expiresAt <= now) cancelledBeforeStart.delete(pendingKey);
    }
    for (const [completedKey, expiresAt] of completedImports) {
      if (expiresAt <= now) completedImports.delete(completedKey);
    }
    if (cancelledBeforeStart.has(key)) {
      return res.status(499).json({ error: 'Đã dừng nhập tài liệu theo yêu cầu.', aborted: true });
    }
    if (activeImportByApp.has(appId)) return res.status(409).json({ error: 'another import is already running for this app' });
    const controller = new AbortController();
    const operation: ActiveImport = { controller, phase: 'preparing' };
    activeImports.set(key, operation);
    activeImportByApp.set(appId, key);
    const abortOnDisconnect = () => {
      if (operation.phase === 'preparing') controller.abort(new Error('HTTP client disconnected'));
    };
    req.once?.('aborted', abortOnDisconnect);
    res.once?.('close', () => {
      if (!res.writableEnded) abortOnDisconnect();
    });
    try {
      const result = await importConfluenceIntoPool({
        projectsDir: paths.PROJECTS_DIR,
        runtimeDataDir: paths.RUNTIME_DATA_DIR,
        appId,
        refs,
        relatedRefs,
        followLinks,
        includeDescendants,
        signal: controller.signal,
        onCommitStart: async () => {
          operation.phase = 'committing';
          await ctx.onImportCommitStart?.(appId);
        },
      });
      // The pool commit is complete; cancellation after this boundary must not
      // turn a committed import into an apparent failure.
      if (activeImports.get(key) === operation) activeImports.delete(key);
      if (activeImportByApp.get(appId) === key) activeImportByApp.delete(appId);
      rememberOperationMarker(completedImports, key);
      const contextVersion = await versionAfterMutation(appId);
      res.json({ ...result, contextVersion: contextVersion.manifest });
    } catch (err: any) {
      if (!res.headersSent) {
        const cancelled = operation.phase === 'preparing' && controller.signal.aborted;
        res.status(cancelled ? 499 : 502).json({
          error: cancelled ? 'Đã dừng nhập tài liệu theo yêu cầu.' : String(err?.message ?? err),
          ...(cancelled ? { aborted: true } : {}),
        });
      }
    } finally {
      req.removeListener?.('aborted', abortOnDisconnect);
      if (activeImports.get(key) === operation) activeImports.delete(key);
      if (activeImportByApp.get(appId) === key) activeImportByApp.delete(appId);
    }
  });

  // Explicit cancellation companion for the operation POST above. This is
  // intentionally idempotent so a late keepalive request is harmless.
  app.post('/api/pipelines/apps/:appId/import-confluence/:operationId/cancel', (req, res) => {
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    const operationId = typeof req.params.operationId === 'string' ? req.params.operationId.trim() : '';
    if (!appId || !operationId) return res.status(400).json({ error: 'appId and operationId are required' });
    const operation = activeImports.get(importKey(appId, operationId));
    const key = importKey(appId, operationId);
    const completed = completedImports.has(key);
    const cancellable = operation?.phase === 'preparing';
    if (cancellable) operation.controller.abort(new Error('Cancelled by user'));
    if (!operation && !completed) rememberOperationMarker(cancelledBeforeStart, key);
    res.json({
      ok: true,
      cancelled: cancellable || (!operation && !completed),
      phase: operation?.phase ?? (completed ? 'finished' : 'queued'),
    });
  });

  // POST /api/pipelines/apps/:appId/import-confluence/start — WP22 background
  // job variant: runs the SAME per-batch import as the sync route above, but
  // in the daemon so the client can navigate away/close the tab without
  // aborting it. Returns 202 immediately; the batch loop below runs after the
  // response is sent (no await in this handler).
  app.post('/api/pipelines/apps/:appId/import-confluence/start', (req, res) => {
    pruneImportJobs();
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    if (!appId || !appExistsLocally(db, appId)) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }
    const refs = Array.isArray(req.body?.refs)
      ? (req.body.refs as unknown[]).filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];
    if (refs.length === 0) return res.status(400).json({ error: 'refs (Confluence URLs/ids) is required' });
    // Shares `activeImportByApp` with the sync route: a job holds the SAME
    // per-App lock, so the two kinds of import are mutually exclusive.
    if (activeImportByApp.has(appId)) return res.status(409).json({ error: 'another import is already running for this app' });
    const followLinks = req.body?.followLinks === true;
    const includeDescendants = req.body?.includeDescendants === true;
    const relatedRefs = Array.isArray(req.body?.relatedRefs)
      ? (req.body.relatedRefs as unknown[]).filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : [];

    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    const job: AppImportJob = {
      id: jobId,
      appId,
      status: 'running',
      phase: 'preparing',
      done: 0,
      total: refs.length,
      imported: 0,
      updated: 0,
      startedAt: Date.now(),
    };
    const entry: ImportJobEntry = { job, controller, stopRequested: false };
    importJobs.set(jobId, entry);
    activeImportByApp.set(appId, jobActiveMarker(jobId));
    // Respond AFTER the loop is kicked off: if res.json ever threw before the
    // loop started, the job would sit 'running' forever (prune skips running)
    // and the app lock would leak. A serialization failure must never be able
    // to strand the job, so kick first, answer second.

    // Fire-and-forget: the client gets the 202 + job id right below and polls
    // GET .../import-jobs/:jobId (or the /active listing) for progress.
    // runImportJob() turns every per-batch failure into job.status/error
    // itself; this .catch is only a last-resort guard against something
    // outside that per-batch try/catch throwing, so we never leave an
    // unhandled rejection.
    void runImportJob(entry, { refs, relatedRefs, followLinks, includeDescendants }).catch((err) => {
      console.warn(`[app-pool] import job ${jobId} crashed outside its batch loop:`, err);
      entry.job.status = 'failed';
      entry.job.error = String(err?.message ?? err);
      entry.job.finishedAt = entry.job.finishedAt ?? Date.now();
      if (activeImportByApp.get(appId) === jobActiveMarker(jobId)) activeImportByApp.delete(appId);
    });
    res.status(202).json({ job: { ...job } });
  });

  async function runImportJob(
    entry: ImportJobEntry,
    opts: { refs: string[]; relatedRefs: string[]; followLinks: boolean; includeDescendants: boolean },
  ) {
    const { job, controller } = entry;
    const appId = job.appId;
    let anyCommitted = false;
    try {
      const batches = chunkRefs(opts.refs, IMPORT_JOB_BATCH_SIZE);
      for (const batch of batches) {
        if (entry.stopRequested) {
          job.status = 'cancelled';
          break;
        }
        job.phase = 'preparing';
        try {
          const result = await importConfluenceIntoPool({
            projectsDir: paths.PROJECTS_DIR,
            runtimeDataDir: paths.RUNTIME_DATA_DIR,
            appId,
            refs: batch,
            relatedRefs: opts.relatedRefs,
            followLinks: opts.followLinks,
            includeDescendants: opts.includeDescendants,
            signal: controller.signal,
            onCommitStart: async () => {
              job.phase = 'committing';
              await ctx.onImportCommitStart?.(appId);
            },
          });
          anyCommitted = true;
          job.done += batch.length;
          job.imported += result.imported;
          job.updated += result.updated;
        } catch (err: any) {
          // Distinguish an explicit cancel (this loop only ever aborts the
          // controller from the cancel route below) from a real batch
          // failure — same 'cancelled' vs 'failed' split the sync route
          // makes for its own operation.controller.
          if (controller.signal.aborted) {
            job.status = 'cancelled';
          } else {
            job.status = 'failed';
            job.error = String(err?.message ?? err);
          }
          break;
        }
        if (entry.stopRequested) {
          job.status = 'cancelled';
          break;
        }
      }
      if (job.status === 'running') job.status = 'succeeded';
    } finally {
      delete job.phase;
      job.finishedAt = Date.now();
      if (activeImportByApp.get(appId) === jobActiveMarker(job.id)) activeImportByApp.delete(appId);
      if (anyCommitted) {
        try {
          await versionAfterMutation(appId);
        } catch (err) {
          console.warn(`[app-pool] versionAfterMutation after import job ${job.id} failed:`, err);
        }
      }
    }
  }

  // GET /api/pipelines/apps/:appId/import-jobs/:jobId — WP22.
  app.get('/api/pipelines/apps/:appId/import-jobs/:jobId', (req, res) => {
    pruneImportJobs();
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    const jobId = typeof req.params.jobId === 'string' ? req.params.jobId.trim() : '';
    const entry = importJobs.get(jobId);
    if (!entry || entry.job.appId !== appId) {
      return res.status(404).json({ error: `import job "${jobId}" not found` });
    }
    res.json({ job: { ...entry.job } });
  });

  // POST /api/pipelines/apps/:appId/import-jobs/:jobId/cancel — WP22.
  // 'preparing' → abort the in-flight batch; 'committing' → let it finish
  // (atomic commit, matching the sync route's cancel semantics) and stop
  // after. Idempotent: a finished job is returned as-is.
  app.post('/api/pipelines/apps/:appId/import-jobs/:jobId/cancel', (req, res) => {
    pruneImportJobs();
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    const jobId = typeof req.params.jobId === 'string' ? req.params.jobId.trim() : '';
    const entry = importJobs.get(jobId);
    if (!entry || entry.job.appId !== appId) {
      return res.status(404).json({ error: `import job "${jobId}" not found` });
    }
    if (entry.job.status === 'running') {
      entry.stopRequested = true;
      if (entry.job.phase === 'preparing') entry.controller.abort(new Error('Cancelled by user'));
    }
    res.json({ ok: true, job: { ...entry.job } });
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
