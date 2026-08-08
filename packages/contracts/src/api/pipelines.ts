// Pipelines: a per-project, dependency-gated chain of skill-driven agent runs
// (the docs→UI flow). Each pipeline is a fixed skill; pressing "run" seeds a new
// conversation in the current project with that skill active and the UI switches
// to it. A pipeline becomes runnable ("active") only once every pipeline it
// depends on has succeeded. There is no scheduler/executor — runs are manual
// (button / `od pipeline run`) and the agent does the work guided by the skill.

/**
 * Target platform of the generated screens. Mirrors the UX Spec schema's
 * per-screen `layout` field (`mobile` | `web`): the platform chosen at the UX
 * stage tells the skill which `layout` to author, and the UI-Spec terminals +
 * previews follow each screen's `layout` from there.
 */
export type TargetPlatform = 'mobile' | 'web';

/**
 * A UI TARGET — a distinct app the same product docs are turned into. A project
 * can build several at once (e.g. a mobile app AND a web backoffice), each with
 * its own audience and screen set, so `docs-to-ui` runs the whole post-docs
 * chain (cj → ux-research → ux → ux-review → ui) ONCE PER TARGET into a
 * per-target output subtree. Fixed enum (not free-form) — three shapes cover
 * the real need: a phone app, a customer-facing website, and a staff/admin
 * backoffice website.
 */
export type UiTarget = 'mobile' | 'web-user' | 'web-backoffice';

/** Static descriptor for each UI target: its platform (drives each screen's
 *  `layout`), audience (drives which flows/screens the ux-spec authors), the
 *  human label for the picker, and the output subfolder its stages run under. */
/** Who a UI target is built FOR. Two web targets share a platform and a docs
 *  folder, so this is the only thing that distinguishes them — it reaches the
 *  agent as a kickoff directive (see runPipeline's audienceDirective). */
export type UiTargetAudience = 'user' | 'backoffice';

export interface UiTargetDef {
  id: UiTarget;
  platform: TargetPlatform;
  audience: UiTargetAudience;
  label: string;
  /** Per-target cwd subfolder under the workflow dir (`<workflow>/<dir>/…`). */
  dir: string;
  /**
   * Whether this target's generated UI must be RESPONSIVE. Every target ships
   * web tech (HTML/React — there is no native/RN track); the difference is
   * viewport semantics: the mobile app renders in a FIXED phone viewport (no
   * media queries), the two website targets must adapt across breakpoints
   * (mobile ≤768px ↔ desktop). Drives the ux/ui kickoff directives, the
   * ui-react-ds verify gate, and the Figma-capture viewport set.
   */
  responsive: boolean;
}

export const UI_TARGETS: Record<UiTarget, UiTargetDef> = {
  mobile: { id: 'mobile', platform: 'mobile', audience: 'user', label: 'Mobile app', dir: 'mobile', responsive: false },
  'web-user': { id: 'web-user', platform: 'web', audience: 'user', label: 'Website (người dùng)', dir: 'web-user', responsive: true },
  'web-backoffice': { id: 'web-backoffice', platform: 'web', audience: 'backoffice', label: 'Website (backoffice)', dir: 'web-backoffice', responsive: true },
};

export const UI_TARGET_IDS: UiTarget[] = ['mobile', 'web-user', 'web-backoffice'];

export function isUiTarget(v: unknown): v is UiTarget {
  return v === 'mobile' || v === 'web-user' || v === 'web-backoffice';
}

/**
 * Project target config written by the docs→UI run into `docs-to-ui/targets.json`
 * when ≥1 UI target is chosen. It replaces the old "clone docs + fork a
 * `<workflow>/<target>/` folder per target" scheme: docs are ingested ONCE and
 * this single file records which targets to build for. The post-docs stages read
 * it as input (platform drives each screen's `layout`; audience drives which
 * flows/screens get authored) instead of the daemon physically forking a folder
 * per target. `platform`/`audience` are derived from `UI_TARGETS` so the file is
 * self-describing for any consumer that doesn't import the enum.
 */
export interface TargetsConfig {
  /** Schema marker so a reader can recognize the file without inferring shape. */
  kind: 'od-targets';
  /** 1 = targets/platform/audience only; 2 adds responsiveByTarget +
   *  designSystemByTarget. Readers must tolerate missing v2 fields. */
  version: 1 | 2;
  /** UI targets to build, in pick order. */
  targets: UiTarget[];
  /** Per-target platform (drives each screen's `layout`). */
  platformByTarget: Record<UiTarget, TargetPlatform>;
  /** Per-target audience (drives which flows/screens the ux-spec authors). */
  audienceByTarget: Record<UiTarget, 'user' | 'backoffice'>;
  /** Per-target responsive requirement (see UiTargetDef.responsive). v2+. */
  responsiveByTarget?: Partial<Record<UiTarget, boolean>>;
  /**
   * Per-target design system id (v2+). Each target picks its OWN library —
   * the mobile app and the websites come from different Figma libs, so one
   * project-wide id cannot serve a multi-target build. Resolution order for a
   * UI stage run: explicit per-run designSystemId → this map → the app-config
   * default. Missing entries simply fall through.
   */
  designSystemByTarget?: Partial<Record<UiTarget, string>>;
}

/** Build the `targets.json` payload from a target selection (platform/
 *  audience/responsive resolved from the static `UI_TARGETS` descriptor;
 *  `designSystemByTarget` recorded when the caller picked per-target DS). */
