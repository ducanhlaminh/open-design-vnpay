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

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  BasDocument,
  BasFeature,
  ConfluencePageMeta,
  PipelineRunSource,
} from '@open-design/contracts';

import { readMcpConfig } from '../mcp-config.js';
import { renderDrawioPages, splitMxfilePages } from './drawio-render.js';

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

/** One descendant page of a scan seed: its id/title plus the folder path
 *  (ancestor titles BELOW the seed, seed excluded) so the docs stage can mirror
 *  the wiki hierarchy under ./docs/confluence. */
export interface DescendantPage {
  pageId: string;
  title: string;
  /** Ancestor titles strictly between the seed and this page, top→down. */
  treePath: string[];
}

/** Every page in the sub-tree under `seedPageId` (all levels), via CQL
 *  `ancestor=<id>` with `expand=ancestors` so each result carries its full
 *  path (used to rebuild folder structure relative to the seed). Direct-PAT
 *  only — the gateway has no equivalent subtree query. Paginated; hard-stops
 *  at `hardCap` results so a pathological tree can't run away (the caller's
 *  soft warning fires well before this). */
export async function listDescendantPages(
  creds: ConfluenceCreds,
  seedPageId: string,
  hardCap = 500,
): Promise<DescendantPage[]> {
  const out: DescendantPage[] = [];
  let start = 0;
  const pageSize = 100;
  for (;;) {
    const cql = `ancestor=${seedPageId}`;
    const url = `${creds.base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${pageSize}&start=${start}&expand=ancestors`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${creds.token}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Confluence subtree search HTTP ${res.status} for ${seedPageId}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as {
      results?: Array<{ id?: string; title?: string; ancestors?: Array<{ id?: string; title?: string }> }>;
      size?: number;
    };
    const results = body.results ?? [];
    for (const r of results) {
      const pageId = String(r.id ?? '');
      if (!pageId) continue;
      // ancestors is root→page; keep only the segment strictly below the seed.
      const anc = r.ancestors ?? [];
      const seedIdx = anc.findIndex((a) => String(a.id ?? '') === seedPageId);
      const below = seedIdx >= 0 ? anc.slice(seedIdx + 1) : anc;
      out.push({
        pageId,
        title: r.title ?? pageId,
        treePath: below.map((a) => a.title ?? String(a.id ?? '')).filter(Boolean),
      });
      if (out.length >= hardCap) return out;
    }
    if (results.length < pageSize) break;
    start += pageSize;
  }
  return out;
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

/** Strip Vietnamese diacritics to ASCII so a title slugs to readable words
 *  ("Danh mục" → "Danh muc") instead of dash-shredding each accented letter
 *  ("Danh-m-c"). NFD decomposes tone marks off the base letter; đ/Đ don't
 *  decompose so they're mapped explicitly. */
function deaccentVietnamese(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

function slug(s: string): string {
  return deaccentVietnamese(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'doc';
}

// Source-order comparison for doc titles/segments. Confluence pages are
// numbered "I. …" (roman sections) / "1.", "2.2.3." (arabic sub-pages); a plain
// string sort mangles that (IX before V, "10" before "2"). Compare each segment
// by its leading numbering token so the file order + _index match the sidebar.
function romanToInt(s: string): number {
  const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  let prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = map[s[i]!] ?? 0;
    if (v < prev) total -= v;
    else { total += v; prev = v; }
  }
  return total;
}
function segNumbering(seg: string): number[] | null {
  const m = /^([IVXLCDM]+|\d+(?:\.\d+)*)(?=[.\-\s]|$)/.exec(seg.trim());
  if (!m) return null;
  const tok = m[1]!;
  return /^[IVXLCDM]+$/.test(tok) ? [romanToInt(tok)] : tok.split('.').map(Number);
}
/** Compare two segment lists (folder path + title) in wiki source order. */
export function naturalSegsCompare(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const sa = a[i] ?? '';
    const sb = b[i] ?? '';
    if (sa === sb) continue;
    const ka = segNumbering(sa);
    const kb = segNumbering(sb);
    if (ka && kb) {
      for (let j = 0; j < Math.max(ka.length, kb.length); j++) {
        const d = (ka[j] ?? 0) - (kb[j] ?? 0);
        if (d !== 0) return d;
      }
    } else if (ka && !kb) return -1;
    else if (!ka && kb) return 1;
    const c = sa.localeCompare(sb);
    if (c !== 0) return c;
  }
  return 0;
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

/** Whether `ref` resolves to a Confluence page id (URL carrying /pages/<id>/ or
 * ?pageId=<id>, or a bare numeric id). Gate for the docs stage's DETERMINISTIC
 * (no-agent) path: input made only of such refs never touches an LLM. */
export function looksLikeConfluenceRef(ref: string): boolean {
  try {
    extractPageId(ref);
    return true;
  } catch {
    return false;
  }
}

/** One deterministically-fetched Confluence page, ready to write into the docs
 * stage's output tree. `relPath` is unique across the batch (slug collisions
 * get the page id suffixed). */
export interface ConfluenceDocPage {
  pageId: string;
  title: string;
  url: string;
  relPath: string;
  content: string;
  /** true → not user-picked: auto-fetched because a seed page links to it. */
  linked?: boolean;
  /** true → auto-fetched as a sub-tree page under a seed (folder-structured);
   *  distinct from `linked` (hyperlink reference). */
  viaTree?: boolean;
}

/** Minimal HTML → Markdown for Confluence `body.view` (rendered HTML). No
 * dependency on purpose: headings, lists, tables (pipe rows), links, inline
 * code/bold/italic, code blocks; everything else strips to text. Downstream
 * consumers are agents + the studio doc viewer — rough-but-clean markdown is
 * exactly enough. */
// Named entities Confluence actually emits (Latin-1 letters cover the bulk of
// Vietnamese accents — ê/à/ó/…; everything beyond Latin-1 arrives as numeric
// entities, handled generically below).
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  yacute: 'ý', yuml: 'ÿ', ccedil: 'ç', ntilde: 'ñ',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', Ccedil: 'Ç', Ntilde: 'Ñ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', ndash: '–', mdash: '—',
  rarr: '→', larr: '←', bull: '•', middot: '·', deg: '°', times: '×', divide: '÷',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', sect: '§', para: '¶',
};

// VNPAY fork: this is the DETERMINISTIC docs path (a Confluence page URL
// pasted directly into the docs stage — runDocsDeterministic in server.ts).
// The agent-run JIRA-key path has its own, separate image-download logic
// (skills/jira-ingest/scripts/confluence_export.py's localize_images) — the
// two never share code, so both need the same fix independently.
// Match the REAL `src=` attribute, NOT `data-image-src=`. Confluence renders an
// embedded screenshot as `<img … src="/download/attachments/…" data-image-src=
// "/download/attachments/…">` — a GREEDY `[^>]*` would let `\bsrc=` bind to the
// LAST occurrence (`data-image-src`), so localization rewrote that attribute and
// left the real `src` pointing at the un-localized Confluence URL → htmlToMarkdown
// then dropped the image (prefix mismatch). Non-greedy `[^>]*?` + a negative
// lookbehind (`src` not preceded by `-`/word char, i.e. not `data-image-src`)
// binds to the real, first `src`. draw.io previews (single-`src` <img>) were
// unaffected, which is why only they survived before this fix.
const IMG_SRC_RE = /(<img\b[^>]*?(?<![-\w])src=["'])([^"']+)(["'])/gi;

function resolveImgUrl(base: string, src: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return `${base}${src}`;
  return `${base}/${src}`;
}

function isSameHost(base: string, url: string): boolean {
  try {
    return new URL(base).host === new URL(url).host;
  } catch {
    return false;
  }
}

function sanitizeImageFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120) || 'image';
}

