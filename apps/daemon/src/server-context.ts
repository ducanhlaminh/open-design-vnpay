import type { Express } from 'express';
import type {
  BasDocument,
  BasFeature,
  ConfluencePageMeta,
  PipelineRunSource,
  PullApplyResult,
  PullPlan,
  PullResolution,
} from '@open-design/contracts';
import type { SkillInfo } from './skills.js';
import type { DesignSystemSummary } from './design-systems.js';
import type { RoutineRoutesService } from './routine-routes.js';

export interface HttpDeps {
  createSseResponse: (...args: any[]) => any;
  isLocalSameOrigin: (...args: any[]) => boolean;
  requireLocalDaemonRequest: (...args: any[]) => any;
  resolvedPortRef: { current: number };
  sendApiError: (...args: any[]) => any;
  sendLiveArtifactRouteError: (...args: any[]) => any;
  sendMulterError: (...args: any[]) => any;
}

export interface PathDeps {
  ARTIFACTS_DIR: string;
  BUNDLED_PETS_DIR: string;
  DESIGN_SYSTEMS_DIR: string;
  // Bundled rendering catalogue (see specs/current/skills-and-design-templates.md).
  // Distinct from SKILLS_DIR so the EntryView Templates surface and the
  // Settings → Skills surface stay decoupled.
  DESIGN_TEMPLATES_DIR: string;
  OD_BIN: string;
  PROJECT_ROOT: string;
  PROJECTS_DIR: string;
  PROMPT_TEMPLATES_DIR: string;
  RUNTIME_DATA_DIR: string;
  RUNTIME_DATA_DIR_CANONICAL: string;
  SKILLS_DIR: string;
  USER_DESIGN_SYSTEMS_DIR: string;
  // Mirror of USER_SKILLS_DIR rooted at DESIGN_TEMPLATES_DIR so user
  // imports of templates do not collide with imports of functional skills.
  USER_DESIGN_TEMPLATES_DIR: string;
  USER_SKILLS_DIR: string;
}

export interface ResourceDeps {
  listAllDesignSystems: () => Promise<Array<DesignSystemSummary & { source?: string }>>;
  listAllSkills: () => Promise<Array<SkillInfo & { source?: string }>>;
  // Mirrors listAllSkills but scans DESIGN_TEMPLATE_ROOTS so the Templates
  // surface only sees rendering-catalogue entries.
  listAllDesignTemplates: () => Promise<Array<SkillInfo & { source?: string }>>;
  // Spans both functional skills and design templates so cross-surface
  // resolvers (chat run system prompt, orbit template resolver,
  // /api/skills/:id/example, /api/skills/:id/assets/*) keep working when
  // a stored project.skillId points at either root.
  listAllSkillLikeEntries: () => Promise<Array<SkillInfo & { source?: string }>>;
  mimeFor: (filePath: string) => string;
}

export interface RoutineDeps {
  routineService: RoutineRoutesService;
}

