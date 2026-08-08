import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import type { Express, Response } from 'express';
import type { PipelinePulseIssue, PipelinePulseRating, PipelineRunMode, PipelineRunSource, PipelineStatus, ProjectPipelineState, RunAllConfig, TargetPlatform, UiTarget, WorkflowTerminal } from '@open-design/contracts';
import { TARGETS_CONFIG_BASENAME, UI_TARGETS, buildTargetsConfig, isUiTarget } from '@open-design/contracts';

import {
  deletePipelineApp,
  getPipelineApp,
  getProject,
  getProjectPipelineState,
  insertPipelineApp,
  insertProject,
  listPipelineApps,
  listProjects,
  updateProject,
  upsertPipelineAppName,
} from './db.js';
import {
  DEFAULT_WORKFLOW_ID,
  WORKFLOWS,
  computeActive,
  deriveStateFromLocalFiles,
  getPipelineDef,
  getWorkflow,
  isStageSkipped,
  listPipelineStatus,
  mergePipelineState,
  resolveRunMode,
  validateRunStageSelection,
  workflowDirForPipeline,
  workflowForPipeline,
} from './pipelines.js';
import type { RouteDeps } from './server-context.js';

// `{ target: dsId }` request field → validated map. Unknown targets and
// non-string/empty ids drop silently (same tolerance as the `targets` list);
// undefined when nothing valid remains.
// The project's configured UI targets + per-target DS map ([] single-build) —
// read from `<project>/<workflow>/targets.json` (v1 files simply lack the map).
async function readProjectTargets(
  projectsDir: string,
  projectId: string,
  workflowId: string,
): Promise<{ targets: UiTarget[]; designSystemByTarget?: Partial<Record<UiTarget, string>> }> {
  try {
    const raw = await fs.promises.readFile(
      path.join(projectsDir, projectId, workflowId, TARGETS_CONFIG_BASENAME),
      'utf8',
    );
    const cfg = JSON.parse(raw);
    const targets: UiTarget[] = Array.isArray(cfg?.targets) ? cfg.targets.filter(isUiTarget) : [];
    const designSystemByTarget = parseDesignSystemByTarget(cfg?.designSystemByTarget);
    return { targets, ...(designSystemByTarget ? { designSystemByTarget } : {}) };
  } catch {
    return { targets: [] };
  }
}

function parseDesignSystemByTarget(raw: unknown): Partial<Record<UiTarget, string>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Partial<Record<UiTarget, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isUiTarget(key) && typeof value === 'string' && value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// A workflow's docs-ingest cwd prefix, relative to the project root — the
// SAME cwd a real run of that workflow's ingest stage (`docs`/`prd-docs`/
// `dr-docs`) resolves via `workflowDirForPipeline` (server.ts's `runPipeline`
// computes its `wfDir` the identical way). NEVER hand-roll this as the
// literal `${workflowId}` string — `workflowDirForPipeline` returns null for
// a pipeline outside any workflow (cwd root), and while every REAL workflow
// today happens to resolve to its own id (verified: `docs`, `prd-docs`,
// `dr-docs` each belong to exactly one workflow, and none of them are
// target-scoped — `def.inputPlaceholder` short-circuits `resolveRunTargetDir`
// to null for all three, so no `<target>/` nesting ever applies to the
// ingest stage itself), going through the canonical helper keeps this
// correct if that ever changes instead of silently drifting from the real
// run path. Exposed on GET /api/workflows (docsDir) for the FE.
function docsDirForWorkflow(workflow: { pipelineIds: readonly string[] }): string {
  const firstStageId = workflow.pipelineIds[0];
  const wfDir = firstStageId ? workflowDirForPipeline(firstStageId) : null;
  return wfDir ? `${wfDir}/docs` : 'docs';
}

