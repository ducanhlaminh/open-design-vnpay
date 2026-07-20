import type { Express, Response } from 'express';
import type { PipelinePulseIssue, PipelinePulseRating, PipelineRunSource, ProjectPipelineState, RunAllConfig, TargetPlatform, WorkflowTerminal } from '@open-design/contracts';

import { getProject, getProjectPipelineState, insertProject, listProjects, updateProject } from './db.js';
import {
  DEFAULT_WORKFLOW_ID,
  WORKFLOWS,
  computeActive,
  deriveStateFromLocalFiles,
  getPipelineDef,
  getWorkflow,
  listPipelineStatus,
  mergePipelineState,
} from './pipelines.js';
import type { RouteDeps } from './server-context.js';
import { readAppConfig } from './app-config.js';
import { publishPipelineEvaluation, readPipelineEvaluations } from './feedback.js';

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

// Nguồn BAS (KG document) của pipeline 1 đang KHÓA BẢO TRÌ (2026-07): card
// picker bị disable trên UI (RunInputModal), CLI chặn `--source bas`, và mọi
// run mang source.kind === 'bas' bị từ chối 503 tại cả hai route dưới đây
// (fail-closed — client cũ/gọi thẳng API cũng không lách được). Mở lại: gỡ cờ
// này + hai mirror ở cli.ts và RunInputModal.
const BAS_SOURCE_LOCKED = true;
const BAS_LOCKED_MSG =
  'Nguồn BAS đang bảo trì — chọn trang Confluence (hoặc nhập JIRA key/JQL) cho bước Docs.';

// The pipelines capability has no scheduler/service of its own (unlike routines):
// runs are manual and one-shot. The route layer validates project + gating and
// delegates the actual conversation-seeding run to `ctx.pipelines.runPipeline`,
// a closure wired in server.ts that has access to design.runs + startChatRun.
export interface RegisterPipelineRoutesDeps extends RouteDeps<'db' | 'pipelines' | 'paths'> {}

