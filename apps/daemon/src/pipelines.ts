// Pipeline registry — the static docs→UI DAG. Each pipeline is a fixed skill
// whose SKILL.md body becomes the run's system prompt (via composeSystemPrompt's
// "## Active skill" block). There is no scheduler/executor: pipelines are run
// manually (button / `od pipeline run`) and gated by dependency — a pipeline is
// "active" only once every pipeline it dependsOn has succeeded. Mutable run
// state per project lives in projects.metadata_json (see db.ts helpers); this
// module is pure registry + derivation.

import type {
  PipelineStatus,
  PipelineView,
  ProjectPipelineState,
  Workflow,
} from '@open-design/contracts';

export interface PipelineDef {
  id: string;
  name: string;
  /** Skill id whose SKILL.md body drives this pipeline's agent run. */
  skillId: string;
  /**
   * Extra skills whose SKILL.md bodies are appended after the primary skill (one
   * combined block, via startChatRun's `skillIds`) so ONE pipeline can drive
   * several skills in a single run — e.g. a combined Feature Analysis + Customer
   * Journey step that emits both outputs from one "Run".
   */
  extraSkillIds?: string[];
  /** Pipeline ids that must be `succeeded` before this one becomes active. */
  dependsOn: string[];
  /**
   * B2 auto-convert: when true, after a successful run the daemon runs this
   * skill's converter (skills/<skillId>/scripts/push_to_kgs.py) on the produced
   * JSON output to push it into the KGS graph, then marks those files
   * CONVERTED. Stages without a converter (or that stay file-only, e.g. raw
   * docs) leave this false — the pipeline never depends on graph conversion.
   */
  convertToGraph?: boolean;
  /**
   * Output path patterns this stage produces in the project cwd. Used by the
   * MANUAL upload to attribute each file to its stage (and decide B2). Patterns:
   * `dir/` = anything under that dir; `-suffix.json` / `*x` = endsWith; else an
   * exact relative path or basename.
   */
  outputs?: string[];
  /** If set, this pipeline takes a free-text run input (e.g. a Confluence URL).
   * The UI renders an input box with this placeholder; the value is folded into
   * the run kickoff. */
  inputPlaceholder?: string;
  /**
   * When true, this stage's outputs stay LOCAL — they are never pushed to the
   * media file store nor graph-converted on upload, so they do NOT round-trip to
   * another device via push-all/pull-all. Reserve this for genuinely
   * device-local scratch outputs; a stage's user-facing DELIVERABLE must stay
   * syncable (file-only is fine — that's `convertToGraph` unset, not localOnly).
   * No stage currently sets this.
   */
  localOnly?: boolean;
}

// docs → UI: jira-ingest → feature-analysis → (ux-spec ∥ customer-journey) → ui.
// jira-ingest + feature-analysis ship as new skills; ux-spec, customer-journey-spec
// and react-shadcn already exist under skills/.
export const PIPELINE_DEFS: readonly PipelineDef[] = [
  // ── Workflow A: docs → UI (react-shadcn screen.json) ──────────────────────
  { id: 'jira-ingest',      name: 'Docs → Markdown (JIRA)',    skillId: 'jira-ingest',           dependsOn: [],                                  outputs: ['docs/jira/', 'docs/confluence/'], inputPlaceholder: 'Confluence page URL/id, or JIRA project key / JQL' },
  { id: 'feature-analysis', name: 'Feature Analysis',          skillId: 'feature-analysis',      dependsOn: ['jira-ingest'],                     outputs: ['features/', 'features.json', 'docs/features.md'] },
  { id: 'ux-spec',          name: 'UX Spec',                   skillId: 'ux-spec',               dependsOn: ['feature-analysis'], convertToGraph: true, outputs: ['-ux-spec.json', 'ux/'] },
  { id: 'customer-journey', name: 'Customer Journey',          skillId: 'customer-journey-spec', dependsOn: ['feature-analysis'], convertToGraph: true, outputs: ['-customer-journey.json', '-journey.json', '-cj.json', 'customer-journey/', 'cj/'] },
  { id: 'ui',               name: 'UI (static + interactive)', skillId: 'react-shadcn',          dependsOn: ['ux-spec', 'customer-journey'],     outputs: ['ui/', 'screens/'] },

  // ── Workflow B: docs → HTML prototype (INDEPENDENT chain, own ids) ────────
  // Reuses the same upstream skills as Workflow A but with distinct ids so its
  // run-state never overlaps. There is NO feature-analysis step here: the
  // Customer Journey is authored DIRECTLY from the step-1 docs MD, and UX Spec is
  // derived from those docs + the journey.
  //   html-docs → html-cj (customer journey from docs) → html-ux → ui-html
  // Terminal `ui-html` runs a dedicated HTML skill (authored in Phase 2) that
  // emits one self-contained `.html` per screen.
  { id: 'html-docs',        name: 'Docs → Markdown (JIRA)',    skillId: 'jira-ingest',           dependsOn: [],                                       outputs: ['docs/jira/', 'docs/confluence/'], inputPlaceholder: 'Confluence page URL/id, or JIRA project key / JQL' },
  // Customer Journey built straight from the ingested docs MD (no feature-analysis
  // upstream). Each STAGE carries `sources[]` — the key text excerpts from the
  // source MD — which the SpecPreview surfaces under each stage card.
  { id: 'html-cj',          name: 'Customer Journey',          skillId: 'customer-journey-spec', dependsOn: ['html-docs'], convertToGraph: true, outputs: ['-customer-journey.json', '-journey.json', '-cj.json', 'customer-journey/', 'cj/'] },
  { id: 'html-ux',          name: 'UX Spec',                   skillId: 'ux-spec',               dependsOn: ['html-cj'], convertToGraph: true, outputs: ['-ux-spec.json', 'ux/'] },
  // ui-html also activates `frontend-design` (UI/UX craft) so the agent designs
  // boldly + well, not just structurally. The prototype skill additionally opts
  // into craft rules (anti-ai-slop, laws-of-ux, typography, color, animation).
  // The `prototype/` HTML output IS the workflow deliverable, so it syncs to the
  // media file store like every other stage (push-all/pull-all cross-device
  // handoff). It is file-only — `convertToGraph` stays unset (not graph data).
  { id: 'ui-html',          name: 'UI (HTML prototype)',       skillId: 'html-interactive-prototype', extraSkillIds: ['frontend-design', 'web-design-guidelines', 'taste-skill'], dependsOn: ['html-ux'], outputs: ['prototype/'] },
];

