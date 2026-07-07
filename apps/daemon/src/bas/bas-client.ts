// BAS MCP gateway client — pipeline 1 (jira-ingest) reads source documents from
// BAS via this client INSTEAD of the agent calling an MCP server. The daemon
// owns all BAS HTTP traffic (token never reaches the browser, no CORS), mirroring
// the theme-lab proxy. Transport is the BAS "Streamable HTTP MCP Gateway"
// (see the BAS OpenAPI: JSON-RPC 2.0 over `POST {url}` with a Bearer token).
//
// Two read paths feed the Pipelines UI's source-selection modal:
//   - Confluence link → `confluence_fetch_page` (BE extracts the page_id from the
//     link). Requires the BAS account behind the token to have a linked
//     Confluence credential, else the tool returns "tool execution failed".
//   - BAS document → the KG tools: `kg_list_documents` (documents),
//     `kg_get_document_subgraph` (a document's FEATURE nodes), and
//     `kg_get_feature_detail` (one feature's full content). The gateway exposes
//     NO project→feature link, so the KG document is the pickable unit.
//
// Endpoint + token resolution (first hit wins):
//   1. env  BAS_MCP_URL + BAS_MCP_TOKEN
//   2. the daemon's external-MCP store (<dataDir>/mcp-config.json) — the http
//      server whose id is BAS_MCP_SERVER_ID (default "ba-agent"): its `url`
//      and `Authorization: Bearer …` header.
//
// Tool arg names + result shapes below are verified against the live gateway
// (mcp-gateway-service 0.1.0). All tool inputSchemas are `additionalProperties:
// false`, so the arg builders send ONLY the declared keys.

