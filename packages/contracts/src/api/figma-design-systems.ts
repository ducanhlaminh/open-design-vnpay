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
