// WP25a — "Dựng trong Figma" per màn: job registry + HTTP routes.
//
// Daemon compiles a deterministic input (figma-build.ts's
// compileScreenBuildInput) and spawns ONE agent run per screen — the run
// carries the Figma MCP server the user already OAuth'd (Settings → MCP),
// narrowed to exactly that one server via the INTERNAL_MCP_SERVER_IDS
// Symbol-gate (server.ts). The daemon itself never talks to Figma's write
// API (it doesn't have one) — see figma-build.ts's docblock.
//
// Job shape clones the figma-guide job pattern (figma-design-system-
// routes.ts): registry keyed by project (one job/project at a time), 202
// immediately, background loop, /active for cross-project re-attach, TTL
// lazy cleanup for finished jobs.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';

import { getProject, insertConversation, upsertMessage } from './db.js';
import {
  catalogHasComponentKeys,
  compileScreenBuildInput,
  parseFigmaPreviewLink,
  pickFigmaMcpServer,
  readFigmaPreviewConfig,
  readFrozenFigmaCatalog,
  writeFigmaPreviewConfig,
  type FigmaPreviewConfig,
  type McpServerLike,
  type ScreenBuildSourceDoc,
} from './figma-build.js';
import { effectiveMcpAuthMode, readMcpConfig, type McpServerConfig } from './mcp-config.js';
import { getToken } from './mcp-tokens.js';
import { workflowDirForPipeline } from './pipelines.js';
import { ensureProject } from './projects.js';
import { screenDocRel, wireframeRel } from './screen-components.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterFigmaBuildRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'design' | 'chat' | 'agents'> {}

const docsReviewCwd = async (projectsDir: string, projectId: string): Promise<string> => {
  const projectRoot = await ensureProject(projectsDir, projectId);
  return path.join(projectRoot, workflowDirForPipeline('dr-comp') ?? 'docs-review');
};

function figmaFrameUrl(fileKey: string, nodeId: string): string {
  return `https://www.figma.com/design/${fileKey}/?node-id=${nodeId.replace(':', '-')}`;
}

// ── job state ─────────────────────────────────────────────────────────────

interface FigmaBuildJobItemState {
  screenKey: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  frameUrl?: string;
  error?: string;
  warnings?: string[];
}

interface FigmaBuildJobState {
  id: string;
  projectId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  items: Map<string, FigmaBuildJobItemState>;
  order: string[];
  createdAt: number;
  updatedAt: number;
  startedAtMs: number;
  finishedAtMs?: number;
}

// Dọn lười — job kết thúc >10' trước bị loại khỏi registry lần GET /active kế
// tiếp, cùng hằng số/khuôn với figmaGuideJobs (figma-design-system-routes.ts).
const ACTIVE_BUILD_JOB_RETENTION_MS = 10 * 60 * 1000;

