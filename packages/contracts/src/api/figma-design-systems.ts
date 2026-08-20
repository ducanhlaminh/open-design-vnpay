/** A reusable, machine-independent Figma component catalogue.
 *
 * The Personal Access Token used to refresh it is intentionally absent from
 * every request/response here. Credentials stay in the daemon's local Figma
 * config store and are never attached to a source or synced with an App.
 */
export interface FigmaDesignSystemCatalogFile {
  fileKey: string;
  name: string;
  url: string;
  componentCount: number;
}

export interface FigmaDesignSystemCatalogSummary {
  generatedAt: string;
  digest: string;
  fileCount: number;
  componentCount: number;
  files: FigmaDesignSystemCatalogFile[];
}

export type FigmaDesignSystemSourceStatus = 'empty' | 'ready' | 'refreshing' | 'error';

export interface FigmaDesignSystemRefreshProgress {
  completedFiles: number;
  totalFiles: number;
  phase: 'summary' | 'properties' | 'done';
  currentFileKey: string;
  currentFileName?: string;
}

export interface FigmaDesignSystemSource {
  id: string;
  name: string;
  kind: 'figma-links';
  /** 1–5 canonical `https://www.figma.com/design/<fileKey>` URLs. */
  links: string[];
  status: FigmaDesignSystemSourceStatus;
  /** In-memory progress while this daemon is refreshing the source. */
  refreshProgress: FigmaDesignSystemRefreshProgress | null;
  catalog: FigmaDesignSystemCatalogSummary | null;
  lastError: string | null;
  /** Link catalogues are reference data, not compiled UI packages. */
  hasShowcase: false;
  hasReactBundle: false;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFigmaDesignSystemSourceRequest {
  name: string;
  links: string[];
}

export interface UpdateFigmaDesignSystemSourceRequest {
  name?: string;
  links?: string[];
}

export interface ListFigmaDesignSystemSourcesResponse {
  sources: FigmaDesignSystemSource[];
}

/** Detail payload keeps the large Markdown document out of the list route. */
export interface GetFigmaDesignSystemSourceResponse {
  source: FigmaDesignSystemSource;
  /** Rendered `criteria/components.md`, or null before the first successful load. */
  componentsMarkdown: string | null;
  /** WP20: rendered `components-guide.md` of this SHARED source (AI-generated
   *  fallback description guide, same closed format as
   *  `AppFigmaCatalogResponse.guideMarkdown` — mirrors the App-level field
   *  one-for-one, this is the same feature applied to a source that many
   *  Apps can point at via `figmaDesignSystemSourceId`). Optional and omitted
   *  (not `null`) when the source has no guide yet, so responses for every
   *  source created before this field stay byte-for-byte identical. */
  guideMarkdown?: string | null;
  /** WP20 coverage counts, computed from the source's catalog + guide. Optional
   *  and omitted when there is no catalog yet — same "omit rather than send a
   *  zeroed shape" rule as `guideMarkdown`. */
  coverage?: FigmaDesignSystemGuideCoverage;
  /** WP21a: outcome of the most recent finished `generate-guide` run (kể cả
   *  partial — job stopped early / some chunks failed), persisted at
   *  `figma-design-systems/<sourceId>/criteria/components-guide.meta.json` so
   *  it survives a daemon restart. Optional and omitted when no run has ever
   *  finished for this source — same "omit rather than send a zeroed shape"
   *  rule as `guideMarkdown`/`coverage`. See `.tmp/pipeline/wp21-contract.md`
   *  mục 3. */
  lastGuideRun?: FigmaDesignSystemLastGuideRun;
}

/** WP21a: one component that failed to get a description in the most recent
 *  `generate-guide` run — either validation rejected it, or the whole chunk
 *  it belonged to errored. */
export interface FigmaDesignSystemGuideRunFailure {
  anchor: string;
  name: string;
  reason: string;
}

/** WP21a: summary of the most recent finished `generate-guide` run for a
 *  source, persisted so `GET /:id` can show it after a daemon restart (the
 *  in-memory job map does not survive one). See
 *  `.tmp/pipeline/wp21-contract.md` mục 3. */
export interface FigmaDesignSystemLastGuideRun {
  finishedAt: string;
  generated: number;
  failed: number;
  failures: FigmaDesignSystemGuideRunFailure[];
}

/** WP20: how many of a shared source's Figma components have a description,
 *  and where it came from — one-for-one mirror of `AppFigmaCatalogCoverage`
 *  (figma-config.ts) applied to a source instead of an App. `described`
 *  counts BOTH a real Figma description and one filled in from
 *  `components-guide.md`. */
export interface FigmaDesignSystemGuideCoverage {
  total: number;
  described: number;
  fromGuide: number;
  missing: number;
}

/** WP21a: per-component status inside a running/finished `generate-guide` job
 *  — one entry per component in THIS round, so the UI can show live progress
 *  instead of only 3 aggregate numbers. `page` is the Figma page this
 *  component belongs to, so the UI can group progress by page (the engine
 *  fans generation out by (fileKey, page) group — see
 *  `.tmp/pipeline/wp21-contract.md` mục 2). `reason` is only present for
 *  `'failed'` (validation rejection message, or "agent lỗi: <msg>" when the
 *  whole chunk errored). */
export interface FigmaDesignSystemGuideJobItem {
  anchor: string;
  name: string;
  page?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  reason?: string;
}

/** WP20: `POST /api/figma-design-systems/:id/generate-guide` background job
 *  status — same "queued → running → succeeded/failed" shape as
 *  `AppFigmaGuideJob` (figma-config.ts), scoped to a shared source instead of
 *  an App because the guide is shared between every App that points at this
 *  source. Polled by `GET .../generate-guide/:jobId`. */
export interface FigmaDesignSystemGuideJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  /** Short human-readable (Vietnamese) status line for the button/progress UI. */
  message: string;
  /** How many descriptions this run accepted so far (updates as chunks land). */
  generated: number;
  /** How many candidate descriptions this run rejected (validation failed). */
  rejected: number;
  /** How many components are still missing a description AFTER this run
   *  (capped at 60/click) — > 0 means "bấm tiếp" is still useful. */
  remaining: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** WP21a: per-component live status for this round — optional so older
   *  daemon builds (or a client reading a job that predates this field) stay
   *  compatible; see `FigmaDesignSystemGuideJobItem`. */
  items?: FigmaDesignSystemGuideJobItem[];
  /** WP21a: number of components still missing a description outside the cap
   *  of THIS round — only meaningful for the capped dr-comp catch-up round
   *  (cap 60); the "Sinh mô tả" button run has no cap (generates every
   *  missing component in one click, per the 2026-08-20 decision), so this
   *  is absent/0 there. Optional for the same reason as `items`. See
   *  `.tmp/pipeline/wp21-contract.md` mục 2. */
  remainingAfterCap?: number;
}

