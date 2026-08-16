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
}
