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
