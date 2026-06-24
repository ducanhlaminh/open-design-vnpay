// BAS MCP gateway client — pipeline 1 (jira-ingest) reads source documents from
// BAS via this client INSTEAD of the agent calling an MCP server. The daemon
// owns all BAS HTTP traffic (token never reaches the browser, no CORS), mirroring
// the theme-lab proxy. Transport is the BAS "Streamable HTTP MCP Gateway"
// (see the BAS OpenAPI: JSON-RPC 2.0 over `POST {url}` with a Bearer token).
//
// Two read paths feed the Pipelines UI's source-selection modal:
//   - Confluence link  → `confluence_fetch_page`            (link + metadata preview)
//   - BAS document     → `workspace_list_projects` / `kg_search_features` /
//                        `workspace_list_documents` / `workspace_get_document`
//
// Endpoint + token resolution (first hit wins):
//   1. env  BAS_MCP_URL + BAS_MCP_TOKEN
//   2. the daemon's external-MCP store (<dataDir>/mcp-config.json) — the http
//      server whose id is BAS_MCP_SERVER_ID (default "ba-agent"): its `url`
//      and `Authorization: Bearer …` header.
//
// NOTE: the BAS gateway was unreachable at authoring time (the configured Kong
// route 404s and no local :8090 was running), so the per-tool ARGUMENT names and
// RESULT shapes below are coded against the OpenAPI contract with tolerant
// parsing. If a live gateway names things differently, adjust `TOOL_ARGS` /
// the `pick*` mappers — they are deliberately the only places that assume shape.

import type {
  BasFeature,
  BasProject,
  ConfluencePageMeta,
  PipelineRunSource,
} from '@open-design/contracts';

import { readMcpConfig } from '../mcp-config.js';

export interface BasEndpoint {
  /** Full MCP endpoint URL, e.g. https://host/api/mcp/ */
  url: string;
  /** Bearer access token (without the "Bearer " prefix). */
  token: string;
}

const DEFAULT_SERVER_ID = process.env.BAS_MCP_SERVER_ID || 'ba-agent';

function stripBearer(v: string | undefined): string {
  return (v ?? '').replace(/^\s*Bearer\s+/i, '').trim();
}

// Resolve the BAS endpoint from env, else from the daemon's MCP server store.
// Returns null when nothing is configured — callers turn that into a clear
// "BAS is not configured" error so the UI can tell the user to set it up.
export async function resolveBasEndpoint(dataDir: string): Promise<BasEndpoint | null> {
  const envUrl = process.env.BAS_MCP_URL?.trim();
  const envToken = stripBearer(process.env.BAS_MCP_TOKEN);
  if (envUrl && envToken) return { url: envUrl, token: envToken };

  try {
    const cfg = await readMcpConfig(dataDir);
    const server =
      cfg.servers.find((s) => s.id === DEFAULT_SERVER_ID) ??
      cfg.servers.find((s) => /\bbas\b|ba-agent/i.test(s.id) || /\bbas\b/i.test(s.label ?? ''));
    if (server?.url) {
      const auth = server.headers?.['Authorization'] ?? server.headers?.['authorization'];
      const token = envToken || stripBearer(auth);
      if (token) return { url: server.url, token };
    }
  } catch {
    // mcp-config unreadable — fall through to "not configured".
  }
  return null;
}

interface RpcOk {
  jsonrpc: '2.0';
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// A streamable-HTTP MCP response is either a single JSON object or an SSE stream
// of `data: {json}` frames. Normalize both to the last/most-complete JSON-RPC
// envelope so callers don't care which framing the gateway chose.
function parseRpcBody(contentType: string, body: string): RpcOk {
  const isEventStream = /text\/event-stream/i.test(contentType) || /^\s*event:|^\s*data:/m.test(body);
  if (!isEventStream) {
    return JSON.parse(body) as RpcOk;
  }
  let last: RpcOk | null = null;
  for (const line of body.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m || !m[1] || m[1] === '[DONE]') continue;
    try {
      const obj = JSON.parse(m[1]) as RpcOk;
      // Prefer frames that carry a result/error (the actual response, not pings).
      if (obj && (obj.result !== undefined || obj.error !== undefined)) last = obj;
      else if (!last) last = obj;
    } catch {
      /* skip non-JSON keepalive frames */
    }
  }
  if (!last) throw new Error('BAS: empty event-stream response');
  return last;
}

// Minimal MCP client over streamable HTTP. One instance ≈ one session: it lazily
// runs the initialize handshake (capturing any Mcp-Session-Id) and reuses it for
// subsequent tool calls. Stateless gateways simply never return a session id.
export class BasClient {
  private sessionId: string | null = null;
  private initialized = false;
  private rpcId = 0;