// Body của `POST /api/pipelines/run-all` và `PUT .../run-config` → các field
// của `metadata.runAllConfig`. MỘT nơi duy nhất quyết định shape đã lưu để hai
// đường ghi không lệch nhau:
//  - `withDefaults` (run-all): ghi CẢ BỘ lựa chọn của lần chạy, field thiếu lấy
//    default — đúng shape route này vẫn ghi từ trước.
//  - mặc định (run-config): merge từng section, nên CHỈ field có mặt trong body
//    được ghi. `designSystemId: null` ghi đè thành null ("Không dùng"),
//    `confluencePages: []` xóa hết trang; field không gửi giữ nguyên giá trị cũ.
function runAllConfigFromBody(input: unknown, opts?: { withDefaults?: boolean }): Partial<RunAllConfig> {
  const all = opts?.withDefaults === true;
  const body = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const has = (key: string) => all || Object.prototype.hasOwnProperty.call(body, key);
  const out: Partial<RunAllConfig> = {};
  if (has('confluencePages')) {
    const pages = (Array.isArray(body.confluencePages) ? body.confluencePages : ([] as unknown[]))
      .filter(
        (p: unknown): p is { id?: string; title?: string; url?: string } =>
          !!p && typeof p === 'object' && (typeof (p as any).id === 'string' || typeof (p as any).url === 'string'),
      )
      .map((p: { id?: string; title?: string; url?: string }) => ({
        ...(typeof p.id === 'string' && p.id ? { id: p.id } : {}),
        ...(typeof p.title === 'string' && p.title ? { title: p.title } : {}),
        ...(typeof p.url === 'string' && p.url ? { url: p.url } : {}),
      }));
    // run-all không ghi danh sách rỗng (giữ shape cũ); patch thì rỗng = xóa hết.
    if (pages.length > 0 || !all) out.confluencePages = pages;
  }
  // designSystemId là field ba trạng thái: id / null (không dùng) / vắng mặt.
  const dsId = body.designSystemId;
  if (typeof dsId === 'string') out.designSystemId = dsId;
  else if (dsId === null) out.designSystemId = null;
  // appPool là field ba trạng thái GIỐNG designSystemId (object / null / vắng
  // mặt) — cố tình đọc trực tiếp `body.appPool` thay vì qua `has()`: dưới
  // run-all (`all=true`) muốn "vắng mặt" vẫn để `out.appPool` KHÔNG được set
  // (khác `confluencePages`/`terminal` vốn tự điền default khi `all`), để
  // route gọi PRESERVE giá trị đã lưu thay vì ghi đè bằng default — bài học
  // run-all full-replace (docs/app-docs-pool-spec.md §1, §2.2).
  if (Object.prototype.hasOwnProperty.call(body, 'appPool')) {
    const rawAppPool = body.appPool;
    if (rawAppPool === null) {
      out.appPool = null;
    } else if (rawAppPool && typeof rawAppPool === 'object' && !Array.isArray(rawAppPool)) {
      const obj = rawAppPool as Record<string, unknown>;
      const poolAppId = typeof obj.appId === 'string' ? obj.appId.trim() : '';
      const poolPaths = Array.isArray(obj.paths)
        ? obj.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      if (poolAppId) out.appPool = { appId: poolAppId, paths: poolPaths };
    }
  }
  if (has('terminal')) {
    const t = body.terminal;
    if (t === 'ui-html' || t === 'ui-react' || t === 'ui-react-ds' || t === 'both') out.terminal = t as WorkflowTerminal;
    else if (all) out.terminal = 'ui-html';
  }
  if (has('platform')) {
    const pf = body.platform;
    if (pf === 'mobile' || pf === 'web') out.platform = pf as TargetPlatform;
    else if (all) out.platform = 'mobile';
  }
  if (has('targets')) {
    const targets = Array.isArray(body.targets) ? (body.targets as unknown[]).filter(isUiTarget) : [];
    if (targets.length > 0 || !all) out.targets = targets;
  }
  if (has('designSystemByTarget')) {
    const map = parseDesignSystemByTarget(body.designSystemByTarget);
    if (map) out.designSystemByTarget = map;
    else if (!all) out.designSystemByTarget = {};
  }
  if (has('followLinks')) out.followLinks = body.followLinks !== false;
  if (has('includeDescendants')) out.includeDescendants = body.includeDescendants === true;
  if (has('docsFromUpload')) {
    // run-all chỉ ghi khi true (shape cũ); patch ghi cả false để đổi nguồn từ
    // nhánh upload về Confluence xóa được cờ.
    const fromUpload = body.docsFromUpload === true;
    if (fromUpload || !all) out.docsFromUpload = fromUpload;
  }
  if (has('skipSucceeded')) out.skipSucceeded = body.skipSucceeded === true;
  if (has('lean')) out.lean = body.lean === true;
  if (has('stageIds')) {
    // Bước người dùng tick tay. Chỉ nhận chuỗi không rỗng, khử trùng lặp, GIỮ
    // NGUYÊN thứ tự gửi lên — server sắp lại theo thứ tự workflow lúc chạy
    // (selectRunStages), nên thứ tự ở đây chỉ là dữ liệu người dùng đã chọn.
    const ids = [
      ...new Set(
        (Array.isArray(body.stageIds) ? (body.stageIds as unknown[]) : []).filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0,
        ),
      ),
    ];
    // run-all không ghi danh sách rỗng (giữ shape cũ: vắng mặt = hành vi cũ);
    // patch thì rỗng = bỏ chọn tay, quay về `lean` + `skipSucceeded`.
    if (ids.length > 0 || !all) out.stageIds = ids;
  }
  return out;
}

import { KgsClient, kgsConfigFromEnv } from './kg-sync/kgs-client.js';
import { MediaClient, mediaConfigFromEnv } from './kg-sync/media-client.js';
import { loadRemoteProjects } from './kg-sync/remote-registry.js';
import { StagingBlockedError } from './kg-sync/push-dest.js';
import { readAppConfig } from './app-config.js';
import { readFeedbackForms, saveFeedbackForm } from './feedback-forms.js';
import { readAllFeedbackSubmissions, submitFeedback, uploadFeedbackImage } from './feedback-submissions.js';
import { getMachineUser } from './auth-routes.js';
import { isPackagedRuntime } from './app-version.js';
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

// The project's run mode. `POST /api/pipelines/run-all` persists the modal's
// choices into `metadata.runAllConfig`, so `lean` there is the record of "this
// project runs the short chain". Legacy projects ran lean BEFORE the mode was
// persisted, so when the saved config carries no `lean` field the mode is
// inferred from the run state instead (resolveRunMode) — otherwise those
// projects would keep showing UI terminals locked behind a review that their
// chain never runs. Gating, the stepper's badges and the single-stage 409 all
// read the mode from here.
function runModeFor(
  project: { metadata?: Record<string, unknown> } | null | undefined,
  state: ProjectPipelineState,
  pipelineIds: readonly string[],
): PipelineRunMode {
  const raw = project?.metadata?.runAllConfig;
  const saved =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RunAllConfig).lean : undefined;
  return resolveRunMode(typeof saved === 'boolean' ? saved : undefined, state, pipelineIds);
}