export function buildTargetsConfig(
  targets: UiTarget[],
  designSystemByTarget?: Partial<Record<UiTarget, string>>,
): TargetsConfig {
  const platformByTarget = {} as Record<UiTarget, TargetPlatform>;
  const audienceByTarget = {} as Record<UiTarget, 'user' | 'backoffice'>;
  const responsiveByTarget: Partial<Record<UiTarget, boolean>> = {};
  for (const t of targets) {
    platformByTarget[t] = UI_TARGETS[t].platform;
    audienceByTarget[t] = UI_TARGETS[t].audience;
    responsiveByTarget[t] = UI_TARGETS[t].responsive;
  }
  const dsEntries = Object.entries(designSystemByTarget ?? {}).filter(
    ([t, id]) => typeof id === 'string' && id && targets.includes(t as UiTarget),
  );
  return {
    kind: 'od-targets',
    version: 2,
    targets,
    platformByTarget,
    audienceByTarget,
    responsiveByTarget,
    ...(dsEntries.length > 0 ? { designSystemByTarget: Object.fromEntries(dsEntries) } : {}),
  };
}

/** Canonical relative path (under the docs-to-ui workflow dir) of the config. */
export const TARGETS_CONFIG_BASENAME = 'targets.json';

export type PipelineStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

// One pipeline as seen by clients: the static definition (id/name/dependsOn)
// merged with the current project's run state (status/active/last run ids).
export interface PipelineView {
  id: string;
  name: string;
  /** Pipeline ids that must be `succeeded` before this one is `active` — the
   *  STATIC registry list, independent of run mode. Clients use its identity as
   *  structure (the stepper fuses consecutive pipelines sharing the same list
   *  into one option-group step, and computes downstream sets from it), so it
   *  must never be rewritten per mode — that fuses unrelated stages. The gate
   *  the current mode actually enforces is `effectiveDependsOn`. */
  dependsOn: string[];
  /** The gate the project's run mode ACTUALLY enforces, when it differs from
   *  `dependsOn`: under `lean`, a dependency the mode never runs is replaced by
   *  its own dependencies (transitively), so lock messages only ever name a
   *  stage that can reach `succeeded`. Absent = same as `dependsOn`. */
  effectiveDependsOn?: string[];
  status: PipelineStatus;
  /** Derived: every pipeline in the mode's effective gate is `succeeded`. */
  active: boolean;
  /**
   * The project's run mode drops this stage from the chain (today: the LEAN
   * run-all skipping the journey / research / heuristic-review stages). It is
   * NOT locked and NOT failed — it simply is not part of what this project
   * runs, and nothing downstream waits on it. Clients render it muted with a
   * "bỏ qua" badge and keep its Run button live so it can be run on demand.
   * Absent = a normal stage of the current mode.
   */
  skipped?: boolean;
  /**
   * When set, this pipeline accepts a free-text run input (e.g. a Confluence
   * page URL / id, a JIRA project key or JQL). The UI renders an input box with
   * this string as placeholder; the value is sent as `RunPipelineRequest.input`.
   */
  inputPlaceholder?: string;
  /**
   * When true, this stage generates UI and can apply a design system. The UI
   * opens a design-system picker before running (None + the installed systems);
   * the chosen id is sent as `RunPipelineRequest.designSystemId`. Today only the
   * `ui-html` HTML-prototype stage of the docs→HTML workflow sets this.
   */
  acceptsDesignSystem?: boolean;
  /**
   * When true, this stage takes review criteria from a design system.
   * Unlike `acceptsDesignSystem` (which generates UI), the design system is
   * only a file source: the daemon copies its criteria into the workflow.
   */
  usesDesignSystemCriteria?: boolean;
  /**
   * When true, this stage decides the target platform of the generated screens
   * (the UX Spec stage: every screen's `layout` field). The UI shows a
   * Mobile/Website picker before running; the choice is sent as
   * `RunPipelineRequest.platform`. Omitted/`mobile` keeps the legacy behavior.
   */
  acceptsPlatform?: boolean;
  /**
   * When true, this stage accepts a MANUAL file upload from the UI — a
   * secondary "Tải file lên" button next to Run (not folded into the Run
   * flow: a stage can also have `inputPlaceholder`, and Run's dispatch is
   * mutually exclusive on those fields, so upload needs its own affordance).
   * The upload itself goes through the existing project-files route; this
   * flag only controls whether the button renders. Today only the
   * `docs-review` workflow's `dr-docs` stage sets it.
   */
  acceptsUpload?: boolean;
  /**
   * Output path patterns this pipeline produces in the project cwd (from the
   * daemon registry). The UI surfaces a stage's result files ("Quick result")
   * by matching these against `GET /api/projects/:id/files`. Patterns:
   * `dir/` = anything under that dir; `-suffix.json` / `*x` = endsWith; else an
   * exact relative path or basename.
   */
  outputs?: string[];
  lastRunId?: string;
  lastConversationId?: string;
  /** Per-task conversations when the last run fanned out — the UI lists them
   *  behind a "Hội thoại (N)" button so you can open each parallel agent's
   *  transcript. Absent for a single-agent run. */
  subConversations?: PipelineSubConversation[];
  updatedAt?: number;
  /**
   * Free-text input of the LAST run (Confluence URL / JIRA key / JQL), kept so
   * the source behind a stage's output stays reviewable after the run (the
   * per-stage "run info" panel).
   */
  lastInput?: string;
  /** Structured source of the LAST run (Confluence ref or BAS document). */
  lastSource?: PipelineRunSource;
  /** Target platform of the LAST run (stages with `acceptsPlatform`). */
  lastPlatform?: TargetPlatform;
  /**
   * Short human-readable reason the stage's LAST run failed — a fail-fast
   * validation message (e.g. no docs-ingest source configured), the
   * underlying agent run's own error, or a generic fallback when neither is
   * available. Only present when `status === 'failed'`; the FE's "Xem lỗi"
   * renders this instead of an empty panel. Absent for every other status.
   */
  error?: string;
}