async function downloadConfluenceBinary(creds: ConfluenceCreds, url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${creds.token}` } });
  if (!res.ok) throw new Error(`image download HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Download every same-host <img src> in html into attachmentsDir, rewriting
 *  src to a path relative to the page's .md so the exported Markdown carries
 *  real images instead of Confluence-authenticated URLs that break outside a
 *  logged-in session. Images from other hosts (external CDNs, emoji sprites)
 *  and data: URIs are left untouched. Best-effort per image — one download
 *  failing must not fail the whole page. */
async function localizeConfluenceImages(
  creds: ConfluenceCreds,
  html: string,
  attachmentsDir: string,
  relPrefix: string,
): Promise<{ html: string; count: number }> {
  const rawSrcs = new Set<string>();
  for (const m of html.matchAll(IMG_SRC_RE)) rawSrcs.add(m[2]!);
  const localBySrc = new Map<string, string>();
  const downloadedByUrl = new Map<string, string>();
  let count = 0;
  for (const src of rawSrcs) {
    if (src.startsWith('data:')) continue;
    // Skip already-local refs (e.g. multi-page draw.io pages rendered straight
    // into attachments/): only absolute URLs and root-relative Confluence paths
    // (`/download/…`) get downloaded.
    if (!/^https?:\/\//i.test(src) && !src.startsWith('/')) continue;
    const url = resolveImgUrl(creds.base, src);
    if (!isSameHost(creds.base, url)) continue;
    let localName = downloadedByUrl.get(url);
    if (!localName) {
      try {
        const data = await downloadConfluenceBinary(creds, url);
        const rawName = sanitizeImageFileName(
          decodeURIComponent(path.basename(new URL(url).pathname)) || 'image',
        );
        await fs.mkdir(attachmentsDir, { recursive: true });
        let candidate = rawName;
        let n = 1;
        for (;;) {
          const existing = await fs.readFile(path.join(attachmentsDir, candidate)).catch(() => null);
          if (!existing) break;
          if (existing.equals(data)) break;
          const ext = path.extname(rawName);
          const stem = path.basename(rawName, ext);
          candidate = `${stem}-${n}${ext}`;
          n += 1;
        }
        const alreadyThere = await fs.readFile(path.join(attachmentsDir, candidate)).catch(() => null);
        if (!alreadyThere) {
          await fs.writeFile(path.join(attachmentsDir, candidate), data);
          count += 1;
        }
        localName = candidate;
        downloadedByUrl.set(url, localName);
      } catch (err) {
        console.warn(`[bas] image download failed (${url}):`, err);
        continue;
      }
    }
    localBySrc.set(src, `${relPrefix}/${localName}`);
  }
  const out = html.replace(IMG_SRC_RE, (full, prefix: string, src: string, suffix: string) => {
    const local = localBySrc.get(src);
    return local ? `${prefix}${local}${suffix}` : full;
  });
  return { html: out, count };
}

/** Confluence draw.io macros render client-side — body.view carries NO <img>,
 * just a JS mount div plus a base64 JSON blob (`data-diagramdata`) that names
 * the server-rendered PNG preview attachment (`previewName` under
 * `owningPageId`). Rewrite each macro block into a real same-host
 * `<img src="<base>/download/attachments/<pageId>/<previewName>">` BEFORE
 * image localization, so the normal download-and-rewrite path ships the
 * diagram into `attachments/` like any other image. A macro whose data can't
 * be parsed is stripped whole — its hidden title div otherwise leaks junk
 * text ("Untitled Diagram-…") into the markdown. */
export function inlineDrawioPreviews(html: string, base: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const markerIdx = html.indexOf('data-macro-name="drawio"', cursor);
    if (markerIdx === -1) break;
    const start = html.lastIndexOf('<div', markerIdx);
    if (start === -1 || start < cursor) {
      out += html.slice(cursor, markerIdx + 1);
      cursor = markerIdx + 1;
      continue;
    }
    // Balanced <div> scan from the macro's opening tag to its matching close —
    // the block nests several inner divs, a lazy regex would cut it short.
    const tagRe = /<\/?div\b[^>]*>/gi;
    tagRe.lastIndex = start;
    let depth = 0;
    let end = -1;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html))) {
      depth += m[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    if (end === -1) {
      out += html.slice(cursor, markerIdx + 1);
      cursor = markerIdx + 1;
      continue;
    }
    out += html.slice(cursor, start) + drawioPreviewImgTag(html.slice(start, end), base);
    cursor = end;
  }
  return out + html.slice(cursor);
}