// Tiến độ của MỘT workflow trên state đã nạp: đếm đúng các stage mà MODE của
// project này thật sự chạy (một chuỗi lean xong là 5/5, không phải 5/8 — một
// project "xong" không được đọc thành dở dang vì các stage nó cố tình bỏ).
// Tách ra khỏi route vì giờ có hai người gọi: badge tổng (theo workflow của
// query) và mảng `workflows` (mọi workflow trong registry).
function countWorkflowProgress(
  project: { metadata?: Record<string, unknown> } | null | undefined,
  state: ProjectPipelineState,
  pipelineIds: readonly string[],
): { done: number; total: number; running: number } {
  const mode = runModeFor(project, state, pipelineIds);
  const countedIds = pipelineIds.filter((id) => {
    const def = getPipelineDef(id);
    return !def || !isStageSkipped(def, mode);
  });
  return {
    total: countedIds.length,
    done: countedIds.reduce((n, id) => (state[id]?.status === 'succeeded' ? n + 1 : n), 0),
    running: countedIds.reduce(
      (n, id) => (state[id]?.status === 'running' || state[id]?.status === 'queued' ? n + 1 : n),
      0,
    ),
  };
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
  if (s.kind === 'app-pool') {
    const appId = typeof s.appId === 'string' ? s.appId.trim() : '';
    if (!appId) throw new Error('source.appId is required for an app-pool source');
    const paths = Array.isArray(s.paths)
      ? s.paths.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : [];
    if (paths.length === 0) throw new Error('source.paths (App pool pages) is required for an app-pool source');
    return { kind: 'app-pool', appId, paths };
  }
  throw new Error('source.kind must be "confluence", "bas" or "app-pool"');
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
    const kgsProjects = listProjects(db).filter((p: { metadata?: unknown }) => isKgsProject(p));
    // Compute the merged (local + KGS) state per project. KGS calls run in
    // parallel and fall back to local-only on failure (loadMergedState swallows
    // KGS errors).
    const projects = await Promise.all(
      kgsProjects.map(async (p: { id: string; name: string; metadata?: Record<string, unknown> }) => {
        const state = await loadMergedState(p.id);
        const { done, total, running } = countWorkflowProgress(p, state, wf.pipelineIds);
        // Trạng thái của TỪNG workflow, đếm trên CÙNG state vừa nạp (không nạp
        // lại lần nào): badge một-workflow ở trên không nói được workflow nào
        // đang chạy, nên một feature đang chạy workflow khác vẫn báo "Chưa
        // chạy". Row feature xổ ra đọc mảng này.
        const workflows = WORKFLOWS.map((w) => ({
          id: w.id,
          name: w.name,
          ...countWorkflowProgress(p, state, w.pipelineIds),
        }));
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
          workflows,
          ...(config ? { config } : {}),
          ...(savedRunAll ? { savedRunAll } : {}),
          ...(appId ? { app: { id: appId, ...(appName ? { name: appName } : {}) } } : {}),
        };
      }),
    );
    res.json({ projects });
  });

  // GET /api/workflows — the named docs→output flows the picker offers.
  // `docsDir` (additive; not yet in packages/contracts' `Workflow` type — this
  // route intentionally widens past it) is the workflow's docs-ingest cwd
  // prefix — see `docsDirForWorkflow` — so the FE's single-file upload path
  // (UploadFilesModal's `${workflowId}/docs/` name-building) can target the
  // REAL on-disk folder for every workflow, not just docs-review.
  app.get('/api/workflows', (_req, res) => {
    const workflows = WORKFLOWS.map((w) => ({ ...w, docsDir: docsDirForWorkflow(w) }));
    res.json({ workflows, defaultWorkflowId: DEFAULT_WORKFLOW_ID });
  });

  // POST /api/pipelines/projects { projectId, name, appId?, appName? } —
  // Phase B: mở lại tạo dự án CỤC BỘ (trước đây route này trả 410 và bắt
  // buộc khai sinh ở Pipeline Studio). Giờ user dựng cấu trúc
  // Project(App)/feature ngay trong open-design; project được đánh dấu
  // metadata.kind='pipeline' như trước. Trên Push, đích được chọn sau (ghi
  // đè project đã tồn tại trên studio, hoặc đi qua thư mục staging/approval —
  // xem apps/daemon/src/kg-sync/push-dest.ts) — route này KHÔNG chạm tới
  // studio/KGS, chỉ tạo project row cục bộ.
  app.post('/api/pipelines/projects', (req, res) => {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const name = typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : projectId;
    // Regex của pipeline-studio (khác regex cũ, rộng hơn, của route này
    // trước khi bị gỡ): một id dài quá 63 ký tự hoặc mở đầu bằng ký tự không
    // phải chữ/số sẽ KHÔNG BAO GIỜ được studio duyệt — chấp nhận nó ở đây chỉ
    // trì hoãn một lỗi chắc chắn xảy ra, tới tận lúc Push mới lộ ra.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(projectId)) {
      return res.status(400).json({
        error:
          'invalid project id (must start with a letter/digit, then A-Z a-z 0-9 . _ - , max 64 chars total — matches pipeline-studio\'s id rule). This is the KGS project_id.',
      });
    }
    if (getProject(db, projectId)) {
      return res.status(409).json({ error: `project "${projectId}" already exists` });
    }
    // App cha (optional): khi có, mirror denormalized vào metadata.studioConfig
    // — GET /api/pipelines/projects (trên) đọc thẳng appId/appName từ đây để
    // nhóm feature theo app, nên không cần thêm gì ở đó cho project mới này.
    const appId = typeof req.body?.appId === 'string' ? req.body.appId.trim() : '';
    const appName = typeof req.body?.appName === 'string' ? req.body.appName.trim() : '';
    const now = Date.now();
    insertProject(db, {
      id: projectId,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: appId
        ? { kind: 'pipeline', studioConfig: { appId, ...(appName ? { appName } : {}) } }
        : { kind: 'pipeline' },
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ id: projectId, name });
  });

  // Các App CỤC BỘ thấy được: {appId, appName} denormalize trên feature +
  // row bảng pipeline_apps (App 0 feature). Dùng cho cả picker (GET) và check
  // trùng khi tạo (POST).
  type AppEntry = { id: string; name?: string; origin: 'local' | 'remote' };
  const collectLocalApps = (): Map<string, AppEntry> => {
    const byId = new Map<string, AppEntry>();
    const mergeName = (entry: AppEntry, name: string | undefined) => {
      if (!entry.name && name) entry.name = name;
    };
    for (const p of listProjects(db).filter((p: { metadata?: unknown }) => isKgsProject(p))) {
      const sc = (p as { metadata?: Record<string, unknown> }).metadata?.studioConfig;
      const scRec =
        sc && typeof sc === 'object' && !Array.isArray(sc) ? (sc as Record<string, unknown>) : undefined;
      const appId = typeof scRec?.appId === 'string' ? scRec.appId.trim() : '';
      if (!appId) continue;
      const appName = typeof scRec?.appName === 'string' && scRec.appName.trim() ? scRec.appName.trim() : undefined;
      const existing = byId.get(appId);
      if (existing) {
        mergeName(existing, appName);
      } else {
        byId.set(appId, { id: appId, ...(appName ? { name: appName } : {}), origin: 'local' });
      }
    }
    // App 0 feature (POST /api/pipelines/apps): chưa có feature nào mirror
    // {appId, appName} nên nguồn duy nhất là bảng pipeline_apps.
    for (const a of listPipelineApps(db)) {
      const existing = byId.get(a.id);
      if (existing) {
        mergeName(existing, a.name && a.name !== a.id ? a.name : undefined);
      } else {
        byId.set(a.id, {
          id: a.id,
          ...(a.name && a.name !== a.id ? { name: a.name } : {}),
          origin: 'local',
        });
      }
    }
    return byId;
  };

  // Các App có trên registry trung tâm (KGS/media). Ném lỗi khi store không
  // với tới được — nơi gọi tự quyết định degrade (picker: local-only; tạo mới:
  // bỏ qua check trùng remote).
  const loadRemoteApps = async (): Promise<Array<{ id: string; name?: string }>> => {
    const remote = await loadRemoteProjects(
      new KgsClient(kgsConfigFromEnv()),
      new MediaClient(mediaConfigFromEnv()),
    );
    return remote
      .filter((r) => r.isApp)
      .map((r) => ({
        id: r.projectId,
        ...(r.name && r.name !== r.projectId ? { name: r.name } : {}),
      }));
  };

  // POST /api/pipelines/apps { appId, name } — tạo App container 0 feature.
  // Form "App mới" trên UI chỉ tạo App; feature thêm sau qua POST
  // /api/pipelines/projects (khi đó {appId, appName} được mirror vào
  // metadata.studioConfig của feature). App 0 feature không có gì để
  // chạy/push nên route này là LOCAL-ONLY: không chạm KGS/studio/media.
  app.post('/api/pipelines/apps', async (req, res) => {
    const appId = typeof req.body?.appId === 'string' ? req.body.appId.trim() : '';
    const name = typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : appId;
    // Cùng regex với POST /api/pipelines/projects: id App cũng là project_id
    // trên KGS, id studio không duyệt thì chặn ngay tại đây.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(appId)) {
      return res.status(400).json({
        error:
          'invalid app id (must start with a letter/digit, then A-Z a-z 0-9 . _ - , max 64 chars total — matches pipeline-studio\'s id rule). This is the KGS project_id.',
      });
    }
    if (collectLocalApps().has(appId)) {
      return res.status(409).json({ error: `app "${appId}" already exists` });
    }
    // Trùng với App đã có trên studio cũng là trùng (picker đã offer nó,
    // origin 'remote'). Best-effort: store chết thì cứ cho tạo cục bộ.
    try {
      if ((await loadRemoteApps()).some((r) => r.id === appId)) {
        return res.status(409).json({ error: `app "${appId}" already exists` });
      }
    } catch {
      /* stores unreachable → chỉ dựa vào check cục bộ ở trên */
    }
    insertPipelineApp(db, { id: appId, name, createdAt: Date.now() });
    res.status(201).json({ id: appId, name });
  });

  // GET /api/pipelines/apps — App containers a user can pick as the parent of
  // a NEW feature (Phase B local creation picker). Union of:
  //   - local: distinct {appId, appName} pairs denormalized onto existing
  //     local pipeline projects' metadata.studioConfig, PLUS `pipeline_apps`
  //     rows (Apps created locally that have no feature yet).
  //   - remote: {isApp: true} rows from the KGS/media registry, so the picker
  //     can also parent a new feature under an App that already exists on
  //     Pipeline Studio (that is case 1 — the feature gets created there on
  //     approval, the App is reused as-is). Best-effort: the remote stores
  //     being unreachable degrades the picker to local-only rather than 500ing
  //     a user out of creating anything.
  //
  // An App with features deliberately does NOT get a local `projects` row of
  // its own: it has no cwd, no stages, nothing to run, and isKgsProject() would
  // then try to push it like a real feature. It only ever exists as this
  // denormalized {appId, appName} mirrored onto each of its features; the
  // `pipeline_apps` row exists solely so a 0-feature App survives.
  app.get('/api/pipelines/apps', async (_req, res) => {
    const byId = collectLocalApps();
    // Remote Apps come second so a local name (typed by this user) wins over
    // the store's, but an App that only exists remotely still shows up.
    try {
      for (const r of await loadRemoteApps()) {
        const existing = byId.get(r.id);
        if (existing) {
          if (!existing.name && r.name) existing.name = r.name;
        } else {
          byId.set(r.id, { id: r.id, ...(r.name ? { name: r.name } : {}), origin: 'remote' });
        }
      }
    } catch {
      /* stores unreachable → local-only picker */
    }
    const apps = Array.from(byId.values())
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({
        id: e.id,
        ...(e.name ? { name: e.name } : {}),
        origin: e.origin,
      }));
    res.json({ apps });
  });

  // ---- Sửa/xóa App và feature (Phase 2) — tất cả LOCAL-ONLY: không chạm
  // KGS/studio/media, chỉ ghi row cục bộ + metadata denormalize.

  // {appId, appName} denormalize trên một feature; bản copy để sửa tự do.
  const studioConfigOf = (
    project: { metadata?: Record<string, unknown> } | null | undefined,
  ): Record<string, unknown> => {
    const sc = project?.metadata?.studioConfig;
    return sc && typeof sc === 'object' && !Array.isArray(sc)
      ? { ...(sc as Record<string, unknown>) }
      : {};
  };

  // Các feature CỤC BỘ đang thuộc app này (nguồn duy nhất: studioConfig.appId).
  type LocalFeature = { id: string; name: string; metadata?: Record<string, unknown> };
  const featuresOfApp = (appId: string): LocalFeature[] =>
    (listProjects(db) as LocalFeature[])
      .filter((p) => isKgsProject(p))
      .filter((p) => studioConfigOf(p).appId === appId);

  // metadata của feature sau khi gỡ App cha. studioConfig rỗng thì bỏ hẳn key
  // để GET /api/pipelines/projects không trả về `config: {}`.
  const detachApp = (feature: LocalFeature): Record<string, unknown> => {
    const metadata = { ...(feature.metadata ?? {}) };
    const sc = studioConfigOf(feature);
    delete sc.appId;
    delete sc.appName;
    if (Object.keys(sc).length > 0) metadata.studioConfig = sc;
    else delete metadata.studioConfig;
    return metadata;
  };

  // Id các App trên registry trung tâm; null khi store không với tới được —
  // caller phân biệt "chắc chắn không remote" với "không biết".
  const remoteAppIds = async (): Promise<Set<string> | null> => {
    try {
      return new Set((await loadRemoteApps()).map((r) => r.id));
    } catch {
      return null;
    }
  };

  // PATCH /api/pipelines/apps/:id { name } — đổi TÊN HIỂN THỊ của App (id giữ
  // nguyên vì nó là project_id trên KGS). Ghi hai chỗ vì tên App sống ở hai
  // nguồn: row pipeline_apps (UPSERT — App có feature chưa chắc có row) và
  // appName denormalize trên từng feature (GET /api/pipelines/projects đọc ở đó).
  app.patch('/api/pipelines/apps/:id', async (req, res) => {
    const appId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    // Rename được cả App remote: row local chỉ là cái tên phủ lên (picker cho
    // tên local thắng), không đổi gì trên studio.
    if (!collectLocalApps().has(appId) && !(await remoteAppIds())?.has(appId)) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }
    upsertPipelineAppName(db, { id: appId, name, createdAt: Date.now() });
    for (const f of featuresOfApp(appId)) {
      updateProject(db, f.id, {
        metadata: {
          ...(f.metadata ?? {}),
          studioConfig: { ...studioConfigOf(f), appId, appName: name },
        },
      });
    }
    res.json({ id: appId, name });
  });

  // DELETE /api/pipelines/apps/:id — xóa App CỤC BỘ. Feature KHÔNG bị xóa: chỉ
  // gỡ {appId, appName} nên nó về nhóm "Chưa gán app" (xóa dự án là việc của
  // DELETE /api/projects/:id). App có trên studio thì máy này không có quyền
  // xóa — 409 để user xử lý trên studio.
  app.delete('/api/pipelines/apps/:id', async (req, res) => {
    const appId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const remote = await remoteAppIds();
    if (remote?.has(appId)) {
      return res.status(409).json({
        error:
          `App "${appId}" tồn tại trên Pipeline Studio — xóa trên studio; máy này chỉ xóa được App local.`,
      });
    }
    if (!collectLocalApps().has(appId)) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }
    deletePipelineApp(db, appId);
    const features = featuresOfApp(appId);
    for (const f of features) {
      updateProject(db, f.id, { metadata: detachApp(f) });
    }
    res.json({ ok: true, detached: features.length });
  });

  // PATCH /api/pipelines/projects/:id { name?, appId?, appName? } — sửa một
  // feature: đổi tên hiển thị và/hoặc chuyển sang App khác (`appId: null` = gỡ
  // về "Chưa gán app"). Id/thư mục cwd giữ nguyên — nó là project_id trên KGS.
  app.patch('/api/pipelines/projects/:id', (req, res) => {
    const projectId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const project = getProject(db, projectId) as LocalFeature | null;
    if (!project || !isKgsProject(project)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
    const hasAppId = Object.prototype.hasOwnProperty.call(body, 'appId');
    if (!hasName && !hasAppId) {
      return res.status(400).json({ error: 'name or appId is required' });
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (hasName && !name) return res.status(400).json({ error: 'name must not be empty' });
    const patch: Record<string, unknown> = {};
    if (hasName) patch.name = name;
    if (hasAppId) {
      const appId = typeof body.appId === 'string' ? body.appId.trim() : '';
      if (!appId) {
        patch.metadata = detachApp(project);
      } else {
        // appName do client gửi (đang hiện trên picker); thiếu thì lấy tên đang
        // biết của App để card không tụt về hiển thị id trần.
        const known = collectLocalApps().get(appId)?.name;
        const appName = typeof body.appName === 'string' && body.appName.trim()
          ? body.appName.trim()
          : known;
        patch.metadata = {
          ...(project.metadata ?? {}),
          studioConfig: {
            ...studioConfigOf(project),
            appId,
            ...(appName ? { appName } : {}),
          },
        };
      }
    }
    const updated = updateProject(db, projectId, patch);
    res.json({ id: projectId, name: updated?.name ?? project.name });
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
    const runMode = runModeFor(project, state, wf.pipelineIds);
    // Multi-target: configured targets + a FILE-derived per-target status
    // (which stages have outputs under <wf>/<target>/) — the DB run state is
    // stage-global, so this is what tells "mobile done, web-user not yet".
    const { targets, designSystemByTarget } = await readProjectTargets(
      ctx.paths.PROJECTS_DIR,
      projectId,
      wf.id,
    );
    let statusByTarget: Partial<Record<UiTarget, Record<string, PipelineStatus>>> | undefined;
    if (targets.length > 0) {
      const localPaths = await ctx.pipelines.localOutputs(projectId).catch(() => [] as string[]);
      statusByTarget = {};
      for (const t of targets) {
        const prefix = `${wf.id}/${UI_TARGETS[t].dir}/`;
        const derived = deriveStateFromLocalFiles(localPaths.filter((p) => p.startsWith(prefix)));
        statusByTarget[t] = Object.fromEntries(
          Object.entries(derived).map(([id, v]) => [id, v.status]),
        ) as Record<string, PipelineStatus>;
      }
    }
    res.json({
      projectId,
      workflowId: wf.id,
      pipelines: listPipelineStatus(state, wf.pipelineIds, runMode),
      runMode,
      ...(targets.length > 0 ? { targets } : {}),
      ...(statusByTarget ? { statusByTarget } : {}),
      ...(designSystemByTarget ? { designSystemByTarget } : {}),
    });
  });

  // Gán/đổi design system cho MỘT target sau khi docs đã chạy — run-all là nơi
  // duy nhất ghi designSystemByTarget lúc đầu, nên thiếu route này thì panel
  // "Gán component" của preview ux-spec (và mọi re-run stage lẻ) không có cách
  // nào cấu hình DS cho target nữa.
  app.put('/api/pipelines/target-design-system', async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });
      const target = req.body?.target;
      if (!isUiTarget(target)) return res.status(400).json({ error: 'invalid target' });
      const designSystemId =
        typeof req.body?.designSystemId === 'string' && req.body.designSystemId
          ? (req.body.designSystemId as string)
          : null; // null = gỡ gán
      const wf =
        getWorkflow(typeof req.body?.workflowId === 'string' ? req.body.workflowId : '')
        ?? getWorkflow(DEFAULT_WORKFLOW_ID)!;
      const cfgPath = path.join(ctx.paths.PROJECTS_DIR, projectId, wf.id, TARGETS_CONFIG_BASENAME);
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(await fs.promises.readFile(cfgPath, 'utf8')) as Record<string, unknown>;
      } catch {
        return res.status(400).json({
          error: 'dự án chưa chia target (không có targets.json) — chạy bước Docs với lựa chọn target trước',
        });
      }
      const targets: UiTarget[] = Array.isArray(cfg.targets)
        ? (cfg.targets as unknown[]).filter(isUiTarget)
        : [];
      if (!targets.includes(target)) {
        return res.status(400).json({ error: `target "${target}" không nằm trong targets.json (${targets.join(', ')})` });
      }
      const map = (cfg.designSystemByTarget && typeof cfg.designSystemByTarget === 'object'
        ? { ...(cfg.designSystemByTarget as Record<string, string>) }
        : {}) as Record<string, string>;
      if (designSystemId) map[target] = designSystemId;
      else delete map[target];
      cfg.designSystemByTarget = map;
      if (Object.keys(map).length === 0) delete cfg.designSystemByTarget;
      // File cũ version 1 vẫn hợp lệ; có map thì nâng lên 2 cho tự mô tả.
      if (cfg.designSystemByTarget && cfg.version === 1) cfg.version = 2;
      await fs.promises.writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      res.json({ ok: true, target, designSystemId, designSystemByTarget: cfg.designSystemByTarget ?? {} });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
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

  // ── Form feedback cuối pipeline (builder + submit + thống kê) ─────────────
  // Sáu route mỏng trên hai module thuần feedback-forms/feedback-submissions —
  // logic (validate/version/cap/merge) sống bên đó và đã có unit test; route
  // chỉ resolve danh tính + channel rồi chuyển tiếp.

  /** user = email Google đã xác thực (getMachineUser) khi có; fallback
   *  feedbackUsername/installationId — cùng thứ tự ưu tiên với attribution của
   *  push (server.ts), để hai chỗ không kể hai câu chuyện về cùng một người. */
  const resolveFeedbackIdentity = async () => {
    const config = await readAppConfig(ctx.paths.RUNTIME_DATA_DIR);
    const machine = getMachineUser();
    return {
      user: machine?.email || config.feedbackUsername?.trim() || config.installationId || 'unknown',
      installationId: config.installationId || 'unknown-install',
    };
  };

  app.get('/api/pipelines/feedback/forms', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    void (async () => {
      try {
        res.json(await readFeedbackForms(projectId));
      } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  app.put('/api/pipelines/feedback/forms', (req, res) => {
    const body = req.body as Partial<{ projectId: string; title: string; workflowId: string; sections: unknown; questions: unknown }>;
    if (!body.projectId || typeof body.title !== 'string' || !Array.isArray(body.questions)) {
      return res.status(400).json({ error: 'projectId, title and questions are required' });
    }
    if (!getProject(db, body.projectId)) return res.status(404).json({ error: 'project not found' });
    void (async () => {
      try {
        const { user } = await resolveFeedbackIdentity();
        const form = await saveFeedbackForm(
          body.projectId!,
          {
            title: body.title!,
            ...(typeof body.workflowId === 'string' && body.workflowId ? { workflowId: body.workflowId } : {}),
            ...(Array.isArray(body.sections) ? { sections: body.sections as never } : {}),
            questions: body.questions as never,
          },
          { user },
        );
        res.status(201).json({ form });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  // Ảnh gửi RAW (body = bytes, Content-Type = image/*) thay vì JSON base64:
  // limit json toàn cục là 4mb, còn ảnh cap 5MB — base64 phồng ~33% nữa là
  // chắc chắn vượt. Raw thì cap 6mb là đủ dư cho 5MB thật.
  app.post(
    '/api/pipelines/feedback/attachments',
    express.raw({ type: 'image/*', limit: '6mb' }),
    (req, res) => {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
      const draftId = typeof req.query.draftId === 'string' ? req.query.draftId : '';
      const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
      if (!projectId || !draftId || !filename) {
        return res.status(400).json({ error: 'projectId, draftId and filename are required' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'body phải là bytes ảnh (Content-Type: image/*)' });
      }
      void (async () => {
        try {
          const attachment = await uploadFeedbackImage({
            projectId,
            submissionDraftId: draftId,
            filename,
            contentType: req.headers['content-type'] ?? 'application/octet-stream',
            data: req.body as Buffer,
          });
          res.status(201).json({ attachment });
        } catch (error) {
          res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        }
      })();
    },
  );

  app.post('/api/pipelines/feedback/submissions', (req, res) => {
    const body = req.body as Partial<{
      projectId: string; workflowId: string; runId: string; formVersion: number;
      answers: Record<string, unknown>; otherTexts: Record<string, string>;
      images: unknown[]; stageFiles: unknown[];
    }>;
    if (!body.projectId || !body.workflowId || typeof body.formVersion !== 'number' || !body.answers) {
      return res.status(400).json({ error: 'projectId, workflowId, formVersion and answers are required' });
    }
    if (!getProject(db, body.projectId)) return res.status(404).json({ error: 'project not found' });
    void (async () => {
      try {
        const { forms } = await readFeedbackForms(body.projectId!);
        const form = forms.find((f) => f.version === body.formVersion);
        // Version không tồn tại = client cầm form đã bị vượt qua hoặc bịa —
        // nhận bừa thì answers không đối chiếu được với câu hỏi nào.
        if (!form) return res.status(400).json({ error: `Form version ${body.formVersion} không tồn tại` });
        const { user, installationId } = await resolveFeedbackIdentity();
        const projectRoot = path.resolve(ctx.paths.PROJECTS_DIR, body.projectId!);
        const submission = await submitFeedback({
          projectId: body.projectId!,
          installationId,
          user,
          channel: isPackagedRuntime() ? 'packaged' : 'dev',
          workflowId: body.workflowId!,
          ...(body.runId ? { runId: body.runId } : {}),
          form,
          answers: body.answers as never,
          ...(body.otherTexts ? { otherTexts: body.otherTexts } : {}),
          ...(Array.isArray(body.images) ? { images: body.images as never } : {}),
          ...(Array.isArray(body.stageFiles) ? { stageFiles: body.stageFiles as never } : {}),
          // Snapshot đọc từ CWD của project, và CHẶN đường dẫn thoát ra ngoài
          // (sourcePath là input người dùng — '../' trỏ được vào file bất kỳ
          // trên máy nếu không kiểm).
          readStageFile: async (sourcePath: string) => {
            const abs = path.resolve(projectRoot, sourcePath);
            if (abs !== projectRoot && !abs.startsWith(projectRoot + path.sep)) {
              throw new Error(`Đường dẫn không hợp lệ: ${sourcePath}`);
            }
            return fs.promises.readFile(abs);
          },
        });
        res.status(201).json({ submission });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  // Tải MỘT file đính kèm từ media store về trình duyệt — đính kèm KHÔNG nằm
  // trong cwd local (projectRawUrl không với tới). Chặn path ngoài thư mục
  // đính kèm: đây là proxy store, không phải cửa đọc file tùy ý.
  app.get('/api/pipelines/feedback/attachment', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!projectId || !filePath) return res.status(400).json({ error: 'projectId and path are required' });
    if (!filePath.startsWith('feedback/attachments/') || filePath.includes('..')) {
      return res.status(400).json({ error: 'path phải nằm dưới feedback/attachments/' });
    }
    void (async () => {
      try {
        const { MediaClient, mediaConfigFromEnv } = await import('./kg-sync/media-client.js');
        const data = await new MediaClient(mediaConfigFromEnv()).downloadFile(projectId, filePath);
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'application/octet-stream';
        res.setHeader('content-type', mime);
        res.send(data);
      } catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  app.get('/api/pipelines/feedback/summary', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    void (async () => {
      try {
        const [formsRes, subsRes] = await Promise.all([
          readFeedbackForms(projectId),
          readAllFeedbackSubmissions(projectId),
        ]);
        res.json({
          storeReachable: formsRes.storeReachable && subsRes.storeReachable,
          forms: formsRes.forms,
          submissions: subsRes.submissions,
        });
      } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
      }
    })();
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
      // "Chưa đăng nhập" là điều kiện người dùng sửa được trong 10 giây, không
      // phải lỗi máy chủ — 400 kèm code để UI nói đúng việc phải làm.
      if (err instanceof StagingBlockedError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
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
      const buildTarget = req.body?.target;
      if (buildTarget !== undefined && !isUiTarget(buildTarget)) {
        return res.status(400).json({ error: 'invalid target' });
      }
      const result = await ctx.pipelines.buildReact(projectId, buildTarget);
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
      const demoTarget = req.body?.target;
      if (demoTarget !== undefined && !isUiTarget(demoTarget)) {
        return res.status(400).json({ error: 'invalid target' });
      }
      const result = await ctx.pipelines.buildReactDemo(projectId, demoTarget);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(422).json({ error: String(err?.message ?? err) });
    }
  });

  // POST /api/pipelines/figma-capture { projectId } — capture the BUILT
  // UI-Spec (React DS) app into Figma screen JSON (figma-h2d IR with component
  // instance markers) under react-ds/figma-screens/. The output feeds the
  // design-v3 Fig Pipeline plugin's "Screen JSON → Figma" tab, which rebuilds
  // the screens with REAL component instances. 422 with the runner tail on
  // failure (missing dist, playwright env, dead click selector).
  // POST /api/pipelines/figma-audit { projectId, target? } — Lớp 1 audit
  // "Preview ↔ Figma": soi tĩnh các file capture đối chiếu bộ DS, báo trước
  // unmatched icon / variant fallback / layer tràn khung TRƯỚC khi dán vào
  // Figma. Ghi figma-screens/audit.json.
  app.post('/api/pipelines/figma-audit', async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      const auditTarget = req.body?.target;
      if (auditTarget !== undefined && !isUiTarget(auditTarget)) {
        return res.status(400).json({ error: 'invalid target' });
      }
      const result = await ctx.pipelines.figmaAudit(projectId, auditTarget);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(422).json({ error: String(err?.message ?? err) });
    }
  });

  app.post('/api/pipelines/figma-capture', async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      const captureTarget = req.body?.target;
      if (captureTarget !== undefined && !isUiTarget(captureTarget)) {
        return res.status(400).json({ error: 'invalid target' });
      }
      const result = await ctx.pipelines.figmaCapture(projectId, captureTarget);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(422).json({ error: String(err?.message ?? err) });
    }
  });

  // PUT /api/pipelines/projects/:id/run-config — LƯU cấu hình chạy mà KHÔNG
  // chạy gì cả. Rail cấu hình trên màn Chạy có nút "Đổi" từng dòng, mở modal chỉ
  // chứa section đó; bấm Lưu đi vào đây. Body là một RunAllConfig PARTIAL (chỉ
  // các field của section vừa sửa) và được merge shallow vào
  // `metadata.runAllConfig` — trước route này, đổi một lựa chọn phải chạy lại cả
  // workflow (`POST /api/pipelines/run-all`) mới lưu được.
  app.put('/api/pipelines/projects/:id/run-config', (req, res) => {
    const projectId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const project = getProject(db, projectId);
    if (!project || !isKgsProject(project)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const prev = project.metadata?.runAllConfig;
    const saved = (prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}) as RunAllConfig;
    const patch = runAllConfigFromBody(req.body);
    const merged: RunAllConfig = { ...saved, ...patch };
    updateProject(db, projectId, {
      metadata: {
        ...(project.metadata ?? {}),
        runAllConfig: merged,
      },
    });
    // Đổi "Sản phẩm cần build" phải ăn NGAY cả với chạy-lẻ-từng-bước: các stage
    // chạy lẻ đọc target từ `<workflow>/targets.json` — file này trước đây chỉ
    // được ghi lúc run-all khởi động, nên lưu target mới xong mà chạy lẻ vẫn
    // build target CŨ (đã chọn web vẫn ra mobile). targets là khái niệm riêng
    // của docs-to-ui (workflow duy nhất có stage acceptsPlatform) nên ghi thẳng
    // vào thư mục đó; best-effort — dự án chưa có thư mục thì tạo.
    if (patch.targets !== undefined || patch.designSystemByTarget !== undefined) {
      const targets = (merged.targets ?? []).filter(isUiTarget);
      if (targets.length > 0) {
        try {
          const wfDir = path.join(ctx.paths.PROJECTS_DIR, projectId, 'docs-to-ui');
          fs.mkdirSync(wfDir, { recursive: true });
          const cfg = buildTargetsConfig(targets, merged.designSystemByTarget);
          fs.writeFileSync(path.join(wfDir, TARGETS_CONFIG_BASENAME), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
        } catch (error) {
          console.warn('[pipelines] run-config: writing targets.json failed:', error);
        }
      }
    }
    res.json({ ok: true });
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
        rawTerminal !== 'ui-react-ds' &&
        rawTerminal !== 'both'
      ) {
        return res.status(400).json({ error: "terminal must be 'ui-html', 'ui-react', 'ui-react-ds' or 'both'" });
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
      const lean = req.body?.lean === true;
      const followLinks = req.body?.followLinks !== false;
      const includeDescendants = req.body?.includeDescendants === true;
      // Docs came from the modal's own upload, not from a fetch: the ingest
      // stage is dropped from the chain (its output IS the folder they landed
      // in, so re-running it would delete them).
      const docsFromUpload = req.body?.docsFromUpload === true;
      // UI targets (docs-to-ui): a subset of the fixed enum; invalid entries drop.
      const targets: import('@open-design/contracts').UiTarget[] = Array.isArray(req.body?.targets)
        ? (req.body.targets as unknown[]).filter(
            (t): t is import('@open-design/contracts').UiTarget =>
              t === 'mobile' || t === 'web-user' || t === 'web-backoffice',
          )
        : [];
      // Per-target design systems: `{ target: dsId }` entries; unknown targets
      // and non-string ids drop silently (same tolerance as `targets`).
      const designSystemByTarget = parseDesignSystemByTarget(req.body?.designSystemByTarget);
      // Bước người dùng tick tay. Dùng CHUNG parser với cấu hình đã lưu để hai
      // đường (chạy ngay / lưu rồi chạy sau) không bao giờ hiểu khác nhau.
      const stageIds = runAllConfigFromBody(req.body).stageIds;
      if (stageIds && stageIds.length > 0) {
        // CHẶN NGAY một lựa chọn thiếu phụ thuộc, thay vì để nó chạy rồi hỏng:
        // run-all gọi thẳng runPipeline và KHÔNG hỏi gating (xem runWorkflowAll
        // trong server.ts), nên một bước thiếu input sẽ không bị chặn ở đâu cả —
        // nó chạy thật, đọc thư mục input rỗng, và cho ra một kết quả trông như
        // thành công. Hỏng ồn ào ngay từ đầu rẻ hơn nhiều so với một bản spec
        // rác mà người dùng chỉ phát hiện ở bước cuối.
        const wf = getWorkflow(workflowId ?? DEFAULT_WORKFLOW_ID);
        // Workflow lạ: để runWorkflowAll ném "Unknown workflow" → 404 như cũ.
        if (wf) {
          // Cùng nguồn "đã xong" mà mọi route khác dùng (local run metadata +
          // output trên đĩa), và cùng MODE mà `POST /api/pipelines/:id/run`
          // gate theo: trên một project từng chạy lean, phụ thuộc mà chế độ đó
          // không bao giờ chạy phải thu về bước gần nhất nó có chạy, nếu không
          // các terminal UI sẽ bị khoá vĩnh viễn (xem effectiveDependsOn).
          // Đọc TRƯỚC khi ghi runAllConfig bên dưới — ghi trước thì mode của
          // lần chạy này sẽ tự trả lời chính nó.
          const state = await loadMergedState(projectId);
          const check = validateRunStageSelection(stageIds, wf.pipelineIds, state, {
            workflowName: wf.name,
            mode: runModeFor(project, state, wf.pipelineIds),
          });
          if (!check.ok) return res.status(400).json({ error: check.error });
        }
      }
      // Remember this device's last-used run-all choices (per project) so a
      // later open of the Run-all modal — e.g. after canceling a stage mid-chain
      // — prefills from here instead of forcing the user to re-enter everything.
      // Only Pipeline-Studio's config seeds the FIRST run (no saved config yet);
      // every trigger after that overwrites this with the latest choices.
      const nextRunAllConfig = runAllConfigFromBody(req.body, { withDefaults: true });
      // run-all GHI ĐÈ TOÀN BỘ `runAllConfig` (không merge như PUT run-config)
      // — bài học lịch sử (commit cfef0fe): một field mới mà request không
      // nhắc tới sẽ bị XÓA thay vì giữ nguyên. `appPool` là field như vậy
      // (runAllConfigFromBody đọc thẳng `body.appPool`, không tự điền default
      // dưới `withDefaults`) — PRESERVE nó từ config đã lưu khi request này
      // không gửi key `appPool`.
      const savedRunAllConfig =
        project.metadata?.runAllConfig && typeof project.metadata.runAllConfig === 'object' && !Array.isArray(project.metadata.runAllConfig)
          ? (project.metadata.runAllConfig as RunAllConfig)
          : undefined;
      updateProject(db, projectId, {
        metadata: {
          ...(project.metadata ?? {}),
          // Cùng builder với `PUT .../run-config` để hai đường ghi không lệch shape.
          runAllConfig: {
            ...nextRunAllConfig,
            ...(nextRunAllConfig.appPool === undefined && savedRunAllConfig?.appPool !== undefined
              ? { appPool: savedRunAllConfig.appPool }
              : {}),
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
        ...(designSystemByTarget ? { designSystemByTarget } : {}),
        skipSucceeded,
        lean,
        ...(stageIds && stageIds.length > 0 ? { stageIds } : {}),
        ...(followLinks ? {} : { followLinks: false }),
        ...(includeDescendants ? { includeDescendants: true } : {}),
        ...(docsFromUpload ? { docsFromUpload: true } : {}),
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
      // Gate against the stages this project's mode actually runs: on a LEAN
      // project the UI terminals must stay runnable even though the heuristic
      // review they statically depend on was never part of the chain.
      const wf = workflowForPipeline(def.id);
      if (!computeActive(state, def, runModeFor(project, state, wf?.pipelineIds ?? []))) {
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
      // Multi-target single-stage run: WHICH configured target this run builds.
      // The daemon resolves the target subfolder + platform/audience from
      // targets.json (see RunPipelineRequest.target).
      const rawTarget = req.body?.target;
      if (rawTarget !== undefined && !isUiTarget(rawTarget)) {
        return res
          .status(400)
          .json({ error: "target must be 'mobile', 'web-user' or 'web-backoffice'" });
      }
      const target = rawTarget as UiTarget | undefined;
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
      // UI targets picked at the docs step (docs-to-ui) → daemon writes
      // targets.json. Invalid entries drop; empty/absent → no file (single build).
      const rawTargets = req.body?.targets;
      const targets = Array.isArray(rawTargets)
        ? (rawTargets.filter(
            (t: unknown) => t === 'mobile' || t === 'web-user' || t === 'web-backoffice',
          ) as import('@open-design/contracts').UiTarget[])
        : undefined;
      const { completion: _completion, ...start } = await ctx.pipelines.runPipeline(projectId, def.id, {
        input,
        source,
        designSystemId,
        platform,
        resetScope,
        followLinks,
        includeDescendants,
        target,
        targets,
        designSystemByTarget: parseDesignSystemByTarget(req.body?.designSystemByTarget),
      });
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

  // GET /api/pipelines/confluence/descendants?ref=… — the sub-tree (all levels,
  // flat + treePath) under one page, so the picker renders a checkbox tree.
  app.get('/api/pipelines/confluence/descendants', async (req, res) => {
    const ref = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
    if (!ref) return res.status(400).json({ error: 'ref (Confluence URL/id) is required' });
    try {
      const pages = await ctx.pipelines.bas.confluenceDescendants(ref);
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
