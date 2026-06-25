import type { Express, Response } from 'express';
import type { PipelineRunSource, ProjectPipelineState } from '@open-design/contracts';

import { getProject, getProjectPipelineState, insertProject, listProjects } from './db.js';
import {
  DEFAULT_WORKFLOW_ID,
  WORKFLOWS,
  computeActive,
  deriveStateFromKgsFiles,
  deriveStateFromLocalFiles,
  getPipelineDef,
  getWorkflow,
  listPipelineStatus,
  mergePipelineState,
} from './pipelines.js';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';
import type { RouteDeps } from './server-context.js';

// A pipeline's "project" is a KGS app: either pulled from the central KGS
// (`od kg pull`, metadata.source === 'kg-pull') OR created fresh for pipelines
// (metadata.kind === 'pipeline'). Either way its id IS the KGS project_id.
// Ephemeral chat/orbit/routine workspaces are NOT eligible.
function isKgsProject(project: { metadata?: unknown } | null | undefined): boolean {
  const metadata = project?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const m = metadata as Record<string, unknown>;
  return m.source === 'kg-pull' || m.kind === 'pipeline';
}

// Validate the optional structured run source from the request body. Returns
// undefined when absent; throws on a malformed shape so the route can 400.
export function parseRunSource(raw: unknown): PipelineRunSource | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object') throw new Error('source must be an object');
  const s = raw as Record<string, unknown>;
  if (s.kind === 'confluence') {
    const ref = typeof s.ref === 'string' ? s.ref.trim() : '';
    if (!ref) throw new Error('source.ref (Confluence URL/id) is required');
    return { kind: 'confluence', ref };
  }
  if (s.kind === 'bas') {
    const documentId = typeof s.documentId === 'string' ? s.documentId.trim() : '';
    if (!documentId) throw new Error('source.documentId is required for a BAS source');
    const featureIds = Array.isArray(s.featureIds)
      ? s.featureIds.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : [];
    // featureIds may be empty → ingest the whole document subgraph.
    return {
      kind: 'bas',
      documentId,
      ...(featureIds.length ? { featureIds } : {}),
    };
  }
  throw new Error('source.kind must be "confluence" or "bas"');
}

// The pipelines capability has no scheduler/service of its own (unlike routines):
// runs are manual and one-shot. The route layer validates project + gating and
// delegates the actual conversation-seeding run to `ctx.pipelines.runPipeline`,
// a closure wired in server.ts that has access to design.runs + startChatRun.
export interface RegisterPipelineRoutesDeps extends RouteDeps<'db' | 'pipelines'> {}