export interface PipelinesResponse {
  projectId: string;
  /** Which workflow these pipelines belong to (echoed back from the query). */
  workflowId: string;
  pipelines: PipelineView[];
  /** The project's run mode: `RunAllConfig.lean` saved by the last run-all —
   *  or, for legacy projects that ran lean before the mode was persisted,
   *  INFERRED from the state shape only a lean chain leaves behind (a UI
   *  terminal succeeded while the analysis stages never ran). Gating,
   *  `effectiveDependsOn` and `skipped` in `pipelines` are all computed for
   *  THIS mode; the UI also shows it so the reason a stage is greyed out is
   *  visible on the stepper instead of hidden in a modal chosen an hour ago. */
  runMode: PipelineRunMode;
  /** Multi-target project: the configured targets (targets.json order). Absent
   *  → single build. Clients use it for the target switcher and to send
   *  `RunPipelineRequest.target` on stage runs / build / capture. */
  targets?: UiTarget[];
  /** Per-target, FILE-derived stage statuses (the DB run state is
   *  stage-global): which stages have outputs under `<wf>/<target>/`. Only the
   *  states a file scan can prove (succeeded) appear; missing = no outputs. */
  statusByTarget?: Partial<Record<UiTarget, Record<string, PipelineStatus>>>;
  /** targets.json v2 per-target design systems, when configured. */
  designSystemByTarget?: Partial<Record<UiTarget, string>>;
}

/** Which stages a project's chain runs: `lean` drops the analysis stages
 *  (journey / research / heuristic review), `full` runs everything. */
export type PipelineRunMode = 'full' | 'lean';

export type PipelinePulseRating = 'ready' | 'minor_edits' | 'major_edits' | 'unusable';

export type PipelinePulseIssue =
  | 'run_error'
  | 'wrong_business'
  | 'missing_cases'
  | 'low_quality'
  | 'too_slow'
  | 'other';

export interface PipelinePulseFeedback {
  id: string;
  projectId: string;
  workflowId: string;
  pipelineId: string;
  runId: string;
  rating: PipelinePulseRating;
  issues: PipelinePulseIssue[];
  comment?: string;
  createdAt: number;
  user?: string;
  surveyKind?: 'pulse' | 'deep';
  answers?: Record<string, unknown>;
}

export interface PipelinePulseFeedbackRequest {
  projectId: string;
  workflowId: string;
  pipelineId: string;
  runId: string;
  rating: PipelinePulseRating;
  issues?: PipelinePulseIssue[];
  comment?: string;
  surveyKind?: 'pulse' | 'deep';
  answers?: Record<string, unknown>;
}

export interface PipelinePulseFeedbackListResponse {
  feedback: PipelinePulseFeedback[];
}

// A workflow is one named docs→output flow — an ordered set of pipelines.
// Since the 2026-07 merge there is exactly ONE workflow, `docs-to-ui`: three
// shared upstream stages (docs → cj → ux) feeding two terminal UI-Spec
// OPTIONS — `ui-html` (interactive HTML prototype) and `ui-react` (built
// Vite+React app). (The earlier react-shadcn workflow was removed.)
export interface Workflow {
  id: string;
  name: string;
  /** One-line description for the workflow tab. */
  description?: string;
  /** Ordered pipeline ids that make up this workflow's DAG. */
  pipelineIds: string[];
  /**
   * Human-readable name for each id in `pipelineIds`, in the SAME order. Both
   * fields exist because they serve different readers: `pipelineIds` is the
   * bare-id list every gating/filtering/ordering call site already keys off
   * (stepper grouping, output attribution, sync scoping — see
   * apps/daemon/src/pipelines.ts) and must stay a plain `string[]` for that;
   * `stages` is purely a display lookup so a client (e.g. the Pull/Push stage
   * picker) can render "UX Spec" instead of the raw id "ux" without hand-
   * mirroring the daemon's `PipelineDef.name` registry. Optional so existing
   * consumers built before this field keep working; a client reading it should
   * still fall back to the raw id when a name is missing.
   */
  stages?: Array<{ id: string; name: string }>;
}

export interface WorkflowsResponse {
  workflows: Workflow[];
  /** The workflow shown by default (the first one). */
  defaultWorkflowId: string;
}

/** Một trang Confluence nguồn — dùng cả cho config Pipeline Studio lẫn cấu
 *  hình Run-all đã lưu (chọn NHIỀU từ picker, mỗi dòng một trang). */
export interface ConfluencePageRef {
  id?: string;
  title?: string;
  url?: string;
}