import type {
  BasDocument,
  BasFeature,
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

// ── shape helpers (verified against the live gateway) ────────────────────────

function asArray(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (payload && typeof payload === 'object') {
    for (const key of ['documents', 'features', 'nodes', 'items', 'data', 'results']) {
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

// Pull a Confluence numeric page_id out of a pasted link (…/pages/<id>/… or
// ?pageId=<id>) or accept a bare numeric id. Throws with guidance otherwise —
// confluence_fetch_page requires page_id, not a URL.
export function extractPageId(ref: string): string {
  const t = ref.trim();
  if (/^\d+$/.test(t)) return t;
  const m = /\/pages\/(\d+)/.exec(t) ?? /[?&]pageId=(\d+)/.exec(t);
  if (m) return m[1]!;
  throw new Error(
    `Could not find a Confluence page id in "${ref}". Paste the page URL (…/pages/<id>/…) or the numeric page id.`,
  );
}

// ── Confluence page search (modal Run pipeline 1 — picker "tìm trang theo
// tên" như bên pipeline-studio) ──────────────────────────────────────────────

export interface ConfluencePageHit {
  id: string;
  title: string;
  url?: string;
  space?: string;
}

export interface ConfluenceCreds {
  base: string;
  token: string;
}

/**
 * Confluence PAT cho picker tìm trang — MỘT chỗ config duy nhất với agent:
 *   ① per-user: Settings → MCP servers → server `mcp-atlassian` (env
 *      CONFLUENCE_URL + CONFLUENCE_PERSONAL_TOKEN — chính là creds agent dùng
 *      khi chạy pipeline, user sửa được trong UI);
 *   ② fallback: env của daemon (CONFLUENCE_URL/_PERSONAL_TOKEN — deploy-wide).
 */
export async function resolveConfluenceCreds(dataDir: string): Promise<ConfluenceCreds | null> {
  try {
    const cfg = await readMcpConfig(dataDir);
    const server =
      cfg.servers.find((s) => s.id === 'mcp-atlassian') ??
      cfg.servers.find((s) => /atlassian/i.test(s.id) || /atlassian/i.test(s.label ?? ''));
    const env = (server?.env ?? {}) as Record<string, string>;
    const base = (env.CONFLUENCE_URL ?? '').trim().replace(/\/+$/, '');
    const token = (env.CONFLUENCE_PERSONAL_TOKEN ?? '').trim();
    if (base && token) return { base, token };
  } catch {
    /* mcp-config unreadable — fall through to env */
  }
  const base = (process.env.CONFLUENCE_URL ?? '').trim().replace(/\/+$/, '');
  const token = (process.env.CONFLUENCE_PERSONAL_TOKEN ?? '').trim();
  return base && token ? { base, token } : null;
}

/**
 * Tìm trang Confluence theo tiêu đề. Hai đường, ưu tiên theo thứ tự:
 *   ① PAT trực tiếp (env CONFLUENCE_URL + CONFLUENCE_PERSONAL_TOKEN — CQL
 *      `title~`, verified live với wiki.servicehub.vn);
 *   ② BAS gateway `confluence_search` (credential Confluence link với tài
 *      khoản BAS đứng sau token) khi `ep` khả dụng.
 * Cả hai đều thiếu → throw message cấu hình rõ ràng.
 */
export async function searchConfluencePages(
  ep: BasEndpoint | null,
  q: string,
  limit = 25,
  creds: ConfluenceCreds | null = null,
): Promise<ConfluencePageHit[]> {
  if (creds) {
    const cql = `type=page AND title~"${q.replace(/["\\]/g, ' ').trim()}" order by lastmodified desc`;
    const url = `${creds.base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${Math.min(Math.max(limit, 1), 50)}&expand=space`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${creds.token}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Confluence search HTTP ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as {
      results?: Array<{
        id?: string;
        title?: string;
        space?: { key?: string };
        _links?: { webui?: string };
      }>;
    };
    return (body.results ?? [])
      .map((r) => ({
        id: String(r.id ?? ''),
        title: r.title ?? String(r.id ?? ''),
        ...(r._links?.webui ? { url: `${creds.base}${r._links.webui}` } : {}),
        ...(r.space?.key ? { space: r.space.key } : {}),
      }))
      .filter((r) => r.id);
  }
  if (!ep) {
    throw new Error(
      'Tìm trang Confluence chưa cấu hình — thêm CONFLUENCE_URL + CONFLUENCE_PERSONAL_TOKEN vào server mcp-atlassian trong Settings → MCP (hoặc env daemon / BAS gateway).',
    );
  }
  const client = new BasClient(ep);
  const payload = await client.callTool('confluence_search', { query: q, limit: Math.min(Math.max(limit, 1), 50) });
  return asArray(payload)
    .map((row) => {
      const links = (row._links ?? {}) as Record<string, unknown>;
      const id = str(row, 'page_id', 'id', 'content_id');
      const title = str(row, 'title', 'label', 'name');
      const url = str(row, 'url', 'webui', 'link') || (typeof links.webui === 'string' ? links.webui : '');
      const space = str(row, 'space_key', 'space');
      return { id, title: title || id, ...(url ? { url } : {}), ...(space ? { space } : {}) };
    })
    .filter((r) => r.id);
}

// ── high-level reads used by the routes + run-time prefetch ──────────────────

// Top level of the BAS picker: the KG documents (kg_list_documents returns
// `{document_id, node_count, edge_count, last_updated}` rows).
export async function basListDocuments(ep: BasEndpoint): Promise<BasDocument[]> {
  const client = new BasClient(ep);
  const payload = await client.callTool('kg_list_documents', {});
  return asArray(payload)
    .map((row) => {
      const id = str(row, 'document_id', 'id');
      const label = str(row, 'label', 'name', 'title');
      const nodeCount = typeof row.node_count === 'number' ? (row.node_count as number) : undefined;
      const updatedAt = str(row, 'last_updated', 'updated_at');
      return {
        id,
        ...(label ? { label } : {}),
        ...(nodeCount !== undefined ? { nodeCount } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      };
    })
    .filter((d) => d.id);
}

// Second level: the FEATURE nodes of one KG document. kg_get_document_subgraph
// returns `{nodes:[{type, reference_id, summary, description, …}]}`; FEATURE
// nodes carry the feature_id in `reference_id` and the name in `summary`.
export async function basListFeatures(ep: BasEndpoint, documentId: string): Promise<BasFeature[]> {
  const client = new BasClient(ep);
  const payload = await client.callTool('kg_get_document_subgraph', {
    document_id: documentId,
    include_edges: false,
  });
  const nodes = asArray((payload as Record<string, unknown>)?.nodes ?? payload);
  const out: BasFeature[] = [];
  for (const n of nodes) {
    if (str(n, 'type') !== 'FEATURE') continue;
    const id = str(n, 'reference_id') || str(n, 'id');
    const name = str(n, 'summary', 'name') || id;
    if (!id) continue;
    const summary = str(n, 'description');
    out.push({ id, name, documentId, ...(summary ? { summary } : {}) });
  }
  return out;
}

function plainExcerpt(text: string, max = 280): string {
  const clean = text
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

export async function basConfluenceMeta(ep: BasEndpoint, ref: string): Promise<ConfluencePageMeta> {
  const client = new BasClient(ep);
  const pageId = extractPageId(ref);
  const payload = await client.callTool('confluence_fetch_page', { page_id: pageId, format: 'markdown' });
  const p = (Array.isArray(payload) ? payload[0] : payload) as Record<string, unknown> | undefined ?? {};
  const body = str(p, 'markdown', 'content', 'body', 'storage', 'view');
  return {
    id: str(p, 'page_id', 'id') || pageId,
    title: str(p, 'title', 'name') || `Confluence page ${pageId}`,
    ...(str(p, 'space_key', 'space', 'spaceKey') ? { space: str(p, 'space_key', 'space', 'spaceKey') } : {}),
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

function titleCase(t: string): string {
  return t.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Render a list of KG nodes (each `{summary, description}`) as a markdown bullet
// list under a heading. Empty arrays render nothing.
function renderNodeList(heading: string, nodes: unknown): string {
  const arr = Array.isArray(nodes) ? (nodes as Array<Record<string, unknown>>) : [];
  if (arr.length === 0) return '';
  const lines = arr.map((n) => {
    const s = str(n, 'summary', 'name', 'title');
    const d = str(n, 'description', 'detail');
    return d ? `- **${s || 'Item'}** — ${d}` : `- ${s || 'Item'}`;
  });
  return `\n## ${heading}\n${lines.join('\n')}\n`;
}

// kg_get_feature_detail → one self-contained markdown doc for the feature.
function renderFeatureDetail(p: Record<string, unknown>, fallbackId: string): { name: string; md: string } {
  const name = str(p, 'feature_name', 'name', 'summary') || str(p, 'feature_id') || fallbackId;
  let md = `# ${name}\n`;
  const summary = str(p, 'summary', 'description');
  if (summary) md += `\n${summary}\n`;
  md += renderNodeList('Feature details', p.feature_details);
  md += renderNodeList('Business rules', p.business_rules);
  md += renderNodeList('Acceptance criteria', p.acceptance_criteria);
  md += renderNodeList('User flows', p.user_flows);
  md += renderNodeList('UI screens', p.ui_screens);
  md += renderNodeList('Permissions', p.permissions);
  md += renderNodeList('Non-functional', p.non_functional);
  md += renderNodeList('Additional', p.additional_nodes);
  return { name, md };
}

// kg_get_document_subgraph → markdown grouping every node by type (used when the
// user ingests a whole document without picking individual features).
function renderDocumentSubgraph(payload: unknown): string {
  const nodes = asArray((payload as Record<string, unknown>)?.nodes ?? payload);
  if (nodes.length === 0) return '> (empty document subgraph)\n';
  const byType = new Map<string, Array<Record<string, unknown>>>();
  for (const n of nodes) {
    const t = str(n, 'type') || 'NODE';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(n);
  }
  const order = ['FEATURE', 'FEATURE_DETAIL', 'BUSINESS_RULE', 'ACCEPTANCE_CRITERIA', 'USER_FLOW', 'UI_SCREEN', 'PERMISSION', 'NON_FUNCTIONAL'];
  const rank = (t: string) => (order.indexOf(t) < 0 ? 99 : order.indexOf(t));
  let md = '';
  for (const t of [...byType.keys()].sort((a, b) => rank(a) - rank(b))) {
    md += renderNodeList(titleCase(t), byType.get(t));
  }
  return md;
}

export async function fetchSourceFiles(ep: BasEndpoint, source: PipelineRunSource): Promise<SourceFile[]> {
  const client = new BasClient(ep);
  if (source.kind === 'confluence') {
    const pageId = extractPageId(source.ref);
    const payload = await client.callTool('confluence_fetch_page', { page_id: pageId, format: 'markdown' });
    const p = (Array.isArray(payload) ? payload[0] : payload) as Record<string, unknown> | undefined ?? {};
    const title = str(p, 'title', 'name') || `Confluence page ${pageId}`;
    const body = str(p, 'markdown', 'content', 'body', 'storage', 'view');
    const content =
      frontmatter({
        title,
        page_id: pageId,
        url: str(p, 'url', 'webui', 'link') || source.ref,
        source: 'confluence',
      }) + (body || '> (empty page body)\n');
    return [{ relPath: `docs/source/confluence/${slug(title)}.md`, content }];
  }

  // BAS: KG document → selected feature(s), else the whole document subgraph.
  const files: SourceFile[] = [];
  const featIds = source.featureIds ?? [];
  if (featIds.length > 0) {
    for (const fid of featIds) {
      try {
        const feat = await client.callTool('kg_get_feature_detail', {
          document_id: source.documentId,
          feature_id: fid,
        });
        const p = (Array.isArray(feat) ? feat[0] : feat) as Record<string, unknown> | undefined ?? {};
        const { name, md } = renderFeatureDetail(p, fid);
        files.push({
          relPath: `docs/source/bas/feature-${slug(fid)}.md`,
          content: frontmatter({ title: name, feature_id: fid, document_id: source.documentId, source: 'bas' }) + md,
        });
      } catch (err) {
        files.push({
          relPath: `docs/source/bas/feature-${slug(fid)}.md`,
          content: `# ${fid}\n\n> BAS feature fetch failed: ${String((err as Error).message)}\n`,
        });
      }
    }
  } else {
    const payload = await client.callTool('kg_get_document_subgraph', { document_id: source.documentId });
    files.push({
      relPath: `docs/source/bas/${slug(source.documentId)}.md`,
      content:
        frontmatter({ title: source.documentId, document_id: source.documentId, source: 'bas' }) +
        renderDocumentSubgraph(payload),
    });
  }
  if (files.length === 0) throw new Error('BAS source produced no files');
  return files;
}
