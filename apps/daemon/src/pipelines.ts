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
   * When true, this stage generates UI and can apply a design system: the UI
   * shows a design-system picker before running and sends the chosen id as
   * `RunPipelineRequest.designSystemId`, which the daemon forwards to the chat
   * run (overriding the app-config default for that run only). Both UI-Spec
   * terminals (`ui-html`, `ui-react`) set this.
   */
  acceptsDesignSystem?: boolean;
  /**
   * When true, this stage decides the target platform of the generated screens
   * — the UX Spec stage, whose per-screen `layout` field (`mobile` | `web`)
   * downstream UI-Spec terminals follow. The UI shows a Mobile/Website picker
   * before running and sends the choice as `RunPipelineRequest.platform`; the
   * daemon folds it into the kickoff. No choice → the skill defaults to mobile.
   */
  acceptsPlatform?: boolean;
  /**
   * When true, this stage's outputs stay LOCAL — they are never pushed to the
   * media file store nor graph-converted on upload, so they do NOT round-trip to
   * another device via push-all/pull-all. Reserve this for genuinely
   * device-local scratch outputs; a stage's user-facing DELIVERABLE must stay
   * syncable (file-only is fine — that's `convertToGraph` unset, not localOnly).
   * No stage currently sets this.
   */
  localOnly?: boolean;
  /**
   * Path patterns (same syntax as `outputs`, workflow-dir-relative) that are
   * NEVER synced to the media file store — in BOTH directions. Push skips
   * (and prunes previously-pushed copies of) them; pull ignores them even
   * when an older store still carries them. Use for derived build artifacts
   * (`react/dist/` is rebuilt from source via the Build button) and
   * template-owned scaffold that the builder reseeds — syncing those would
   * pin a stale template over a newer toolkit on the pulling device.
   */
  syncExclude?: string[];
}