/** Bộ cấu hình cho "Chạy full workflow" — dùng chung cho hai nguồn:
 *  `PipelineProject.config` (đọc từ Pipeline Studio, project.json) và
 *  `PipelineProject.savedRunAll` (lưu lại từ lần Run-all gần nhất trên máy
 *  này). Mọi field đều optional vì `config` chỉ set nguồn tài liệu + design
 *  system trong khi `savedRunAll` set đầy đủ mọi lựa chọn của modal Run-all. */
export interface RunAllConfig {
  confluencePages?: ConfluencePageRef[];
  designSystemId?: string | null;
  /**
   * DS làm NGUỒN BỘ TIÊU CHÍ review cho workflow `docs-review` — daemon chép
   * `<ds>/criteria/components.md` (+ `rules.md` nếu có) vào `<workflow>/criteria/`
   * khi bước `dr-docs` chạy.
   *
   * CỐ Ý TÁCH khỏi `designSystemId`: `runAllConfig` là MỘT object cho cả feature,
   * dùng chung giữa `docs-to-ui` và `docs-review`. `designSystemId` là DS mà
   * `ui-html`/`ui-react` dùng để SINH UI — ghép hai nghĩa vào một field thì chọn
   * DS ở màn review sẽ âm thầm đổi DS sinh UI của workflow kia.
   *
   * 3 trạng thái giống `designSystemId`: id / `null` (không dùng) / vắng mặt (giữ
   * giá trị đã lưu).
   */
  criteriaDesignSystemId?: string | null;
  basDocumentId?: string;
  basDocumentTitle?: string;
  displayName?: string;
  terminal?: WorkflowTerminal;
  platform?: TargetPlatform;
  /** UI targets to build (docs-to-ui). When set with ≥1 entry, the post-docs
   *  chain runs once per target into `<workflow>/<target>/…` and `platform` is
   *  ignored (each target carries its own). Omitted/empty → single build using
   *  `platform` (legacy). */
  targets?: UiTarget[];
  /**
   * Per-target design system ids (multi-target run): each target's UI stages
   * run against its OWN library. Recorded into `targets.json` so later
   * single-stage re-runs resolve the same DS. Falls back per target to
   * `designSystemId`, then the app-config default.
   */
  designSystemByTarget?: Partial<Record<UiTarget, string>>;
  followLinks?: boolean;
  /** Docs stage: also fetch the whole sub-tree under each seed page
   *  (folder-structured), independent of followLinks. Omitted → false. */
  includeDescendants?: boolean;
  /** Last run started from HAND-UPLOADED documents rather than a Confluence
   *  fetch (see RunWorkflowRequest.docsFromUpload). */
  docsFromUpload?: boolean;
  skipSucceeded?: boolean;
  /**
   * LEAN run: drop the analysis stages (customer journey, UX research, the
   * heuristic review) and run only docs → UX Spec → UI. Much shorter and
   * cheaper; the spec is written from the docs alone rather than from a journey
   * and research criteria, so use it to get something on screen fast, not for
   * the run you hand over. Omitted → the full chain.
   */
  lean?: boolean;
  /**
   * Danh sách id bước sẽ chạy, do người dùng tick trong panel cấu hình. Có mặt
   * và KHÔNG rỗng → chạy ĐÚNG các bước này theo thứ tự của workflow, bỏ qua
   * `lean` và `skipSucceeded` (người dùng đã chọn tay thì lựa chọn đó thắng —
   * kể cả khi họ tick lại một bước đã succeeded để chạy lại).
   * Vắng mặt → giữ nguyên hành vi cũ (`lean` + `skipSucceeded`), nên mọi cấu
   * hình đã lưu và mọi lệnh CLI hiện có vẫn chạy y như trước.
   */
  stageIds?: string[];
  /**
   * App Docs Pool (docs/app-docs-pool-spec.md §2.2): trang CHÍNH đã tick từ
   * pool tài liệu của App sở hữu dự án này — nguồn thay thế cho
   * `confluencePages` khi dự án dùng pool thay vì picker Confluence lẻ. Run-all
   * PUT PRESERVE field này khi body không nhắc tới key (giống `appFiles` cũ);
   * `null` (3-state, cùng ngữ nghĩa `designSystemId`) XÓA field đã lưu — mỗi
   * lần Lưu nguồn tài liệu phải resend cả ba nhánh loại trừ nhau
   * (`confluencePages` / `docsFromUpload` / `appPool`).
   * Run copies selected pages from the App pool into the feature's `docs-feature/`
   * root; the full pool is available read-only under `docs-app/`.
   */
  appPool?: { appId: string; paths: string[] } | null;
}

/** Tiến độ của MỘT workflow trên một feature (`PipelineProject.workflows`).
 *  `done`/`total`/`running` đếm y như các field cùng tên ở cấp project, chỉ
 *  khác là theo workflow này chứ không theo workflow của query. */
export interface PipelineWorkflowSummary {
  id: string;
  name: string;
  done: number;
  total: number;
  running: number;
}

