// Pipelines: a per-project, dependency-gated chain of skill-driven agent runs
// (the docs→UI flow). Each pipeline is a fixed skill; pressing "run" seeds a new
// conversation in the current project with that skill active and the UI switches
// to it. A pipeline becomes runnable ("active") only once every pipeline it
// depends on has succeeded. There is no scheduler/executor — runs are manual
// (button / `od pipeline run`) and the agent does the work guided by the skill.

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
  /** Pipeline ids that must be `succeeded` before this one is `active`. */
  dependsOn: string[];
  status: PipelineStatus;
  /** Derived: every dependsOn pipeline is `succeeded`. */
  active: boolean;
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
   * Output path patterns this pipeline produces in the project cwd (from the
   * daemon registry). The UI surfaces a stage's result files ("Quick result")
   * by matching these against `GET /api/projects/:id/files`. Patterns:
   * `dir/` = anything under that dir; `-suffix.json` / `*x` = endsWith; else an
   * exact relative path or basename.
   */
  outputs?: string[];
  lastRunId?: string;
  lastConversationId?: string;
  updatedAt?: number;
  /**
   * Free-text input of the LAST run (Confluence URL / JIRA key / JQL), kept so
   * the source behind a stage's output stays reviewable after the run (the
   * per-stage "run info" panel).
   */
  lastInput?: string;
  /** Structured source of the LAST run (Confluence ref or BAS document). */
  lastSource?: PipelineRunSource;
}

export interface PipelinesResponse {
  projectId: string;
  /** Which workflow these pipelines belong to (echoed back from the query). */
  workflowId: string;
  pipelines: PipelineView[];
}

// A workflow is one named docs→output flow — an ordered set of pipelines with
// its own terminal. `docs-to-html` ends at an interactive HTML prototype;
// `docs-to-react` ends at a built Vite+React app. Each workflow has its own
// pipeline ids, so their run-state never overlaps. (The former `docs-to-ui`
// react-shadcn workflow was removed.)
export interface Workflow {
  id: string;
  name: string;
  /** One-line description for the workflow tab. */
  description?: string;
  /** Ordered pipeline ids that make up this workflow's DAG. */
  pipelineIds: string[];
}

export interface WorkflowsResponse {
  workflows: Workflow[];
  /** The workflow shown by default (the first one). */
  defaultWorkflowId: string;
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
  config?: {
    /** Các trang Confluence nguồn (chọn NHIỀU từ picker của studio) — Run
     *  điền tất cả, mỗi dòng một trang (bước Docs nhận cả link lẫn page id). */
    confluencePages?: Array<{ id?: string; title?: string; url?: string }>;
    designSystemId?: string;
    basDocumentId?: string;
    basDocumentTitle?: string;
  };
}

export interface PipelineProjectsResponse {
  projects: PipelineProject[];
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
}

export interface ConfluencePagesResponse {
  pages: ConfluencePageHit[];
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
  conversationId: string;
  agentRunId: string;
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