export interface PipelineDeps {
  // Seed a new conversation in `projectId` with `pipelineId`'s skill active and
  // start the agent run. Wired in server.ts (needs design.runs + startChatRun).
  // `source` (Confluence/BAS) is pre-fetched from the BAS gateway into the
  // project cwd BEFORE the run, so pipeline 1 normalizes local files.
  runPipeline(
    projectId: string,
    pipelineId: string,
    input?: string,
    source?: PipelineRunSource,
    // Per-run design system for UI stages (`ui-html`). undefined → inherit the
    // app-config default; string id / null ("none") override it for this run.
    designSystemId?: string | null,
    // Target platform for `acceptsPlatform` stages (the UX stage): folded into
    // the kickoff so the skill authors screens with the matching `layout`.
    // undefined → no directive (the skill defaults to mobile).
    platform?: import('@open-design/contracts').TargetPlatform,
    // RE-RUN clear scope: 'stage' (default) clears only this stage's outputs;
    // 'downstream' also clears every stage that depends on it. See
    // RunPipelineRequest.resetScope.
    resetScope?: 'stage' | 'downstream',
    // Docs stage, deterministic Confluence path: also fetch link-referenced
    // pages (depth 1, capped). undefined → true. See RunPipelineRequest.
    followLinks?: boolean,
    // Docs stage: also fetch the whole sub-tree under each seed (folder-
    // structured). undefined/false → seeds only. See RunPipelineRequest.
    includeDescendants?: boolean,
  ): Promise<{
    projectId: string;
    /** Absent on a DETERMINISTIC run (docs stage, Confluence source): the
     * daemon fetches the pages itself — no conversation is seeded and no
     * agent runs, so there is nothing to open. */
    conversationId?: string;
    agentRunId?: string;
    /** Resolves when THIS stage's run reaches a terminal state (never rejects).
     * Consumed by the run-all orchestrator; routes must strip it before
     * JSON-serializing the start payload. */
    completion: Promise<'succeeded' | 'failed' | 'idle'>;
  }>;
  /** UX knowledge base (media-store backed, see ux-kb-sync.ts): status
   * resolves the active KB source (env → media cache → home folder); push
   * uploads a local KB folder to the store so every machine syncs it before
   * the ux-research stage. Wired in server.ts. */
  uxKbStatus(): Promise<{
    dir: string | null;
    source: 'env' | 'media' | 'home' | 'none';
    synced?: number;
    note?: string;
  }>;
  uxKbPush(dir?: string): Promise<{
    project: string;
    files: number;
    uploaded: number;
    skipped: number;
    deleted: number;
  }>;
  /** Run the WHOLE workflow sequentially with no per-stage review (the "Run
   * full workflow" button / `od pipeline run-all`). Starts the chain in the
   * background and returns the planned stage order; progress surfaces through
   * the normal per-stage statuses. Wired in server.ts. */
  runWorkflowAll(
    projectId: string,
    opts: {
      workflowId?: string;
      terminal?: import('@open-design/contracts').WorkflowTerminal;
      input?: string;
      source?: PipelineRunSource;
      designSystemId?: string | null;
      platform?: import('@open-design/contracts').TargetPlatform;
      /** UI targets to build (docs-to-ui) — post-docs chain runs once per
       *  target into <workflow>/<target>/. Empty/absent → single build. */
      targets?: import('@open-design/contracts').UiTarget[];
      skipSucceeded?: boolean;
      followLinks?: boolean;
      includeDescendants?: boolean;
    },
  ): Promise<{ projectId: string; workflowId: string; stages: string[] }>;
  // BAS MCP gateway reads for the Pipelines source-selection modal. Each resolves
  // the endpoint from env / mcp-config and proxies one BAS tool (server-side, so
  // the token never reaches the browser). Throw when BAS is not configured.
  // The BAS branch is KG-document-centric: list documents, then a document's
  // features (the gateway exposes no project→feature link).
  bas: {
    listDocuments(): Promise<BasDocument[]>;
    listFeatures(documentId: string): Promise<BasFeature[]>;
    confluenceMeta(ref: string): Promise<ConfluencePageMeta>;
    // Picker "tìm trang Confluence theo tên" (như pipeline-studio): PAT trực
    // tiếp (CONFLUENCE_URL/_PERSONAL_TOKEN) ưu tiên, else gateway
    // confluence_search. Wired in server.ts.
    searchConfluencePages(q: string): Promise<import('@open-design/contracts').ConfluencePageHit[]>;
  };
  // Regenerate the project's pipeline files from the KGS file store into the
  // local project cwd (cross-device "pull to continue"). `stages` narrows to
  // those pipelines' outputs (Pull all modal); absent → all. Wired in server.ts.
  pullFiles(projectId: string, stages?: string[]): Promise<{ pulled: number }>;
  // Manual upload: push the project's current output files to the KGS file
  // store (+ B2 convert for convertToGraph stages). `stages` narrows to those
  // pipelines' outputs (Push all modal); absent → all. Wired in server.ts.
  uploadFiles(projectId: string, stages?: string[]): Promise<{ uploaded: number; converted: number }>;
  // Per-stage local↔remote file diff (badges in the Pull all / Push all modals
  // + `od kg diff`). Wired in server.ts.
  syncStatus(projectId: string): Promise<import('@open-design/contracts').ProjectSyncStatus>;
  // On-demand ui-react build (Build button / `od pipelines build`):
  // react/dist/ is never synced (PipelineDef.syncExclude), so a pulled project
  // reconstructs it locally via the ui-react builder. Wired in server.ts.
  buildReact(projectId: string): Promise<{ built: boolean; output: string }>;
  // Prototype auto-demo (Dựng demo button / `od pipeline demo`): Playwright
  // drives the BUILT react app through its flow.json use cases and records
  // video + per-step screenshots under react/prototype-demo/ (deterministic,
  // no agent). Wired in server.ts (react-demo.ts).
  buildReactDemo(projectId: string): Promise<{ cases: number; output: string }>;
  // List the project cwd's output file paths (cwd-relative). Used to derive
  // "done" stage state from on-disk outputs, offline-safe. Wired in server.ts.
  localOutputs(projectId: string): Promise<string[]>;
  // Project history: published versions (store changelog + _v/ snapshots) và
  // machine-local .odhistory commits; restore rewinds the cwd to either.
  // Wired in server.ts (project-history.ts + kg-sync/published-versions.ts).
  history(projectId: string): Promise<import('@open-design/contracts').ProjectHistoryResponse>;
  restoreHistory(
    projectId: string,
    opts: { verId?: string; commit?: string; paths?: string[]; stage?: string },
  ): Promise<import('@open-design/contracts').RestoreHistoryResponse>;
  // Conflict-aware pull (PLAN → APPLY). `plan` classifies remote vs local
  // without writing disk; `apply` downloads chosen-remote + new files against a
  // prior plan's snapshot (TOCTOU-guarded). Wired in server.ts. See
  // docs/guides/pull-conflict-resolution-spec.md.
  pullConflict: {
    plan(projectId: string): Promise<PullPlan>;
    apply(
      projectId: string,
      planId: string,
      resolutions: Record<string, PullResolution>,
      onConflictDefault?: PullResolution,
    ): Promise<PullApplyResult>;
  };
}