// A KGS app/project available for pipelines. These are projects pulled from the
// central KGS (`od kg pull <project-id>`), whose open-design id IS the KGS
// project_id. Pipelines run ONLY on these — not on ephemeral chat workspaces.
export interface PipelineProject {
  id: string;
  name: string;
  /** How many of this project's pipelines have `succeeded` (for the picker
   * card's `done/total` progress badge). */
  done: number;
  /** Total number of pipelines in the docs→UI flow (the stepper length). */
  total: number;
  /** How many of this project's pipelines are currently in flight
   * (`running`/`queued`) — drives the picker card's live running spinner.
   * 0 when nothing is running. */
  running: number;
  /** Cấu hình từ Pipeline Studio (project.json trên store, mirror về khi
   *  pull): Run tự điền nguồn tài liệu (link Confluence HOẶC tài liệu BAS đã
   *  chọn) + design system từ đây — vẫn cho override từng lần chạy. */
  config?: RunAllConfig;
  /** Cấu hình Run-all được LƯU LẠI từ lần chạy full workflow gần nhất trên
   *  project này (ghi mỗi lần POST /api/pipelines/run-all thành công) — modal
   *  Run-all mở lại (kể cả sau khi cancel giữa chừng) điền sẵn từ đây thay vì
   *  bắt nhập lại. Khi chưa từng chạy lần nào (`undefined`), modal fallback về
   *  `config` (Pipeline Studio). */
  savedRunAll?: RunAllConfig;
  /** App (project cấp trên bên Pipeline Studio, media folder `app--…`) mà
   *  feature này thuộc về — mirror từ `project.json.appId` lúc pull. Picker
   *  dùng nó để nhóm các feature theo app; thiếu = feature chưa gán app. */
  app?: { id: string; name?: string };
  /** Trạng thái của TỪNG workflow trong registry — `done`/`total`/`running` ở
   *  trên chỉ nói về MỘT workflow (cái của query, mặc định là workflow đầu
   *  tiên), nên một feature đang chạy workflow khác vẫn đọc thành "Chưa chạy".
   *  Row feature xổ ra dùng mảng này. Optional: client cũ / server cũ vẫn phải
   *  chạy được, nên nơi đọc phải fallback về các field ở trên khi nó vắng. */
  workflows?: PipelineWorkflowSummary[];
}

export interface PipelineProjectsResponse {
  projects: PipelineProject[];
}

// Request body for `POST /api/pipelines/projects` (Phase B: local
// Project/feature creation). `appId`/`appName` are optional — when set the
// new project is mirrored under that App in the picker (see `PipelineApp`).
export interface CreatePipelineProjectRequest {
  projectId: string;
  name?: string;
  appId?: string;
  appName?: string;
}

export interface CreatePipelineProjectResponse {
  id: string;
  name: string;
}

// One App container offered as the parent of a new feature (`GET
// /api/pipelines/apps`). `local` Apps only exist denormalized on local
// features' `PipelineProject.app`; `remote` Apps come from the central
// KGS/media registry's `{isApp: true}` rows.
export interface PipelineApp {
  id: string;
  name?: string;
  origin: 'local' | 'remote';
}

export interface PipelineAppsResponse {
  apps: PipelineApp[];
}

export interface RunPipelineRequest {
  projectId: string;
  /** Optional free-text input for pipelines that declare `inputPlaceholder`
   * (e.g. a JIRA project key / JQL for jira-ingest's advanced path). Folded into
   * the run's kickoff message so the skill uses it as the source. Mutually
   * exclusive with `source` — prefer `source` for the Confluence/BAS pickers. */
  input?: string;
  /**
   * Structured source selection for pipeline 1 (jira-ingest). When set, the
   * daemon fetches the referenced document(s) from the BAS MCP gateway BEFORE the
   * agent run and writes them into the project cwd (`docs/source/…`); the skill
   * then normalizes those local files. The agent never calls BAS itself.
   */
  source?: PipelineRunSource;
  /**
   * Optional design system to apply at a UI-generating stage (`ui-html`). A
   * non-empty id overrides the app-config default for THIS run only; `null`
   * means "no design system" for this run (suppresses the global default);
   * omitted → fall back to the app-config default (the pre-existing behavior).
   * Only stages whose `PipelineView.acceptsDesignSystem` is true consume it.
   */
  designSystemId?: string | null;
  /** DS nguồn bộ tiêu chí review cho stage `dr-docs`; cùng 3 trạng thái với RunAllConfig. */
  criteriaDesignSystemId?: string | null;
  /**
   * Target platform for stages whose `PipelineView.acceptsPlatform` is true
   * (the UX Spec stage). `web` makes the skill author every screen with
   * `layout: "web"`; `mobile` pins the legacy mobile layout. Omitted → the
   * skill's default (mobile), preserving pre-existing behavior.
   */
  platform?: TargetPlatform;
  /**
   * Multi-target project (`targets.json` present): WHICH target this single
   * stage run builds. The daemon resolves it to the per-target subfolder
   * (`<workflow>/<target>/`) plus that target's platform/audience — the same
   * scoping the run-all orchestrator applies. Rules on a multi-target project:
   * omitted + exactly one configured target → that target is used
   * automatically; omitted + several targets → the run is rejected (the caller
   * must say which product to build); a target not in `targets.json` → rejected.
   * Ignored by the shared stages (docs ingest & sharedAcrossTargets) and by
   * single-build (no `targets.json`) projects.
   */
  target?: UiTarget;
  /**
   * Docs stage of a multi-target run: per-target design system ids, recorded
   * into `targets.json` alongside the chosen targets so every later stage run
   * (and re-run) resolves each target's OWN library. Ignored on other stages.
   */
  designSystemByTarget?: Partial<Record<UiTarget, string>>;
  /**
   * Docs stage, deterministic Confluence path: also fetch the pages each seed
   * page LINKS to (same wiki, depth 1, capped) so referenced sibling docs (BO
   * specs, shared logic pages) land in ./docs too. Omitted → true. Ignored by
   * other stages and by the agent (JIRA/JQL) path.
   */
  followLinks?: boolean;
  /**
   * Docs stage, deterministic Confluence path: also fetch the whole SUB-TREE
   * under each seed page (its child/descendant pages in the space hierarchy),
   * preserving their folder structure under ./docs/confluence. Independent of
   * `followLinks` (that follows hyperlink REFERENCES; this walks the page
   * TREE). Omitted → false (only the seed pages). Soft-capped: a scan whose
   * tree exceeds the cap still runs but warns. Ignored by other stages and by
   * the agent (JIRA/JQL) path.
   */
  includeDescendants?: boolean;
  /**
   * On a RE-RUN, how much to clear before the agent regenerates (a re-run that
   * left the previous outputs in place made the agent see them and declare the
   * work already done):
   *   'stage' (default) → clear only THIS stage's outputs;
   *   'downstream'      → clear this stage AND every stage that depends on it
   *                       (transitively) — those are now stale, so they reset to
   *                       idle and must be re-run.
   * A first run (no prior output) is a no-op either way. Cleared files are
   * snapshotted to project history first, so a re-run stays recoverable.
   */
  resetScope?: 'stage' | 'downstream';
}