export function registerFigmaBuildRoutes(app: Express, deps: RegisterFigmaBuildRoutesDeps): void {
  const { db } = deps;
  const { PROJECTS_DIR, RUNTIME_DATA_DIR } = deps.paths;
  const guard = (req: any, res: any): boolean => {
    if (deps.http.isLocalSameOrigin(req, deps.http.resolvedPortRef.current)) return true;
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'cross-origin request rejected' } });
    return false;
  };

  const jobs = new Map<string, FigmaBuildJobState>();
  const jobByProject = new Map<string, string>();

  const toJobResponse = (job: FigmaBuildJobState) => ({
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    items: job.order.map((screenKey) => job.items.get(screenKey)!),
  });

  /** Spawn + await ONE agent run for one screen, in its OWN conversation
   *  (titled `Dựng Figma · <tên màn>` — WP25a decision #6, unlike the
   *  figma-guide job's single shared conversation for the whole job: each
   *  screen here is an independent Figma MCP session). Throws when the run
   *  doesn't end `succeeded` — caller marks that one item failed and moves
   *  on to the next screen (job keeps running). */
  async function runFigmaScreenBuildAgent(opts: {
    projectId: string;
    cwdSubdir: string;
    screenKey: string;
    screenName: string;
    inputRelPath: string;
    resultRelPath: string;
    mcpServerId: string;
    execution: { agentId: string; modelPrefs: { model?: string | null; reasoning?: string | null } };
  }): Promise<void> {
    const { design, chat, agents } = deps;
    const conversationId = `figma-build-conv-${randomUUID()}`;
    const rowNow = Date.now();
    insertConversation(db, {
      id: conversationId,
      projectId: opts.projectId,
      title: `Dựng Figma · ${opts.screenName}`,
      createdAt: rowNow,
      updatedAt: rowNow,
    });
    const assistantMessageId = `figma-build-assistant-${randomUUID()}`;
    const kickoff =
      `Áp skill "figma-screen-build". Đọc "${opts.inputRelPath}" (đường dẫn tính từ cwd của bạn), ` +
      `dựng màn trong file Figma preview theo đúng hợp đồng của skill, rồi ghi ĐÚNG MỘT file "${opts.resultRelPath}" ` +
      `cùng thư mục. Không sửa file nào khác, không mở/sửa file Figma nào khác ngoài file preview.`;
    const run = design.runs.create({
      projectId: opts.projectId,
      conversationId,
      assistantMessageId,
      clientRequestId: `figma-build-${randomUUID()}`,
      agentId: opts.execution.agentId,
    });
    upsertMessage(db, conversationId, { id: `figma-build-user-${run.id}`, role: 'user', content: kickoff });
    upsertMessage(db, conversationId, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      agentId: opts.execution.agentId,
      agentName: agents?.getAgentDef?.(opts.execution.agentId)?.name ?? opts.execution.agentId,
      runId: run.id,
      runStatus: 'queued',
      startedAt: Date.now(),
    });
    // WP25a: narrow this run's external MCP servers to EXACTLY the one Figma
    // server picked for the job — via the chat dep's `withMcpServerIds`
    // wrapper (server.ts owns the actual Symbol; this route module never
    // imports it, which would create a server.ts ⇄ figma-build-routes.ts
    // import cycle — see registerFigmaBuildRoutes's call site in server.ts).
    const baseChatBody = {
      agentId: opts.execution.agentId,
      projectId: opts.projectId,
      conversationId,
      assistantMessageId,
      clientRequestId: run.clientRequestId,
      skillId: 'figma-screen-build',
      cwdSubdir: opts.cwdSubdir,
      model: opts.execution.modelPrefs.model ?? null,
      reasoning: opts.execution.modelPrefs.reasoning ?? null,
      message: kickoff,
      systemPrompt: 'Bạn đang chạy một job không có người ngồi cạnh. Không hỏi lại, không chờ input — chọn mặc định hợp lý và hoàn thành.',
    };
    const chatBody = typeof chat.withMcpServerIds === 'function'
      ? chat.withMcpServerIds(baseChatBody, [opts.mcpServerId])
      : baseChatBody;
    design.runs.start(run, () => chat.startChatRun(chatBody, run));
    const final = await design.runs.wait(run);
    db.prepare(`UPDATE messages SET run_status = ?, ended_at = ? WHERE id = ?`).run(final.status, Date.now(), assistantMessageId);
    if (final.status !== 'succeeded') {
      throw new Error(`Agent kết thúc với trạng thái "${final.status}".`);
    }
  }

  function startFigmaBuildJob(opts: {
    projectId: string;
    cwd: string;
    cwdSubdir: string;
    screenKeys: string[];
    previewConfig: FigmaPreviewConfig;
    mcpServer: McpServerLike;
    catalog: Parameters<typeof compileScreenBuildInput>[0]['catalog'];
    execution: { agentId: string; modelPrefs: { model?: string | null; reasoning?: string | null } };
  }): FigmaBuildJobState {
    const rowNow = Date.now();
    const job: FigmaBuildJobState = {
      id: randomUUID(),
      projectId: opts.projectId,
      status: 'queued',
      order: [...opts.screenKeys],
      items: new Map(opts.screenKeys.map((screenKey) => [screenKey, { screenKey, status: 'queued' as const }])),
      createdAt: rowNow,
      updatedAt: rowNow,
      startedAtMs: rowNow,
    };
    jobs.set(job.id, job);
    jobByProject.set(opts.projectId, job.id);
    const touch = () => { job.updatedAt = Date.now(); };

    void (async () => {
      job.status = 'running';
      touch();
      try {
      const project = getProject(db, opts.projectId);
      const appFeature = (project?.name && String(project.name).trim()) || opts.projectId;
      // Tuần tự — Figma MCP vốn phải tuần tự (một phiên/lượt), WP25a quyết
      // định #6. Một màn lỗi KHÔNG dừng job — item đó failed, job chạy tiếp.
      for (const screenKey of opts.screenKeys) {
        const item = job.items.get(screenKey)!;
        item.status = 'running';
        touch();
        try {
          const screenDocRaw = await fs.promises.readFile(path.join(opts.cwd, screenDocRel(screenKey)), 'utf8').catch(() => null);
          if (screenDocRaw == null) throw new Error(`Không tìm thấy ${screenDocRel(screenKey)}.`);
          const screenDoc = JSON.parse(screenDocRaw) as ScreenBuildSourceDoc;
          const wireframeHtml = await fs.promises.readFile(path.join(opts.cwd, wireframeRel(screenKey)), 'utf8').catch(() => null);
          const input = compileScreenBuildInput({
            screenDoc,
            wireframeHtml,
            catalog: opts.catalog,
            previewFileKey: opts.previewConfig.fileKey,
            appFeature,
          });
          const buildDir = path.join(opts.cwd, 'comp', 'figma-build');
          await fs.promises.mkdir(buildDir, { recursive: true });
          const inputPath = path.join(buildDir, `${screenKey}.input.json`);
          const resultPath = path.join(buildDir, `${screenKey}.result.json`);
          // Dọn kết quả lần chạy trước — tránh đọc nhầm result.json cũ nếu
          // lượt agent lần này không ghi ra được gì (throw trước khi ghi).
          await fs.promises.rm(resultPath, { force: true });
          await fs.promises.writeFile(inputPath, JSON.stringify(input, null, 2), 'utf8');

          await runFigmaScreenBuildAgent({
            projectId: opts.projectId,
            cwdSubdir: opts.cwdSubdir,
            screenKey,
            screenName: screenDoc.name ?? screenKey,
            inputRelPath: path.posix.join('comp', 'figma-build', `${screenKey}.input.json`),
            resultRelPath: path.posix.join('comp', 'figma-build', `${screenKey}.result.json`),
            mcpServerId: opts.mcpServer.id,
            execution: opts.execution,
          });

          const resultRaw = await fs.promises.readFile(resultPath, 'utf8');
          const result = JSON.parse(resultRaw) as { frameNodeId?: string; frameUrl?: string; warnings?: string[] };
          if (!result?.frameNodeId || typeof result.frameNodeId !== 'string') {
            throw new Error('Agent không ghi "frameNodeId" hợp lệ trong result.json.');
          }
          item.status = 'succeeded';
          item.frameUrl = typeof result.frameUrl === 'string' && result.frameUrl
            ? result.frameUrl
            : figmaFrameUrl(opts.previewConfig.fileKey, result.frameNodeId);
          if (Array.isArray(result.warnings) && result.warnings.length > 0) {
            item.warnings = result.warnings.filter((w): w is string => typeof w === 'string');
          }
        } catch (err) {
          item.status = 'failed';
          item.error = err instanceof Error ? err.message : String(err);
        }
        touch();
      }
      job.status = [...job.items.values()].some((i) => i.status === 'failed') ? 'failed' : 'succeeded';
      } catch (err) {
        // Lỗi NGOÀI vòng per-màn (vd getProject throw). Không có nhánh này thì
        // job kẹt `running` mãi mãi — TTL chỉ prune job đã kết thúc, và dedupe
        // theo project sẽ chặn mọi lần start sau cho tới khi restart daemon.
        const message = err instanceof Error ? err.message : String(err);
        for (const item of job.items.values()) {
          if (item.status === 'queued' || item.status === 'running') {
            item.status = 'failed';
            item.error = message;
          }
        }
        job.status = 'failed';
      }
      job.finishedAtMs = Date.now();
      touch();
    })();

    return job;
  }

  app.post('/api/projects/:projectId/docs-review/figma-build/start', async (req: any, res: any) => {
    if (!guard(req, res)) return;
    const projectId = String(req.params.projectId ?? '');
    const rawScreenKeys: unknown[] = Array.isArray(req.body?.screenKeys) ? req.body.screenKeys : [];
    const screenKeys: string[] = [...new Set(rawScreenKeys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0))];
    if (!projectId || screenKeys.length === 0) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Cần ít nhất một SCREEN-KEY.' } });
    }
    // SCREEN-KEY đi thẳng vào đường dẫn fs (comp/<key>.screen.json,
    // comp/figma-build/<key>.input.json…) và vào câu kickoff của agent — chặn
    // traversal/injection tại cửa: chỉ nhận chữ-số . _ -, cấm '..' và mọi
    // dấu phân cách đường dẫn. Key thật có dạng "6.3.1".
    const badKey = screenKeys.find((k) => !/^[A-Za-z0-9._-]+$/.test(k) || k.includes('..'));
    if (badKey !== undefined) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: `SCREEN-KEY không hợp lệ: "${badKey}".` } });
    }
    const existingId = jobByProject.get(projectId);
    const existing = existingId ? jobs.get(existingId) : undefined;
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return res.status(202).json({ jobId: existing.id, job: toJobResponse(existing) });
    }
    try {
      const cwdSubdir = workflowDirForPipeline('dr-comp') ?? 'docs-review';
      const cwd = await docsReviewCwd(PROJECTS_DIR, projectId);
      const previewConfig = await readFigmaPreviewConfig(cwd);
      if (!previewConfig) {
        return res.status(400).json({ error: { code: 'FIGMA_PREVIEW_FILE_REQUIRED', message: 'Chưa cấu hình file Figma preview cho dự án này — dán link file preview trước.' } });
      }
      const mcpConfig = await readMcpConfig(RUNTIME_DATA_DIR).catch(() => ({ servers: [] }));
      const mcpServer = pickFigmaMcpServer(mcpConfig.servers);
      if (!mcpServer) {
        return res.status(400).json({ error: { code: 'MCP_FIGMA_REQUIRED', message: 'Chưa có Figma MCP server đang bật trong Cài đặt → MCP — thêm rồi đăng nhập.' } });
      }
      // WP26: distinguish "no server picked at all" (above) from "server is
      // there but OAuth was never completed" — the seeded default (WP26 seed,
      // mcp-config.ts) means the FIRST branch rarely fires post-install, so
      // this is the message a fresh machine actually sees. A DISTINCT error
      // code, because the web maps codes to hardcoded messages — reusing
      // MCP_FIGMA_REQUIRED would show the stale "thêm server" text; unknown
      // codes fall through to the daemon's raw message by design.
      //
      // The check only applies where a missing token actually breaks the run:
      // effective authMode 'oauth' AND no user-pinned Authorization header
      // (mergeAuthHeader lets a pinned header win over the daemon Bearer, and
      // stdio/authMode-none servers never use stored tokens at all). We only
      // check presence, NOT expiry: an expired-but-refreshable token still
      // means "connected" — the spawn path (buildClaudeMcpJson) refreshes it
      // transparently, refreshing here would duplicate that logic for no
      // observable benefit.
      const pinnedAuth = Object.entries((mcpServer as McpServerConfig).headers ?? {}).some(
        ([k, v]) => k.toLowerCase() === 'authorization' && typeof v === 'string' && v.trim() !== '',
      );
      if (effectiveMcpAuthMode(mcpServer as McpServerConfig) === 'oauth' && !pinnedAuth) {
        const token = await getToken(RUNTIME_DATA_DIR, mcpServer.id).catch(() => null);
        if (!token) {
          return res.status(400).json({ error: { code: 'MCP_FIGMA_CONNECT_REQUIRED', message: 'Server Figma MCP đã có nhưng chưa đăng nhập — vào Cài đặt → MCP bấm Connect.' } });
        }
      }
      const catalog = await readFrozenFigmaCatalog(cwd);
      // 400 chứ KHÔNG 409 — web coi 409-kèm-job là "job đang chạy, adopt đi";
      // dùng 409 ở đây bắt client phân biệt bằng body, fragile không cần thiết.
      if (!catalog || !catalogHasComponentKeys(catalog)) {
        return res.status(400).json({ error: { code: 'CATALOG_REQUIRED', message: 'Danh mục component Figma chưa có hoặc thiếu key — Làm mới DS Figma rồi thử lại.' } });
      }
      if (typeof deps.agents?.resolveAgent !== 'function') {
        return res.status(501).json({ error: { code: 'AGENT_UNAVAILABLE', message: 'Chưa cấu hình agent để chạy job này.' } });
      }
      const execution = await deps.agents.resolveAgent();
      // Re-check sau await (resolveAgent là async) — hai POST gần nhau không
      // tạo hai job song song, cùng khuôn double-check của figma-guide job.
      const racedId = jobByProject.get(projectId);
      const raced = racedId ? jobs.get(racedId) : undefined;
      if (raced && (raced.status === 'queued' || raced.status === 'running')) {
        return res.status(202).json({ jobId: raced.id, job: toJobResponse(raced) });
      }
      const job = startFigmaBuildJob({ projectId, cwd, cwdSubdir, screenKeys, previewConfig, mcpServer, catalog, execution });
      res.status(202).json({ jobId: job.id, job: toJobResponse(job) });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL', message: String(err && err.message ? err.message : err) } });
    }
  });

  app.get('/api/projects/:projectId/docs-review/figma-build/:jobId', (req: any, res: any) => {
    if (!guard(req, res)) return;
    const job = jobs.get(req.params.jobId);
    if (!job || job.projectId !== req.params.projectId) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'job not found' } });
    }
    res.json({ job: toJobResponse(job) });
  });

  // Cross-project re-attach, cùng lý do/hình dạng với
  // GET /api/figma-guide-jobs/active (figma-design-system-routes.ts).
  app.get('/api/figma-build-jobs/active', (req: any, res: any) => {
    if (!guard(req, res)) return;
    const nowMs = Date.now();
    const active: Array<{ jobId: string; projectId: string; status: FigmaBuildJobState['status']; done: number; total: number; startedAt: number; finishedAt?: number }> = [];
    for (const job of [...jobs.values()]) {
      const isFinished = job.status === 'succeeded' || job.status === 'failed';
      if (isFinished && job.finishedAtMs !== undefined && nowMs - job.finishedAtMs > ACTIVE_BUILD_JOB_RETENTION_MS) {
        jobs.delete(job.id);
        if (jobByProject.get(job.projectId) === job.id) jobByProject.delete(job.projectId);
        continue;
      }
      const items = [...job.items.values()];
      active.push({
        jobId: job.id,
        projectId: job.projectId,
        status: job.status,
        done: items.filter((i) => i.status === 'succeeded' || i.status === 'failed').length,
        total: items.length,
        startedAt: job.startedAtMs,
        ...(job.finishedAtMs !== undefined ? { finishedAt: job.finishedAtMs } : {}),
      });
    }
    res.json({ jobs: active });
  });

  app.get('/api/projects/:projectId/docs-review/figma-preview', async (req: any, res: any) => {
    if (!guard(req, res)) return;
    try {
      const cwd = await docsReviewCwd(PROJECTS_DIR, String(req.params.projectId ?? ''));
      const config = await readFigmaPreviewConfig(cwd);
      res.json({ config });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL', message: String(err && err.message ? err.message : err) } });
    }
  });

  app.put('/api/projects/:projectId/docs-review/figma-preview', async (req: any, res: any) => {
    if (!guard(req, res)) return;
    const link = parseFigmaPreviewLink(String(req.body?.url ?? ''));
    if (!link) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Link Figma không hợp lệ — dán link dạng figma.com/design/<fileKey>.' } });
    }
    try {
      const cwd = await docsReviewCwd(PROJECTS_DIR, String(req.params.projectId ?? ''));
      await writeFigmaPreviewConfig(cwd, link);
      res.json({ config: link });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL', message: String(err && err.message ? err.message : err) } });
    }
  });
}
