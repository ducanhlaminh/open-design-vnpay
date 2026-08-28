// BAS MCP gateway client — pipeline 1 (confluence-ingest) reads source documents from
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
  ConfluencePageHit as ContractConfluencePageHit,
  ConfluencePageMeta,
  PipelineRunSource,
} from '@open-design/contracts';

import { readMcpConfig } from '../mcp-config.js';
import { configuredConfluenceBase, readConfluenceConfig } from '../confluence-config.js';
import { renderDrawioPages, splitMxfilePages } from './drawio-render.js';
import { htmlToMarkdown } from './html-to-markdown.js';
import { svgForImgEmbedding } from './svg-xml.js';

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
  // Env first. BAS_MCP_URL/BAS_MCP_TOKEN, or the OD_BA_AGENT_URL/OD_BA_AGENT_TOKEN
  // pair a deployment may bake in (2026-08-18: the `ba-agent` MCP seed is
  // gone, so env is the primary way to configure the gateway; the mcp-config
  // lookup below only serves a server the user added by hand).
  const envUrl = (process.env.BAS_MCP_URL ?? process.env.OD_BA_AGENT_URL)?.trim();
  const envToken = stripBearer(process.env.BAS_MCP_TOKEN ?? process.env.OD_BA_AGENT_TOKEN);
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

  private async post(payload: unknown, signal?: AbortSignal): Promise<{ status: number; sessionId: string | null; body: RpcOk | null }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const abortFromCaller = () => ctrl.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
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
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
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
      }, signal);
      // Best-effort initialized notification; gateways that don't need a session
      // ignore it. Failure here must not block a stateless tools/call.
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal).catch((err) => {
        if (signal?.aborted) throw err;
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      // Stateless gateway that rejects initialize — proceed; tools/call may work.
    }
    this.initialized = true;
  }

  // Call an MCP tool and return its decoded payload. The gateway wraps results
  // as `content[].text` where text is a JSON-serialized string (per the BAS
  // OpenAPI ToolContent); we concatenate text parts and JSON.parse them.
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    await this.ensureInitialized(signal);
    const { body } = await this.post({
      jsonrpc: '2.0',
      id: ++this.rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }, signal);
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

/** Lỗi tra trang Confluence mang HTTP status để route map thẳng
 *  (400 = không đọc được ref, 404 = không tồn tại/không quyền, 502 = thiếu
 *  cấu hình / upstream lỗi). */
export class ConfluenceResolveError extends Error {
  constructor(
    public readonly status: 400 | 404 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'ConfluenceResolveError';
  }
}

/** Một ref Confluence người dùng dán vào ô tìm, đã nhận dạng:
 *  - `id`    — `…/pages/<id>[/…]`, `…?pageId=<id>`, hoặc id số trần;
 *  - `title` — Server-style `…/display/<SPACE>/<Title>` (title URL-encoded,
 *              `+` = khoảng trắng) → phải tra CQL theo space+title;
 *  - `tiny`  — link rút gọn `…/x/<token>` → phải follow redirect mới ra id. */
export type ConfluenceRef =
  | { kind: 'id'; id: string }
  | { kind: 'title'; space: string; title: string }
  | { kind: 'tiny'; url: string };

const REF_HELP =
  'Paste the page URL (…/pages/<id>/…, …?pageId=<id>, …/display/<SPACE>/<Title>, …/x/<tiny>) or the numeric page id.';

/** Nhận dạng link/id Confluence (thuần, không mạng). Không khớp → throw
 *  `ConfluenceResolveError` 400 với hướng dẫn các dạng hỗ trợ. */