// ── BAS-sourced inputs for pipeline 1 (jira-ingest) ─────────────────────────
// Both branches resolve their content through the BAS MCP gateway (the daemon's
// BasClient). The picker is two-level for BAS: pick a KG document, then the
// feature(s) within it (the gateway has no project→feature link, so the KG
// document — which holds the analyzed features + business rules — is the unit).
//   confluence → confluence_fetch_page (BE extracts the page_id from the link)
//   bas        → kg_get_feature_detail per feature (or kg_get_document_subgraph
//                for the whole document when no feature is selected)
export type PipelineRunSource =
  | { kind: 'confluence'; /** Confluence page URL or numeric page id. */ ref: string }
  | {
      kind: 'bas';
      /** KG document id (from `kg_list_documents`). */
      documentId: string;
      /** Chosen feature ids within that document; empty/absent → whole document. */
      featureIds?: string[];
    }
  | {
      /** App Docs Pool (docs/app-docs-pool-spec.md §2.2): copy the ticked MAIN
       *  pages (deterministic, incl. images/attachments) into `<wf>/docs/`,
       *  same status semantics as the plain Confluence path — gated on every
       *  pool page being present (parsed at `parseRunSource`). */
      kind: 'app-pool';
      appId: string;
      paths: string[];
    };

// A KG document in BAS (from `kg_list_documents`) — the top level of the BAS
// source picker. The analyzed requirement features/rules live under it.
export interface BasDocument {
  /** KG document_id. */
  id: string;
  /** Human label if the gateway provides one; otherwise the UI shows the id. */
  label?: string;
  /** Node count from kg_list_documents, for a small "N nodes" hint. */
  nodeCount?: number;
  /** Last-updated ISO timestamp, if present. */
  updatedAt?: string;
}

export interface BasDocumentsResponse {
  documents: BasDocument[];
}

/** Một trang Confluence từ picker tìm-theo-tên của modal Run pipeline 1
 *  (GET /api/pipelines/confluence/pages?q=) — như picker bên pipeline-studio. */
export interface ConfluencePageHit {
  id: string;
  title: string;
  url?: string;
  space?: string;
  /** Ancestor page TITLES, top→down, excluding this page itself — lets a
   *  search result with a title shared by pages in different dự án be told
   *  apart (App-root combobox). Optional: the direct-PAT search path can
   *  supply it (CQL `expand=ancestors`); the BAS-gateway fallback path
   *  cannot, so it stays undefined there rather than guessing. */
  ancestors?: string[];
  /** Whether this page has at least one child page — lets the App-root search
   *  dropdown only render an expand arrow on pages that actually have
   *  children. `undefined` = unknown (the BAS-gateway fallback path has no
   *  equivalent field, and the direct-PAT path leaves it undefined too when
   *  Confluence's response omits the children block for a result). */
  hasChildren?: boolean;
}

export interface ConfluencePagesResponse {
  pages: ConfluencePageHit[];
}

// ── App Docs Pool (docs/app-docs-pool-spec.md §2) ────────────────────────────
// One Confluence fetch per App: pages land in `<appId>/docs/` + a manifest.

/** One page in an App's pool (`<appId>/docs/_manifest.json` entry). */
export interface AppPoolPage {
  pageId: string;
  /** Relative path under `<appId>/docs/`. */
  path: string;
  title: string;
  /** Slug of the top-level branch (phân hệ) this page belongs to. */
  branch: string;
  contentHash: string;
  fetchedAt: number;
  /** Trang vào pool qua "Quét tài liệu liên quan" (depth-1) chứ không phải
   *  do user tick trực tiếp — UI tách nhóm "Docs liên quan" riêng. */
  related?: boolean;
}

/** `GET /api/pipelines/apps/:appId/pool`. */
export interface AppPoolResponse {
  pages: AppPoolPage[];
}

/** `POST /api/pipelines/apps/:appId/import-confluence` response. */
export interface AppPoolImportResponse {
  imported: number;
  updated: number;
  pages: AppPoolPage[];
}

