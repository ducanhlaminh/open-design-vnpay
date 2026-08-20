// Figma Personal Access Token store + link verification contract.
//
// The docs-review "Screen → Component" stage can read its component catalogue
// straight from 1–5 Figma files (see `DocsReviewComponentSource`). That read
// is a deterministic daemon-side REST call (`GET /v1/files/:key`, `/nodes`)
// authenticated with a Figma Personal Access Token — no agent, no MCP server,
// no Figma Desktop process involved. This is the token's own small store,
// mirroring `confluence-config.ts` (the docs stages already work this way for
// Confluence); it is deliberately separate from the generic external-MCP
// config in `mcp.ts`.

export interface FigmaConfigResponse {
  /** Whether a token is currently saved — the real value never round-trips
   *  back to the client. */
  hasToken: boolean;
}

export interface PutFigmaConfigRequest {
  /** New token to save. Empty/omitted keeps the previously saved token
   *  (the UI shows a "•••• saved" placeholder rather than the real value). */
  token?: string;
  /** Explicitly forget the saved token. */
  clear?: boolean;
}

export interface TestFigmaConfigRequest {
  /** Empty/omitted tests the already-saved token instead of a fresh one. */
  token?: string;
}

export interface TestFigmaConfigResponse {
  ok: boolean;
  /** Human-readable failure reason, or a network/timeout message. */
  detail?: string;
  /** Figma handle / email of the token owner on success (`GET /v1/me`). */
  handle?: string;
  email?: string;
}

export interface VerifyFigmaLinksRequest {
  links: Array<{ url: string; fileKey: string; nodeId?: string }>;
  /** Empty/omitted verifies with the already-saved token. */
  token?: string;
}

/** Outcome of `GET /v1/files/:key?depth=1` for one configured link. */
export interface FigmaLinkVerification {
  fileKey: string;
  url: string;
  ok: boolean;
  /** File name as Figma reports it. */
  name?: string;
  /** Number of catalogue entries the file would contribute: component sets
   *  plus standalone components that belong to THIS file (remote library
   *  components used by the file are not counted). */
  componentCount?: number;
  /** Set when the file itself defines no components but uses components from
   *  other libraries — the user most likely pasted a product file instead of
   *  the design-system file. */
  remoteOnly?: boolean;
  /** Human-readable failure reason (403 no access, 404 not found, timeout…). */
  detail?: string;
}

export interface VerifyFigmaLinksResponse {
  hasToken: boolean;
  links: FigmaLinkVerification[];
}

/** App-level Figma component catalogue (`GET/POST
 *  /api/pipelines/apps/:appId/figma-catalog[/refresh]`) — what the App's DS
 *  tab shows when the component source is Figma links. Read by the daemon
 *  from the same REST snapshot the dr-comp preparation phase produces. */
export interface AppFigmaCatalogFile {
  fileKey: string;
  name: string;
  url: string;
  componentCount: number;
}
export interface AppFigmaCatalogResponse {
  /** null when the App's component source is not `figma-links`. */
  links: Array<{ url: string; fileKey: string; nodeId?: string }> | null;
  hasToken: boolean;
  /** null until the catalogue has been read at least once. */
  generatedAt: string | null;
  files: AppFigmaCatalogFile[];
  componentCount: number;
  /** Rendered `criteria/components.md` (closed catalogue format), or null. */
  markdown: string | null;
  /** Rendered `figma-catalog/components-guide.md` (WP19a — AI-generated
   *  fallback description guide, mirrors the closed catalogue format; see
   *  `figma-component-guide.ts`). Optional and omitted (not `null`) when the
   *  App has no guide yet, so responses for every project that predates this
   *  field stay byte-for-byte identical to before. */
  guideMarkdown?: string | null;
  /** WP19b coverage counts, computed from the snapshot + guide. Optional and
   *  omitted when there is no snapshot yet (`generatedAt == null`) — same
   *  "omit rather than send a zeroed shape" rule as `guideMarkdown`. Powers
   *  the DS tab's "X/Y component có mô tả · Z từ AI · N thiếu" line and the
   *  "Sinh mô tả (N thiếu)" button's N. */
  coverage?: AppFigmaCatalogCoverage;
}

/** WP19b: how many of an App's Figma components have a description, and
 *  where it came from. `described` counts BOTH a real Figma description and
 *  one filled in from `components-guide.md` (`fromGuide` is the subset of
 *  `described` that came from the guide, not an addition to it). */
export interface AppFigmaCatalogCoverage {
  total: number;
  described: number;
  fromGuide: number;
  missing: number;
}

/** WP19b: `POST /api/pipelines/apps/:appId/figma-catalog/generate-guide`
 *  background job status — same "queued → running → succeeded/failed" shape
 *  as the DS criteria-generation jobs it is modeled after (see
 *  `docs-review-enrich`/`ds-criteria` in the daemon), polled by
 *  `GET .../generate-guide/:jobId`. */
export interface AppFigmaGuideJob {
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

export interface GenerateAppFigmaGuideResponse {
  jobId: string;
  job: AppFigmaGuideJob;
}
