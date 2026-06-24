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
}

export interface PipelinesResponse {
  projectId: string;
  /** Which workflow these pipelines belong to (echoed back from the query). */
  workflowId: string;
  pipelines: PipelineView[];
}

// A workflow is one named docs→output flow — an ordered set of pipelines with
// its own terminal. `docs-to-ui` ends at react-shadcn `screen.json`;
// `docs-to-html` is an independent chain ending at an HTML prototype. The two
// have separate pipeline ids, so their run-state never overlaps.
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
}

// ── BAS-sourced inputs for pipeline 1 (jira-ingest) ─────────────────────────
// Both branches resolve their content through the BAS MCP gateway (the daemon's
// BasClient): `confluence` → `confluence_fetch_page`; `bas` → the workspace/KG
// document tools. The UI's source-selection modal builds one of these and sends
// it as `RunPipelineRequest.source`.
export type PipelineRunSource =
  | { kind: 'confluence'; /** Confluence page URL or id. */ ref: string }
  | {
      kind: 'bas';
      /** BAS workspace/project id the documents belong to. */
      projectId: string;
      /** Chosen feature ids (from `kg_search_features`), if any. */
      featureIds?: string[];
      /** Chosen document ids (from `workspace_list_documents`), if any. */
      documentIds?: string[];
    };

// A project/workspace in BAS (from `workspace_list_projects`). Pipeline-1's BAS
// branch lists these so the user can pick which BAS workspace to ingest from.
export interface BasProject {
  id: string;
  name: string;
  /** Optional short description shown under the project name in the picker. */
  description?: string;
}

export interface BasProjectsResponse {
  projects: BasProject[];
}

// A selectable BAS document or feature (from `kg_search_features` /
// `workspace_list_documents`) used as pipeline-1 input.
export interface BasFeature {
  id: string;
  title: string;
  /** 'feature' (KG feature node) or 'document' (workspace document). */
  kind: 'feature' | 'document';
  /** Optional one-line summary for the row. */
  summary?: string;
}

export interface BasFeaturesResponse {
  projectId: string;
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
}

export type ProjectPipelineState = Record<string, PipelineRunState>;