// A feature within a KG document (from kg_get_document_subgraph's FEATURE nodes).
// `documentId` is carried because kg_get_feature_detail needs BOTH ids.
export interface BasFeature {
  /** feature_id (reference_id of the FEATURE node). */
  id: string;
  /** feature_name. */
  name: string;
  /** Owning KG document_id. */
  documentId: string;
  /** Optional one-line summary for the row. */
  summary?: string;
}

export interface BasFeaturesResponse {
  documentId: string;
  features: BasFeature[];
}

// Lightweight Confluence page metadata for the link-preview panel (from
// `confluence_fetch_page`, trimmed to header fields — the full body is only
// fetched at run time when the pipeline actually ingests).
export interface ConfluencePageMeta {
  id: string;
  title: string;
  /** Space key / name, if the gateway returns one. */
  space?: string;
  url: string;
  /** First ~280 chars of the page body, plain text, for the preview card. */
  excerpt?: string;
}

export interface ConfluencePageMetaResponse {
  page: ConfluencePageMeta;
}

export interface RunPipelineResponse {
  projectId: string;
  /** Absent on a DETERMINISTIC run (docs stage with a Confluence source): the
   * daemon fetches the pages itself — no conversation, no agent run. Progress
   * still surfaces through the stage status. */
  conversationId?: string;
  agentRunId?: string;
}

// ── Run the WHOLE workflow with one click (no per-stage review gate) ────────
// POST /api/pipelines/run-all: the daemon runs the workflow's stages
// SEQUENTIALLY in dependency order — each stage's normal run (same seeding,
// clearing, and gating as a manual run), auto-chained: when a stage's run
// succeeds the next one starts immediately, without the user reviewing the
// output in between. A stage failure aborts the chain (later stages stay
// idle). Progress surfaces through the existing per-stage statuses
// (GET /api/pipelines) — the stepper animates through the chain.

/** Which UI-Spec terminal(s) the full run ends with. `both` = html + react
 *  (legacy pair); `ui-react-ds` is always an explicit single choice since it
 *  hard-requires a react-bundle design system. */
export type WorkflowTerminal = 'ui-html' | 'ui-react' | 'ui-react-ds' | 'both';

export interface RunWorkflowRequest {
  projectId: string;
  /** Workflow to run; omitted → the default workflow. */
  workflowId?: string;
  /**
   * Terminal stage(s) to finish with. The two UI-Spec terminals are OPTIONS —
   * a full run picks one (default `ui-html`) or `both` (html first, then
   * react).
   */
  terminal?: WorkflowTerminal;
  /** Free-text input for the first stage (Confluence URL / JIRA key / JQL). */
  input?: string;
  /** Structured source for the first stage — same as RunPipelineRequest. */
  source?: PipelineRunSource;
  /** Structured Confluence picks behind `input` (title kept for redisplay) —
   * NOT used to run the docs stage (that reads `input`/`source`); persisted
   * into `savedRunAll` so a later Run-all modal open can restore the picker
   * with titles instead of just bare URLs. */
  confluencePages?: ConfluencePageRef[];
  /** App Docs Pool nguồn (docs/app-docs-pool-spec.md §2.2) — trang CHÍNH đã
   *  tick từ pool của App. Có mặt → daemon GATE (mọi trang pool `distilled`)
   *  rồi copy deterministic vào `<wf>/docs/`, cùng semantics `confluencePages`
   *  nhưng đọc từ pool thay vì fetch trực tiếp. `null` xóa lựa chọn đã lưu. */
  appPool?: { appId: string; paths: string[] } | null;
  /** Design system for the UI terminal(s) — same semantics as RunPipelineRequest. */
  designSystemId?: string | null;
  /** Target platform for the UX stage — same semantics as RunPipelineRequest.
   *  Ignored when `targets` is set. */
  platform?: TargetPlatform;
  /** UI targets to build — same semantics as RunAllConfig.targets. When ≥1,
   *  the post-docs chain runs once per target into `<workflow>/<target>/`. */
  targets?: UiTarget[];
  /** Docs stage link-follow — same semantics as RunPipelineRequest.followLinks. */
  followLinks?: boolean;
  /** Docs stage sub-tree scan — same semantics as
   *  RunPipelineRequest.includeDescendants. */
  includeDescendants?: boolean;
  /**
   * The workflow's DOCS INGEST stage is skipped because its documents were
   * uploaded by hand (`acceptsUpload` stages — Docs → Review tài liệu): the
   * files already sit in `<workflow>/docs/`, which IS that stage's declared
   * output, so running it would clear them and then fetch nothing. The chain
   * therefore starts at the stage after the ingest. Ignored by workflows whose
   * first stage has no upload affordance.
   */
  docsFromUpload?: boolean;
  /**
   * When true, stages already `succeeded` are SKIPPED (resume: only the
   * missing stages run, each clearing just its own outputs). Default false: a
   * full fresh run — the project RESETS up front (the first stage runs with a
   * downstream cascade-clear, so every stage's old outputs are snapshotted to
   * history, wiped, and their statuses flip to idle) before the chain rebuilds
   * stage by stage.
   */
  lean?: boolean;
  skipSucceeded?: boolean;
  /**
   * Danh sách id bước sẽ chạy — cùng ngữ nghĩa với `RunAllConfig.stageIds`:
   * có mặt và KHÔNG rỗng → chạy ĐÚNG các bước này theo thứ tự của workflow và
   * bỏ qua `lean` + `skipSucceeded`. Vắng mặt → hành vi cũ. Daemon TỪ CHỐI
   * (400) khi danh sách chứa id không thuộc workflow, hoặc khi một bước được
   * chọn có phụ thuộc vừa không được chọn vừa chưa `succeeded` — run-all không
   * hỏi gating, nên bước thiếu input sẽ chạy thật và cho ra kết quả rác.
   */
  stageIds?: string[];
}