interface DrawioMacroMeta {
  previewName: string;
  pageId: string;
  /** The `.drawio` attachment name (the XML file — preview name without .png). */
  diagramName: string;
}

/** Parse a drawio macro block's base64 blob into the fields needed to fetch its
 *  preview PNG and its source XML attachment. Returns null when unparseable. */
function parseDrawioMacro(macroBlock: string): DrawioMacroMeta | null {
  try {
    const b64 = /data-diagramdata="([^"]+)"/.exec(macroBlock)?.[1];
    if (!b64) return null;
    const data = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
    const previewName = typeof data.previewName === 'string' ? data.previewName : '';
    const pageId = String(
      data.owningPageId ?? data.ceoId ?? /data-content-id="(\d+)"/.exec(macroBlock)?.[1] ?? '',
    ).trim();
    if (!previewName || !pageId || !/^\d+$/.test(pageId)) return null;
    const diagramName =
      typeof data.diagramName === 'string' && data.diagramName
        ? data.diagramName
        : previewName.replace(/\.png$/i, '');
    return { previewName, pageId, diagramName };
  } catch {
    return null;
  }
}

// Marker prefixed on every draw.io image's alt text so the docs-mockup-review
// skill knows it's a FLOW DIAGRAM (sequence/flowchart), not a UI mockup to
// score — it reviews screens, and uses diagrams only as flow context.
const DIAGRAM_ALT_MARKER = '[flow-diagram]';

function drawioPreviewImgTag(macroBlock: string, base: string): string {
  const meta = parseDrawioMacro(macroBlock);
  if (!meta) return '';
  return `<img src="${base}/download/attachments/${meta.pageId}/${encodeURIComponent(meta.previewName)}" alt="${DIAGRAM_ALT_MARKER} ${meta.diagramName.replace(/"/g, '&quot;')}"/>`;
}

/** Async variant of inlineDrawioPreviews that recovers EVERY page of a
 *  multi-page diagram. Confluence only stores a preview PNG for page 1, so for a
 *  diagram with >1 `<diagram>` page we download its source `.drawio` XML and
 *  render each page to a local PNG in `attachmentsDir` (headless Chromium),
 *  emitting one local `<img>` per page. Single-page diagrams — and any diagram
 *  we can't download or render — fall back to the stored page-1 preview `<img>`,
 *  which the caller's image localization then downloads as usual. */