// ONE docs→UI-Spec workflow: three shared upstream stages (jira-ingest →
// customer-journey-spec → ux-spec) feeding TWO terminal OPTIONS — generate the
// UI-Spec as an interactive HTML prototype (`ui-html`) or as a real React app
// (`ui-react`). Both terminals depend on the shared `ux` stage; a project may
// run either or both. (History: merged 2026-07 from the twin docs-to-html +
// docs-to-react workflows, whose upstream stages duplicated the same skills
// under workflow-scoped ids. The former Workflow A "docs → UI" — react-shadcn
// screen.json, KGS graph projection via convertToGraph — was removed earlier.)
export const PIPELINE_DEFS: readonly PipelineDef[] = [
  // There is NO feature-analysis step: the Customer Journey is authored
  // DIRECTLY from the step-1 docs MD, and UX Spec is derived from those docs +
  // the journey.
  //   docs → cj (customer journey from docs) → ux-research → ux → ux-review → ui-html | ui-react
  // Confluence sources run DETERMINISTICALLY (daemon fetches via the BAS
  // gateway — no agent, see runDocsDeterministic in server.ts); the skill/agent
  // path remains only for JIRA key / JQL input. BAS source: locked (maintenance).
  { id: 'docs',             name: 'Docs → Markdown (JIRA)',    skillId: 'jira-ingest',           dependsOn: [],                                       outputs: ['docs/jira/', 'docs/confluence/'], inputPlaceholder: 'Confluence page URL/id, or JIRA project key / JQL' },
  // Customer Journey built straight from the ingested docs MD (no feature-analysis
  // upstream). Each STAGE carries `sources[]` — the key text excerpts from the
  // source MD — which the SpecPreview surfaces under each stage card.
  // FILE-ONLY (no `convertToGraph`): every stage produces local file
  // deliverables synced to the media store; nothing is projected into the
  // KGS graph anymore (that was the removed react-shadcn workflow's job).
  { id: 'cj',               name: 'Customer Journey',          skillId: 'customer-journey-spec', dependsOn: ['docs'], outputs: ['-customer-journey.json', '-journey.json', '-cj.json', 'customer-journey/', 'cj/'] },
  // ── UX Research (desk research from the local UX knowledge base) ───────────
  // BETWEEN cj and ux: reads the docs + customer journey to know the domain and
  // key flows, searches the local UX knowledge base (Growth.Design / NN/g /
  // Baymard — env UX_KB_DIR, default ~/ux-knowledge-base), and emits an
  // evidence-based criteria report (`ux-research/report.json` + report.md):
  // the UX criteria this app must meet, each traced to cited sources and
  // illustrated with hotlinked Growth.Design images. The ux stage depends on
  // this report so the UX Spec is authored AGAINST those criteria; the
  // heuristic gate may also cite them. FILE-ONLY, synced like other outputs.
  // When the knowledge base is absent on this machine the skill emits a
  // minimal report from its built-in fundamentals instead of failing the gate.
  { id: 'ux-research',      name: 'UX Research',               skillId: 'ux-research',           dependsOn: ['cj'], outputs: ['ux-research/'] },
  // The UX stage decides each screen's target platform (`layout: mobile|web`),
  // which both UI-Spec terminals follow — so the platform picker lives here.
  // Besides the spec JSON it emits one free-layout wireframe per screen
  // (`wireframes/<SCREEN-ID>.wire.json`, wiretext schema) AND one rule
  // flowchart per user flow (`flows/<FLOW-ID>.flow.json`: decision/end nodes +
  // labeled edges between screens — the wireframe+flowchart pair IS the user
  // flow deliverable; viewers render it instead of the retired Mermaid view).
  // File-only deliverables, synced like other outputs.
  // Depends on ux-research (not cj directly): the spec must be authored against
  // the researched criteria.
  { id: 'ux',               name: 'UX Spec',                   skillId: 'ux-spec',               dependsOn: ['ux-research'], outputs: ['-ux-spec.json', 'ux/', 'wireframes/', 'flows/'], acceptsPlatform: true },
  // ── GATE 1: UX Heuristic Review (Nielsen + Norman, judged on the wireframe) ─
  // Shift-left quality gate BETWEEN the UX Spec and the UI-Spec terminals: a
  // separate run (not the ux-spec generator grading its own work) reads the
  // authored screens and evaluates them against usability heuristics, emitting
  // a review report under `./heuristic-review/`. Both terminals depend on THIS
  // stage (not `ux` directly), so the review must run once before any UI is
  // built — one gate protects both html + react. FILE-ONLY (convertToGraph
  // unset): the report is a local deliverable synced to the media store, never
  // projected into KGS. WCAG pixel gates are judged later, post-render.
  { id: 'ux-review',        name: 'UX Heuristic Review',       skillId: 'heuristic-eval',        dependsOn: ['ux'], outputs: ['heuristic-review/'] },
  // ── Terminal option A: UI-Spec (HTML prototype) ────────────────────────────
  // ui-html also activates `frontend-design` (UI/UX craft) so the agent designs
  // boldly + well, not just structurally. The prototype skill additionally opts
  // into craft rules (anti-ai-slop, laws-of-ux, typography, color, animation).
  // The `prototype/` HTML output IS the deliverable, so it syncs to the
  // media file store like every other stage (push-all/pull-all cross-device
  // handoff). It is file-only — `convertToGraph` stays unset (not graph data).
  // GATE 2 (post-render WCAG) rides along as `wcag-lint`: after the prototype is
  // produced, the agent runs the bundled static linter and writes
  // ./prototype/a11y-report.json (measured contrast / touch / manual notes).
  // Baked into the terminal (not a separate stage) because the WCAG gate is
  // deterministic and the two terminals are OPTIONAL — a shared post-terminal
  // stage couldn't gate "either one". The report lives inside prototype/ so it
  // syncs + attributes to this stage with no extra output pattern.
  { id: 'ui-html',          name: 'UI-Spec (HTML)',            skillId: 'html-interactive-prototype', extraSkillIds: ['frontend-design', 'web-design-guidelines', 'taste-skill', 'wcag-lint'], dependsOn: ['ux-review'], outputs: ['prototype/'], acceptsDesignSystem: true },

  // ── Terminal option B: UI-Spec (React app) ─────────────────────────────────
  // The `ui-react` skill emits a REAL, buildable Vite + React 19 + Tailwind v4
  // shadcn app (built in an isolated Docker container) rather than static HTML.
  // FILE-ONLY like ui-html: the react/ deliverable syncs to the media store but
  // is never projected into the KGS graph (no convertToGraph).
  // Terminal ui-react activates the same design/craft skills as ui-html so the
  // app is genuinely designed; the built `react/` (source + dist) IS the
  // deliverable and syncs to the media store (file-only, convertToGraph unset).
  // Sync policy for the react/ tree: what the agent authored (src/screens,
  // App.tsx, main.tsx, index.css, flow.json) AND the built `dist/` travel.
  // dist/ syncs because remote consumers (pipeline-studio) preview the app
  // from the store — dist/screens/*.html + shared dist/assets/* chunks — and
  // have no Docker builder to reconstruct it (~1MB/project, multi-entry build,
  // no singlefile). It can still be rebuilt locally on demand (Build button →
  // POST /api/pipelines/react-build). Generated entries (react/screens/) and
  // template-owned scaffold stay excluded — pulling those would pin a stale
  // template over a newer toolkit. `*.artifact.json` are daemon-side render
  // metadata written next to each html — noise for remote consumers.
  // GATE 2 (post-render WCAG) also rides along here as `wcag-lint`: after the
  // Vite build, the agent lints ./react/dist and writes ./react/a11y-report.json
  // (react/a11y-report.json is not in syncExclude, so it round-trips).
  { id: 'ui-react',         name: 'UI-Spec (React)',           skillId: 'ui-react',              extraSkillIds: ['frontend-design', 'web-design-guidelines', 'taste-skill', 'wcag-lint'], dependsOn: ['ux-review'], outputs: ['react/'], acceptsDesignSystem: true,
    syncExclude: [
      'react/screens/',
      'react/package.json',
      'react/vite.config.ts',
      'react/tsconfig.json',
      'react/components.json',
      'react/index.html',
      'react/src/components/ui/',
      'react/src/lib/',
      '*.artifact.json',
    ] },
];