export function registerPipelineRoutes(app: Express, ctx: RegisterPipelineRoutesDeps) {
  const { db } = ctx;

  // Cross-device pipeline state = this device's local run metadata (transient
  // running/failed) merged with the media-service file store (durable "done"
  // signal any device sees after a pull). Media unreachable → fall back to local.
  const loadMergedState = async (projectId: string): Promise<ProjectPipelineState> => {
    const local = getProjectPipelineState(db, projectId) as ProjectPipelineState;
    // "Done" is derived from THIS DEVICE'S LOCAL state only: a stage is done when
    // its output files exist in the local cwd (or local run metadata says so).
    // The media/KGS store is deliberately NOT consulted — a stage whose output is
    // only on the store shows "not started" until the user pulls it into local
    // (Pull all / running a downstream stage auto-pulls its inputs), at which
    // point the local files flip it to done. This makes a local re-run's clear
    // reflect immediately (no stale store copy keeping a reset stage "done").
    const localPaths = await ctx.pipelines.localOutputs(projectId).catch(() => [] as string[]);
    const fileState: ProjectPipelineState = deriveStateFromLocalFiles(localPaths);
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
      kgsProjects.map(async (p: { id: string; name: string; metadata?: Record<string, unknown> }) => {
        const state = await loadMergedState(p.id);
        const done = wf.pipelineIds.reduce(
          (n, id) => (state[id]?.status === 'succeeded' ? n + 1 : n),
          0,
        );
        const running = wf.pipelineIds.reduce(
          (n, id) => (state[id]?.status === 'running' || state[id]?.status === 'queued' ? n + 1 : n),
          0,
        );
        // Studio config (mirrored into metadata on pull): Run prefills the
        // Confluence link + design system from it (per-run override allowed).
        const sc = p.metadata?.studioConfig;
        const config =
          sc && typeof sc === 'object' && !Array.isArray(sc) ? (sc as RunAllConfig) : undefined;
        // Run-all config SAVED from this device's last successful trigger
        // (POST /api/pipelines/run-all writes it) — takes precedence over the
        // Studio config above; Studio config only seeds the very first run.
        const rac = p.metadata?.runAllConfig;
        const savedRunAll =
          rac && typeof rac === 'object' && !Array.isArray(rac) ? (rac as RunAllConfig) : undefined;
        // App cha (Studio) — mirror sẵn trong studioConfig lúc pull; picker
        // nhóm các feature card theo app từ đây.
        const scRec = (sc && typeof sc === 'object' ? sc : {}) as Record<string, unknown>;
        const appId = typeof scRec.appId === 'string' ? scRec.appId : '';
        const appName = typeof scRec.appName === 'string' ? scRec.appName : '';
        return {
          id: p.id,
          name: p.name,
          done,
          total,
          running,
          ...(config ? { config } : {}),
          ...(savedRunAll ? { savedRunAll } : {}),
          ...(appId ? { app: { id: appId, ...(appName ? { name: appName } : {}) } } : {}),
        };
      }),
    );
    res.json({ projects });
  });

  // GET /api/workflows — the named docs→output flows the picker offers.
  app.get('/api/workflows', (_req, res) => {
    res.json({ workflows: WORKFLOWS, defaultWorkflowId: DEFAULT_WORKFLOW_ID });
  });

  // POST /api/pipelines/projects đã GỠ (2026-07): dự án khai sinh ở Pipeline
  // Studio (identity + media project.json + workspace KGS); open-design chỉ
  // pull về (`od kg pull-all` tạo project row với source kg-pull). Trả 410 để
  // client cũ nhận thông báo rõ thay vì 404 mù.
  app.post('/api/pipelines/projects', (_req, res) => {
    res.status(410).json({
      error: 'tạo dự án đã chuyển sang Pipeline Studio — tạo ở đó rồi dùng `od kg pull-all` để kéo về',
    });
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

  app.get('/api/pipelines/feedback', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    void (async () => {
      try {
        const config = await readAppConfig(ctx.paths.RUNTIME_DATA_DIR);
        const user = config.feedbackUsername?.trim() || config.installationId || 'unknown';
        res.json({ feedback: await readPipelineEvaluations(projectId, user) });
      } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  app.post('/api/pipelines/feedback', async (req, res) => {
    const body = req.body as Partial<{
      projectId: string; workflowId: string; pipelineId: string; runId: string;
      rating: PipelinePulseRating; issues: PipelinePulseIssue[]; comment: string;
      surveyKind: 'pulse' | 'deep'; answers: Record<string, unknown>;
    }>;
    const ratings = new Set<PipelinePulseRating>(['ready', 'minor_edits', 'major_edits', 'unusable']);
    const issueAllowlist = new Set<PipelinePulseIssue>(['run_error', 'wrong_business', 'missing_cases', 'low_quality', 'too_slow', 'other']);
    if (!body.projectId || !body.workflowId || !body.pipelineId || !body.runId || !body.rating) {
      return res.status(400).json({ error: 'projectId, workflowId, pipelineId, runId and rating are required' });
    }
    if (!getProject(db, body.projectId)) return res.status(404).json({ error: 'project not found' });
    if (!ratings.has(body.rating)) return res.status(400).json({ error: 'invalid rating' });
    const issues = Array.isArray(body.issues)
      ? Array.from(new Set(body.issues.filter((issue): issue is PipelinePulseIssue => issueAllowlist.has(issue))))
      : [];
    // The `issues` allowlist is a PULSE-survey field; the DEEP survey captures
    // its own rich `answers` instead, so only gate on issues for pulse — else a
    // major_edits/unusable deep submission (the most important feedback) 400s.
    if (
      body.surveyKind !== 'deep' &&
      (body.rating === 'major_edits' || body.rating === 'unusable') &&
      issues.length === 0
    ) {
      return res.status(400).json({ error: 'at least one issue is required for this rating' });
    }
    try {
      const config = await readAppConfig(ctx.paths.RUNTIME_DATA_DIR);
      const user = config.feedbackUsername?.trim() || config.installationId || 'unknown';
      const comment = body.comment?.trim().slice(0, 2000);
      const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
        ? body.answers : undefined;
      const feedback = await publishPipelineEvaluation(body.projectId, user, {
        projectId: body.projectId,
        workflowId: body.workflowId,
        pipelineId: body.pipelineId,
        runId: body.runId,
        rating: body.rating,
        issues,
        surveyKind: body.surveyKind === 'deep' ? 'deep' : 'pulse',
        ...(comment ? { comment } : {}),
        ...(answers ? { answers } : {}),
      });
      res.status(201).json({ feedback });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
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

  // GET /api/pipelines/history?projectId= — project changelog: published
  // versions (store `_v/` snapshots indexed by changelog.json) + machine-local
  // .odhistory commits, newest first.
  app.get('/api/pipelines/history', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      if (!getProject(db, projectId)) return res.status(404).json({ error: 'project not found' });
      res.json({ ok: true, ...(await ctx.pipelines.history(projectId)) });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/pipelines/history/restore { projectId, verId? | commit?, paths? }
  // — rewind the cwd to a published version (downloads `_v/<verId>/…`) or a
  // local commit. The pre-restore state is committed first, so this is safe.
  app.post('/api/pipelines/history/restore', async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      if (!getProject(db, projectId)) return res.status(404).json({ error: 'project not found' });
      const verId = typeof req.body?.verId === 'string' ? req.body.verId : undefined;
      const commit = typeof req.body?.commit === 'string' ? req.body.commit : undefined;
      if (!verId && !commit) return res.status(400).json({ error: 'verId hoặc commit là bắt buộc' });
      const paths = Array.isArray(req.body?.paths)
        ? (req.body.paths as unknown[]).filter((p): p is string => typeof p === 'string')
        : undefined;
      const stage = typeof req.body?.stage === 'string' && req.body.stage ? req.body.stage : undefined;
      const result = await ctx.pipelines.restoreHistory(projectId, {
        ...(verId ? { verId } : {}),
        ...(commit ? { commit } : {}),
        ...(paths ? { paths } : {}),
        ...(stage ? { stage } : {}),
      });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/pipelines/react-build { projectId } — build (or rebuild) the
  // ui-react app from its synced sources. dist/ is never synced
  // (PipelineDef.syncExclude), so this is how a device that pulled a project
  // gets a previewable app: build.sh reseeds the scaffold + runs tsc+vite in
  // the shared toolkit container. Requires Docker on this machine.
  app.post('/api/pipelines/react-build', async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });
      const result = await ctx.pipelines.buildReact(projectId);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      // Build failures carry the tsc/vite tail — surface it so the UI/CLI can
      // show WHY instead of a bare 500.
      res.status(422).json({ error: String(err?.message ?? err) });
    }
  });

  // ── UX knowledge base (media-store backed, ux-research stage) ─────────────
  // GET /api/ux-kb/status — which KB the next ux-research run will use
  // (env override / media cache / home folder / none).
  app.get('/api/ux-kb/status', async (_req, res) => {
    try {
      res.json(await ctx.pipelines.uxKbStatus());
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/ux-kb/push { dir? } — upload a local KB folder to the media
  // store (content-hash sync; NN/g full-text article cache stays local by
  // design). Every machine's next ux-research run picks the new set up.
  app.post('/api/ux-kb/push', async (req, res) => {
    try {
      const dir = typeof req.body?.dir === 'string' ? req.body.dir : undefined;
      res.json(await ctx.pipelines.uxKbPush(dir));
    } catch (err: any) {
      res.status(422).json({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/pipelines/react-demo { projectId } — Playwright auto-demo of the
  // BUILT react app: derive use cases from flow.json, drive the real app, and
  // record video + per-step screenshots under react/prototype-demo/. 422 with
  // the runner tail on failure (missing dist/flow, playwright env, dead click).
  app.post('/api/pipelines/react-demo', async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      const result = await ctx.pipelines.buildReactDemo(projectId);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(422).json({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/pipelines/run-all — run the WHOLE workflow sequentially with no
  // per-stage review (the "Run full workflow" button / `od pipeline run-all`).
  // The daemon chains the stages in the background — each stage is a normal
  // run; a success auto-starts the next. 409 when a chain is already in flight
  // for this project or (with skipSucceeded) nothing is left to run. Progress
  // surfaces through the normal per-stage statuses (GET /api/pipelines).
  app.post('/api/pipelines/run-all', async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });
      if (!isKgsProject(project)) {
        return res.status(400).json({
          error: 'project is not a KGS app; pull it first with `od kg pull <project-id>`',
        });
      }
      const workflowId = typeof req.body?.workflowId === 'string' ? req.body.workflowId : undefined;
      const rawTerminal = req.body?.terminal;
      if (
        rawTerminal !== undefined &&
        rawTerminal !== 'ui-html' &&
        rawTerminal !== 'ui-react' &&
        rawTerminal !== 'both'
      ) {
        return res.status(400).json({ error: "terminal must be 'ui-html', 'ui-react' or 'both'" });
      }
      const input = typeof req.body?.input === 'string' ? req.body.input : undefined;
      let source: PipelineRunSource | undefined;
      try {
        source = parseRunSource(req.body?.source);
      } catch (err: any) {
        return res.status(400).json({ error: String(err?.message ?? err) });
      }
      if (BAS_SOURCE_LOCKED && source?.kind === 'bas') {
        return res.status(503).json({ error: BAS_LOCKED_MSG });
      }
      const rawDesignSystemId = req.body?.designSystemId;
      const designSystemId =
        typeof rawDesignSystemId === 'string'
          ? rawDesignSystemId
          : rawDesignSystemId === null
            ? null
            : undefined;
      const rawPlatform = req.body?.platform;
      if (rawPlatform !== undefined && rawPlatform !== 'mobile' && rawPlatform !== 'web') {
        return res.status(400).json({ error: "platform must be 'mobile' or 'web'" });
      }
      const rawConfluencePages = Array.isArray(req.body?.confluencePages) ? req.body.confluencePages : [];
      const confluencePages = rawConfluencePages
        .filter(
          (p: unknown): p is { id?: string; title?: string; url?: string } =>
            !!p && typeof p === 'object' && (typeof (p as any).id === 'string' || typeof (p as any).url === 'string'),
        )
        .map((p: { id?: string; title?: string; url?: string }) => ({
          ...(typeof p.id === 'string' && p.id ? { id: p.id } : {}),
          ...(typeof p.title === 'string' && p.title ? { title: p.title } : {}),
          ...(typeof p.url === 'string' && p.url ? { url: p.url } : {}),
        }));
      const skipSucceeded = req.body?.skipSucceeded === true;
      const followLinks = req.body?.followLinks !== false;
      const includeDescendants = req.body?.includeDescendants === true;
      // UI targets (docs-to-ui): a subset of the fixed enum; invalid entries drop.
      const targets: import('@open-design/contracts').UiTarget[] = Array.isArray(req.body?.targets)
        ? (req.body.targets as unknown[]).filter(
            (t): t is import('@open-design/contracts').UiTarget =>
              t === 'mobile' || t === 'web-user' || t === 'web-backoffice',
          )
        : [];
      // Remember this device's last-used run-all choices (per project) so a
      // later open of the Run-all modal — e.g. after canceling a stage mid-chain
      // — prefills from here instead of forcing the user to re-enter everything.
      // Only Pipeline-Studio's config seeds the FIRST run (no saved config yet);
      // every trigger after that overwrites this with the latest choices.
      updateProject(db, projectId, {
        metadata: {
          ...(project.metadata ?? {}),
          runAllConfig: {
            ...(confluencePages.length ? { confluencePages } : {}),
            ...(designSystemId !== undefined ? { designSystemId } : {}),
            terminal: (rawTerminal as WorkflowTerminal | undefined) ?? 'ui-html',
            platform: (rawPlatform as TargetPlatform | undefined) ?? 'mobile',
            ...(targets.length ? { targets } : {}),
            followLinks,
            includeDescendants,
            skipSucceeded,
          },
        },
      });
      const result = await ctx.pipelines.runWorkflowAll(projectId, {
        ...(workflowId !== undefined ? { workflowId } : {}),
        ...(rawTerminal !== undefined ? { terminal: rawTerminal as WorkflowTerminal } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(designSystemId !== undefined ? { designSystemId } : {}),
        ...(rawPlatform !== undefined ? { platform: rawPlatform as TargetPlatform } : {}),
        ...(targets.length ? { targets } : {}),
        skipSucceeded,
        ...(followLinks ? {} : { followLinks: false }),
        ...(includeDescendants ? { includeDescendants: true } : {}),
      });
      res.status(202).json(result);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const status = /already in progress|nothing to run/i.test(msg)
        ? 409
        : /Unknown workflow/i.test(msg)
          ? 404
          : 500;
      res.status(status).json({ error: msg });
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
      if (BAS_SOURCE_LOCKED && source?.kind === 'bas') {
        return res.status(503).json({ error: BAS_LOCKED_MSG });
      }
      // Per-run design system (ui-html picker). string → use it; null → explicit
      // "none" (suppress the app-config default); absent → inherit the default.
      const rawDesignSystemId = req.body?.designSystemId;
      const designSystemId =
        typeof rawDesignSystemId === 'string'
          ? rawDesignSystemId
          : rawDesignSystemId === null
            ? null
            : undefined;
      // Target platform (UX-stage picker / CLI --platform). Only 'mobile' |
      // 'web' pass through; absent → the skill's default (mobile).
      const rawPlatform = req.body?.platform;
      if (rawPlatform !== undefined && rawPlatform !== 'mobile' && rawPlatform !== 'web') {
        return res.status(400).json({ error: "platform must be 'mobile' or 'web'" });
      }
      const platform = rawPlatform as TargetPlatform | undefined;
      // RE-RUN clear scope (UI re-run dialog / CLI --reset-downstream). Only
      // 'stage' | 'downstream' pass; absent → 'stage' (clear this stage only).
      const rawScope = req.body?.resetScope;
      if (rawScope !== undefined && rawScope !== 'stage' && rawScope !== 'downstream') {
        return res.status(400).json({ error: "resetScope must be 'stage' or 'downstream'" });
      }
      const resetScope = rawScope as 'stage' | 'downstream' | undefined;
      // Docs link-follow: only an explicit false disables it (default on).
      const followLinks = req.body?.followLinks === false ? false : undefined;
      // Docs sub-tree scan: only an explicit true enables it (default off).
      const includeDescendants = req.body?.includeDescendants === true ? true : undefined;
      const { completion: _completion, ...start } = await ctx.pipelines.runPipeline(projectId, def.id, input, source, designSystemId, platform, resetScope, followLinks, includeDescendants);
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

  // GET /api/pipelines/confluence/pages?q=… — tìm trang Confluence theo tên
  // cho picker của modal Run pipeline 1 (như bên pipeline-studio). q < 2 ký
  // tự → [] không gọi upstream.
  app.get('/api/pipelines/confluence/pages', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) return res.json({ pages: [] });
    try {
      const pages = await ctx.pipelines.bas.searchConfluencePages(q);
      res.json({ pages });
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