async function inlineDrawioPreviewsRendered(
  html: string,
  creds: ConfluenceCreds,
  attachmentsDir: string,
  relPrefix: string,
  runtimeDataDir: string,
): Promise<string> {
  let out = '';
  let cursor = 0;
  for (;;) {
    const markerIdx = html.indexOf('data-macro-name="drawio"', cursor);
    if (markerIdx === -1) break;
    const start = html.lastIndexOf('<div', markerIdx);
    if (start === -1 || start < cursor) {
      out += html.slice(cursor, markerIdx + 1);
      cursor = markerIdx + 1;
      continue;
    }
    const tagRe = /<\/?div\b[^>]*>/gi;
    tagRe.lastIndex = start;
    let depth = 0;
    let end = -1;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html))) {
      depth += m[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    if (end === -1) {
      out += html.slice(cursor, markerIdx + 1);
      cursor = markerIdx + 1;
      continue;
    }
    const block = html.slice(start, end);
    out += html.slice(cursor, start) + (await renderDrawioMacroBlock(block, creds, attachmentsDir, relPrefix, runtimeDataDir));
    cursor = end;
  }
  return out + html.slice(cursor);
}

/** Render one drawio macro block into its markdown-ready `<img>`(s). Multi-page
 *  → one local `<img>` per rendered page; otherwise the single stored preview. */
async function renderDrawioMacroBlock(
  block: string,
  creds: ConfluenceCreds,
  attachmentsDir: string,
  relPrefix: string,
  runtimeDataDir: string,
): Promise<string> {
  const meta = parseDrawioMacro(block);
  if (!meta) return '';
  const fallback = () => drawioPreviewImgTag(block, creds.base);
  let xml: string;
  try {
    const buf = await downloadConfluenceBinary(
      creds,
      `${creds.base}/download/attachments/${meta.pageId}/${encodeURIComponent(meta.diagramName)}`,
    );
    xml = buf.toString('utf8');
  } catch {
    return fallback(); // can't read the source → keep the page-1 preview
  }
  const pages = splitMxfilePages(xml);
  if (pages.length <= 1) return fallback(); // single page → the stored preview is complete
  const stem = (sanitizeImageFileName(meta.diagramName).replace(/\.png$/i, '') || 'diagram').replace(/\s+/g, '_');
  const outPaths = pages.map((_, i) => path.join(attachmentsDir, `${stem}-p${i + 1}.png`));
  try {
    await fs.mkdir(attachmentsDir, { recursive: true });
    const written = new Set(await renderDrawioPages(xml, outPaths, runtimeDataDir));
    const imgs = outPaths
      .map((p, i) =>
        written.has(p)
          ? `<img src="${relPrefix}/${path.basename(p)}" alt="${DIAGRAM_ALT_MARKER} ${meta.diagramName.replace(/"/g, '&quot;')} — trang ${i + 1}"/>`
          : '',
      )
      .filter(Boolean);
    console.log(`[bas] drawio "${meta.diagramName}": rendered ${imgs.length}/${pages.length} pages`);
    return imgs.length ? imgs.join('\n') : fallback();
  } catch (err) {
    console.warn(`[bas] drawio multi-page render failed for "${meta.diagramName}" (keeping page-1 preview):`, err);
    return fallback();
  }
}

