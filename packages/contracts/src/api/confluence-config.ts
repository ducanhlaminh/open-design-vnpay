// Confluence credential storage contract — a small, dedicated store for the
// Confluence base URL + Personal Access Token used by the docs/prd-docs/
// dr-docs pipeline stages (deterministic REST fetch, no agent). Deliberately
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
  base: string;
  /** Empty/omitted keeps the previously saved token — the UI shows a
   *  "•••• saved" placeholder rather than the real value, so it only sends a
   *  new token when the user actually types one. */
  token?: string;
}
