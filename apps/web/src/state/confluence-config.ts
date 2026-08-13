// Web client for the daemon's Confluence credential endpoints.
//
// Independent of the generic external-MCP config (`state/mcp.ts`) — WP8
// removed the `mcp-atlassian` MCP server; the Confluence base URL + Personal
// Access Token now live in their own store (`<dataDir>/confluence-config.json`).
// `GET /api/confluence-config` never returns the real token, only whether one
// is saved (`hasToken`).

import type { ConfluenceConfigResponse, PutConfluenceConfigRequest } from '@open-design/contracts';

export type { ConfluenceConfigResponse, PutConfluenceConfigRequest };

export async function fetchConfluenceConfig(): Promise<ConfluenceConfigResponse | null> {
  try {
    const res = await fetch('/api/confluence-config');
    if (!res.ok) return null;
    const data = (await res.json()) as ConfluenceConfigResponse;
    return { base: data?.base ?? '', hasToken: Boolean(data?.hasToken) };
  } catch {
    return null;
  }
}

export async function saveConfluenceConfig(
  body: PutConfluenceConfigRequest,
): Promise<ConfluenceConfigResponse | null> {
  try {
    const res = await fetch('/api/confluence-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ConfluenceConfigResponse;
    return { base: data?.base ?? '', hasToken: Boolean(data?.hasToken) };
  } catch {
    return null;
  }
}