export function htmlToMarkdown(
  html: string,
  resolveHref?: (href: string) => string,
  /** Prefix a src must start with to be treated as already-localized
   *  (localizeConfluenceImages ran first) — anything else degrades to
   *  alt-text-only, same as before images were downloaded at all. */
  localizedImagePrefix?: string,
): string {
  const decode = (s: string) =>
    s
      .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => {
        try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _m; }
      })
      .replace(/&#(\d+);/g, (_m, d: string) => {
        try { return String.fromCodePoint(Number(d)); } catch { return _m; }
      })
      .replace(/&([a-zA-Z]+);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m);
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  // Code blocks first so their contents survive untouched.
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) => `\n\`\`\`\n${decode(code.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`);
  // Inline marks before block handling (block handlers strip remaining tags).
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
    const label = t.replace(/<[^>]+>/g, '').trim();
    const target = resolveHref ? resolveHref(href) : href;
    return `[${label || target}](${target})`;
  });
  // Pure-inline formatting tags (Confluence highlight <span>s, underline, …)
  // vanish with NO replacement text. They must go BEFORE the <li>/table-cell
  // handlers, whose generic tag→space strip would otherwise split words in
  // half whenever a highlight starts or ends mid-word ("t oàn bộ hồ sơ N CC").
  s = s.replace(/<\/?(?:span|u|s|sub|sup|small|mark|font|abbr|time|ins|del)\b[^>]*>/gi, '');
  // Tables → REAL GFM tables (header row + `| --- |` separator, cells padded
  // to a uniform width, pipes escaped) so react-markdown/remark-gfm render
  // them as tables instead of literal pipe text. Innermost-first loop handles
  // Confluence's nested tables: each pass converts tables with no <table>
  // inside, so an outer table sees its inner one already flattened to text.
  const tableToMd = (tbl: string): string => {
    const rows: string[][] = [];
    for (const tr of tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) =>
        c[1]!.replace(/<[^>]+>/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim(),
      );
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '\n';
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array<string>(Math.max(0, width - r.length)).fill('')];
    const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
    const sep = `| ${Array<string>(width).fill('---').join(' | ')} |`;
    return `\n${line(rows[0]!)}\n${sep}\n${rows.slice(1).map(line).join('\n')}\n\n`;
  };
  // Fixed-point loop (no .test(): a /g regex's lastIndex would desync).
  for (;;) {
    const next = s.replace(/<table(?:(?!<table)[\s\S])*?<\/table>/gi, (tbl) => tableToMd(tbl));
    if (next === s) break;
    s = next;
  }
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l: string, t: string) => `\n${'#'.repeat(Number(l))} ${t.replace(/<[^>]+>/g, '').trim()}\n`);
  // Lists → markdown that KEEPS the nesting (Confluence specs lean on
  // bullet-under-heading structure). Innermost-first fixed-point, same trick
  // as the tables above: each pass converts lists containing no nested
  // <ul>/<ol>, so an outer <li> sees its inner list already as markdown
  // lines and indents them 2 more spaces — depth accumulates per pass. The
  // old single flat `<li>` regex collapsed a nested list into its parent's
  // line, flattening the whole hierarchy.
  const liItemToMd = (inner: string, marker: string): string => {
    // Continuation lines keep their leading indent as-is — it carries the
    // accumulated nesting depth from earlier passes; only the item's own
    // first line gets whitespace-collapsed.
    const lines = inner
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    const first = (lines.shift() ?? '').replace(/\s+/g, ' ').trim();
    const rest = lines.map((l) => `  ${l}`);
    return [`${marker}${first}`, ...rest].join('\n');
  };
  const listToMd = (listHtml: string, ordered: boolean): string => {
    const items: string[] = [];
    let n = 0;
    for (const li of listHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
      n += 1;
      items.push(liItemToMd(li[1]!, ordered ? `${n}. ` : '- '));
    }
    return items.length ? `\n${items.join('\n')}\n\n` : '\n';
  };
  for (;;) {
    const next = s.replace(/<(ul|ol)\b(?:(?!<ul\b|<ol\b)[\s\S])*?<\/\1>/gi, (list, tag: string) =>
      listToMd(list, tag.toLowerCase() === 'ol'),
    );
    if (next === s) break;
    s = next;
  }
  // Orphan <li> with no surviving parent list (malformed markup) — old flat behavior.
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t: string) => `- ${t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n`);
  // src has already been localized (localizeConfluenceImages) before this
  // function runs, when the caller has Confluence creds to download with —
  // emit a real Markdown image instead of dropping it. An unlocalized src
  // (no creds, or a same-host download that failed) still degrades to the
  // alt-text-only / stripped behavior, same as before this fix.
  s = s.replace(/<img\b([^>]*)\/?>/gi, (_m, attrs: string) => {
    // Real `src`, not `data-image-src` (see IMG_SRC_RE) — the negative
    // lookbehind keeps this reading the localized attribute, not the leftover
    // Confluence URL sitting in `data-image-src`.
    const srcMatch = /(?<![-\w])src=["']([^"']+)["']/i.exec(attrs);
    const altMatch = /\balt=["']([^"']*)["']/i.exec(attrs);
    const src = srcMatch?.[1];
    const alt = altMatch?.[1] ?? '';
    if (src && localizedImagePrefix && src.startsWith(localizedImagePrefix)) return `![${alt}](${src})`;
    return alt ? `(${alt})` : '';
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|ul|ol|table|section|article|blockquote)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decode(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Direct-PAT page fetch (Data Center REST, same creds the page SEARCH uses —
 * verified live with wiki.servicehub.vn). Returns the RAW rendered HTML
 * (`body.view`) — conversion happens later so cross-page links can be
 * rewritten once every fetched page is known. */
async function fetchConfluencePageDirect(
  creds: ConfluenceCreds,
  pageId: string,
): Promise<{ title: string; url: string; html: string }> {
  const res = await fetch(`${creds.base}/rest/api/content/${pageId}?expand=body.view,space`, {
    headers: { authorization: `Bearer ${creds.token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Confluence REST ${res.status} for page ${pageId}: ${text.slice(0, 160)}`);
  const p = JSON.parse(text) as {
    title?: string;
    body?: { view?: { value?: string } };
    _links?: { base?: string; webui?: string };
  };
  const url = p._links?.webui
    ? `${(p._links.base ?? creds.base).replace(/\/+$/, '')}${p._links.webui}`
    : `${creds.base}/pages/viewpage.action?pageId=${pageId}`;
  return {
    title: p.title ?? `Confluence page ${pageId}`,
    url,
    html: p.body?.view?.value ?? '',
  };
}

/** Wiki-internal page ids referenced by `html`'s links: same wiki host (or a
 * relative /spaces|/pages href) AND a resolvable page id. Everything else
 * (JIRA, external sites, anchors) is ignored. */
export function extractLinkedPageIds(html: string, base: string): string[] {
  const ids = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    const href = (m[1] ?? '').trim();
    if (!href) continue;
    const sameWiki = href.startsWith('/') || href.toLowerCase().startsWith(base.toLowerCase());
    if (!sameWiki) continue;
    const idMatch = /\/pages\/(\d+)/.exec(href) ?? /[?&]pageId=(\d+)/.exec(href);
    if (idMatch) ids.add(idMatch[1]!);
  }
  return [...ids];
}

/** What the deterministic docs fetch authenticates with — direct PAT is
 * preferred (the SAME creds that power the page search picker); the BAS
 * gateway's `confluence_fetch_page` is only a fallback because most gateway
 * deployments have no Confluence credential linked ("tool execution failed"). */
export interface ConfluenceFetchSource {
  creds?: ConfluenceCreds | null;
  ep?: BasEndpoint | null;
}

// Link-follow crawl bounds: only pages linked DIRECTLY from a seed page
// (depth 1), and never more than this many pages in total — an unbounded
// follow could drag half the wiki into ./docs and drown the downstream
// stages in irrelevant context.
const FOLLOW_MAX_DEPTH = 1;
const FOLLOW_MAX_TOTAL = 15;

/** TOOL-ONLY docs fetch (no agent / no LLM): pull each Confluence page as
 * markdown — direct PAT REST first, gateway `confluence_fetch_page` as the
 * fallback — shaped as final `docs/confluence/<slug>.md` deliverables (same
 * frontmatter the agent path produced). Throws on the first unfetchable SEED
 * page — the docs stage FAILS loudly instead of silently shipping a partial
 * source set.
 *
 * `followLinks` (default true, PAT path only): specs habitually reference
 * sibling docs (BO specs, shared logic pages). A bounded BFS also fetches the
 * pages a seed links to (same wiki, depth ≤ FOLLOW_MAX_DEPTH, total ≤
 * FOLLOW_MAX_TOTAL), and cross-page links between FETCHED pages are rewritten
 * to relative `./<file>.md` so the doc set reads as one linked bundle. A
 * linked page that fails to fetch (permissions, deleted) is skipped with a
 * warning — only seeds are load-bearing.
 *
 * `treePages` (opts, PAT path only): sub-tree pages under the seeds (from
 * listDescendantPages). Fetched best-effort like linked pages (a deleted /
 * permission-blocked child warns, never fails the run), but each carries a
 * `treePath` so pass 2 nests it into `docs/confluence/<parent>/<child>.md`,
 * mirroring the wiki hierarchy. Independent of followLinks. */
export async function fetchConfluencePages(
  src: ConfluenceFetchSource,
  refs: string[],
  opts: {
    followLinks?: boolean;
    attachmentsDir?: string;
    treePages?: DescendantPage[];
    /** Enables headless rendering of multi-page draw.io diagrams (needs a
     *  writable runtime dir for the chromium runner). */
    runtimeDataDir?: string;
  } = {},
): Promise<ConfluenceDocPage[]> {
  if (!src.creds && !src.ep) throw new Error('no Confluence credential (PAT) and no BAS gateway configured');
  const followLinks = opts.followLinks !== false;
  const treePathById = new Map<string, string[]>((opts.treePages ?? []).map((t) => [t.pageId, t.treePath]));
  const client = src.ep ? new BasClient(src.ep) : null;
  const fetchViaGateway = async (pageId: string, ref: string) => {
    if (!client) throw new Error('BAS gateway not configured');
    const payload = await client.callTool('confluence_fetch_page', { page_id: pageId, format: 'markdown' });
    const p = ((Array.isArray(payload) ? payload[0] : payload) as Record<string, unknown> | undefined) ?? {};
    return {
      title: str(p, 'title', 'name') || `Confluence page ${pageId}`,
      url: str(p, 'url', 'webui', 'link') || ref,
      body: str(p, 'markdown', 'content', 'body', 'storage', 'view'),
    };
  };

  // ── Pass 1: fetch every page (seeds + bounded link-follow) ────────────────
  interface RawPage {
    pageId: string;
    title: string;
    url: string;
    /** Raw body.view HTML (direct fetch) — converted in pass 2. */
    html?: string;
    /** Pre-converted markdown (gateway fallback path). */
    markdown?: string;
    linked: boolean;
    /** Folder segments (relative to a scan seed) when this is a sub-tree page. */
    treePath?: string[];
  }
  const fetched = new Map<string, RawPage>();
  const seedIds: string[] = [];
  for (const ref of refs) {
    const pageId = extractPageId(ref);
    if (fetched.has(pageId)) continue;
    seedIds.push(pageId);
    if (src.creds) {
      try {
        const p = await fetchConfluencePageDirect(src.creds, pageId);
        fetched.set(pageId, { pageId, ...p, linked: false });
        continue;
      } catch (err) {
        if (!client) throw err;
        console.warn(`[bas] direct Confluence fetch failed for ${pageId}, falling back to gateway:`, err);
      }
    }
    const gw = await fetchViaGateway(pageId, ref);
    fetched.set(pageId, { pageId, title: gw.title, url: gw.url, markdown: gw.body, linked: false });
  }
  // Bounded BFS over wiki-internal links (direct-PAT only: the gateway path
  // returns markdown, not reliably parseable for links).
  if (followLinks && src.creds) {
    let frontier = seedIds;
    for (let depth = 1; depth <= FOLLOW_MAX_DEPTH; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        const page = fetched.get(id);
        if (!page?.html) continue;
        for (const linkedId of extractLinkedPageIds(page.html, src.creds.base)) {
          if (fetched.size >= FOLLOW_MAX_TOTAL) break;
          if (fetched.has(linkedId)) continue;
          try {
            const p = await fetchConfluencePageDirect(src.creds, linkedId);
            fetched.set(linkedId, { pageId: linkedId, ...p, linked: true });
            next.push(linkedId);
          } catch (err) {
            // Linked pages are best-effort — permissions/deleted pages skip.
            console.warn(`[bas] linked Confluence page ${linkedId} skipped:`, err);
          }
        }
      }
      frontier = next;
      if (fetched.size >= FOLLOW_MAX_TOTAL) {
        console.warn(`[bas] link-follow stopped at the ${FOLLOW_MAX_TOTAL}-page cap`);
        break;
      }
    }
  }
  // Sub-tree pages (opts.treePages) — best-effort, direct-PAT only, each
  // folder-structured by its treePath. A seed already fetched above keeps its
  // seed status; a genuinely new sub-page fetches here (deleted/blocked → warn).
  if (opts.treePages?.length && src.creds) {
    for (const t of opts.treePages) {
      if (fetched.has(t.pageId)) {
        const existing = fetched.get(t.pageId)!;
        if (!existing.treePath) existing.treePath = t.treePath;
        continue;
      }
      try {
        const p = await fetchConfluencePageDirect(src.creds, t.pageId);
        fetched.set(t.pageId, { pageId: t.pageId, ...p, linked: true, treePath: t.treePath });
      } catch (err) {
        console.warn(`[bas] sub-tree Confluence page ${t.pageId} skipped:`, err);
      }
    }
  }

  // ── Pass 2: assign files, then convert with cross-page links rewritten ────
  const pages: ConfluenceDocPage[] = [];
  const takenPaths = new Set<string>();
  const relByPageId = new Map<string, string>();
  // Source order: seeds first, then sub-tree pages in wiki-hierarchy order
  // (treePath + title, numbered naturally: roman "VII." sections, arabic
  // "2.2.3." sub-pages), then link-followed pages. This drives both the file
  // order and the _index.md listing.
  const ordered = [...fetched.values()].sort((a, b) => {
    const band = (p: RawPage) => (p.treePath ? 0 : p.linked ? 2 : 0); // linked-only pages last
    const bd = band(a) - band(b);
    if (bd) return bd;
    return naturalSegsCompare([...(a.treePath ?? []), a.title], [...(b.treePath ?? []), b.title]);
  });
  for (const p of ordered) {
    // Sub-tree pages nest into folders mirroring the wiki hierarchy; seed and
    // linked pages stay flat directly under docs/confluence/.
    const dir = (p.treePath ?? []).map(slug).filter(Boolean);
    const folder = ['docs', 'confluence', ...dir].join('/');
    let relPath = `${folder}/${slug(p.title)}.md`;
    if (takenPaths.has(relPath)) relPath = `${folder}/${slug(p.title)}-${p.pageId}.md`;
    takenPaths.add(relPath);
    relByPageId.set(p.pageId, relPath);
  }
  // Cross-page link rewrite, folder-aware: a link to another FETCHED page
  // becomes a path relative to the REFERRING page's own folder (so it resolves
  // whether both pages are flat or nested at different depths).
  const makeResolveHref = (fromRel: string) => (href: string): string => {
    const idMatch = /\/pages\/(\d+)/.exec(href) ?? /[?&]pageId=(\d+)/.exec(href);
    const toRel = idMatch ? relByPageId.get(idMatch[1]!) : undefined;
    if (!toRel) return href;
    const rel = path.posix.relative(path.posix.dirname(fromRel), toRel);
    return rel.startsWith('.') ? rel : `./${rel}`;
  };
  let totalImages = 0;
  for (const p of ordered) {
    const relPath = relByPageId.get(p.pageId)!;
    // Depth below docs/confluence/ → how many `../` a page needs to reach the
    // shared attachments dir (all images localize into docs/confluence/attachments).
    const depth = relPath.split('/').length - 3;
    const attachmentsPrefix = depth > 0 ? `${'../'.repeat(depth)}attachments` : 'attachments';
    let body: string;
    if (p.html !== undefined) {
      // Same-host <img src> download (mirrors the agent-run JIRA-key path's
      // confluence_export.py localize_images) — only possible on the direct
      // PAT path, which is the only one that has raw HTML + creds to
      // authenticate the image download with.
      let html = p.html;
      let localizedImagePrefix: string | undefined;
      // draw.io macros become <img> tags first, so localization below ships the
      // diagram PNGs like any page image. Multi-page diagrams are rendered
      // page-by-page into attachments/ (headless) when a runtime dir is given;
      // otherwise (and for single-page) we emit the stored page-1 preview URL.
      if (src.creds && opts.attachmentsDir && opts.runtimeDataDir) {
        html = await inlineDrawioPreviewsRendered(
          html,
          src.creds,
          opts.attachmentsDir,
          attachmentsPrefix,
          opts.runtimeDataDir,
        ).catch((err) => {
          console.warn(`[bas] drawio render pass failed for page ${p.pageId} (falling back):`, err);
          return inlineDrawioPreviews(html, src.creds!.base);
        });
      } else if (src.creds) {
        html = inlineDrawioPreviews(html, src.creds.base);
      }
      if (src.creds && opts.attachmentsDir) {
        const localized = await localizeConfluenceImages(
          src.creds,
          html,
          opts.attachmentsDir,
          attachmentsPrefix,
        ).catch((err) => {
          console.warn(`[bas] image localization failed for page ${p.pageId}:`, err);
          return { html, count: 0 };
        });
        html = localized.html;
        totalImages += localized.count;
        localizedImagePrefix = attachmentsPrefix;
      }
      body = htmlToMarkdown(html, makeResolveHref(relPath), localizedImagePrefix);
    } else {
      body = p.markdown ?? '';
    }
    const viaTree = !!p.treePath;
    // Drop empty-body pages that were auto-fetched (sub-tree / link-follow) —
    // section-overview stubs and TOC-only pages carry no content or images, so
    // they're pure noise in the docs listing + downstream. A user-PICKED seed
    // is always kept even if empty (respect the explicit choice).
    const isSeed = !p.linked && !viaTree;
    if (!isSeed && !body.trim()) {
      console.log(`[bas] skipping empty ${viaTree ? 'sub-tree' : 'linked'} page ${p.pageId} (${p.title})`);
      continue;
    }
    pages.push({
      pageId: p.pageId,
      title: p.title,
      url: p.url,
      relPath,
      linked: p.linked && !viaTree,
      viaTree,
      content:
        frontmatter({
          title: p.title,
          page_id: p.pageId,
          url: p.url,
          source: 'confluence',
          ...(viaTree
            ? { fetched_via: 'sub-tree', tree_path: (p.treePath ?? []).join(' / ') }
            : p.linked
              ? { fetched_via: 'linked-from-seed' }
              : {}),
        }) + (body || '> (empty page body)\n'),
    });
  }
  if (pages.length === 0) throw new Error('Confluence source produced no files');
  console.log(`[bas] deterministic docs fetch: ${pages.length} page(s), ${totalImages} image(s) downloaded`);
  return pages;
}

/** The `docs/confluence/_index.md` companion of a deterministic docs run —
 * the per-page table of contents downstream stages (and reviewers) start
 * from. Seed pages and link-followed pages list in separate groups so it is
 * obvious what the user picked vs what the crawl pulled in. */
export function renderConfluenceIndex(pages: ConfluenceDocPage[]): string {
  // Link relative to docs/confluence/ (keeps folder nesting for sub-tree pages
  // instead of collapsing every link to a basename).
  const rel = (p: ConfluenceDocPage) => p.relPath.replace(/^docs\/confluence\//, './');
  const row = (p: ConfluenceDocPage) =>
    `- [${p.title}](${rel(p)}) — page ${p.pageId} · ${p.url}`;
  const treeRow = (p: ConfluenceDocPage) => {
    const path = p.content.match(/^tree_path:\s*(.*)$/m)?.[1]?.trim();
    return `- [${p.title}](${rel(p)})${path ? ` — ${path}` : ''} · page ${p.pageId}`;
  };
  const seeds = pages.filter((p) => !p.linked && !p.viaTree);
  const tree = pages.filter((p) => p.viaTree);
  const linked = pages.filter((p) => p.linked);
  let md = `# Tài liệu nguồn (Confluence)\n\n${seeds.map(row).join('\n')}\n`;
  if (tree.length) {
    md += `\n## Trang con (quét theo cây phân cấp)\n\n${tree.map(treeRow).join('\n')}\n`;
  }
  if (linked.length) {
    md += `\n## Trang liên kết (tự fetch từ link trong trang nguồn)\n\n${linked.map(row).join('\n')}\n`;
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
