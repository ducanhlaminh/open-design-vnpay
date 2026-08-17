// Confluence credential storage contract — a small, dedicated store for the
// Confluence Personal Access Token used by the docs/prd-docs/dr-docs pipeline
// stages (deterministic REST fetch, no agent). The base URL is deployment
// configuration (CONFLUENCE_URL), returned read-only so the web can build the
// token-creation link. Deliberately
// separate from the generic external-MCP config (`packages/contracts/src/api/mcp.ts`):
// that framework serves OTHER MCP servers (GitHub, Filesystem, image-gen…)
// unrelated to Confluence, and WP8 removed the `mcp-atlassian` row it used to
// piggyback these creds on.

export interface ConfluenceConfigResponse {
  base: string;
  /** Whether a token is currently saved — the real value never round-trips
   *  back to the client. */
  hasToken: boolean;
}

export interface PutConfluenceConfigRequest {
  /** Empty/omitted keeps the previously saved token — the UI shows a
   *  "•••• saved" placeholder rather than the real value, so it only sends a
   *  new token when the user actually types one. */
  token?: string;
  /** Internal/admin escape hatch; the Settings UI does not expose deletion. */
  clear?: boolean;
}

export interface TestConfluenceConfigRequest {
  /** Empty/omitted tests the already-saved token instead of a fresh one. */
  token?: string;
}

export interface TestConfluenceConfigResponse {
  ok: boolean;
  /** Human-readable failure reason, or a network/timeout message. */
  detail?: string;
  /** Confluence's own displayName/username for the authenticated user, when the daemon can read it back from a successful probe. */
  displayName?: string;
}
