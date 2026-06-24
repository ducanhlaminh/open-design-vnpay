import type { Express } from 'express';
import type {
  BasFeature,
  BasProject,
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
  ): Promise<{
    projectId: string;
    conversationId: string;
    agentRunId: string;
  }>;
  // BAS MCP gateway reads for the Pipelines source-selection modal. Each resolves
  // the endpoint from env / mcp-config and proxies one BAS tool (server-side, so
  // the token never reaches the browser). Throw when BAS is not configured.
  bas: {
    listProjects(): Promise<BasProject[]>;
    listFeatures(projectId: string): Promise<BasFeature[]>;
    confluenceMeta(ref: string): Promise<ConfluencePageMeta>;
  };
  // Regenerate the project's pipeline files from the KGS file store into the
  // local project cwd (cross-device "pull to continue"). Wired in server.ts.
  pullFiles(projectId: string): Promise<{ pulled: number }>;
  // Manual upload: push the project's current output files to the KGS file
  // store (+ B2 convert for convertToGraph stages). Wired in server.ts.
  uploadFiles(projectId: string): Promise<{ uploaded: number; converted: number }>;
  // List the project cwd's output file paths (cwd-relative). Used to derive
  // "done" stage state from on-disk outputs, offline-safe. Wired in server.ts.
  localOutputs(projectId: string): Promise<string[]>;
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