// Named docs→output flows. Each is an ordered subset of PIPELINE_DEFS. The UI
// shows one workflow at a time (tab selector); progress + gating are scoped to
// the active workflow's pipeline ids.
export const WORKFLOWS: readonly Workflow[] = [
  {
    id: 'docs-to-ui',
    name: 'Docs → UI',
    description: 'Product docs → react-shadcn screens (design-v3 preview).',
    pipelineIds: ['jira-ingest', 'feature-analysis', 'ux-spec', 'customer-journey', 'ui'],
  },
  {
    id: 'docs-to-html',
    name: 'Docs → HTML prototype',
    description: 'Product docs → interactive HTML/CSS prototype (React Flow canvas).',
    pipelineIds: ['html-docs', 'html-cj', 'html-ux', 'ui-html'],
  },
];

export const DEFAULT_WORKFLOW_ID = WORKFLOWS[0]!.id;

export function getWorkflow(id: string): Workflow | undefined {
  return WORKFLOWS.find((w) => w.id === id);
}

export function getPipelineDef(id: string): PipelineDef | undefined {
  return PIPELINE_DEFS.find((p) => p.id === id);
}

function outputMatches(rel: string, pattern: string): boolean {
  if (pattern.endsWith('/')) return rel === pattern.slice(0, -1) || rel.startsWith(pattern);
  if (pattern.startsWith('*') || pattern.startsWith('-')) {
    return rel.endsWith(pattern.startsWith('*') ? pattern.slice(1) : pattern);
  }
  return rel === pattern || rel.endsWith('/' + pattern);
}

// The workflow a pipeline belongs to. Each pipeline id is in exactly one
// workflow, so this is unambiguous. Drives the per-workflow output namespace:
// a pipeline run writes under the project cwd subdirectory named after its
// workflow id (workflowDirForPipeline), so the two workflows' outputs live in
// separate folders and never collide. Undefined for an unknown id.
export function workflowForPipeline(pipelineId: string): Workflow | undefined {
  return WORKFLOWS.find((w) => w.pipelineIds.includes(pipelineId));
}

// The cwd subdirectory a pipeline's run + outputs live under (== its workflow
// id). Pipelines outside any workflow fall back to the cwd root (null).
export function workflowDirForPipeline(pipelineId: string): string | null {
  return workflowForPipeline(pipelineId)?.id ?? null;
}

// Split a cwd-relative output path into [workflow, rest] when it is namespaced
// under a workflow folder (`<workflowId>/...`). Returns [undefined, rel] for a
// legacy unprefixed path (produced before per-workflow folders existed).
function splitWorkflowPath(rel: string): [Workflow | undefined, string] {
  const slash = rel.indexOf('/');
  if (slash > 0) {
    const head = rel.slice(0, slash);
    const wf = WORKFLOWS.find((w) => w.id === head);
    if (wf) return [wf, rel.slice(slash + 1)];
  }
  return [undefined, rel];
}