export function registerPipelineRoutes(app: Express, ctx: RegisterPipelineRoutesDeps) {
  const { db } = ctx;

  // Cross-device pipeline state = this device's local run metadata (transient
  // running/failed) merged with the media-service file store (durable "done"
  // signal any device sees after a pull). Media unreachable → fall back to local.
  const loadMergedState = async (projectId: string): Promise<ProjectPipelineState> => {
    const local = getProjectPipelineState(db, projectId) as ProjectPipelineState;
    // "Done" = the stage's output files exist — on local disk (offline-safe,
    // covers outputs produced/pulled locally) OR in the media-service file store
    // (cross-device). Both feed one file-derived state; mergePipelineState still
    // preserves a local in-flight 'running' (it never overrides a running stage).
    const localPaths = await ctx.pipelines.localOutputs(projectId).catch(() => [] as string[]);
    const fileState: ProjectPipelineState = deriveStateFromLocalFiles(localPaths);
    try {
      const files = await new MediaClient(mediaConfigFromEnv()).listFiles(projectId);
      Object.assign(fileState, deriveStateFromKgsFiles(files));
    } catch {
      // media-service unreachable — local file-derived done-state still applies.
    }
    return mergePipelineState(local, fileState);
  };

  // GET /api/pipelines/projects — the KGS apps available for pipelines (projects
  // pulled from KGS; their id is the KGS project_id). Excludes ephemeral chat
  // workspaces so the UI selector only offers real KGS apps.
  app.get('/api/pipelines/projects', async (req, res) => {
    // Progress badges are scoped to the active workflow's pipelines.
    const wf = getWorkflow(typeof req.query.workflowId === 'string' ? req.query.workflowId : '')
      ?? getWorkflow(DEFAULT_WORKFLOW_ID)!;
    const total = wf.pipelineIds.length;
    const kgsProjects = listProjects(db).filter((p: { metadata?: unknown }) => isKgsProject(p));
    // Compute the merged (local + KGS) state per project. KGS calls run in
    // parallel and fall back to local-only on failure (loadMergedState swallows
    // KGS errors).
    const projects = await Promise.all(
      kgsProjects.map(async (p: { id: string; name: string }) => {
        const state = await loadMergedState(p.id);
        const done = wf.pipelineIds.reduce(
          (n, id) => (state[id]?.status === 'succeeded' ? n + 1 : n),
          0,
        );
        return { id: p.id, name: p.name, done, total };
      }),
    );
    res.json({ projects });
  });

  // GET /api/workflows — the named docs→output flows the picker offers.
  app.get('/api/workflows', (_req, res) => {
    res.json({ workflows: WORKFLOWS, defaultWorkflowId: DEFAULT_WORKFLOW_ID });
  });

  // POST /api/pipelines/projects { projectId, name } — create a NEW pipeline
  // project (id IS the KGS project_id). Marked metadata.kind='pipeline' so it
  // shows in the selector and can run pipelines (starting at jira-ingest). Use
  // this for a brand-new product; use `od kg pull <id>` to bring in one that
  // already has data in KGS.
  app.post('/api/pipelines/projects', (req, res) => {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const name = typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : projectId;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(projectId)) {
      return res.status(400).json({
        error: 'invalid project id (allowed: A-Z a-z 0-9 . _ - , max 128). This is the KGS project_id.',
      });
    }
    if (getProject(db, projectId)) {
      return res.status(409).json({ error: `project "${projectId}" already exists` });
    }
    const now = Date.now();
    insertProject(db, {
      id: projectId,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'pipeline' },
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ id: projectId, name });
  });

  // GET /api/pipelines?projectId=... — the docs→UI pipeline list for a project,
  // each merged with its persisted status + derived `active` gating flag.
  app.get('/api/pipelines', async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const project = getProject(db, projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const wf = getWorkflow(typeof req.query.workflowId === 'string' ? req.query.workflowId : '')
      ?? getWorkflow(DEFAULT_WORKFLOW_ID)!;
    const state = await loadMergedState(projectId);
    res.json({ projectId, workflowId: wf.id, pipelines: listPipelineStatus(state, wf.pipelineIds) });
  });

  // POST /api/pipelines/pull-files { projectId } — regenerate the project's
  // pipeline files from the KGS file store into the local project cwd. This is
  // the "pull on another device to continue" step (cross-device handoff).
  app.post('/api/pipelines/pull-files', async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });
      if (!isKgsProject(project)) {
        return res.status(400).json({ error: 'project is not a KGS app' });
      }
      const result = await ctx.pipelines.pullFiles(projectId);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/pipelines/upload { projectId } — MANUAL upload of the project's
  // current output files to the KGS file store (+ B2 convert for convertToGraph
  // stages). Replaces the old auto-upload-after-run.
  app.post('/api/pipelines/upload', async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });
      if (!isKgsProject(project)) {
        return res.status(400).json({ error: 'project is not a KGS app' });
      }
      const result = await ctx.pipelines.uploadFiles(projectId);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/pipelines/:id/run { projectId } — seed a new conversation in the
  // project with this pipeline's skill active and start the run. 409 if the
  // pipeline is not active yet (its prerequisites have not all succeeded).
  app.post('/api/pipelines/:id/run', async (req, res) => {
    try {
      const def = getPipelineDef(req.params.id);
      if (!def) return res.status(404).json({ error: 'pipeline not found' });
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });
      if (!isKgsProject(project)) {
        return res.status(400).json({
          error: 'project is not a KGS app; pull it first with `od kg pull <project-id>`',
        });
      }
      const state = await loadMergedState(projectId);
      if (!computeActive(state, def)) {
        return res.status(409).json({
          error: `pipeline "${def.id}" is not active yet; finish its prerequisites first`,
        });
      }
      const input = typeof req.body?.input === 'string' ? req.body.input : undefined;
      let source: PipelineRunSource | undefined;
      try {
        source = parseRunSource(req.body?.source);
      } catch (err: any) {
        return res.status(400).json({ error: String(err?.message ?? err) });
      }
      const start = await ctx.pipelines.runPipeline(projectId, def.id, input, source);
      res.status(202).json(start);
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // ── BAS gateway proxy (pipeline-1 source picker) ───────────────────────────
  // Server-side reads from the BAS MCP gateway so the bearer token never reaches
  // the browser and there is no CORS. `ctx.pipelines.bas.*` resolves the endpoint
  // from env / mcp-config; a "not configured" / unreachable error surfaces as 502
  // so the modal can show a clear hint.

  // GET /api/pipelines/bas/documents — KG documents (top level of the BAS branch).
  app.get('/api/pipelines/bas/documents', async (_req, res) => {
    try {
      const documents = await ctx.pipelines.bas.listDocuments();
      res.json({ documents });
    } catch (err: any) {
      res.status(502).json({ error: String(err?.message ?? err) });
    }
  });

  // GET /api/pipelines/bas/documents/:id/features — a document's FEATURE nodes.
  app.get('/api/pipelines/bas/documents/:id/features', async (req, res) => {
    try {
      const features = await ctx.pipelines.bas.listFeatures(req.params.id);
      res.json({ documentId: req.params.id, features });
    } catch (err: any) {
      res.status(502).json({ error: String(err?.message ?? err) });
    }
  });

  // GET /api/pipelines/bas/confluence/page?ref=… — link metadata for the preview.
  app.get('/api/pipelines/bas/confluence/page', async (req, res) => {
    const ref = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
    if (!ref) return res.status(400).json({ error: 'ref (Confluence URL/id) is required' });
    try {
      const page = await ctx.pipelines.bas.confluenceMeta(ref);
      res.json({ page });
    } catch (err: any) {
      res.status(502).json({ error: String(err?.message ?? err) });
    }
  });

  // ── Theme-lab proxy (design-v3 theme/branding for the pipeline UI preview) ──
  // theme-lab (:8107) resolves the design-v3 KGS theme data (DP_UI_THEME axes +
  // DP_UI_TOKEN) into compositions + cssVars. We proxy it (server-side: no CORS,
  // url hidden) so the open-design FileViewer theme panel can list brandings and
  // resolve a composition into the cssVars it posts into the preview iframe.
  const THEME_LAB_URL = (process.env.THEME_LAB_URL || 'http://localhost:8107').replace(/\/+$/, '');

  const proxyThemeLab = async (
    res: Response,
    path: string,
    init?: { method?: string; body?: unknown },
  ) => {
    try {
      const r = await fetch(`${THEME_LAB_URL}${path}`, {
        method: init?.method ?? 'GET',
        ...(init?.body !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }
          : {}),
      });
      const text = await r.text();
      res.status(r.status).type('application/json').send(text || '{}');
    } catch (err: any) {
      res.status(502).json({ error: `theme-lab unreachable at ${THEME_LAB_URL}: ${String(err?.message ?? err)}` });
    }
  };

  // GET /api/pipelines/theme/compositions?workspaceId=… — list brandings.
  app.get('/api/pipelines/theme/compositions', async (req, res) => {
    const ws = typeof req.query.workspaceId === 'string' && req.query.workspaceId
      ? req.query.workspaceId
      : 'ws-catalog-shadcn';
    await proxyThemeLab(res, `/api/v1/theme-lab/compositions?workspaceId=${encodeURIComponent(ws)}`);
  });

  // GET /api/pipelines/theme/modes?workspaceId=… — mode picker labels.
  app.get('/api/pipelines/theme/modes', async (req, res) => {
    const ws = typeof req.query.workspaceId === 'string' && req.query.workspaceId
      ? req.query.workspaceId
      : 'ws-catalog-shadcn';
    await proxyThemeLab(res, `/api/v1/theme-lab/modes?workspaceId=${encodeURIComponent(ws)}`);
  });

  // GET /api/pipelines/theme/layers?workspaceId=…[&kind=…] — the theme catalog:
  // every available layer (brand / visual / icon / typography / rounded / …), so
  // the inspector can offer per-axis swap selections.
  app.get('/api/pipelines/theme/layers', async (req, res) => {
    const ws = typeof req.query.workspaceId === 'string' && req.query.workspaceId
      ? req.query.workspaceId
      : 'ws-catalog-shadcn';
    const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : '';
    const qs = `workspaceId=${encodeURIComponent(ws)}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`;
    await proxyThemeLab(res, `/api/v1/theme-lab/layers?${qs}`);
  });

  // GET /api/pipelines/theme/layers/:slug/values?workspaceId=… — the resolved
  // token rows for one layer (used to paint color-swatch previews on the brand
  // / visual axis cards).
  app.get('/api/pipelines/theme/layers/:slug/values', async (req, res) => {
    const ws = typeof req.query.workspaceId === 'string' && req.query.workspaceId
      ? req.query.workspaceId
      : 'ws-catalog-shadcn';
    const slug = encodeURIComponent(req.params.slug);
    await proxyThemeLab(res, `/api/v1/theme-lab/layers/${slug}/values?workspaceId=${encodeURIComponent(ws)}`);
  });

  // POST /api/pipelines/theme/resolve — resolve a composition → cssVars + cssText.
  // Body forwarded verbatim ({ workspaceId, compositionSlug|compositionId,
  // modeId?, options?, overrides? }).
  app.post('/api/pipelines/theme/resolve', async (req, res) => {
    await proxyThemeLab(res, '/api/v1/theme-lab/resolve', { method: 'POST', body: req.body ?? {} });
  });
}