// Named docs→output flows. Each is an ordered subset of PIPELINE_DEFS. Since
// the 2026-07 merge there is exactly ONE workflow; the UI's workflow tab bar
// auto-hides with a single entry, and progress + gating span all its stages.
export const WORKFLOWS: readonly Workflow[] = [
  {
    id: 'docs-to-ui',
    name: 'Docs → UI-Spec',
    description:
      'Product docs → UX Research (evidence-based criteria) → UX Spec → a heuristic review gate → UI-Spec: an interactive HTML prototype or a real Vite + React 19 app — pick either (or both) at the final stage.',
    pipelineIds: ['docs', 'cj', 'ux-research', 'ux', 'ux-review', 'ui-html', 'ui-react'],
  },
];

// Folder heads of the RETIRED twin workflows (merged into docs-to-ui 2026-07).
// Old projects' outputs keep these prefixes on disk and on the media store;
// mapping them onto the merged workflow keeps their stages lighting and their
// syncExclude rules applying without any data migration.
const LEGACY_WORKFLOW_DIRS: Record<string, string> = {
  'docs-to-html': 'docs-to-ui',
  'docs-to-react': 'docs-to-ui',
};

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
// workflow id (workflowDirForPipeline). Undefined for an unknown id.
export function workflowForPipeline(pipelineId: string): Workflow | undefined {
  return WORKFLOWS.find((w) => w.pipelineIds.includes(pipelineId));
}

// The cwd subdirectory a pipeline's run + outputs live under (== its workflow
// id). Pipelines outside any workflow fall back to the cwd root (null).
export function workflowDirForPipeline(pipelineId: string): string | null {
  return workflowForPipeline(pipelineId)?.id ?? null;
}

// Split a cwd-relative output path into [workflow, rest] when it is namespaced
// under a workflow folder (`<workflowId>/...`) — including the retired twin
// workflows' folders, which resolve to the merged workflow. Returns
// [undefined, rel] for a legacy unprefixed path (produced before per-workflow
// folders existed).
function splitWorkflowPath(rel: string): [Workflow | undefined, string] {
  const slash = rel.indexOf('/');
  if (slash > 0) {
    const head = rel.slice(0, slash);
    const wf =
      WORKFLOWS.find((w) => w.id === head) ??
      (LEGACY_WORKFLOW_DIRS[head] ? getWorkflow(LEGACY_WORKFLOW_DIRS[head]!) : undefined);
    if (wf) return [wf, rel.slice(slash + 1)];
  }
  return [undefined, rel];
}

// STORE METADATA (not pipeline outputs): published version snapshots + their
// changelog index, and `project.json` — the project config Pipeline Studio
// writes at create/config time (dự án khai sinh ở studio: link Confluence +
// design system). None of these may light a stage, sync, or pull as an
// output. Mirrors kg-sync/published-versions.ts isHistoryPath (kept local
// here so the pure registry stays dependency-free).
export function isHistoryArtifact(rel: string): boolean {
  return rel === 'changelog.json' || rel === 'project.json' || rel.startsWith('_v/');
}

// DOWNLOAD-READY MD EXPORTS (`exports/…`): regenerated from the local outputs
// on EVERY push (pipeline-exports.ts) and streamed as-is by Pipeline Studio.
// They are derived artifacts, not stage outputs: they must never light a
// stage, never gate, and never pull back down (each machine regenerates its
// own on push) — but unlike history metadata they DO push, bypassing any
// stage filter.
export function isExportArtifact(rel: string): boolean {
  return rel === 'exports' || rel.startsWith('exports/');
}

