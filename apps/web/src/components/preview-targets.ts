// Pipeline-step → "hero preview file" resolution for the workspace Preview
// dropdown (FileWorkspace toolbar).
//
// The dropdown must answer one question: for each step of the pipeline this
// project ran, which single file IS the preview? We answer it from the `files`
// list ProjectView already owns (kept fresh by the SSE file-watch) instead of
// fetching /api/pipelines — the dropdown opens files BY the very paths in
// `files`, so reading the same source means the two can never fall out of sync,
// and we avoid a third pipelines consumer plus its 2.5s polling.
//
// Path shapes handled (the daemon writes outputs under the workflow folder, and
// nests post-docs outputs per UI target on multi-target builds):
//   docs-to-ui/prototype/index.html
//   docs-to-ui/mobile/prototype/index.html
//   prototype/index.html                     (legacy flat project)
//
// Strip/match is NOT reimplemented here: `stripWorkflowDir` and `outputMatches`
// are imported from PipelineModals (already the web-side mirror of the daemon's
// pipelines.ts), which is why the hero table below is workflow-RELATIVE.

import type { Dict } from '../i18n/types';
import { outputMatches, stripWorkflowDir } from './pipelines/PipelineModals';

/** One row of the Preview dropdown. `path === null` → the step has no output
 *  yet, rendered disabled so the user still sees the whole pipeline. */
export interface PreviewTarget {
  stageId: string;
  labelKey: keyof Dict;
  target: string | null;
  path: string | null;
}

interface StageSpec {
  stageId: string;
  labelKey: keyof Dict;
  /** Workflow-relative hero-file patterns, most-preferred first. */
  heroes: string[];
}

// Display order == pipeline order. Ingest steps (docs / prd-docs / dr-docs) are
// intentionally absent: they emit N markdown files with no single hero file and
// the affordance is a *UI* preview.
const STAGE_SPECS: readonly StageSpec[] = [
  { stageId: 'docs-map', labelKey: 'workspace.previewStage.docsMap', heroes: ['docs/system-map.json'] },
  {
    stageId: 'cj',
    labelKey: 'workspace.previewStage.cj',
    heroes: ['-customer-journey.json', '-journey.json', '-cj.json'],
  },
  { stageId: 'ux-research', labelKey: 'workspace.previewStage.uxResearch', heroes: ['ux-research/report.json'] },
  { stageId: 'ux', labelKey: 'workspace.previewStage.ux', heroes: ['-ux-spec.json'] },
  { stageId: 'ux-review', labelKey: 'workspace.previewStage.uxReview', heroes: ['heuristic-review/report.json'] },
  { stageId: 'ui-html', labelKey: 'workspace.previewStage.uiHtml', heroes: ['prototype/index.html'] },
  { stageId: 'ui-react', labelKey: 'workspace.previewStage.uiReact', heroes: ['react/dist/index.html'] },
  { stageId: 'ui-react-ds', labelKey: 'workspace.previewStage.uiReactDs', heroes: ['react-ds/dist/index.html'] },
  { stageId: 'prd-review', labelKey: 'workspace.previewStage.prdReview', heroes: ['review/summary.md'] },
  { stageId: 'dr-review', labelKey: 'workspace.previewStage.drReview', heroes: ['review/index.json'] },
];

/** Number of steps the dropdown always lists (pinned by tests: the user needs
 *  the whole-pipeline overview, not only the finished part). */
export const PREVIEW_STAGE_COUNT = STAGE_SPECS.length;

// Folder heads the daemon may prefix an output with, mapped to their canonical
// workflow id. docs-to-html / docs-to-react were merged into docs-to-ui in
// 2026-07 and old projects keep those heads on disk (LEGACY_WORKFLOW_DIRS in
// pipelines.ts), so they count towards the same workflow.
const WORKFLOW_HEAD_TO_ID: Record<string, string> = {
  'docs-to-ui': 'docs-to-ui',
  'docs-to-html': 'docs-to-ui',
  'docs-to-react': 'docs-to-ui',
  'docs-to-prd': 'docs-to-prd',
  'docs-review': 'docs-review',
  // ds-lab (WP-lab, 2026-08-22): no STAGE_SPECS entry (lab-compose emits N
  // PNGs under screens/, no single hero file — same reason the ingest steps
  // are absent from STAGE_SPECS), but still needs its head mapped here so its
  // files don't fall through to the "unprefixed legacy" bucket and get
  // conflated with a genuinely flat project's files.
  'ds-lab': 'ds-lab',
};

// Mirrors UI_TARGET_SEG_RE in PipelineModals: a multi-target build nests
// post-docs outputs under <workflow>/<target>/.
const UI_TARGET_SEG_RE = /^(mobile|web-user|web-backoffice)\//;
const TARGET_ORDER = ['mobile', 'web-user', 'web-backoffice'];

interface FileEntry {
  /** Full name as it appears in `files` — what we hand to onOpenFile. */
  name: string;
  /** Canonical workflow id, or null for an unprefixed legacy file. */
  workflowId: string | null;
  target: string | null;
  /** Workflow- and target-relative path, ready for `outputMatches`. */
  rel: string;
}

function describe(name: string): FileEntry {
  const head = name.split('/')[0] ?? '';
  const workflowId = WORKFLOW_HEAD_TO_ID[head] ?? null;
  const afterWorkflow = workflowId ? name.slice(head.length + 1) : name;
  const targetMatch = UI_TARGET_SEG_RE.exec(afterWorkflow);
  return {
    name,
    workflowId,
    target: targetMatch ? targetMatch[1]! : null,
    rel: stripWorkflowDir(name),
  };
}

/** The workflow whose outputs dominate the project, or null when nothing is
 *  prefixed (legacy flat output). Multi-workflow projects show the one with the
 *  most files: the workspace has no workflow picker to disambiguate with. */
function dominantWorkflow(entries: readonly FileEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.workflowId) continue;
    counts.set(entry.workflowId, (counts.get(entry.workflowId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

function sortTargets(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const ai = TARGET_ORDER.indexOf(a);
  const bi = TARGET_ORDER.indexOf(b);
  return (ai < 0 ? TARGET_ORDER.length : ai) - (bi < 0 ? TARGET_ORDER.length : bi);
}

/** Resolve the Preview dropdown rows from the project's file list. Always
 *  returns every pipeline step, in pipeline order; steps with no output yet
 *  come back as a single `path: null` (disabled) row. */
export function resolvePreviewTargets(files: readonly { name: string }[]): PreviewTarget[] {
  const described = files.map((file) => describe(file.name));
  const workflowId = dominantWorkflow(described);
  // Keep only the picked workflow's tree; an unprefixed (legacy) project keeps
  // exactly the unprefixed files.
  const scoped = described.filter((entry) => entry.workflowId === workflowId);

  const rows: PreviewTarget[] = [];
  for (const spec of STAGE_SPECS) {
    const byTarget = new Map<string | null, string>();
    for (const hero of spec.heroes) {
      for (const entry of scoped) {
        if (byTarget.has(entry.target)) continue;
        if (outputMatches(entry.rel, hero)) byTarget.set(entry.target, entry.name);
      }
    }
    if (byTarget.size === 0) {
      rows.push({ stageId: spec.stageId, labelKey: spec.labelKey, target: null, path: null });
      continue;
    }
    const targets = [...byTarget.keys()].sort(sortTargets);
    for (const target of targets) {
      rows.push({
        stageId: spec.stageId,
        labelKey: spec.labelKey,
        target,
        path: byTarget.get(target)!,
      });
    }
  }
  return rows;
}
