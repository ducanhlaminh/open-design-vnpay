import fs from 'node:fs';
import path from 'node:path';

import multer from 'multer';
import JSZip from 'jszip';
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
// run path. Exposed on GET /api/workflows (docsDir) for the FE; NOT used by
// the App-level doc uploads below — an App's doc corpus lives at
// `<appId>/docs/`, independent of any workflow (see the docs-tree spec's
// multi-root App-level design).
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
//
// `appFiles` is the ONE field here that THROWS on a malformed shape (every
// other field silently drops a bad entry) — it's picked from a real list
// (GET /api/pipelines/apps/:appId/docs-files), so a malformed shape is a
// genuine client bug worth a 400, not a silent no-op. Both call sites
// (PUT .../run-config, POST /api/pipelines/run-all) must catch this and map
// it to 400 — see each route.
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
  // App-corpus selection for the docs-ingest stage (docs-tree/App-corpus
  // "Nguồn tài liệu" rail). Three states: absent (has()===false in patch
  // mode, or key genuinely missing in withDefaults mode) → untouched/omitted;
  // `null` → explicit clear (patch mode only — withDefaults never persists an
  // empty selection, same convention as confluencePages above); an object →
  // validated { appId: non-empty string, paths: non-empty string[] }.
  if (has('appFiles')) {
    const raw = body.appFiles;
    if (raw === undefined) {
      // withDefaults mode, key genuinely absent from the request → omit,
      // mirroring confluencePages' "don't persist an empty selection".
    } else if (raw === null) {
      // Explicit key-present-but-undefined so `{ ...saved, ...patch }` at the
      // call site overrides a previously-saved value (JSON.stringify then
      // drops the key entirely) — `exactOptionalPropertyTypes` forbids this
      // assignment through `out`'s own optional-field type, hence the local cast.
      if (!all) (out as { appFiles?: { appId: string; paths: string[] } | undefined }).appFiles = undefined;
    } else {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('appFiles must be an object { appId, paths } or null to clear');
      }
      const rec = raw as Record<string, unknown>;
      const appId = typeof rec.appId === 'string' ? rec.appId.trim() : '';
      const rawPaths = Array.isArray(rec.paths) ? rec.paths : null;
      if (
        !appId ||
        !rawPaths ||
        rawPaths.length === 0 ||
        !rawPaths.every((p) => typeof p === 'string' && p.trim() !== '')
      ) {
        throw new Error('appFiles must be { appId: non-empty string, paths: non-empty string[] }');
      }
      out.appFiles = { appId, paths: rawPaths.map((p) => (p as string).trim()) };
    }
  }
  // designSystemId là field ba trạng thái: id / null (không dùng) / vắng mặt.
  const dsId = body.designSystemId;
  if (typeof dsId === 'string') out.designSystemId = dsId;
  else if (dsId === null) out.designSystemId = null;
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
import { publishPipelineEvaluation, readPipelineEvaluations } from './feedback.js';
import {
  extractPageId,
  fetchConfluencePageDirect,
  listDescendantPages,
  resolveConfluenceCreds,
} from './bas/bas-client.js';
import type { ConfluenceCreds } from './bas/bas-client.js';
import { writeProjectFile } from './projects.js';

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
  if (s.kind === 'app-files') {
    const appId = typeof s.appId === 'string' ? s.appId.trim() : '';
    if (!appId) throw new Error('source.appId is required for an app-files source');
    const paths = Array.isArray(s.paths)
      ? s.paths.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
      : [];
    if (paths.length === 0) throw new Error('source.paths (at least one) is required for an app-files source');
    return { kind: 'app-files', appId, paths };
  }
  throw new Error('source.kind must be "confluence", "bas", or "app-files"');
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
// 'http' added for sendMulterError — POST /api/pipelines/apps/:appId/upload-zip
// reuses the SAME multer-error responder /api/plugins/upload-zip uses.
export interface RegisterPipelineRoutesDeps extends RouteDeps<'db' | 'pipelines' | 'paths' | 'http'> {}

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
  type AppEntry = { id: string; name?: string; confluenceRoots?: string[]; origin: 'local' | 'remote' };
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
    // {appId, appName} nên nguồn duy nhất là bảng pipeline_apps. confluenceRoots
    // CŨNG chỉ sống ở đây (không denormalize trên feature — xem docs-tree spec).
    for (const a of listPipelineApps(db)) {
      const existing = byId.get(a.id);
      if (existing) {
        mergeName(existing, a.name && a.name !== a.id ? a.name : undefined);
        if (!existing.confluenceRoots?.length && a.confluenceRoots?.length) {
          existing.confluenceRoots = a.confluenceRoots;
        }
      } else {
        byId.set(a.id, {
          id: a.id,
          ...(a.name && a.name !== a.id ? { name: a.name } : {}),
          ...(a.confluenceRoots?.length ? { confluenceRoots: a.confluenceRoots } : {}),
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

  // Optional `confluenceRoots`/`confluenceRoot` field (POST create / PATCH
  // update, docs-tree spec — multi-root revision): an App's Confluence scope
  // is now MULTIPLE roots.
  //   - `confluenceRoots: string[]` (NEW, plural) — each entry normalized via
  //     extractPageId (a URL that doesn't resolve throws → 400); `[]` clears.
  //     Must be an array of non-empty strings, else 400.
  //   - `confluenceRoot: string` (LEGACY, singular) — kept accepting so
  //     existing callers don't break: normalizes to a 1-element array; ''
  //     clears. A present-but-non-string value 400s rather than silently
  //     falling through to the clear branch.
  //   - Both present → `confluenceRoots` wins.
  //   - Neither present → caller leaves the stored roots untouched.
  const parseConfluenceRootsField = (
    body: Record<string, unknown>,
  ): { present: boolean; value: string[] } => {
    if (Object.prototype.hasOwnProperty.call(body, 'confluenceRoots')) {
      const raw = body.confluenceRoots;
      if (!Array.isArray(raw)) {
        throw new Error('confluenceRoots must be an array of Confluence URLs/page ids');
      }
      const seen = new Set<string>();
      const value: string[] = [];
      for (const entry of raw) {
        if (typeof entry !== 'string') {
          throw new Error('confluenceRoots entries must be strings (Confluence URL or page id)');
        }
        const trimmed = entry.trim();
        if (!trimmed) {
          throw new Error('confluenceRoots entries must not be empty');
        }
        const pageId = extractPageId(trimmed);
        if (!seen.has(pageId)) {
          seen.add(pageId);
          value.push(pageId);
        }
      }
      return { present: true, value };
    }
    if (Object.prototype.hasOwnProperty.call(body, 'confluenceRoot')) {
      const raw = body.confluenceRoot;
      if (typeof raw !== 'string') {
        throw new Error('confluenceRoot must be a string (Confluence URL, page id, or "" to clear)');
      }
      const trimmed = raw.trim();
      return { present: true, value: trimmed ? [extractPageId(trimmed)] : [] };
    }
    return { present: false, value: [] };
  };

  // POST /api/pipelines/apps { appId, name, confluenceRoots?, confluenceRoot? }
  // — tạo App container 0 feature. Form "App mới" trên UI chỉ tạo App;
  // feature thêm sau qua POST /api/pipelines/projects (khi đó {appId,
  // appName} được mirror vào metadata.studioConfig của feature). App 0
  // feature không có gì để chạy/push nên route này là LOCAL-ONLY: không chạm
  // KGS/studio/media. `confluenceRoots` (docs-tree spec) là danh sách URL
  // hoặc page id Confluence — chuẩn hóa từng phần tử về pageId.
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
    let confluenceRoots: string[] = [];
    try {
      const parsed = parseConfluenceRootsField((req.body ?? {}) as Record<string, unknown>);
      if (parsed.present) confluenceRoots = parsed.value;
    } catch (err: any) {
      return res.status(400).json({ error: String(err?.message ?? err) });
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
    insertPipelineApp(db, { id: appId, name, createdAt: Date.now(), ...(confluenceRoots.length ? { confluenceRoots } : {}) });
    res.status(201).json({
      id: appId,
      name,
      ...(confluenceRoots.length ? { confluenceRoot: confluenceRoots[0], confluenceRoots } : {}),
    });
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
    // `confluenceRoot` (singular, first root) rides along `confluenceRoots`
    // for one release of back-compat — a client reading the old field never
    // sees an app with roots go silently blank.
    const apps = Array.from(byId.values())
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({
        id: e.id,
        ...(e.name ? { name: e.name } : {}),
        ...(e.confluenceRoots?.length
          ? { confluenceRoot: e.confluenceRoots[0], confluenceRoots: e.confluenceRoots }
          : {}),
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

  // PATCH /api/pipelines/apps/:id { name, confluenceRoots?, confluenceRoot? }
  // — đổi TÊN HIỂN THỊ của App (id giữ nguyên vì nó là project_id trên KGS)
  // và, khi gửi kèm, confluenceRoots (docs-tree spec, multi-root revision —
  // [] xóa hết, phần tử không hợp lệ → 400; `confluenceRoot` singular vẫn
  // được chấp nhận cho back-compat, '' xóa, và thua `confluenceRoots` khi cả
  // hai cùng có mặt). Ghi hai chỗ vì tên App sống ở hai nguồn: row
  // pipeline_apps (UPSERT — App có feature chưa chắc có row) và appName
  // denormalize trên từng feature (GET /api/pipelines/projects đọc ở đó);
  // confluenceRoots chỉ sống ở pipeline_apps (không denormalize).
  app.patch('/api/pipelines/apps/:id', async (req, res) => {
    const appId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    // Rename được cả App remote: row local chỉ là cái tên phủ lên (picker cho
    // tên local thắng), không đổi gì trên studio.
    if (!collectLocalApps().has(appId) && !(await remoteAppIds())?.has(appId)) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }
    let confluenceRootsPatch: { present: boolean; value: string[] };
    try {
      confluenceRootsPatch = parseConfluenceRootsField((req.body ?? {}) as Record<string, unknown>);
    } catch (err: any) {
      return res.status(400).json({ error: String(err?.message ?? err) });
    }
    upsertPipelineAppName(db, {
      id: appId,
      name,
      createdAt: Date.now(),
      ...(confluenceRootsPatch.present ? { confluenceRoots: confluenceRootsPatch.value } : {}),
    });
    for (const f of featuresOfApp(appId)) {
      updateProject(db, f.id, {
        metadata: {
          ...(f.metadata ?? {}),
          studioConfig: { ...studioConfigOf(f), appId, appName: name },
        },
      });
    }
    const finalConfluenceRoots = confluenceRootsPatch.present
      ? confluenceRootsPatch.value
      : (getPipelineApp(db, appId)?.confluenceRoots ?? []);
    res.json({
      id: appId,
      name,
      ...(finalConfluenceRoots.length
        ? { confluenceRoot: finalConfluenceRoots[0], confluenceRoots: finalConfluenceRoots }
        : {}),
    });
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

  // ---- App docs-tree browse (docs-tree picker spec §2, multi-root revision) ─
  // GET /api/pipelines/apps/:appId/docs-tree — the MERGED Confluence sub-tree
  // under ALL of the App's declared `confluence_root`s, for the run-source
  // modal's "Tài liệu App" tab. Ingest stages that record a page selection here.
  const INGEST_STAGE_IDS = ['docs', 'prd-docs', 'dr-docs'] as const;
  // listDescendantPages' own default is the same 500; named locally so the
  // truncation check below reads as intent, not a magic re-derivation of the
  // library's default.
  const DOCS_TREE_HARD_CAP = 500;

  // pageId -> which sibling features (same App) already ingested it, per
  // ingest-stage `lastInput`/`lastSource`. In-memory over the projects list,
  // best-effort: a ref that doesn't parse as a Confluence page id (a JIRA
  // key/JQL run) is skipped rather than surfaced as an error — this is a
  // hint, not a ledger (see spec's "Risks / edge cases").
  const collectDocsTreeUsedBy = (
    appId: string,
  ): Map<string, Array<{ projectId: string; pipelineId: string }>> => {
    const map = new Map<string, Array<{ projectId: string; pipelineId: string }>>();
    const add = (pageId: string, projectId: string, pipelineId: string) => {
      const arr = map.get(pageId) ?? [];
      if (!arr.some((e) => e.projectId === projectId && e.pipelineId === pipelineId)) {
        arr.push({ projectId, pipelineId });
        map.set(pageId, arr);
      }
    };
    for (const p of listProjects(db) as LocalFeature[]) {
      if (!isKgsProject(p)) continue;
      if (studioConfigOf(p).appId !== appId) continue;
      const pipelines = (p.metadata?.pipelines ?? {}) as Record<
        string,
        { lastInput?: unknown; lastSource?: unknown }
      >;
      for (const stageId of INGEST_STAGE_IDS) {
        const run = pipelines[stageId];
        if (!run) continue;
        const refs: string[] = [];
        if (typeof run.lastInput === 'string') {
          refs.push(...run.lastInput.split('\n').map((l) => l.trim()).filter(Boolean));
        }
        if (
          run.lastSource &&
          typeof run.lastSource === 'object' &&
          (run.lastSource as Record<string, unknown>).kind === 'confluence' &&
          typeof (run.lastSource as Record<string, unknown>).ref === 'string'
        ) {
          refs.push((run.lastSource as Record<string, unknown>).ref as string);
        }
        for (const ref of refs) {
          try {
            add(extractPageId(ref), p.id, stageId);
          } catch {
            /* not a Confluence ref (JIRA key/JQL) — best-effort, skip */
          }
        }
      }
    }
    return map;
  };

  // Best-effort root page title: id fallback keeps the response usable when
  // the PAT can't read the root page's metadata (permissions) even though
  // listDescendantPages (CQL `ancestor=`) still succeeds.
  const bestEffortPageTitle = async (creds: ConfluenceCreds, pageId: string): Promise<string> => {
    try {
      return (await fetchConfluencePageDirect(creds, pageId)).title || pageId;
    } catch {
      return pageId;
    }
  };

  app.get('/api/pipelines/apps/:appId/docs-tree', async (req, res) => {
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    // Local `pipeline_apps` only — an App that only exists denormalized on
    // features (no row yet) has never had a confluence_root configured.
    const appRow = getPipelineApp(db, appId);
    if (!appRow) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }
    const roots = appRow.confluenceRoots ?? [];
    if (roots.length === 0) {
      return res.status(400).json({ error: `app "${appId}" has no confluence_root configured` });
    }
    const creds = await resolveConfluenceCreds(ctx.paths.RUNTIME_DATA_DIR);
    if (!creds) {
      return res.status(502).json({
        error:
          'Chưa có credential Confluence (CONFLUENCE_URL + CONFLUENCE_PERSONAL_TOKEN) — cần PAT để đọc cây trang.',
      });
    }
    const usedByMap = collectDocsTreeUsedBy(appId);
    type PageOut = {
      pageId: string;
      title: string;
      treePath: string[];
      rootPageId: string;
      usedBy: Array<{ projectId: string; pipelineId: string }>;
    };
    // Merge every root's sub-tree into one page list. Insertion order = roots
    // order; a page reachable from TWO overlapping roots keeps the FIRST
    // root's entry (Map.set is a no-op on an existing key below).
    const pagesById = new Map<string, PageOut>();
    const rootsOut: Array<{ pageId: string; title: string }> = [];
    let truncated = false;
    for (const root of roots) {
      const rootTitle = await bestEffortPageTitle(creds, root);
      rootsOut.push({ pageId: root, title: rootTitle });
      // The root page ITSELF is a legitimate, selectable ingest target (the
      // old single-root shape excluded it) — treePath [] marks it as top-level.
      if (!pagesById.has(root)) {
        pagesById.set(root, {
          pageId: root,
          title: rootTitle,
          treePath: [],
          rootPageId: root,
          usedBy: usedByMap.get(root) ?? [],
        });
      }
      let fetched: Awaited<ReturnType<typeof listDescendantPages>>;
      try {
        // Ask for ONE more than the cap: listDescendantPages itself hard-stops
        // at its `hardCap` arg (returns exactly that many when the tree is
        // bigger OR exactly that size), so capping the request at
        // DOCS_TREE_HARD_CAP can't tell "exactly 500 pages" apart from "more
        // than 500, cut short". The +1 sentinel disambiguates; sliced back
        // down to DOCS_TREE_HARD_CAP for the response either way.
        fetched = await listDescendantPages(creds, root, DOCS_TREE_HARD_CAP + 1);
      } catch (err: any) {
        return res.status(502).json({ error: String(err?.message ?? err) });
      }
      const rootTruncated = fetched.length > DOCS_TREE_HARD_CAP;
      if (rootTruncated) truncated = true;
      const descendants = rootTruncated ? fetched.slice(0, DOCS_TREE_HARD_CAP) : fetched;
      for (const p of descendants) {
        if (pagesById.has(p.pageId)) continue; // dedupe overlap — keep first
        pagesById.set(p.pageId, {
          pageId: p.pageId,
          title: p.title,
          treePath: p.treePath,
          rootPageId: root,
          usedBy: usedByMap.get(p.pageId) ?? [],
        });
      }
    }
    res.json({
      // Singular `root` kept for one release of back-compat with the
      // single-root response shape — first root, same {pageId, title} shape.
      root: rootsOut[0],
      roots: rootsOut,
      pages: Array.from(pagesById.values()),
      truncated,
    });
  });

  // ── App-level doc corpus upload (no-API Confluence "export to MD") ─────────
  // The App (`pipeline_apps`) owns the docs corpus, not any one pipeline run:
  // a feature's run-config later PICKS files out of what the App already
  // loaded (see the `app-files` deterministic run source in server.ts's
  // `runPipeline`) — uploading is a one-time App-level load, independent of
  // any workflow. Two upload shapes land in the SAME place,
  // `<PROJECTS_DIR>/<appId>/docs/`:
  //   - POST .../upload-folder — JSON batch (files[].text|base64), for a
  //     browser folder-picker that can't produce one multipart request
  //     without re-flattening every path (see UploadFilesModal's header
  //     comment on why multipart strips '/' out of names).
  //   - POST .../upload-zip — one multipart zip (raw bytes, no base64
  //     inflation) for a Confluence "export to MD" delivered as an archive.
  // Both funnel through the SAME per-entry validate core (validateUploadPath)
  // and the SAME write pass (writeValidatedUploadEntries) — reusing
  // `writeProjectFile` (project.ts), the exact helper /api/projects/:id/files
  // calls, so target-dir resolution and overwrite semantics stay identical to
  // every other project-file write path in the daemon.
  const UPLOAD_MAX_FILES = 300;
  const UPLOAD_MAX_FILE_BYTES = 10 * 1024 * 1024;
  const UPLOAD_MAX_REQUEST_BYTES = 80 * 1024 * 1024;
  const UPLOAD_ZIP_MAX_BYTES = 200 * 1024 * 1024;
  const UPLOAD_ZIP_MAX_EXTRACTED_BYTES = 300 * 1024 * 1024;
  // NO extension allowlist: a real Confluence "export to MD" folder mixes
  // genuine extensionless documents (Confluence attachment names sometimes
  // carry none) with export-tool artifacts (.tmp/.html/.render/.tfss) the
  // user still wants preserved verbatim — a real 590-file export lost 117
  // files (57 of them extensionless, real documents) to a prior allowlist
  // here. Path safety + size caps are the only gate; content type is not
  // this route's concern.

  // Path safety for one entry of a batch: absolute / '..' / backslash /
  // empty-segment paths are REJECTED (skip that entry, never trust a client-
  // supplied path enough to hand it to writeProjectFile's own sanitizer
  // un-checked) — distinct from writeProjectFile's own `sanitizePath`, which
  // silently NORMALIZES backslashes into separators; this route's contract
  // is stricter: backslashes are a hard skip, not a normalize. Doubles as the
  // zip-slip guard for upload-zip (a zip entry name is just another
  // client-supplied path).
  const validateUploadRelPath = (
    raw: unknown,
  ): { ok: true; relPath: string } | { ok: false; reason: string } => {
    if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'empty path' };
    if (raw.includes('\\')) return { ok: false, reason: 'backslashes are not allowed in path' };
    if (raw.includes('\0')) return { ok: false, reason: 'invalid path' };
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
      return { ok: false, reason: 'absolute paths are not allowed' };
    }
    const segments = raw.split('/');
    if (segments.some((s) => s === '')) return { ok: false, reason: 'empty path segment' };
    if (segments.some((s) => s === '..')) return { ok: false, reason: 'path traversal (..) is not allowed' };
    return { ok: true, relPath: segments.join('/') };
  };

  // Shared per-entry CORE for both upload routes: path safety ONLY — no
  // extension gate (see the note above). A problem here is a per-entry SKIP —
  // one malformed path must never fail the rest of a real folder/zip export.
  // (The per-file BYTE-SIZE cap is intentionally NOT folded in here — it 400s
  // the WHOLE request in both callers, so each keeps that check inline where
  // it can `return` immediately.)
  const validateUploadPath = (
    rawPath: unknown,
  ): { ok: true; relPath: string } | { ok: false; path: string; reason: string } => {
    const pathCheck = validateUploadRelPath(rawPath);
    if (!pathCheck.ok) {
      return { ok: false, path: typeof rawPath === 'string' ? rawPath : '(invalid)', reason: pathCheck.reason };
    }
    return { ok: true, relPath: pathCheck.relPath };
  };

  // Shared write pass for both upload routes: <PROJECTS_DIR>/<appId>/docs/<relPath>.
  const writeValidatedUploadEntries = async (
    appId: string,
    toWrite: Array<{ relPath: string; buf: Buffer }>,
  ): Promise<{ written: number; skipped: Array<{ path: string; reason: string }> }> => {
    let written = 0;
    const writeFailures: Array<{ path: string; reason: string }> = [];
    for (const { relPath, buf } of toWrite) {
      try {
        await writeProjectFile(ctx.paths.PROJECTS_DIR, appId, `docs/${relPath}`, buf, {}, undefined);
        written += 1;
      } catch (err: any) {
        writeFailures.push({ path: relPath, reason: String(err?.message ?? err) });
      }
    }
    return { written, skipped: writeFailures };
  };

  // POST /api/pipelines/apps/:appId/upload-folder { files: [{path, text?, base64?}] }
  app.post('/api/pipelines/apps/:appId/upload-folder', async (req, res) => {
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    if (!getPipelineApp(db, appId)) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }

    const files = Array.isArray(req.body?.files) ? (req.body.files as unknown[]) : [];
    if (files.length === 0) return res.status(400).json({ error: 'files are required' });
    if (files.length > UPLOAD_MAX_FILES) {
      return res.status(400).json({
        error: `too many files in one request (max ${UPLOAD_MAX_FILES}) — chunk the upload`,
      });
    }

    // Pass 1: validate path + content shape, decode to a Buffer, and enforce
    // the per-file / total-request byte caps — ALL before a single byte hits
    // disk, so a cap violation 400s the whole request with nothing partially
    // written (the FE is expected to chunk under these caps; hitting one
    // here is a client bug, not something to silently truncate).
    const skipped: Array<{ path: string; reason: string }> = [];
    const toWrite: Array<{ relPath: string; buf: Buffer }> = [];
    let totalBytes = 0;
    for (const raw of files) {
      const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const pe = validateUploadPath(entry.path);
      if (!pe.ok) {
        skipped.push({ path: pe.path, reason: pe.reason });
        continue;
      }
      const hasText = typeof entry.text === 'string';
      const hasBase64 = typeof entry.base64 === 'string';
      if (hasText === hasBase64) {
        // Both present or neither — same "not exactly one" rejection either way.
        skipped.push({ path: pe.relPath, reason: 'exactly one of text or base64 is required' });
        continue;
      }
      let buf: Buffer;
      try {
        buf = hasText ? Buffer.from(entry.text as string, 'utf8') : Buffer.from(entry.base64 as string, 'base64');
      } catch {
        skipped.push({ path: pe.relPath, reason: 'invalid base64 content' });
        continue;
      }
      if (buf.length > UPLOAD_MAX_FILE_BYTES) {
        return res.status(400).json({
          error: `file too large (max ${UPLOAD_MAX_FILE_BYTES} bytes): ${pe.relPath}`,
        });
      }
      totalBytes += buf.length;
      if (totalBytes > UPLOAD_MAX_REQUEST_BYTES) {
        return res.status(400).json({
          error: `request exceeds ${UPLOAD_MAX_REQUEST_BYTES} bytes total — chunk the upload into smaller batches`,
        });
      }
      toWrite.push({ relPath: pe.relPath, buf });
    }

    const result = await writeValidatedUploadEntries(appId, toWrite);
    res.json({ written: result.written, skipped: [...skipped, ...result.skipped] });
  });

  // Multipart zip upload — raw bytes, NO base64 (avoids the ~1.33× inflation
  // the JSON upload-folder path pays). Memory storage: the extraction below
  // needs the whole buffer for JSZip anyway, and the 200MB cap keeps this
  // bounded. Mirrors `pluginUpload` (server.ts's POST /api/plugins/upload-zip)
  // in shape, sized for this route's own cap.
  const pipelineZipUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: UPLOAD_ZIP_MAX_BYTES, files: 1 },
  });

  // POST /api/pipelines/apps/:appId/upload-zip — multipart, field "file".
  app.post('/api/pipelines/apps/:appId/upload-zip', (req, res) => {
    pipelineZipUpload.single('file')(req, res, async (err) => {
      if (err) return ctx.http.sendMulterError(res, err);
      const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
      if (!getPipelineApp(db, appId)) {
        return res.status(404).json({ error: `app "${appId}" not found` });
      }
      const file = (req as any).file as { buffer: Buffer } | undefined;
      if (!file || !file.buffer) {
        return res.status(400).json({ error: 'file is required' });
      }

      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(file.buffer);
      } catch (err2: any) {
        return res.status(400).json({ error: `not a valid zip file: ${String(err2?.message ?? err2)}` });
      }
      const entries = Object.values(zip.files);
      if (entries.length === 0) {
        return res.status(400).json({ error: 'zip contains no files' });
      }

      // Same validate-then-write two-pass shape as upload-folder: a per-file
      // size violation or the total-extracted cap 400s the whole request
      // before anything is written; a bad path is a per-entry skip.
      const skipped: Array<{ path: string; reason: string }> = [];
      const toWrite: Array<{ relPath: string; buf: Buffer }> = [];
      let totalBytes = 0;
      for (const entry of entries) {
        if (entry.dir) continue;
        // Zip-safety (reused from /api/plugins/upload-zip's extractPluginZipToFolder):
        // a zip entry can encode a symlink via its unix permission bits in
        // the external file attributes — reject it outright rather than
        // trusting the path check alone, since a symlink can point outside
        // the write target even when its OWN zip-entry name is safe.
        const unixMode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
        if ((unixMode & 0o170000) === 0o120000) {
          skipped.push({ path: entry.name, reason: 'zip entry is a symbolic link' });
          continue;
        }
        // Entry paths = paths inside the zip, top folder kept (no stripping).
        const pe = validateUploadPath(entry.name);
        if (!pe.ok) {
          skipped.push({ path: pe.path, reason: pe.reason });
          continue;
        }
        const buf = await entry.async('nodebuffer');
        if (buf.length > UPLOAD_MAX_FILE_BYTES) {
          return res.status(400).json({
            error: `file too large (max ${UPLOAD_MAX_FILE_BYTES} bytes): ${pe.relPath}`,
          });
        }
        totalBytes += buf.length;
        if (totalBytes > UPLOAD_ZIP_MAX_EXTRACTED_BYTES) {
          return res.status(400).json({
            error: `extracted content exceeds ${UPLOAD_ZIP_MAX_EXTRACTED_BYTES} bytes total`,
          });
        }
        toWrite.push({ relPath: pe.relPath, buf });
      }

      const result = await writeValidatedUploadEntries(appId, toWrite);
      res.json({ written: result.written, skipped: [...skipped, ...result.skipped] });
    });
  });

  // GET /api/pipelines/apps/:appId/docs-files — recursive listing of the
  // App's uploaded doc corpus, for the run-config source picker (which PICKS
  // files out of this list rather than re-uploading per feature).
  const DOCS_FILE_TITLE_EXTENSIONS = new Set(['.md', '.markdown']);
  // Only the HEAD of a doc file matters for a display title — a 2KB read
  // comfortably covers any real front-matter/heading without paying for a
  // full-file read across a few hundred markdown files per request.
  const DOCS_FILE_TITLE_HEAD_BYTES = 2048;
  // A line that's ENTIRELY one markdown image/link and nothing else — never a
  // usable title (e.g. a lone `![Diagram](attachments/x.png)` as the first
  // line of an export).
  const IMAGE_OR_LINK_ONLY_LINE = /^!?\[[^\]]*\]\([^)]*\)$/;

  // Confluence's "export to MD" slugifies filenames (diacritics dropped,
  // spaces→hyphens — "1-tng-quan-h-thng..."), but the real title survives
  // INSIDE the file as the first heading. Never renamed on disk: other
  // exported .md files cross-reference these exact slug paths, and renaming
  // would break every such link. This is purely a DISPLAY title layered onto
  // the listing.
  //   1. First ATX heading (`#`..`######`) anywhere in the head chunk, its
  //      captured text with trailing `#`s/whitespace stripped.
  //   2. Else the first non-empty line, IF it's short (<200 chars) and not an
  //      image/link-only line — otherwise no title (undefined), not a worse
  //      guess.
  const extractMdTitle = async (fullPath: string): Promise<string | undefined> => {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(fullPath, 'r');
      const buf = Buffer.alloc(DOCS_FILE_TITLE_HEAD_BYTES);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const lines = buf.toString('utf8', 0, bytesRead).split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        const m = /^#{1,6}\s+(.+)$/.exec(line);
        if (m) {
          const title = m[1]!.replace(/\s*#+\s*$/, '').trim();
          if (title) return title;
        }
      }
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.length >= 200) return undefined;
        if (IMAGE_OR_LINK_ONLY_LINE.test(line)) return undefined;
        return line;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => {});
    }
  };

  const walkDocsFiles = async (
    dir: string,
    relDir: string,
    out: Array<{ path: string; size: number; title?: string }>,
  ) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDocsFiles(full, rel, out);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = await fs.promises.stat(full);
      const ext = path.extname(entry.name).toLowerCase();
      const title = DOCS_FILE_TITLE_EXTENSIONS.has(ext) ? await extractMdTitle(full) : undefined;
      out.push({ path: rel, size: st.size, ...(title ? { title } : {}) });
    }
  };

  app.get('/api/pipelines/apps/:appId/docs-files', async (req, res) => {
    const appId = typeof req.params.appId === 'string' ? req.params.appId.trim() : '';
    if (!getPipelineApp(db, appId)) {
      return res.status(404).json({ error: `app "${appId}" not found` });
    }
    const docsDir = path.join(ctx.paths.PROJECTS_DIR, appId, 'docs');
    const files: Array<{ path: string; size: number; title?: string }> = [];
    await walkDocsFiles(docsDir, '', files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ files });
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
    let patch: Partial<RunAllConfig>;
    try {
      patch = runAllConfigFromBody(req.body);
    } catch (err: any) {
      return res.status(400).json({ error: String(err?.message ?? err) });
    }
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
      updateProject(db, projectId, {
        metadata: {
          ...(project.metadata ?? {}),
          // Cùng builder với `PUT .../run-config` để hai đường ghi không lệch shape.
          runAllConfig: runAllConfigFromBody(req.body, { withDefaults: true }),
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
          : /^appFiles/.test(msg) // runAllConfigFromBody's appFiles validation (see there)
            ? 400
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