export interface RunWorkflowResponse {
  projectId: string;
  workflowId: string;
  /** Stage ids the chain will run, in order (after any skipSucceeded filter). */
  stages: string[];
}

// Persisted shape stored under projects.metadata_json -> `pipelines`. Keyed by
// pipeline id. dependsOn is NOT stored here (it lives in the daemon registry);
// only mutable run state is persisted.
export interface PipelineRunState {
  status: PipelineStatus;
  lastRunId?: string;
  lastConversationId?: string;
  updatedAt?: number;
  /** Free-text input of the last run (Confluence URL / JIRA key / JQL). */
  lastInput?: string;
  /** Structured source of the last run (Confluence ref or BAS document). */
  lastSource?: PipelineRunSource;
  /** Target platform of the last run (stages with `acceptsPlatform`). */
  lastPlatform?: TargetPlatform;
  /** When the last run FANNED OUT (per-page/module/screen parallel tasks), the
   *  conversation of each task so the UI can list them individually. Absent /
   *  empty for a single-agent run (its one conversation is lastConversationId). */
  subConversations?: PipelineSubConversation[];
  /** Short reason the last run failed — only meaningful alongside
   *  `status: 'failed'`; a later succeeded/running/idle status clears it. */
  error?: string;
}

export interface PipelineSubConversation {
  id: string;
  /** Task label (page / module / screen name) for the list. */
  title: string;
  /** Live per-task state — 'queued' (waiting), 'running', 'succeeded' (done),
   *  'failed' (error). Updated as the fan-out pool progresses so the Status
   *  modal shows X/N done + each task's state. */
  status: 'queued' | 'running' | 'succeeded' | 'failed';
}

export type ProjectPipelineState = Record<string, PipelineRunState>;

/* ── Project history (version hóa output) ──
 * Two layers: PUBLISHED versions on the media store (one per push — the
 * `_v/<verId>/…` snapshots indexed by changelog.json, what pipeline-studio
 * renders), and machine-local fine-grained commits (the hidden .odhistory
 * git repo). GET /api/pipelines/history returns both, newest first. */

export interface HistoryActorRef {
  id?: string;
  email?: string;
  name?: string;
}

/** One published version — an entry of the store-side changelog.json. */
export interface PublishedVersion {
  verId: string;
  /** ISO timestamp of the push. */
  at: string;
  by: HistoryActorRef | null;
  /** .odhistory commit hash on the pushing machine. */
  gitCommit?: string;
  /** Deliverable files frozen into the snapshot. */
  files: number;
  uploaded: number;
  deleted: number;
  note?: string;
  /** Pipeline (stage) ids whose outputs are present in this snapshot —
   *  derived from the snapshot files' `stage:` tags, so the UI can show a
   *  per-pipeline history. Absent when the snapshot was pruned. */
  stages?: string[];
}

/** One machine-local history commit (.odhistory). */
export interface ProjectHistoryCommit {
  commit: string;
  /** ISO timestamp. */
  at: string;
  subject: string;
  kind: 'manual-edits' | 'run' | 'build' | 'pre-pull' | 'pull' | 'push' | 'restore' | 'export';
  pipelineId?: string;
  runId?: string;
  status?: string;
  by?: HistoryActorRef | null;
  input?: string;
  verId?: string;
  note?: string;
  filesChanged?: number;
}

export interface ProjectHistoryResponse {
  versions: PublishedVersion[];
  commits: ProjectHistoryCommit[];
}

/** Restore either a published version (from the store) or a local commit. */
export interface RestoreHistoryRequest {
  projectId: string;
  verId?: string;
  commit?: string;
  /** Restrict a commit-restore to these cwd-relative paths. */
  paths?: string[];
  /** Restrict a version-restore to one pipeline's outputs (stage id) —
   *  per-pipeline "Khôi phục" from a stage card writes only that stage's
   *  files back instead of the whole snapshot. */
  stage?: string;
}

export interface RestoreHistoryResponse {
  restored: 'version' | 'commit';
  verId?: string;
  commit?: string;
  /** Files written (version restore) / touched (commit restore). */
  files: number;
}

/**
 * POST /api/pipelines/figma-capture — capture the built UI-Spec (React DS)
 * app into Figma screen JSON (figma-h2d IR with component-instance markers)
 * under `react-ds/figma-screens/`. The `screensJson` file feeds the design-v3
 * Fig Pipeline plugin's "Screen JSON → Figma" tab, which rebuilds the screens
 * with real component instances bound to Figma variables by token name.
 */
export interface FigmaCaptureRequest {
  projectId: string;
}

export interface FigmaCaptureResponse {
  ok: boolean;
  /** Screens/states captured (one Figma frame each). */
  screens: number;
  /** Component-instance markers captured across all screens. */
  markers: number;
  /** Stage-relative path of the merged screens.json (under react-ds/). */
  screensJson: string;
  /** Project-cwd-relative path — fetch via GET /api/projects/:id/raw/<rawPath>. */
  rawPath: string;
  /** Runner log tail (per-screen node/marker counts). */
  output: string;
}