  constructor(
    private readonly endpoint: BasEndpoint,
    private readonly timeoutMs = 30_000,
  ) {}

  private async post(payload: unknown): Promise<{ status: number; sessionId: string | null; body: RpcOk | null }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${this.endpoint.token}`,
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const text = await res.text();
      const ct = res.headers.get('content-type') ?? '';
      // 202 Accepted (notifications) has no body — that's fine.
      const body = text.trim() ? parseRpcBody(ct, text) : null;
      if (!res.ok) {
        const msg = body?.error?.message || `BAS HTTP ${res.status}: ${text.slice(0, 300)}`;
        throw new Error(msg);
      }
      return { status: res.status, sessionId: sid, body };
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.post({
        jsonrpc: '2.0',
        id: ++this.rpcId,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'open-design-daemon', version: '0' },
        },
      });
      // Best-effort initialized notification; gateways that don't need a session
      // ignore it. Failure here must not block a stateless tools/call.
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
    } catch {
      // Stateless gateway that rejects initialize — proceed; tools/call may work.
    }
    this.initialized = true;
  }

  // Call an MCP tool and return its decoded payload. The gateway wraps results
  // as `content[].text` where text is a JSON-serialized string (per the BAS
  // OpenAPI ToolContent); we concatenate text parts and JSON.parse them.
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ensureInitialized();
    const { body } = await this.post({
      jsonrpc: '2.0',
      id: ++this.rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (!body) throw new Error(`BAS: empty response for tool ${name}`);
    if (body.error) throw new Error(`BAS tool ${name} error: ${body.error.message}`);
    const result = body.result as
      | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
      | undefined;
    if (!result) throw new Error(`BAS: no result for tool ${name}`);
    const text = (result.content ?? [])
      .filter((c) => (c.type ?? 'text') === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('');
    if (result.isError) throw new Error(`BAS tool ${name} failed: ${text.slice(0, 400)}`);
    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Some tools return plain text (e.g. a markdown body) — hand it back raw.
      return text as unknown as T;
    }
  }
}

// ── shape-tolerant helpers ───────────────────────────────────────────────────
// The gateway result shapes aren't pinned by the OpenAPI (tool payloads are
// opaque JSON strings), so pull the array out from whichever common key holds it.

function asArray(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (payload && typeof payload === 'object') {
    for (const key of ['projects', 'features', 'documents', 'items', 'data', 'results', 'pages']) {
      const v = (payload as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function str(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

// Tool argument builders, isolated so a live-gateway arg-name mismatch is a
// one-line fix. snake_case mirrors the snake_case tool names in the OpenAPI.
const TOOL_ARGS = {
  features: (projectId: string) => ({ project_id: projectId, projectId }),
  documents: (projectId: string) => ({ project_id: projectId, projectId }),
  confluence: (ref: string) => ({ page: ref, page_id: ref, url: ref, ref }),
};

// ── high-level reads used by the routes + run-time prefetch ──────────────────

export async function basListProjects(ep: BasEndpoint): Promise<BasProject[]> {
  const client = new BasClient(ep);
  const payload = await client.callTool('workspace_list_projects', {});
  return asArray(payload).map((row) => ({
    id: str(row, 'id', 'project_id', 'projectId', 'key'),
    name: str(row, 'name', 'title', 'label') || str(row, 'id', 'project_id'),
    ...(str(row, 'description', 'summary') ? { description: str(row, 'description', 'summary') } : {}),
  })).filter((p) => p.id);
}

// Feature/document picker rows for a chosen BAS project. Tries KG features first
// (richer for UI), falls back to workspace documents — and merges both when the
// gateway returns each from a different tool.
export async function basListFeatures(ep: BasEndpoint, projectId: string): Promise<BasFeature[]> {
  const client = new BasClient(ep);
  const out: BasFeature[] = [];
  try {
    const feats = await client.callTool('kg_search_features', TOOL_ARGS.features(projectId));
    for (const row of asArray(feats)) {
      const id = str(row, 'id', 'feature_id', 'featureId', 'key');
      const title = str(row, 'title', 'name', 'summary') || id;
      if (id) out.push({ id, title, kind: 'feature', ...(str(row, 'summary', 'description') ? { summary: str(row, 'summary', 'description') } : {}) });
    }
  } catch {
    /* no KG features — try workspace documents below */
  }
  try {
    const docs = await client.callTool('workspace_list_documents', TOOL_ARGS.documents(projectId));
    for (const row of asArray(docs)) {
      const id = str(row, 'id', 'document_id', 'documentId', 'key');
      const title = str(row, 'title', 'name') || id;
      if (id && !out.some((f) => f.id === id)) {
        out.push({ id, title, kind: 'document', ...(str(row, 'summary', 'description') ? { summary: str(row, 'summary', 'description') } : {}) });
      }
    }
  } catch {
    /* workspace documents unavailable */
  }
  return out;
}

function plainExcerpt(html: string, max = 280): string {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export async function basConfluenceMeta(ep: BasEndpoint, ref: string): Promise<ConfluencePageMeta> {
  const client = new BasClient(ep);
  const payload = await client.callTool('confluence_fetch_page', TOOL_ARGS.confluence(ref));
  const row = (Array.isArray(payload) ? payload[0] : payload) as Record<string, unknown> | undefined;
  const p = row ?? {};
  const body = str(p, 'body', 'content', 'html', 'storage', 'markdown');
  return {
    id: str(p, 'id', 'page_id', 'pageId') || ref,
    title: str(p, 'title', 'name') || ref,
    ...(str(p, 'space', 'space_key', 'spaceKey') ? { space: str(p, 'space', 'space_key', 'spaceKey') } : {}),
    url: str(p, 'url', 'webui', 'link') || ref,
    ...(body ? { excerpt: plainExcerpt(body) } : {}),
  };
}

// ── run-time prefetch: resolve a PipelineRunSource → markdown files for cwd ───
// The daemon writes these under the project cwd BEFORE the agent run; jira-ingest
// then normalizes them. Returns cwd-relative paths so the caller just writes.
export interface SourceFile {
  relPath: string;
  content: string;
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'doc';
}

function frontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v.replace(/\n/g, ' ')}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

export async function fetchSourceFiles(ep: BasEndpoint, source: PipelineRunSource): Promise<SourceFile[]> {
  const client = new BasClient(ep);
  if (source.kind === 'confluence') {
    const payload = await client.callTool('confluence_fetch_page', TOOL_ARGS.confluence(source.ref));
    const row = (Array.isArray(payload) ? payload[0] : payload) as Record<string, unknown> | undefined;
    const p = row ?? {};
    const title = str(p, 'title', 'name') || source.ref;
    const body = str(p, 'markdown', 'body', 'content', 'html', 'storage');
    const isHtml = /<[a-z][\s\S]*>/i.test(body);
    const content =
      frontmatter({
        title,
        page_id: str(p, 'id', 'page_id', 'pageId') || source.ref,
        url: str(p, 'url', 'webui', 'link') || source.ref,
        source: 'confluence',
      }) + (isHtml ? plainExcerpt(body, 1_000_000) : body);
    return [{ relPath: `docs/source/confluence/${slug(title)}.md`, content }];
  }

  // BAS documents/features → one markdown file each.
  const files: SourceFile[] = [];
  const docIds = source.documentIds ?? [];
  const featIds = source.featureIds ?? [];
  for (const id of docIds) {
    try {
      const doc = await client.callTool('workspace_get_document', { id, document_id: id, project_id: source.projectId });
      const p = (Array.isArray(doc) ? doc[0] : doc) as Record<string, unknown> | undefined ?? {};
      const title = str(p, 'title', 'name') || id;
      const body = str(p, 'markdown', 'body', 'content', 'text');
      files.push({
        relPath: `docs/source/bas/${slug(title)}.md`,
        content: frontmatter({ title, document_id: id, project_id: source.projectId, source: 'bas' }) + body,
      });
    } catch (err) {
      files.push({ relPath: `docs/source/bas/${slug(id)}.md`, content: `# ${id}\n\n> BAS document fetch failed: ${String((err as Error).message)}\n` });
    }
  }
  for (const id of featIds) {
    try {
      const feat = await client.callTool('kg_get_feature_detail', { id, feature_id: id, project_id: source.projectId });
      const p = (Array.isArray(feat) ? feat[0] : feat) as Record<string, unknown> | undefined ?? {};
      const title = str(p, 'title', 'name', 'summary') || id;
      const body = str(p, 'markdown', 'body', 'content', 'description', 'detail');
      files.push({
        relPath: `docs/source/bas/feature-${slug(id)}.md`,
        content: frontmatter({ title, feature_id: id, project_id: source.projectId, source: 'bas' }) + body,
      });
    } catch (err) {
      files.push({ relPath: `docs/source/bas/feature-${slug(id)}.md`, content: `# ${id}\n\n> BAS feature fetch failed: ${String((err as Error).message)}\n` });
    }
  }
  if (files.length === 0) {
    throw new Error('BAS source has no documentIds or featureIds selected');
  }
  return files;
}