// EVERY pipeline whose declared outputs match this file (cwd-relative path).
// Workflow-namespaced files (`<workflowId>/...`) are attributed ONLY to that
// workflow's stages — so the two workflows' shared output patterns (docs/,
// -ux-spec.json, cj/, …) no longer cross-light each other's stepper. A legacy
// unprefixed path (pre-namespacing) still matches across all stages so old
// projects' status keeps deriving.
export function stagesForOutput(rel: string): PipelineDef[] {
  const [wf, sub] = splitWorkflowPath(rel);
  if (wf) {
    const ids = new Set(wf.pipelineIds);
    return PIPELINE_DEFS.filter(
      (d) => ids.has(d.id) && (d.outputs ?? []).some((p) => outputMatches(sub, p)),
    );
  }
  return PIPELINE_DEFS.filter((d) => (d.outputs ?? []).some((p) => outputMatches(rel, p)));
}

// Which pipeline owns a produced file, for manual upload stage-attribution
// (`stage` tag + `convertToGraph` decision). First match — workflow-scoped when
// the path is namespaced, else first across all stages. Undefined → not a
// declared stage output.
export function stageForOutput(rel: string): PipelineDef | undefined {
  return stagesForOutput(rel)[0];
}

function statusOf(state: ProjectPipelineState, id: string): PipelineStatus {
  return state[id]?.status ?? 'idle';
}

// A pipeline is runnable only when every dependency has succeeded.
export function computeActive(state: ProjectPipelineState, def: PipelineDef): boolean {
  return def.dependsOn.every((dep) => statusOf(state, dep) === 'succeeded');
}

// Cross-device gating: derive "done" stages from the media file store. A stage
// whose declared output file(s) exist in the store is treated as succeeded — its
// output is pullable on any device — independent of this device's local run
// metadata. We re-derive the owning stage(s) from each file's PATH (via
// stagesForOutput) rather than trusting the single `stage` tag stamped at upload:
// that tag is first-match-only (always the docs-to-ui stage for a shared
// pattern), which would leave the docs-to-html stages permanently unlit.
export function deriveStateFromKgsFiles(files: Array<Record<string, unknown>>): ProjectPipelineState {
  const state: ProjectPipelineState = {};
  for (const f of files) {
    const rel = typeof f.path === 'string' ? f.path : '';
    if (!rel) continue;
    for (const def of stagesForOutput(rel)) state[def.id] = { status: 'succeeded' };
  }
  return state;
}

// Local equivalent of deriveStateFromKgsFiles: a stage whose declared output
// file(s) exist in the project cwd is treated as succeeded. This makes the
// stepper reflect on-disk outputs directly — offline-safe (no KGS round-trip)
// and covering outputs produced/pulled locally but not yet on KGS. Paths are
// cwd-relative; `stagesForOutput` maps each to its owning stage(s) (unmatched →
// ignored, so stray files don't mark a stage done).
export function deriveStateFromLocalFiles(relPaths: string[]): ProjectPipelineState {
  const state: ProjectPipelineState = {};
  for (const rel of relPaths) {
    for (const def of stagesForOutput(rel)) state[def.id] = { status: 'succeeded' };
  }
  return state;
}

// Merge cross-device KGS "done" state with this device's local run metadata.
// KGS (has files) is authoritative for the durable done-signal; local fills in
// transient states (running/failed/idle) for stages KGS doesn't have yet. A
// local in-flight re-run ('running') is shown even if KGS already has old files.
export function mergePipelineState(
  local: ProjectPipelineState,
  kgs: ProjectPipelineState,
): ProjectPipelineState {
  const merged: ProjectPipelineState = {};
  for (const def of PIPELINE_DEFS) {
    const l = local[def.id];
    const k = kgs[def.id];
    if (k && l?.status === 'running') {
      merged[def.id] = l;
    } else if (k) {
      merged[def.id] = { ...(l ?? {}), ...k };
    } else if (l) {
      merged[def.id] = l;
    }
  }
  return merged;
}

// Merge the static registry with this project's persisted run state into the
// client-facing view list. When `pipelineIds` is given (a workflow's ids), only
// those pipelines are returned, in the order listed (so the stepper follows the
// workflow). Otherwise every pipeline is returned in registry order.
export function listPipelineStatus(
  state: ProjectPipelineState,
  pipelineIds?: readonly string[],
): PipelineView[] {
  const defs = pipelineIds
    ? pipelineIds.map((id) => PIPELINE_DEFS.find((p) => p.id === id)).filter((d): d is PipelineDef => !!d)
    : PIPELINE_DEFS;
  return defs.map((def) => {
    const run = state[def.id];
    return {
      id: def.id,
      name: def.name,
      dependsOn: [...def.dependsOn],
      status: run?.status ?? 'idle',
      active: computeActive(state, def),
      ...(def.inputPlaceholder ? { inputPlaceholder: def.inputPlaceholder } : {}),
      ...(def.outputs && def.outputs.length ? { outputs: [...def.outputs] } : {}),
      ...(run?.lastRunId ? { lastRunId: run.lastRunId } : {}),
      ...(run?.lastConversationId ? { lastConversationId: run.lastConversationId } : {}),
      ...(run?.updatedAt ? { updatedAt: run.updatedAt } : {}),
    };
  });
}