export function parseConfluenceRef(ref: string): ConfluenceRef {
  const t = ref.trim();
  if (/^\d+$/.test(t)) return { kind: 'id', id: t };
  const idMatch = /\/pages\/(\d+)/.exec(t) ?? /[?&]pageId=(\d+)/.exec(t);
  if (idMatch) return { kind: 'id', id: idMatch[1]! };
  const display = /\/display\/([^/?#]+)\/([^?#]+)/.exec(t);
  if (display) {
    const decode = (v: string) => {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    };
    const space = decode(display[1]!);
    const title = decode(display[2]!).replace(/\+/g, ' ').replace(/\/+$/, '').trim();
    if (space && title) return { kind: 'title', space, title };
  }
  if (/^https?:\/\/[^/]+\/(?:[^?#]*\/)?x\/[A-Za-z0-9_-]+/.test(t)) return { kind: 'tiny', url: t };
  throw new ConfluenceResolveError(400, `Could not find a Confluence page id in "${ref}". ${REF_HELP}`);
}

// Pull a Confluence numeric page_id out of a pasted link (…/pages/<id>/… or
// ?pageId=<id>) or accept a bare numeric id. Throws with guidance otherwise —
// confluence_fetch_page requires page_id, not a URL. Only the `id` shape of
// parseConfluenceRef counts here: `/display/…` and `/x/…` need a network round
// trip (resolveConfluencePage) so they stay "no page id" for this helper.
export function extractPageId(ref: string): string {
  const parsed = parseConfluenceRef(ref);
  if (parsed.kind === 'id') return parsed.id;
  throw new ConfluenceResolveError(400, `Could not find a Confluence page id in "${ref}". ${REF_HELP}`);
}

// ── Confluence page search (modal Run pipeline 1 — picker "tìm trang theo
// tên" như bên pipeline-studio) ──────────────────────────────────────────────

/** Cùng khuôn với contracts (id,title,url?,space?,ancestors?,hasChildren?) —
 *  search lẫn resolve đều trả đúng type FE dùng. */
export type ConfluencePageHit = ContractConfluencePageHit;

/** Một bản ghi trang từ Confluence REST (`/rest/api/content/<id>` hoặc kết
 *  quả `content/search`) với `expand=space,ancestors,children.page`. */
interface RestPage {
  id?: string;
  title?: string;
  space?: { key?: string };
  _links?: { base?: string; webui?: string };
  // Confluence returns these root→down, page itself excluded — the
  // App-root combobox needs this to tell apart same-titled pages that
  // live under different dự án.
  ancestors?: Array<{ title?: string }>;
  // Existence-only signal for the App-root search dropdown's expand
  // arrow — `size` is Confluence's own child COUNT (preferred, doesn't
  // depend on how many child rows the default page limit returned);
  // `results` is the fallback when `size` is absent.
  children?: { page?: { size?: number; results?: unknown[] } };
}

/** Map một bản ghi REST → ConfluencePageHit (dùng chung cho search + resolve).
 *  `url` = `_links.base` (nếu có) hoặc `base` + `webui`. */
function restPageToHit(r: RestPage, base: string): ConfluencePageHit {
  const ancestors = (r.ancestors ?? []).map((a) => a.title ?? '').filter(Boolean);
  const childPage = r.children?.page;
  const hasChildren =
    childPage === undefined
      ? undefined
      : typeof childPage.size === 'number'
        ? childPage.size > 0
        : Array.isArray(childPage.results)
          ? childPage.results.length > 0
          : undefined;
  const urlBase = (r._links?.base ?? base).replace(/\/+$/, '');
  return {
    id: String(r.id ?? ''),
    title: r.title ?? String(r.id ?? ''),
    ...(r._links?.webui ? { url: `${urlBase}${r._links.webui}` } : {}),
    ...(r.space?.key ? { space: r.space.key } : {}),
    ...(ancestors.length ? { ancestors } : {}),
    ...(hasChildren !== undefined ? { hasChildren } : {}),
  };
}

export interface ConfluenceCreds {
  base: string;
  token: string;
}

/**
 * Confluence host luôn đến từ CONFLUENCE_URL. PAT ưu tiên kho per-user
 * <dataDir>/confluence-config.json, rồi mới fallback sang
 * CONFLUENCE_PERSONAL_TOKEN của daemon.
 */
export async function resolveConfluenceCreds(dataDir: string): Promise<ConfluenceCreds | null> {
  const base = configuredConfluenceBase();
  if (!base) return null;
  try {
    const cfg = await readConfluenceConfig(dataDir);
    if (cfg?.token) return { base, token: cfg.token };
  } catch {
    /* confluence-config unreadable — fall through to env */
  }
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
    // `children.page` with NO size override rides Confluence's default child
    // limit (small) — enough to tell existence apart from emptiness without
    // fetching more than we need (we only read presence, never the list).
    const url = `${creds.base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${Math.min(Math.max(limit, 1), 50)}&expand=space,ancestors,children.page`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${creds.token}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Confluence search HTTP ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { results?: RestPage[] };
    return (body.results ?? [])
      .map((r) => restPageToHit(r, creds.base))
      .filter((r) => r.id);
  }
  if (!ep) {
    throw new Error(
      'Tìm trang Confluence chưa cấu hình — thêm Base URL + Personal Access Token ở Settings → Integrations → Confluence (hoặc env daemon / BAS gateway).',
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

// ── Tra MỘT trang từ link/page id dán vào ô tìm (WP confluence-paste-link) ──

const PAT_REQUIRED_MSG =
  'Dạng link này cần PAT Confluence (Settings → Integrations → Confluence) — BAS gateway chỉ tra được theo page id.';
const NO_CREDS_MSG =
  'Tra trang Confluence chưa cấu hình — thêm Base URL + Personal Access Token ở Settings → Integrations → Confluence (hoặc env daemon / BAS gateway).';
const TINY_MAX_HOPS = 3;
/** Ref đã hết chuyển hướng — chỉ còn dạng tra được trực tiếp. */
type ResolvedRef = Exclude<ConfluenceRef, { kind: 'tiny' }>;

function cqlQuote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function patGetJson(creds: ConfluenceCreds, url: string, what: string): Promise<unknown> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${creds.token}` } });
  const text = await res.text();
  if (res.status === 404 || res.status === 403) {
    throw new ConfluenceResolveError(404, `Không tìm thấy hoặc không có quyền xem ${what} (Confluence HTTP ${res.status}).`);
  }
  if (!res.ok) throw new ConfluenceResolveError(502, `Confluence HTTP ${res.status} khi tra ${what}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfluenceResolveError(502, `Confluence trả về dữ liệu không phải JSON khi tra ${what}.`);
  }
}

async function resolveByIdPat(creds: ConfluenceCreds, id: string): Promise<ConfluencePageHit> {
  const p = (await patGetJson(
    creds,
    `${creds.base}/rest/api/content/${id}?expand=space,ancestors,children.page`,
    `trang ${id}`,
  )) as RestPage;
  const hit = restPageToHit({ ...p, id: String(p.id ?? id) }, creds.base);
  if (!hit.id) throw new ConfluenceResolveError(404, `Không tìm thấy trang Confluence ${id}.`);
  return hit;
}

async function resolveByTitlePat(creds: ConfluenceCreds, space: string, title: string): Promise<ConfluencePageHit> {
  const cql = `type=page AND space=${cqlQuote(space)} AND title=${cqlQuote(title)}`;
  const body = (await patGetJson(
    creds,
    `${creds.base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=1&expand=space,ancestors,children.page`,
    `trang «${title}» trong space ${space}`,
  )) as { results?: RestPage[] };
  const first = (body.results ?? []).map((r) => restPageToHit(r, creds.base)).find((r) => r.id);
  if (!first) {
    throw new ConfluenceResolveError(404, `Không tìm thấy trang «${title}» trong space ${space} (hoặc không có quyền xem).`);
  }
  return first;
}

/** Follow link rút gọn `/x/<tiny>` (tối đa 3 hop, `redirect: 'manual'`) tới
 *  khi ra được một ref tra được (`id` / `title`). */
async function followTinyPat(creds: ConfluenceCreds, url: string): Promise<ResolvedRef> {
  let current = url;
  for (let hop = 0; hop < TINY_MAX_HOPS; hop++) {
    const res = await fetch(current, { redirect: 'manual', headers: { authorization: `Bearer ${creds.token}` } });
    const location = res.headers.get('location');
    if (res.status === 404 || res.status === 403) {
      throw new ConfluenceResolveError(404, `Link rút gọn không tồn tại hoặc không có quyền xem (Confluence HTTP ${res.status}).`);
    }
    if (!location) {
      throw new ConfluenceResolveError(404, `Link rút gọn "${url}" không chuyển hướng tới trang nào (HTTP ${res.status}).`);
    }
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new ConfluenceResolveError(502, `Link rút gọn chuyển hướng tới địa chỉ không hợp lệ: ${location}`);
    }
    let parsed: ConfluenceRef;
    try {
      parsed = parseConfluenceRef(next);
    } catch {
      throw new ConfluenceResolveError(404, `Link rút gọn chuyển hướng tới "${next}" — không nhận ra trang Confluence.`);
    }
    if (parsed.kind !== 'tiny') return parsed;
    current = next;
  }
  throw new ConfluenceResolveError(502, `Link rút gọn "${url}" chuyển hướng quá ${TINY_MAX_HOPS} lần.`);
}

/**
 * Tra một trang Confluence từ link/page id dán vào ô tìm → một hit y hệt
 * kết quả tìm-theo-tên. Thứ tự như searchConfluencePages: PAT trực tiếp
 * trước, BAS gateway (`confluence_fetch_page`) fallback — gateway chỉ tra
 * được theo page id (không ancestors/hasChildren); `/display/…` và `/x/…`
 * không có PAT → lỗi rõ. Lỗi ném ra luôn là ConfluenceResolveError:
 * 400 = ref không đọc được, 404 = không tồn tại/không quyền, 502 = thiếu cấu
 * hình / upstream.
 */
export async function resolveConfluencePage(
  creds: ConfluenceCreds | null,
  ep: BasEndpoint | null,
  ref: string,
): Promise<ConfluencePageHit> {
  const parsed = parseConfluenceRef(ref);
  if (creds) {
    const target: ResolvedRef = parsed.kind === 'tiny' ? await followTinyPat(creds, parsed.url) : parsed;
    if (target.kind === 'id') return resolveByIdPat(creds, target.id);
    return resolveByTitlePat(creds, target.space, target.title);
  }
  if (parsed.kind !== 'id') throw new ConfluenceResolveError(502, PAT_REQUIRED_MSG);
  if (!ep) throw new ConfluenceResolveError(502, NO_CREDS_MSG);
  try {
    const meta = await basConfluenceMeta(ep, parsed.id);
    return {
      id: meta.id,
      title: meta.title,
      ...(meta.url ? { url: meta.url } : {}),
      ...(meta.space ? { space: meta.space } : {}),
    };
  } catch (err) {
    if (err instanceof ConfluenceResolveError) throw err;
    throw new ConfluenceResolveError(502, `BAS gateway không tra được trang ${parsed.id}: ${String((err as Error)?.message ?? err)}`);
  }
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
  signal?: AbortSignal,
): Promise<DescendantPage[]> {
  const out: DescendantPage[] = [];
  let start = 0;
  const pageSize = 100;
  for (;;) {
    const cql = `ancestor=${seedPageId}`;
    const url = `${creds.base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${pageSize}&start=${start}&expand=ancestors`;
    signal?.throwIfAborted();
    const res = await fetch(url, { headers: { authorization: `Bearer ${creds.token}` }, ...(signal ? { signal } : {}) });
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
// The daemon writes these under the project cwd BEFORE the agent run; confluence-ingest
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
  return (
    deaccentVietnamese(s)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      // A literal '-' in the title is an ALLOWED char (kept as-is above) —
      // adjacent to a replaced run (e.g. " - " → space→'-', '-' kept, space→'-')
      // that produces runs of 2+ dashes ("---"). Collapse them: real titles
      // like "2.2. URD - Danh mục vật tư hàng hoá" must not slug to
      // "2.2.-URD---Danh-muc-...".
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'doc'
  );
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

// A JIRA issue key ("PROJ-123") or a bare project key ("PROJ" — "give me the
// whole project"). Deliberately requires 2+ letters/digits after the leading
// letter in the bare-key form so a stray short uppercase word (an acronym
// pasted by mistake) doesn't misfire; JIRA project keys are conventionally
// 2-10 chars.
const JIRA_ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const JIRA_BARE_PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
// JQL query hint: `project =`, an `ORDER BY` clause, or any bare ` = `
// comparison (JQL's own field=value syntax) — matches across the whole
// (possibly multi-line) input, not per line.
const JQL_HINT_RE = /\bproject\s*=|\bORDER\s+BY\b|\s=\s/i;

/** Whether `input` is JIRA-shaped (an issue key, a bare project key, or a
 * JQL query). WP8 (2026-08) removed the legacy JIRA agent path (Atlassian
 * MCP) entirely — the confluence-ingest dispatch (server.ts's runPipeline)
 * now fails EVERY non-Confluence input immediately, agent-shaped or not.
 * This heuristic is kept only so that fail-fast rejection can pick a more
 * specific message for genuinely JIRA-shaped input ("JIRA is no longer
 * supported") instead of the generic "input not recognized" one — it no
 * longer gates access to an agent. A JQL hint anywhere in the input wins
 * outright (JQL is normally one query, not line-oriented); otherwise EVERY
 * non-empty line must be a JIRA issue key or a bare project key. */
export function looksLikeJiraInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (JQL_HINT_RE.test(trimmed)) return true;
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((l) => JIRA_ISSUE_KEY_RE.test(l) || JIRA_BARE_PROJECT_KEY_RE.test(l));
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

// VNPAY fork: this is the DETERMINISTIC docs path (a Confluence page URL
// pasted directly into the docs stage — runDocsDeterministic in server.ts).
// The bundled manual/ad-hoc export script keeps its own image-download logic
// (skills/confluence-ingest/scripts/confluence_export.py's localize_images)
// because it runs in the agent's shell, not in this process — it carries a
// copy of the regex below, and the two must be fixed together. WP8 (2026-08)
// removed the legacy agent-run JIRA-key path entirely; the script now only
// matters for a manual/ad-hoc page-tree export, never the pipeline dispatch
// (every Confluence ref reaching the daemon is fetched HERE instead).
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

async function downloadConfluenceBinary(creds: ConfluenceCreds, url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${creds.token}` }, ...(signal ? { signal } : {}) });
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
  signal?: AbortSignal,
): Promise<{ html: string; count: number }> {
  const rawSrcs = new Set<string>();
  for (const m of html.matchAll(IMG_SRC_RE)) rawSrcs.add(m[2]!);
  const localBySrc = new Map<string, string>();
  const downloadedByUrl = new Map<string, string>();
  let count = 0;
  for (const src of rawSrcs) {
    signal?.throwIfAborted();
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
        const data = await downloadConfluenceBinary(creds, url, signal);
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
        signal?.throwIfAborted();
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
// Bracket-free on purpose: a `[…]` marker inside an image ALT closes the
// `![alt](src)` syntax early and breaks rendering. "flow-diagram" is still the
// substring downstream (docs-mockup-review) keys off to tag it a flow diagram.
const DIAGRAM_ALT_MARKER = 'flow-diagram';

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

/** File-name stem for a diagram's derived files, PREFIXED WITH ITS PAGE ID.
 *
 * An attachment name is unique only WITHIN a Confluence page — two pages happily
 * hold different diagrams both called "Untitled Diagram-1783562766184". Every
 * page in a run writes into ONE shared `attachments/` folder, so an unprefixed
 * name lets the last page written win: the `.drawio` a page points at ends up
 * being some other page's diagram, and an agent told the diagram is
 * authoritative then transcribes the wrong flow with full confidence.
 *
 * The page id is how Confluence itself scopes an attachment
 * (`/download/attachments/<pageId>/<name>`), so it is the natural key.
 */
function diagramFileStem(meta: DrawioMacroMeta): string {
  const base = (sanitizeImageFileName(meta.diagramName).replace(/\.png$/i, '') || 'diagram').replace(/\s+/g, '_');
  return `${meta.pageId}-${base}`;
}

/** Expand every draw.io diagram in an `export_view` body to ONE IMAGE PER PAGE.
 *
 * `export_view` already flattens each draw.io macro to a single `<img>` — the
 * page-1 preview PNG Confluence stores. That is precisely where Confluence's own
 * "Export to Markdown" loses pages 2..N of a multi-page diagram.
 *
 * The macro (with the `data-diagramdata` blob naming the diagram's SOURCE
 * mxfile) survives in the `view` rendering, so we read the diagram list from
 * THERE, render every page from the source, and splice the results into the
 * export_view body by matching the preview file name. A diagram we cannot read
 * or render keeps its page-1 `<img>` untouched — never worse than the export.
 */
async function expandDrawioPagesInExportView(
  html: string,
  macroHtml: string,
  creds: ConfluenceCreds,
  attachmentsDir: string,
  relPrefix: string,
  runtimeDataDir: string,
): Promise<string> {
  const metas: DrawioMacroMeta[] = [];
  for (let i = macroHtml.indexOf('data-macro-name="drawio"'); i !== -1; i = macroHtml.indexOf('data-macro-name="drawio"', i + 1)) {
    const start = macroHtml.lastIndexOf('<div', i);
    if (start === -1) continue;
    const meta = parseDrawioMacro(macroHtml.slice(start, i + 4000));
    if (meta && !metas.some((m) => m.previewName === meta.previewName)) metas.push(meta);
  }
  if (!metas.length) return html;

  let out = html;
  for (const meta of metas) {
    let xml: string;
    try {
      const buf = await downloadConfluenceBinary(
        creds,
        `${creds.base}/download/attachments/${meta.pageId}/${encodeURIComponent(meta.diagramName)}`,
      );
      xml = buf.toString('utf8');
    } catch {
      continue; // source unreadable → keep the page-1 preview export_view gave us
    }
    const pages = splitMxfilePages(xml);
    const stem = diagramFileStem(meta);

    // The PNG is what a HUMAN reads; the diagram SOURCE is what the next stage
    // reads. Saved verbatim — an agent working from the source can recover
    // every branch label and condition, which it cannot do reliably from a
    // picture. Written for EVERY diagram, single-page included.
    const sourceRel = `${stem}.drawio`;
    let sourceSaved = false;
    try {
      await fs.mkdir(attachmentsDir, { recursive: true });
      await fs.writeFile(path.join(attachmentsDir, sourceRel), xml, 'utf8');
      sourceSaved = true;
    } catch (err) {
      console.warn(`[bas] could not save drawio source for "${meta.diagramName}":`, err);
    }
    // A reference the agent meets right where the diagram is, rather than a
    // file on disk it has to know to look for.
    const refHtml = sourceSaved
      ? `<br/><em>${DIAGRAM_ALT_MARKER} — nguồn sơ đồ (đọc file này để lấy luồng): <a href="${relPrefix}/${encodeURI(sourceRel)}">${sourceRel}</a></em><br/>`
      : '';

    if (pages.length <= 1) {
      // Stored preview already shows the whole diagram; only the reference is
      // new, so append it after the existing <img> instead of replacing it.
      if (refHtml) out = appendAfterImage(out, meta.previewName, refHtml);
      continue;
    }
    const outPaths = pages.map((_, i) => path.join(attachmentsDir, `${stem}-p${i + 1}.png`));
    let written: Set<string>;
    try {
      written = new Set(await renderDrawioPages(xml, outPaths, runtimeDataDir));
    } catch (err) {
      console.warn(`[bas] drawio multi-page render failed for "${meta.diagramName}" (keeping page-1 preview):`, err);
      if (refHtml) out = appendAfterImage(out, meta.previewName, refHtml);
      continue;
    }
    const imgs = outPaths
      .map((abs, i) =>
        written.has(abs)
          ? `<img src="${relPrefix}/${path.basename(abs)}" alt="${DIAGRAM_ALT_MARKER} ${meta.diagramName.replace(/"/g, '&quot;')} — trang ${i + 1}"/>`
          : '',
      )
      .filter(Boolean);
    if (!imgs.length) continue;
    // Swap the single preview <img> for the per-page set. The src carries the
    // preview file name (percent-encoded or not), which is what identifies it.
    const enc = encodeURIComponent(meta.previewName);
    const imgRe = new RegExp(`<img\\b[^>]*\\bsrc="[^"]*(?:${escapeForRegExp(meta.previewName)}|${escapeForRegExp(enc)})[^"]*"[^>]*>`, 'i');
    if (!imgRe.test(out)) continue;
    out = out.replace(imgRe, `${imgs.join('\n')}${refHtml}`);
    console.log(`[bas] drawio "${meta.diagramName}": ${imgs.length}/${pages.length} trang (export_view)`);
  }
  return out;
}

// ── Mermaid macro (Stratus "Mermaid Diagrams for Confluence") ─────────────
// `mermaid-cloud` renders CLIENT-SIDE: both `view` and `export_view` carry
// only a viewer <div id="stratus-addons-viewer-<macroId>"> (styles + a
// `createViewer('<id>', '<title>', 'fit', 'bottom', `&lt;svg…`)` script) —
// no <img>. htmlToMarkdown drops <style>/<script>, so the section came out
// EMPTY and the flow stage saw a text-only document. The diagram lives in
// two page attachments the macro names after its title: `<title>` (text/plain,
// the Mermaid source) and `<title>.svg` (rendered). Fetch the source by name,
// keep the SVG from the viewer call, and splice an <img> + a ```mermaid fence
// + a source reference where the viewer stood — flow-ux then treats it like
// any Mermaid diagram (kind 'mermaid').

export interface MermaidMacroBlock {
  start: number;
  end: number;
  title: string;
  svg?: string;
}

const MERMAID_VIEWER_MARKER = 'stratus-addons-viewer-';

/** Balanced <div> scan from `start` (index of a `<div`) to its matching close. */
function balancedDivEnd(html: string, start: number): number {
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/** Parse the JS-string args of a `createViewer(...)` call at `start` (index of
 *  the `(`): '…', "…" and `…` literals with `\` escapes. Mirrors
 *  flow-ux/mermaid-detect.ts (kept local so this ingest module does not depend
 *  on the flow stage). */
function parseViewerCallArgs(src: string, start: number): string[] | null {
  let i = start + 1;
  const args: string[] = [];
  const n = src.length;
  for (;;) {
    while (i < n && /[\s,]/.test(src[i]!)) i += 1;
    if (i >= n) return null;
    const ch = src[i]!;
    if (ch === ')') return args;
    if (ch !== "'" && ch !== '"' && ch !== '`') return null;
    let j = i + 1;
    let out = '';
    while (j < n && src[j] !== ch) {
      if (src[j] === '\\' && j + 1 < n) {
        out += src[j + 1];
        j += 2;
        continue;
      }
      out += src[j];
      j += 1;
    }
    if (j >= n) return null;
    args.push(out);
    i = j + 1;
  }
}

function unescapeHtmlText(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Every Mermaid-macro viewer block in `html` (view or export_view), with the
 *  diagram title and — when the viewer call carries it — the rendered SVG. */
export function findMermaidMacroBlocks(html: string): MermaidMacroBlock[] {
  const out: MermaidMacroBlock[] = [];
  let cursor = 0;
  for (;;) {
    const marker = html.indexOf(MERMAID_VIEWER_MARKER, cursor);
    if (marker === -1) break;
    // Only the mount div (`id="stratus-addons-viewer-…"`) starts a block; the
    // same prefix reappears inside it (lightbox ids) and must be skipped.
    const isIdAttr = /\bid=["']$/.test(html.slice(Math.max(0, marker - 4), marker));
    const start = isIdAttr ? html.lastIndexOf('<div', marker) : -1;
    if (start === -1 || start < cursor) {
      cursor = marker + MERMAID_VIEWER_MARKER.length;
      continue;
    }
    const end = balancedDivEnd(html, start);
    if (end === -1) break;
    const block = html.slice(start, end);
    const call = block.indexOf('createViewer(');
    const args = call !== -1 ? parseViewerCallArgs(block, call + 'createViewer'.length) : null;
    const title = (args?.[1] ?? '').trim();
    const svgArg = args?.find((a) => /^\s*(&lt;|<)svg\b/i.test(a));
    const svg = svgArg ? unescapeHtmlText(svgArg).trim() : undefined;
    const item: MermaidMacroBlock = { start, end, title: title || `So-do-${out.length + 1}` };
    if (svg && /^<svg\b/i.test(svg)) item.svg = svg;
    out.push(item);
    cursor = end;
  }
  return out;
}

/** Look a page attachment up BY NAME (Confluence REST `child/attachment?filename=`)
 *  and download it. Returns null when absent or unreadable. */
async function downloadConfluenceAttachmentByName(
  creds: ConfluenceCreds,
  pageId: string,
  filename: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  try {
    const res = await fetch(`${creds.base}/rest/api/content/${pageId}/child/attachment?filename=${encodeURIComponent(filename)}&limit=5`, {
      headers: { authorization: `Bearer ${creds.token}` },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<{ title?: string; _links?: { download?: string } }> };
    const hit = (data.results ?? []).find((r) => r.title === filename) ?? data.results?.[0];
    const dl = hit?._links?.download;
    if (!dl) return null;
    const url = /^https?:\/\//i.test(dl) ? dl : `${creds.base}${dl.startsWith('/') ? '' : '/'}${dl}`;
    return await downloadConfluenceBinary(creds, url, signal);
  } catch {
    return null;
  }
}

function looksLikeMermaidSource(text: string): boolean {
  const first = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/%%.*$/, '').trim())
    .find(Boolean);
  return !!first && /^(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|journey|classDiagram|erDiagram|gantt)\b/i.test(first);
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The HTML that replaces one Mermaid viewer block: rendered SVG as an <img>
 *  (a HUMAN reads that), the Mermaid source as a fenced code block (the flow
 *  stage reads that), and a reference to the saved source file. */
export function mermaidMacroReplacementHtml(
  title: string,
  relPrefix: string,
  saved: { svgRel?: string; codeRel?: string; code?: string },
): string {
  const parts: string[] = [];
  const safeTitle = title.replace(/"/g, '&quot;');
  if (saved.svgRel) parts.push(`<img src="${relPrefix}/${encodeURI(saved.svgRel)}" alt="${DIAGRAM_ALT_MARKER} ${safeTitle}"/>`);
  if (saved.code) parts.push(`<pre data-lang="mermaid">${escapeHtmlText(saved.code.trim())}</pre>`);
  if (saved.codeRel) {
    parts.push(
      `<em>${DIAGRAM_ALT_MARKER} — sơ đồ Mermaid "${safeTitle}"; nguồn: <a href="${relPrefix}/${encodeURI(saved.codeRel)}">${saved.codeRel}</a></em>`,
    );
  }
  return parts.length ? `<p>${parts.join('<br/>')}</p>` : '';
}

/** Rewrite every Mermaid-macro viewer block of an `export_view` body (see the
 *  section comment). Best-effort per diagram: a block whose source cannot be
 *  fetched still gets its SVG (from the viewer call) so the reader sees the
 *  picture; a block with neither is stripped (its styles/scripts are junk in
 *  Markdown either way). */
export async function expandMermaidMacrosInExportView(
  html: string,
  macroHtml: string,
  creds: ConfluenceCreds,
  pageId: string,
  attachmentsDir: string,
  relPrefix: string,
  signal?: AbortSignal,
): Promise<string> {
  const blocks = findMermaidMacroBlocks(html);
  if (!blocks.length) return html;
  // The `view` body renders the same macros — use it to fill a title/SVG the
  // export_view block lacks (blocks pair up in document order).
  const viewBlocks = macroHtml ? findMermaidMacroBlocks(macroHtml) : [];
  let out = '';
  let cursor = 0;
  blocks.forEach((b, i) => {
    out += html.slice(cursor, b.start);
    cursor = b.end;
    // Placeholder replaced below once the async work is done (keeps the
    // synchronous splice simple).
    out += ` MERMAID${i} `;
  });
  out += html.slice(cursor);

  for (const [i, b] of blocks.entries()) {
    signal?.throwIfAborted();
    const twin = viewBlocks[i];
    const title = b.title || twin?.title || `So-do-${i + 1}`;
    const svg = b.svg ?? twin?.svg;
    const stem = `${pageId}-${slug(title) || `so-do-${i + 1}`}`;
    const saved: { svgRel?: string; codeRel?: string; code?: string } = {};
    const srcBuf = await downloadConfluenceAttachmentByName(creds, pageId, title, signal);
    const code = srcBuf ? srcBuf.toString('utf8') : null;
    try {
      await fs.mkdir(attachmentsDir, { recursive: true });
      if (code && looksLikeMermaidSource(code)) {
        await fs.writeFile(path.join(attachmentsDir, `${stem}.mmd`), `${code.trim()}\n`, 'utf8');
        saved.codeRel = `${stem}.mmd`;
        saved.code = code;
      }
      let svgText = svg ?? null;
      if (!svgText) {
        const svgBuf = await downloadConfluenceAttachmentByName(creds, pageId, `${title}.svg`, signal);
        svgText = svgBuf ? svgBuf.toString('utf8') : null;
      }
      if (svgText && /<svg\b/i.test(svgText)) {
        // Browser-serialised SVG (unclosed <br> in foreignObject, &nbsp;) is not
        // XML → `<img>` shows a broken icon. Normalise before saving.
        await fs.writeFile(path.join(attachmentsDir, `${stem}.svg`), svgForImgEmbedding(svgText), 'utf8');
        saved.svgRel = `${stem}.svg`;
      }
    } catch (err) {
      console.warn(`[bas] mermaid "${title}": could not save attachment files:`, err);
    }
    console.log(`[bas] mermaid "${title}" (page ${pageId}): ${saved.code ? 'nguồn ✓' : 'KHÔNG có nguồn'} · ${saved.svgRel ? 'svg ✓' : 'không svg'}`);
    out = out.replace(` MERMAID${i} `, mermaidMacroReplacementHtml(title, relPrefix, saved));
  }
  return out;
}

/** Insert `extra` right after the <img> whose src carries `previewName`. */
function appendAfterImage(html: string, previewName: string, extra: string): string {
  const re = new RegExp(
    `<img\\b[^>]*\\bsrc="[^"]*(?:${escapeForRegExp(previewName)}|${escapeForRegExp(encodeURIComponent(previewName))})[^"]*"[^>]*>`,
    'i',
  );
  const m = re.exec(html);
  return m ? html.replace(re, `${m[0]}${extra}`) : html;
}

function escapeForRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  const stem = diagramFileStem(meta);
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

// The HTML → Markdown conversion itself now lives in html-to-markdown.ts (a
// DOM walk, see that module for why). Re-exported here because every caller
// and test reaches it through bas-client.
export { htmlToMarkdown };

/** Direct-PAT page fetch (Data Center REST, same creds the page SEARCH uses —
 * verified live with wiki.servicehub.vn). Returns the RAW rendered HTML —
 * conversion happens later so cross-page links can be rewritten once every
 * fetched page is known.
 *
 * `body.export_view` is the STATIC-EXPORT rendering, and it is what Confluence's
 * own "Export to Markdown" reads. It differs from `body.view` (the browser
 * rendering) in exactly the ways that matter here: macros that render
 * client-side in `view` are already expanded server-side. Measured on four real
 * pages of this wiki, every metric was equal or better and none regressed — the
 * table of contents alone went from an empty `<div>` to 9 nested entries.
 *
 * `view` is still fetched because the draw.io macro survives there with its
 * `data-diagramdata` blob, which is the only way to reach a diagram's SOURCE
 * mxfile and render pages 2..N. `export_view` flattens that macro to the
 * page-1 preview PNG — the same limitation the browser export ships with. */
// Shared direct-PAT REST call for one page's metadata/body — used by the
// fetchConfluencePages pipeline below (seed fetch, link-follow, tree scan)
// without duplicating the request shape three times.
export interface LinkedPageCandidate {
  pageId: string;
  title: string;
  /** Chuỗi TITLE tổ tiên thật (root → cha gần nhất) — FE hiện làm breadcrumb. */
  ancestors: string[];
  /** Title trang seed đầu tiên nhắc tới nó. */
  linkedFrom: string;
}

async function fetchConfluencePageDirect(
  creds: ConfluenceCreds,
  pageId: string,
  signal?: AbortSignal,
): Promise<{ title: string; url: string; html: string; macroHtml: string; ancestors: Array<{ id: string; title: string }> }> {
  const res = await fetch(`${creds.base}/rest/api/content/${pageId}?expand=body.export_view,body.view,space,ancestors`, {
    headers: { authorization: `Bearer ${creds.token}` },
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Confluence REST ${res.status} for page ${pageId}: ${text.slice(0, 160)}`);
  const p = JSON.parse(text) as {
    title?: string;
    body?: { view?: { value?: string }; export_view?: { value?: string } };
    ancestors?: Array<{ id?: string; title?: string }>;
    _links?: { base?: string; webui?: string };
  };
  const url = p._links?.webui
    ? `${(p._links.base ?? creds.base).replace(/\/+$/, '')}${p._links.webui}`
    : `${creds.base}/pages/viewpage.action?pageId=${pageId}`;
  return {
    title: p.title ?? `Confluence page ${pageId}`,
    url,
    // Root→page ancestor chain (used to fold a multi-page selection into folders).
    ancestors: (p.ancestors ?? [])
      .map((a) => ({ id: String(a.id ?? ''), title: a.title ?? '' }))
      .filter((a) => a.id),
    // Prefer export_view; fall back to view if a deployment doesn't serve it.
    html: p.body?.export_view?.value || p.body?.view?.value || '',
    // Kept ONLY to recover multi-page draw.io diagrams (see the docblock).
    macroHtml: p.body?.view?.value ?? '',
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

/** Khám phá các trang được link trực tiếp từ các seed, không ghi xuống đĩa. */
export async function discoverLinkedConfluencePages(
  creds: { base: string; token: string },
  refs: string[],
  opts: { cap?: number } = {},
): Promise<LinkedPageCandidate[]> {
  if (!creds.base.trim() || !creds.token.trim()) {
    throw new Error('Thiếu credential Confluence PAT');
  }
  const cap = Math.max(0, opts.cap ?? FOLLOW_MAX_TOTAL);
  const seedIds = new Set(refs.map(extractPageId));
  const seeds: Array<{ title: string; html: string }> = [];
  for (const ref of refs) {
    const pageId = extractPageId(ref);
    try {
      const page = await fetchConfluencePageDirect(creds, pageId);
      seeds.push(page);
    } catch (err) {
      console.warn(`[bas] seed Confluence page ${pageId} skipped:`, err);
    }
  }

  const candidates = new Map<string, string>();
  for (const seed of seeds) {
    for (const pageId of extractLinkedPageIds(seed.html, creds.base)) {
      if (seedIds.has(pageId) || candidates.has(pageId)) continue;
      candidates.set(pageId, seed.title);
    }
  }

  const pages: LinkedPageCandidate[] = [];
  for (const [pageId, linkedFrom] of [...candidates].slice(0, cap)) {
    try {
      const page = await fetchConfluencePageDirect(creds, pageId);
      pages.push({
        pageId,
        title: page.title,
        ancestors: page.ancestors.map((a) => a.title),
        linkedFrom,
      });
    } catch (err) {
      console.warn(`[bas] linked Confluence page ${pageId} skipped:`, err);
    }
  }
  return pages;
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
    /**
     * Folder-root convention for the returned `relPath`/attachments layout.
     * `'confluence'` (default) is the original dr-docs shape:
     * `docs/confluence/**` for seeds/sub-tree pages, `docs/context/**` for
     * link-followed pages, images under `docs/confluence/attachments`.
     * `'flat'` drops the `confluence`/`context` split — every page lands at
     * `docs/<ancestor-dir>/<slug>.md` (or `docs/<slug>.md` when it has no
     * shared ancestor), images under `docs/attachments`. Used by the App
     * pool importer, whose manifest `path` is relative to `docs/` with the
     * ancestor folder AS the branch (§app-docs-pool-spec.md §2.1) — a
     * `confluence`/`context` prefix would make every page's branch the same
     * constant instead of its subsystem.
     */
    pathLayout?: 'confluence' | 'flat';
    /** Cancels network reads and prevents later conversion/materialization. */
    signal?: AbortSignal;
  } = {},
): Promise<ConfluenceDocPage[]> {
  if (!src.creds && !src.ep) throw new Error('no Confluence credential (PAT) and no BAS gateway configured');
  const followLinks = opts.followLinks !== false;
  const treePathById = new Map<string, string[]>((opts.treePages ?? []).map((t) => [t.pageId, t.treePath]));
  const client = src.ep ? new BasClient(src.ep) : null;
  const fetchViaGateway = async (pageId: string, ref: string) => {
    opts.signal?.throwIfAborted();
    if (!client) throw new Error('BAS gateway not configured');
    const payload = await client.callTool('confluence_fetch_page', { page_id: pageId, format: 'markdown' }, opts.signal);
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
    /** Raw `body.export_view` HTML (direct fetch) — converted in pass 2. */
    html?: string;
    /** Raw `body.view` HTML — kept ONLY to recover multi-page draw.io sources. */
    macroHtml?: string;
    /** Pre-converted markdown (gateway fallback path). */
    markdown?: string;
    linked: boolean;
    /** Folder segments (relative to a scan seed) when this is a sub-tree page. */
    treePath?: string[];
    /** Root→page ancestor chain (direct-PAT seeds) — folds a multi-page pick. */
    ancestors?: Array<{ id: string; title: string }>;
  }
  const fetched = new Map<string, RawPage>();
  const seedIds: string[] = [];
  for (const ref of refs) {
    opts.signal?.throwIfAborted();
    const pageId = extractPageId(ref);
    if (fetched.has(pageId)) continue;
    seedIds.push(pageId);
    if (src.creds) {
      try {
        const p = await fetchConfluencePageDirect(src.creds, pageId, opts.signal);
        fetched.set(pageId, { pageId, ...p, linked: false });
        continue;
      } catch (err) {
        opts.signal?.throwIfAborted();
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
        opts.signal?.throwIfAborted();
        const page = fetched.get(id);
        if (!page?.html) continue;
        for (const linkedId of extractLinkedPageIds(page.html, src.creds.base)) {
          if (fetched.size >= FOLLOW_MAX_TOTAL) break;
          if (fetched.has(linkedId)) continue;
          try {
            const p = await fetchConfluencePageDirect(src.creds, linkedId, opts.signal);
            fetched.set(linkedId, { pageId: linkedId, ...p, linked: true });
            next.push(linkedId);
          } catch (err) {
            opts.signal?.throwIfAborted();
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
      opts.signal?.throwIfAborted();
      if (fetched.has(t.pageId)) {
        const existing = fetched.get(t.pageId)!;
        if (!existing.treePath) existing.treePath = t.treePath;
        continue;
      }
      try {
        const p = await fetchConfluencePageDirect(src.creds, t.pageId, opts.signal);
        fetched.set(t.pageId, { pageId: t.pageId, ...p, linked: true, treePath: t.treePath });
      } catch (err) {
        opts.signal?.throwIfAborted();
        console.warn(`[bas] sub-tree Confluence page ${t.pageId} skipped:`, err);
      }
    }
  }

  const flat = opts.pathLayout === 'flat';

  // Fold a MULTI-page selection into folders: when ≥2 seed pages were picked
  // (e.g. from the tree picker), nest each under the ancestor titles it does NOT
  // share with the others — so a checkbox pick of pages across a Confluence tree
  // lands folder-structured (docs/confluence/<module>/…/<page>.md) exactly like
  // the old sub-tree scan, driving the module grouping in the review UI. A
  // single seed (or a treePage that already carries its path) stays as-is.
  //
  // 'flat' layout (App pool) does NOT use this — collapsing the ancestor
  // prefix EVERY seed shares is right for "N pages that together form one
  // feature's doc bundle" (dr-docs), but wrong for a pool meant to MIRROR the
  // real Confluence tree: it flattens direct children (their own remaining
  // chain below the shared prefix is empty) while still nesting grandchildren
  // under an ancestor title that itself has no fetched page/file to pair with
  // — the exact "flat siblings + orphan raw-slug folder" bug this replaces.
  // `dir` for flat is computed per-page below instead, straight from real
  // Confluence ancestors, filtered to ones actually IN this fetch (see pass 2).
  const seedPages = seedIds.map((id) => fetched.get(id)).filter((p): p is RawPage => !!p && !p.treePath);
  if (!flat && seedPages.length >= 2) {
    const chains = seedPages.map((p) => (p.ancestors ?? []).map((a) => a.id));
    // Longest common leading ancestor prefix shared by EVERY seed.
    let commonLen = Math.min(...chains.map((c) => c.length));
    for (let i = 0; i < commonLen; i += 1) {
      const id = chains[0]![i];
      if (!chains.every((c) => c[i] === id)) {
        commonLen = i;
        break;
      }
    }
    for (const p of seedPages) {
      const anc = p.ancestors ?? [];
      const below = anc.slice(commonLen).map((a) => a.title).filter(Boolean);
      if (below.length) p.treePath = below;
    }
  }

  // ── Pass 2: assign files, then convert with cross-page links rewritten ────
  const attachmentsRoot = flat ? 'docs/attachments' : 'docs/confluence/attachments';
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
    opts.signal?.throwIfAborted();
    // Link-followed pages are CONTEXT ONLY: they nest under docs/context/ (not
    // docs/confluence/) so downstream skills read them for domain understanding
    // but do NOT build screens/mockups from them, and the rail renders them
    // distinctly from the main pages. Seeds + sub-tree pages stay under
    // docs/confluence/ (sub-tree nested by wiki hierarchy, seeds flat).
    const isContext = !!p.linked && !p.treePath;
    // flat: mirror the page's REAL Confluence ancestor chain — NGUYÊN VĂN,
    // TUYỆT ĐỐI (không lọc theo fetched-set, không cắt prefix chung). Hai
    // cách cắt trước đây đều sinh bug: lọc theo fetched-set làm mất cấp khi
    // tick lá không tick cha; cắt prefix-chung-của-đợt-fetch thì import chia
    // BATCH (mỗi batch một lần fetch) ra prefix khác nhau → cùng một trang
    // cha nằm hai độ sâu. Path tuyệt đối thì mọi batch đều ra một kết quả;
    // phần gốc chung do TẦNG TRÊN xử lý (app-pool: branch tính sau prefix
    // pool-wide; AppPoolTree: ẩn chuỗi folder gốc đơn-con khi render).
    // Non-flat keeps the existing treePath convention.
    const dir = flat
      ? (p.ancestors ?? []).map((a) => slug(a.title)).filter(Boolean)
      : (p.treePath ?? []).map(slug).filter(Boolean);
    const folder = flat
      ? ['docs', ...dir].join('/')
      : ['docs', isContext ? 'context' : 'confluence', ...dir].join('/');
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
    opts.signal?.throwIfAborted();
    const relPath = relByPageId.get(p.pageId)!;
    // Relative path from THIS page's folder to the shared attachments dir (all
    // images localize into docs/confluence/attachments, regardless of whether
    // the page itself lives under confluence/ or context/). Using a real
    // relative path keeps context pages' images resolving (../confluence/…).
    const attachmentsPrefix = path.posix.relative(
      path.posix.dirname(relPath),
      attachmentsRoot,
    );
    let body: string;
    if (p.html !== undefined) {
      // Same-host <img src> download (mirrors the bundled
      // confluence_export.py script's localize_images) — only possible on
      // the direct PAT path, which is the only one that has raw HTML + creds
      // to authenticate the image download with.
      let html = p.html;
      let localizedImagePrefix: string | undefined;
      // draw.io: the body is `export_view`, which already flattened each macro
      // to its page-1 preview <img>. Expand those to one <img> PER PAGE using
      // the diagram SOURCE named by the macro in the `view` body — this is the
      // one place we beat Confluence's own Markdown export, which ships page 1
      // only. Without a runtime dir (no headless renderer) the page-1 <img>
      // stands, and localization below downloads it like any page image.
      if (src.creds && opts.attachmentsDir && opts.runtimeDataDir && p.macroHtml) {
        html = await expandDrawioPagesInExportView(
          html,
          p.macroHtml,
          src.creds,
          opts.attachmentsDir,
          attachmentsPrefix,
          opts.runtimeDataDir,
        ).catch((err) => {
          opts.signal?.throwIfAborted();
          console.warn(`[bas] drawio multi-page pass failed for page ${p.pageId} (keeping page-1 previews):`, err);
          return html;
        });
      }
      // Mermaid (Stratus macro): the viewer div carries no <img> at all — pull
      // the source attachment + SVG and splice them in, else the section is
      // empty in Markdown and the flow stage sees a text-only document.
      if (src.creds && opts.attachmentsDir) {
        html = await expandMermaidMacrosInExportView(
          html,
          p.macroHtml ?? '',
          src.creds,
          p.pageId,
          opts.attachmentsDir,
          attachmentsPrefix,
          opts.signal,
        ).catch((err) => {
          opts.signal?.throwIfAborted();
          console.warn(`[bas] mermaid macro pass failed for page ${p.pageId}:`, err);
          return html;
        });
      }
      if (src.creds && opts.attachmentsDir) {
        const localized = await localizeConfluenceImages(
          src.creds,
          html,
          opts.attachmentsDir,
          attachmentsPrefix,
          opts.signal,
        ).catch((err) => {
          opts.signal?.throwIfAborted();
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
  // Link relative to docs/confluence/ (where _index.md lives). Keeps folder
  // nesting for sub-tree pages and resolves context pages up-and-over to
  // ../context/… instead of collapsing to a basename.
  const rel = (p: ConfluenceDocPage) => {
    const r = path.posix.relative('docs/confluence', p.relPath);
    return r.startsWith('.') ? r : `./${r}`;
  };
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
    md +=
      `\n## Trang ngữ cảnh (link từ trang nguồn — CHỈ để hiểu nghiệp vụ)\n\n` +
      `> Các trang dưới đây ở \`docs/context/\`. Đọc để nắm nghiệp vụ, **KHÔNG** dựng màn/mockup từ chúng.\n\n` +
      `${linked.map(row).join('\n')}\n`;
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
  // (The App-pool source is pre-fetched by app-pool.ts's own deterministic
  // path and never reaches this BAS-gateway fetcher — narrow it out here so
  // the union below is exhaustive.)
  if (source.kind !== 'bas') {
    throw new Error(`fetchSourceFiles does not handle source.kind "${(source as { kind: string }).kind}"`);
  }
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