// EVERY pipeline whose declared outputs match this file (cwd-relative path).
// Workflow-namespaced files (`<workflowId>/...` — current or retired folder
// names) are attributed to that workflow's stages. A legacy unprefixed path
// (pre-namespacing) still matches across all stages so old projects' status
// keeps deriving.
export function stagesForOutput(rel: string): PipelineDef[] {
  // `_v/v3/docs-to-react/x-cj.json` would otherwise match the endsWith
  // patterns and mark stages done from a frozen SNAPSHOT.
  if (isHistoryArtifact(rel)) return [];
  // Derived MD exports repeat output-ish names (customer-journey.md, …) —
  // they must never attribute to (or light) a stage.
  if (isExportArtifact(rel)) return [];
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

/**
 * Whether a project-cwd-relative path is barred from media-store sync by its
 * stage's `syncExclude` patterns (both directions: push skip/prune AND pull
 * ignore). Workflow-namespaced paths are matched against the workflow-relative
 * remainder, mirroring stagesForOutput.
 */
export function isSyncExcluded(rel: string): boolean {
  const [wf, sub] = splitWorkflowPath(rel);
  const candidate = wf ? sub : rel;
  const defs = wf
    ? PIPELINE_DEFS.filter((d) => new Set(wf.pipelineIds).has(d.id))
    : PIPELINE_DEFS;
  return defs.some((d) => (d.syncExclude ?? []).some((p) => outputMatches(candidate, p)));
}

function statusOf(state: ProjectPipelineState, id: string): PipelineStatus {
  return state[id]?.status ?? 'idle';
}

// A pipeline is runnable only when every dependency has succeeded.
export function computeActive(state: ProjectPipelineState, def: PipelineDef): boolean {
  return def.dependsOn.every((dep) => statusOf(state, dep) === 'succeeded');
}

// The set of stages to CLEAR + regenerate when `pipelineId` is re-run. Without
// cascade it's just the stage itself. With cascade it also includes every stage
// that (transitively) dependsOn it — those become stale once its output changes,
// so a re-run wipes them too and they must be re-run. Returns [pipelineId, …]
// (order not significant); an unknown id yields just [pipelineId].
export function stageRegenSet(pipelineId: string, cascade: boolean): string[] {
  const set = new Set<string>([pipelineId]);
  if (cascade) {
    for (;;) {
      let grew = false;
      for (const d of PIPELINE_DEFS) {
        if (set.has(d.id)) continue;
        if (d.dependsOn.some((dep) => set.has(dep))) {
          set.add(d.id);
          grew = true;
        }
      }
      if (!grew) break;
    }
  }
  return [...set];
}

// Whether any stage (transitively) dependsOn `pipelineId` — i.e. re-running it
// can leave downstream stages stale, so the "reset downstream too" choice is
// meaningful. Terminals (ui-html / ui-react) have none.
export function hasDownstream(pipelineId: string): boolean {
  return stageRegenSet(pipelineId, true).length > 1;
}

// Every stage `pipelineId` (transitively) dependsOn — the UPSTREAM inputs it
// needs present before it runs. Excludes pipelineId itself and all downstream.
// The pre-run pull scopes to this so running a middle stage (e.g. ux-review)
// pulls only its inputs (docs/cj/ux) — never resurrects downstream UI outputs.
export function upstreamStages(pipelineId: string): string[] {
  const set = new Set<string>();
  const walk = (id: string) => {
    const d = PIPELINE_DEFS.find((p) => p.id === id);
    if (!d) return;
    for (const dep of d.dependsOn) {
      if (!set.has(dep)) {
        set.add(dep);
        walk(dep);
      }
    }
  };
  walk(pipelineId);
  return [...set];
}

// Cross-device gating: derive "done" stages from the media file store. A stage
// whose declared output file(s) exist in the store is treated as succeeded — its
// output is pullable on any device — independent of this device's local run
// metadata. We re-derive the owning stage(s) from each file's PATH (via
// stagesForOutput) rather than trusting the single `stage` tag stamped at
// upload: old stores carry tags from retired stage ids (html-docs, react-cj,
// jira-ingest, …) that no longer exist in the registry.
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
      ...(def.acceptsDesignSystem ? { acceptsDesignSystem: true } : {}),
      ...(def.acceptsPlatform ? { acceptsPlatform: true } : {}),
      ...(def.outputs && def.outputs.length ? { outputs: [...def.outputs] } : {}),
      ...(run?.lastRunId ? { lastRunId: run.lastRunId } : {}),
      ...(run?.lastConversationId ? { lastConversationId: run.lastConversationId } : {}),
      ...(run?.updatedAt ? { updatedAt: run.updatedAt } : {}),
      ...(run?.lastInput ? { lastInput: run.lastInput } : {}),
      ...(run?.lastSource ? { lastSource: run.lastSource } : {}),
      ...(run?.lastPlatform ? { lastPlatform: run.lastPlatform } : {}),
    };
  });
}
