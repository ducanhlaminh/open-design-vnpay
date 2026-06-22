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
   * (e.g. the Confluence page URL/id for jira-ingest). Folded into the run's
   * kickoff message so the skill uses it as the source. */
  input?: string;
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
