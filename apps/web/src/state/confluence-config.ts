// Web client for the daemon's Confluence credential endpoints.
//
// Independent of the generic external-MCP config (`state/mcp.ts`) — WP8
// removed the `mcp-atlassian` MCP server; the Personal Access Token lives in
// its own store while the Confluence base URL is fixed by CONFLUENCE_URL.
// `GET /api/confluence-config` never returns the real token, only whether one
// is saved (`hasToken`).

import type {
  ConfluenceConfigResponse,
  PutConfluenceConfigRequest,
  TestConfluenceConfigRequest,
  TestConfluenceConfigResponse,
} from '@open-design/contracts';

export type {
  ConfluenceConfigResponse,
  PutConfluenceConfigRequest,
  TestConfluenceConfigRequest,
  TestConfluenceConfigResponse,
};

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

export async function testConfluenceConnection(
  body: TestConfluenceConfigRequest,
): Promise<TestConfluenceConfigResponse> {
  try {
    const res = await fetch('/api/confluence-config/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, detail: `Daemon responded with ${res.status}` };
    }
    return (await res.json()) as TestConfluenceConfigResponse;
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'Network request failed' };
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