export interface GenerateFigmaDesignSystemGuideResponse {
  jobId: string;
  job: FigmaDesignSystemGuideJob;
}

export interface FigmaDesignSystemRefreshChanges {
  previousComponentCount: number;
  currentComponentCount: number;
  addedComponents: number;
  removedComponents: number;
  changedComponents: number;
  unchangedComponents: number;
}

export interface RefreshFigmaDesignSystemSourceResponse {
  source: FigmaDesignSystemSource;
  changes: FigmaDesignSystemRefreshChanges;
}

/** WP21a: `GET /api/figma-design-systems/:id/components` — a structured,
 *  per-component view of the source's catalog for the source detail page
 *  (replaces trying to render the closed `components.md`/`components-guide.md`
 *  Markdown documents directly, which doesn't scale past a few hundred
 *  components). `description` is already merged with the shared guide
 *  (verbatim — no "(AI sinh)" suffix); `descriptionSource` tells the UI where
 *  it came from. See `.tmp/pipeline/wp21-contract.md` mục 1. */
export interface FigmaDesignSystemComponentItem {
  anchor: string;
  name: string;
  nodeId: string;
  fileKey: string;
  fileName: string;
  page?: string;
  description?: string;
  descriptionSource: 'figma' | 'ai' | 'none';
  properties: { name: string; type: string; values: string[] }[];
}

/** Ordered the same as the frozen catalog snapshot (file → component) —
 *  callers must NOT re-sort; see `FigmaDesignSystemComponentItem`. */
export interface ListFigmaDesignSystemComponentsResponse {
  components: FigmaDesignSystemComponentItem[];
}