export interface TelemetryDeps {
  reportFinalizedMessage: (saved: any, body?: any) => void;
  /**
   * Best-effort Langfuse score emission for assistant-turn user ratings.
   * Returns the categorical outcome so the API surface in chat-routes can
   * report back to the web client whether the report was accepted or
   * skipped (consent off / no sink). The handler must not await this in
   * the request hot path — fire-and-forget.
   */
  reportFeedback?: (req: {
    runId: string;
    rating: 'positive' | 'negative';
    reasonCodes: string[];
    hasCustomReason: boolean;
    customReason: string;
    scoreMetadata?: Record<string, unknown>;
  }) => Promise<{ status: 'accepted' | 'skipped_consent' | 'skipped_no_sink' }>;
}

export interface ServerContext {
  db: any;
  design: any;
  http: HttpDeps;
  paths: PathDeps;
  ids: any;
  uploads: any;
  node: any;
  projectStore: any;
  projectFiles: any;
  conversations: any;
  templates: any;
  status: any;
  events: any;
  imports: any;
  exports: any;
  artifacts: any;
  documents: any;
  auth: any;
  liveArtifacts: any;
  deploy: any;
  media: any;
  appConfig: any;
  orbit: any;
  nativeDialogs: any;
  research: any;
  mcp: any;
  resources: ResourceDeps;
  routines: RoutineDeps;
  pipelines: PipelineDeps;
  telemetry?: TelemetryDeps;
  validation: any;
  finalize: any;
  handoff: any;
  chat: any;
  agents: any;
  critique: any;
  lifecycle?: {
    isDaemonShuttingDown: () => boolean;
  };
}

export type RouteDeps<K extends keyof ServerContext> = Pick<ServerContext, K>;

export type RouteRegistrar = (app: Express, ctx: ServerContext) => void;
