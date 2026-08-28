import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  ConfluenceResolveError,
  basConfluenceMeta,
  basListDocuments,
  basListFeatures,
  extractPageId,
  parseConfluenceRef,
  resolveConfluencePage,
  fetchConfluencePages,
  discoverLinkedConfluencePages,
  fetchSourceFiles,
  listDescendantPages,
  naturalSegsCompare,
  looksLikeConfluenceRef,
  looksLikeJiraInput,
  renderConfluenceIndex,
  resolveBasEndpoint,
  searchConfluencePages,
} from '../src/bas/bas-client.js';
import { parseRunSource } from '../src/pipeline-routes.js';

const EP = { url: 'https://bas.test/api/mcp/', token: 'tok_123' };

// Build a minimal Response-like object for the fetch stub.
function makeRes(
  body: string,
  opts: { status?: number; contentType?: string; sessionId?: string } = {},
) {
  const headers = new Map<string, string>([
    ['content-type', opts.contentType ?? 'application/json'],
  ]);
  if (opts.sessionId) headers.set('mcp-session-id', opts.sessionId);
  return {
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: async () => body,
  };
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

// Wrap a tool payload the way the BAS gateway does: result.content[].text is a
// JSON-serialized string.
function toolResult(id: unknown, payload: unknown) {
  return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false });
}

// Route the stub by JSON-RPC method; tools/call dispatches to onToolCall(name,args).
function stubFetch(onToolCall: (name: string, args: any) => ReturnType<typeof makeRes>) {
  globalThis.fetch = vi.fn(async (_url: any, init: any) => {
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return makeRes(rpcResult(msg.id, { protocolVersion: '2025-03-26' }), { sessionId: 's1' }) as any;
    if (msg.method === 'notifications/initialized') return makeRes('', { status: 202 }) as any;
    if (msg.method === 'tools/call') return onToolCall(msg.params.name, msg.params.arguments) as any;
    return makeRes(rpcResult(msg.id, {})) as any;
  }) as any;
}

let savedFetch: typeof globalThis.fetch;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedEnv = { url: process.env.BAS_MCP_URL, token: process.env.BAS_MCP_TOKEN };
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env.BAS_MCP_URL = savedEnv.url;
  process.env.BAS_MCP_TOKEN = savedEnv.token;
});

test('resolveBasEndpoint prefers env BAS_MCP_URL + BAS_MCP_TOKEN', async () => {
  process.env.BAS_MCP_URL = 'https://env.bas/mcp/';
  process.env.BAS_MCP_TOKEN = 'Bearer env_tok'; // "Bearer " prefix must be stripped
  const ep = await resolveBasEndpoint('/nonexistent-data-dir');
  assert.deepEqual(ep, { url: 'https://env.bas/mcp/', token: 'env_tok' });
});

// ── WP confluence-paste-link: parseConfluenceRef + resolveConfluencePage ─────

test('parseConfluenceRef recognises the 6 supported link shapes', () => {
  assert.deepEqual(parseConfluenceRef(' 874352117 '), { kind: 'id', id: '874352117' });
  assert.deepEqual(parseConfluenceRef('https://wiki.test/pages/874352117/Login'), { kind: 'id', id: '874352117' });
  assert.deepEqual(parseConfluenceRef('https://wiki.test/pages/viewpage.action?pageId=98765'), { kind: 'id', id: '98765' });
  // Cloud shape — matches the /pages/<id> rule.
  assert.deepEqual(parseConfluenceRef('https://x.atlassian.net/wiki/spaces/CONSOC/pages/555/Abc'), { kind: 'id', id: '555' });
  // Server "display" shape: title URL-encoded, `+` = space, trailing query dropped.
  assert.deepEqual(parseConfluenceRef('https://wiki.test/display/CONSOC/%C4%90%C4%83ng+nh%E1%BA%ADp+SDK?src=contextnav'), {
    kind: 'title',
    space: 'CONSOC',
    title: 'Đăng nhập SDK',
  });
  // Tiny link keeps the full URL so it can be followed.
  assert.deepEqual(parseConfluenceRef('https://wiki.test/x/AbC-1_'), { kind: 'tiny', url: 'https://wiki.test/x/AbC-1_' });
  assert.deepEqual(parseConfluenceRef('https://wiki.test/wiki/x/AbC'), { kind: 'tiny', url: 'https://wiki.test/wiki/x/AbC' });
});

test('parseConfluenceRef rejects anything else with a 400 that lists the supported shapes', () => {
  for (const bad of ['', 'Đăng nhập', 'https://wiki.test/spaces/CONSOC/overview', 'https://jira.test/browse/PRJ-1']) {
    assert.throws(
      () => parseConfluenceRef(bad),
      (err: unknown) =>
        err instanceof ConfluenceResolveError && err.status === 400 && /page id/.test(err.message) && /display/.test(err.message) && /\/x\//.test(err.message),
      `should reject ${JSON.stringify(bad)}`,
    );
  }
  // `/x/` must be a real http(s) URL — a bare path can't be followed.
  assert.throws(() => parseConfluenceRef('/x/AbC'), /page id/);
});

function patFetchStub(routes: Record<string, () => { status?: number; body?: unknown; location?: string }>) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    if (!key) return { ok: false, status: 599, headers: { get: () => null }, text: async () => `no stub for ${url}` } as any;
    const r = routes[key]!();
    const status = r.status ?? 200;
    const headers = new Map<string, string>();
    if (r.location) headers.set('location', r.location);
    return {
      ok: status < 400,
      status,
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    } as any;
  }) as any;
  return calls;
}

const PAT = { base: 'https://wiki.test', token: 'pat' };

test('resolveConfluencePage (PAT, id) maps /rest/api/content/<id> to a search-shaped hit', async () => {
  const calls = patFetchStub({
    'https://wiki.test/rest/api/content/301?': () => ({
      body: {
        id: '301',
        title: 'Đăng nhập',
        space: { key: 'XPOS' },
        _links: { base: 'https://wiki.test/', webui: '/spaces/XPOS/pages/301/Dang-nhap' },
        ancestors: [{ id: '2', title: 'Space XPOS' }, { id: '200', title: 'Dự án XPOS' }],
        children: { page: { size: 2, results: [] } },
      },
    }),
  });
  const hit = await resolveConfluencePage(PAT, null, 'https://wiki.test/spaces/XPOS/pages/301/Dang-nhap');
  assert.deepEqual(hit, {
    id: '301',
    title: 'Đăng nhập',
    url: 'https://wiki.test/spaces/XPOS/pages/301/Dang-nhap',
    space: 'XPOS',
    ancestors: ['Space XPOS', 'Dự án XPOS'],
    hasChildren: true,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /expand=space,ancestors,children\.page/);
  assert.equal(calls[0]!.init.headers.authorization, 'Bearer pat');
  // PAT wins even when a BAS endpoint is configured (same order as search).
  const again = await resolveConfluencePage(PAT, EP, '301');
  assert.equal(again.id, '301');
  assert.equal(calls.length, 2);
});

test('resolveConfluencePage (PAT, /display/SPACE/Title) runs an exact CQL and takes the first result', async () => {
  const calls = patFetchStub({
    'https://wiki.test/rest/api/content/search?': () => ({
      body: { results: [{ id: '777', title: 'Đăng nhập "SDK"', space: { key: 'CONSOC' }, _links: { webui: '/display/CONSOC/x' } }] },
    }),
  });
  const hit = await resolveConfluencePage(PAT, null, 'https://wiki.test/display/CONSOC/%C4%90%C4%83ng+nh%E1%BA%ADp+%22SDK%22');
  assert.deepEqual(hit, { id: '777', title: 'Đăng nhập "SDK"', space: 'CONSOC', url: 'https://wiki.test/display/CONSOC/x' });
  const cql = decodeURIComponent(new URL(calls[0]!.url).searchParams.get('cql')!);
  assert.equal(cql, 'type=page AND space="CONSOC" AND title="Đăng nhập \\"SDK\\""');
  assert.equal(new URL(calls[0]!.url).searchParams.get('limit'), '1');
});

test('resolveConfluencePage (PAT, /display/…) with no CQL match → 404', async () => {
  patFetchStub({ 'https://wiki.test/rest/api/content/search?': () => ({ body: { results: [] } }) });
  await assert.rejects(
    resolveConfluencePage(PAT, null, 'https://wiki.test/display/CONSOC/Nope'),
    (err: unknown) => err instanceof ConfluenceResolveError && err.status === 404,
  );
});

test('resolveConfluencePage (PAT, /x/<tiny>) follows the redirect manually, then resolves the id', async () => {
  const calls = patFetchStub({
    'https://wiki.test/x/AbC': () => ({ status: 302, location: '/pages/viewpage.action?pageId=4242' }),
    'https://wiki.test/rest/api/content/4242?': () => ({ body: { id: '4242', title: 'Từ tiny', _links: { webui: '/pages/4242' } } }),
  });
  const hit = await resolveConfluencePage(PAT, null, 'https://wiki.test/x/AbC');
  assert.deepEqual(hit, { id: '4242', title: 'Từ tiny', url: 'https://wiki.test/pages/4242' });
  assert.equal(calls[0]!.init.redirect, 'manual');
  assert.equal(calls[0]!.init.headers.authorization, 'Bearer pat');
  assert.equal(calls.length, 2);
});

test('resolveConfluencePage (PAT, /x/<tiny>) gives up after 3 hops and 404s when the target is not a page', async () => {
  patFetchStub({ 'https://wiki.test/x/': () => ({ status: 301, location: 'https://wiki.test/x/loop' }) });
  await assert.rejects(
    resolveConfluencePage(PAT, null, 'https://wiki.test/x/loop'),
    (err: unknown) => err instanceof ConfluenceResolveError && err.status === 502 && /3/.test(err.message),
  );
  patFetchStub({ 'https://wiki.test/x/': () => ({ status: 302, location: 'https://wiki.test/spaces/CONSOC/overview' }) });
  await assert.rejects(
    resolveConfluencePage(PAT, null, 'https://wiki.test/x/ovw'),
    (err: unknown) => err instanceof ConfluenceResolveError && err.status === 404,
  );
});

test('resolveConfluencePage (PAT) maps Confluence 404/403 to status 404 and other HTTP errors to 502', async () => {
  patFetchStub({ 'https://wiki.test/rest/api/content/1?': () => ({ status: 404, body: 'nope' }) });
  await assert.rejects(resolveConfluencePage(PAT, null, '1'), (err: unknown) => err instanceof ConfluenceResolveError && err.status === 404);
  patFetchStub({ 'https://wiki.test/rest/api/content/2?': () => ({ status: 403, body: 'forbidden' }) });
  await assert.rejects(resolveConfluencePage(PAT, null, '2'), (err: unknown) => err instanceof ConfluenceResolveError && err.status === 404);
  patFetchStub({ 'https://wiki.test/rest/api/content/3?': () => ({ status: 500, body: 'boom' }) });
  await assert.rejects(resolveConfluencePage(PAT, null, '3'), (err: unknown) => err instanceof ConfluenceResolveError && err.status === 502);
});

test('resolveConfluencePage falls back to the BAS gateway (id only) when there is no PAT', async () => {
  stubFetch((name, args) => {
    assert.equal(name, 'confluence_fetch_page');
    assert.equal(args.page_id, '301');
    return makeRes(toolResult(2, { page_id: '301', title: 'Đăng nhập', space_key: 'XPOS', url: 'https://wiki.test/pages/301', markdown: '# hi' }));
  });
  const hit = await resolveConfluencePage(null, EP, 'https://wiki.test/pages/301/Dang-nhap');
  assert.deepEqual(hit, { id: '301', title: 'Đăng nhập', url: 'https://wiki.test/pages/301', space: 'XPOS' });
  assert.equal('ancestors' in hit, false);
  assert.equal('hasChildren' in hit, false);
});

test('resolveConfluencePage without PAT: /display and /x need a PAT (502), bad ref is 400, nothing configured is 502', async () => {
  globalThis.fetch = vi.fn(async () => {
    throw new Error('must not hit the network');
  }) as any;
  await assert.rejects(
    resolveConfluencePage(null, EP, 'https://wiki.test/display/CONSOC/Login'),
    (err: unknown) => err instanceof ConfluenceResolveError && err.status === 502 && /PAT/.test(err.message) && /Integrations/.test(err.message),
  );
  await assert.rejects(
    resolveConfluencePage(null, EP, 'https://wiki.test/x/AbC'),
    (err: unknown) => err instanceof ConfluenceResolveError && err.status === 502 && /PAT/.test(err.message),
  );
  await assert.rejects(
    resolveConfluencePage(null, EP, 'not a link'),
    (err: unknown) => err instanceof ConfluenceResolveError && err.status === 400,
  );
  await assert.rejects(
    resolveConfluencePage(null, null, '301'),
    (err: unknown) => err instanceof ConfluenceResolveError && err.status === 502 && /Integrations/.test(err.message),
  );
});

test('extractPageId pulls the id from a Confluence URL or a bare number', () => {
  assert.equal(extractPageId('874352117'), '874352117');
  assert.equal(extractPageId('https://wiki.test/spaces/CONSOC/pages/874352117/Login'), '874352117');
  assert.equal(extractPageId('https://wiki.test/pages/viewpage.action?pageId=98765'), '98765');
  assert.throws(() => extractPageId('https://wiki.test/display/CONSOC/Login'), /page id/);
});

test('basListDocuments maps kg_list_documents rows', async () => {
  let called = '';
  stubFetch((name) => {
    called = name;
    return makeRes(toolResult(2, [{ document_id: 'my-project-001', node_count: 3, edge_count: 2, last_updated: '2026-06-12T03:28:04Z' }]));
  });
  const docs = await basListDocuments(EP);
  assert.equal(called, 'kg_list_documents');
  assert.deepEqual(docs, [{ id: 'my-project-001', nodeCount: 3, updatedAt: '2026-06-12T03:28:04Z' }]);
});

test('basListFeatures extracts FEATURE nodes from the document subgraph', async () => {
  let sentArgs: any = null;
  stubFetch((name, args) => {
    assert.equal(name, 'kg_get_document_subgraph');
    sentArgs = args;
    return makeRes(toolResult(2, {
      nodes: [
        { id: 'feature-1', type: 'FEATURE', reference_id: 'F-001', summary: 'Đăng nhập', description: 'User login feature' },
        { id: 'br-1', type: 'BUSINESS_RULE', summary: 'Mật khẩu tối thiểu 8 ký tự' },
      ],
      edges: [],
    }));
  });
  const feats = await basListFeatures(EP, 'my-project-001');
  assert.deepEqual(sentArgs, { document_id: 'my-project-001', include_edges: false });
  assert.deepEqual(feats, [{ id: 'F-001', name: 'Đăng nhập', documentId: 'my-project-001', summary: 'User login feature' }]);
});

test('basConfluenceMeta extracts page_id, sends format:markdown, strips body to excerpt', async () => {
  let sentArgs: any = null;
  stubFetch((name, args) => {
    assert.equal(name, 'confluence_fetch_page');
    sentArgs = args;
    return makeRes(toolResult(2, { page_id: '874352117', title: 'Login Flow', space_key: 'CONSOC', url: 'https://wiki/874352117', markdown: 'Hello world from Confluence' }));
  });
  const meta = await basConfluenceMeta(EP, 'https://wiki.test/pages/874352117/Login');
  assert.deepEqual(sentArgs, { page_id: '874352117', format: 'markdown' });
  assert.equal(meta.title, 'Login Flow');
  assert.equal(meta.space, 'CONSOC');
  assert.equal(meta.excerpt, 'Hello world from Confluence');
});

test('basListDocuments parses a text/event-stream (SSE) tools/call response', async () => {
  const payload = toolResult(2, [{ document_id: 'A', node_count: 1 }]);
  stubFetch(() => makeRes(`event: message\ndata: ${payload}\n\n`, { contentType: 'text/event-stream' }));
  const docs = await basListDocuments(EP);
  assert.deepEqual(docs, [{ id: 'A', nodeCount: 1 }]);
});

test('fetchSourceFiles(confluence) writes one markdown file with frontmatter', async () => {
  stubFetch(() => makeRes(toolResult(2, { page_id: '12', title: 'Spec Page', url: 'https://wiki/12', markdown: '# Spec\nbody text' })));
  const files = await fetchSourceFiles(EP, { kind: 'confluence', ref: 'https://wiki/pages/12/Spec' });
  assert.equal(files.length, 1);
  assert.match(files[0]!.relPath, /^docs\/source\/confluence\/.*\.md$/);
  assert.match(files[0]!.content, /page_id: 12/);
  assert.match(files[0]!.content, /source: confluence/);
  assert.match(files[0]!.content, /# Spec/);
});

test('looksLikeConfluenceRef gates the deterministic docs path (page id resolvable → true)', () => {
  assert.equal(looksLikeConfluenceRef('874352117'), true);
  assert.equal(looksLikeConfluenceRef('https://wiki.test/spaces/X/pages/874352117/Login'), true);
  assert.equal(looksLikeConfluenceRef('https://wiki.test/pages/viewpage.action?pageId=98765'), true);
  // Opaque short links / JIRA keys / JQL → not a resolvable Confluence ref
  // (WP8: neither route reaches an agent anymore — see looksLikeJiraInput
  // below, which now only picks a rejection message).
  assert.equal(looksLikeConfluenceRef('https://wiki.test/x/AbCd'), false);
  assert.equal(looksLikeConfluenceRef('PROJ-123'), false);
  assert.equal(looksLikeConfluenceRef('project = PROJ ORDER BY created'), false);
});

test('looksLikeJiraInput identifies JIRA-shaped input (WP8: used only to pick a "no longer supported" rejection message, not to route to an agent) — real JIRA keys/JQL match, everything else (incl. corpus paths, plain text) does not', () => {
  // Issue key, one per line, and a bare project key ("give me the whole project").
  assert.equal(looksLikeJiraInput('PROJ-123'), true);
  assert.equal(looksLikeJiraInput('PROJ-123\nABC-9'), true);
  assert.equal(looksLikeJiraInput('PROJ'), true);
  assert.equal(looksLikeJiraInput('  PROJ-123  \n\n'), true); // surrounding blank lines tolerated
  // JQL: any of the three documented hints, anywhere in the (possibly
  // multi-line) input.
  assert.equal(looksLikeJiraInput('project = PROJ'), true);
  assert.equal(looksLikeJiraInput('project = PROJ ORDER BY created DESC'), true);
  assert.equal(looksLikeJiraInput('assignee = currentUser()'), true);
  assert.equal(looksLikeJiraInput('status = "In Progress" ORDER BY updated'), true);

  // Ghost-run vectors this heuristic exists to reject — corpus file paths,
  // plain text, a stray non-key uppercase word, an empty/whitespace string.
  assert.equal(looksLikeJiraInput('Overview.md'), false);
  assert.equal(looksLikeJiraInput('nested/sub/dir/page.md'), false);
  assert.equal(looksLikeJiraInput('Đây là văn bản tiếng Việt bình thường'), false);
  assert.equal(looksLikeJiraInput('random text pasted by mistake'), false);
  assert.equal(looksLikeJiraInput(''), false);
  assert.equal(looksLikeJiraInput('   \n  '), false);
  // A MIX of one real key + one non-key line must NOT pass — every line
  // must qualify, matching looksLikeConfluenceRef's own "every line" gate.
  assert.equal(looksLikeJiraInput('PROJ-123\nOverview.md'), false);
});

test('fetchConfluencePages (gateway fallback) fetches every ref as a final docs/confluence/ deliverable', async () => {
  stubFetch((name, args) => {
    assert.equal(name, 'confluence_fetch_page');
    return makeRes(
      toolResult(2, {
        page_id: args.page_id,
        title: `Page ${args.page_id}`,
        url: `https://wiki/${args.page_id}`,
        markdown: `# Page ${args.page_id}\nbody`,
      }),
    );
  });
  const pages = await fetchConfluencePages({ ep: EP }, ['https://wiki/pages/12/Spec', '34']);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((p) => p.pageId), ['12', '34']);
  // FINAL output paths (docs/confluence/…), not the agent-input docs/source/ tree.
  assert.match(pages[0]!.relPath, /^docs\/confluence\/.*\.md$/);
  assert.match(pages[0]!.content, /source: confluence/);
  assert.match(pages[0]!.content, /# Page 12/);
  // _index.md companion lists every page with its id + url.
  const index = renderConfluenceIndex(pages);
  assert.match(index, /Page 12/);
  assert.match(index, /page 34/);
});

test('htmlToMarkdown decodes named Latin-1 + numeric entities (Vietnamese wiki text)', async () => {
  const { htmlToMarkdown } = await import('../src/bas/bas-client.js');
  const md = htmlToMarkdown('<p>Phi&ecirc;n bản t&agrave;i liệu &#7871; &#x1EBF; &amp; m&ocirc; tả</p>');
  assert.equal(md, 'Phiên bản tài liệu ế ế & mô tả');
});

test('htmlToMarkdown drops inline highlight spans WITHOUT splitting words (Confluence bôi vàng mid-word)', async () => {
  const { htmlToMarkdown } = await import('../src/bas/bas-client.js');
  // Real shape from wiki body.view: the author's yellow highlight starts and
  // ends mid-word, so <span> boundaries sit inside words. The old generic
  // tag→space strip inside <li>/table cells produced "t oàn bộ hồ sơ N CC".
  const md = htmlToMarkdown(
    '<ul><li>hiển thị t<span style="background-color:#ffea00">oàn bộ hồ sơ N</span>CC đã tạo, ' +
      'tìm kiếm th<span class="inline-highlight">eo</span> tên</li></ul>' +
      '<table><tr><td>lọc th<span style="background-color:#ffea00">eo</span> Loại</td></tr></table>',
  );
  assert.match(md, /hiển thị toàn bộ hồ sơ NCC đã tạo/);
  assert.match(md, /tìm kiếm theo tên/);
  assert.match(md, /lọc theo Loại/);
});

test('htmlToMarkdown keeps nested list hierarchy instead of flattening it into one line', async () => {
  const { htmlToMarkdown } = await import('../src/bas/bas-client.js');
  // Real shape from the NCC spec page: a bullet whose content is a heading,
  // with the screen description as a NESTED sub-bullet. The old single-pass
  // <li> regex merged the heading and the first sub-bullet into one flat line.
  const md = htmlToMarkdown(
    '<ul><li><h2>MH-NCC-01 – Danh sách Nhà cung cấp</h2>' +
      '<ul><li><strong>Ý nghĩa màn hình:</strong> Màn danh sách</li>' +
      '<li><em>UI Screen tương ứng</em></li></ul></li></ul>',
  );
  const lines = md.split('\n').filter(Boolean);
  assert.equal(lines[0], '- ## MH-NCC-01 – Danh sách Nhà cung cấp');
  assert.equal(lines[1], '  - **Ý nghĩa màn hình:** Màn danh sách');
  assert.equal(lines[2], '  - *UI Screen tương ứng*');
});

// Real shape from wiki body.view: a draw.io macro is a JS mount div + a
// base64 JSON blob naming the server-rendered PNG preview attachment — no
// <img> at all, so the converter used to drop the diagram and leak the
// hidden title div as junk text ("Untitled Diagram-…").
const DRAWIO_DATA = Buffer.from(
  JSON.stringify({ previewName: 'Untitled Diagram-1783562766184.png', owningPageId: 992678790, diagramName: '' }),
).toString('base64');
const DRAWIO_MACRO =
  '<div style="display:block;" class="conf-macro output-block" data-hasbody="false" data-macro-name="drawio" data-content-id="992678790">' +
  '<div style="display:none">Untitled Diagram-1783562766184</div>' +
  '<div class="drawio-macro" id="drawio-macro-content-x" style="width:1176px;"></div>' +
  `<div id="drawio-macro-data-x" style="display:none" data-diagramdata="${DRAWIO_DATA}"></div>` +
  '</div>';

test('inlineDrawioPreviews rewrites a draw.io macro into a same-host <img> for its PNG preview', async () => {
  const { inlineDrawioPreviews } = await import('../src/bas/bas-client.js');
  const html = `<p>trước</p>${DRAWIO_MACRO}<p>sau</p>`;
  const out = inlineDrawioPreviews(html, 'https://wiki.test');
  assert.match(
    out,
    /<img src="https:\/\/wiki\.test\/download\/attachments\/992678790\/Untitled%20Diagram-1783562766184\.png"/,
  );
  // The macro block (incl. its hidden junk title) is gone; neighbors survive.
  assert.doesNotMatch(out, /display:none/);
  assert.match(out, /<p>trước<\/p>/);
  assert.match(out, /<p>sau<\/p>/);
});

test('inlineDrawioPreviews strips an unparsable macro whole instead of leaking its hidden title', async () => {
  const { inlineDrawioPreviews } = await import('../src/bas/bas-client.js');
  const broken =
    '<div class="conf-macro" data-macro-name="drawio">' +
    '<div style="display:none">Untitled Diagram-999</div>' +
    '<div class="drawio-macro"></div>' +
    '</div>';
  const out = inlineDrawioPreviews(`<p>a</p>${broken}<p>b</p>`, 'https://wiki.test');
  assert.doesNotMatch(out, /Untitled Diagram-999/);
  assert.match(out, /<p>a<\/p>/);
  assert.match(out, /<p>b<\/p>/);
});

test('htmlToMarkdown numbers ordered-list items', async () => {
  const { htmlToMarkdown } = await import('../src/bas/bas-client.js');
  const md = htmlToMarkdown('<ol><li>Bước một</li><li>Bước hai</li></ol>');
  const lines = md.split('\n').filter(Boolean);
  assert.equal(lines[0], '1. Bước một');
  assert.equal(lines[1], '2. Bước hai');
});

test('htmlToMarkdown emits REAL GFM tables (separator row, padded cells, escaped pipes, nested)', async () => {
  const { htmlToMarkdown } = await import('../src/bas/bas-client.js');
  const md = htmlToMarkdown(
    '<table><tr><th>Cột A</th><th>Cột B</th></tr>' +
      '<tr><td>x | y</td><td><table><tr><td>trong</td></tr></table></td></tr>' +
      '<tr><td>thiếu ô</td></tr></table>',
  );
  const lines = md.split('\n').filter(Boolean);
  assert.equal(lines[0], '| Cột A | Cột B |');
  assert.equal(lines[1], '| --- | --- |');
  // Escaped pipe survives; the nested table flattens into the outer cell.
  assert.match(lines[2]!, /^\| x \\\| y \| .*trong.* \|$/);
  // Short row padded to the header width.
  assert.equal(lines[3], '| thiếu ô |  |');
});

test('listDescendantPages returns the whole sub-tree with folder path relative to the seed', async () => {
  globalThis.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    assert.match(u, /\/rest\/api\/content\/search\?cql=ancestor%3D100/);
    assert.match(u, /expand=ancestors/);
    return makeRes(
      JSON.stringify({
        results: [
          {
            id: '301',
            title: '1. Thiết lập',
            // root→page; the seed (100) sits mid-path, and "I. Tài khoản" is
            // the only ancestor BELOW the seed → the folder segment.
            ancestors: [
              { id: '1', title: 'Space' },
              { id: '100', title: 'B1. PRD' },
              { id: '200', title: 'I. Tài khoản' },
            ],
          },
          { id: '200', title: 'I. Tài khoản', ancestors: [{ id: '1', title: 'Space' }, { id: '100', title: 'B1. PRD' }] },
        ],
        size: 2,
      }),
    ) as any;
  }) as any;
  const desc = await listDescendantPages({ base: 'https://wiki.test', token: 'pat' }, '100');
  assert.deepEqual(desc, [
    { pageId: '301', title: '1. Thiết lập', treePath: ['I. Tài khoản'] },
    { pageId: '200', title: 'I. Tài khoản', treePath: [] },
  ]);
});

test('searchConfluencePages (direct PAT) maps each hit\'s ancestors (root→down, page excluded) and hasChildren (existence-only) so the App-root dropdown can distinguish + expand pages correctly', async () => {
  globalThis.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    assert.match(u, /\/rest\/api\/content\/search\?cql=/);
    assert.match(u, /expand=space,ancestors,children\.page/);
    return makeRes(
      JSON.stringify({
        results: [
          {
            id: '301',
            title: 'Đăng nhập',
            space: { key: 'XPOS' },
            _links: { webui: '/spaces/XPOS/pages/301/Dang-nhap' },
            ancestors: [
              { id: '1', title: 'Space XPOS' },
              { id: '100', title: 'Dự án XPOS' },
            ],
          },
          {
            // Same title, DIFFERENT dự án — ancestors is what tells them apart.
            id: '777',
            title: 'Đăng nhập',
            space: { key: 'VNPAY' },
            ancestors: [
              { id: '2', title: 'Space VNPAY' },
              { id: '200', title: 'Dự án VNPAY' },
            ],
          },
          // No ancestors on this hit (top-level page, or field omitted) →
          // the mapped hit must not carry an empty/garbage ancestors array.
          { id: '888', title: 'Trang gốc' },
          // Has children (non-empty children.page.results, no `size`) → true.
          { id: '111', title: 'Thư mục cha', children: { page: { results: [{ id: '112' }] } } },
          // Empty children.page.results → false.
          { id: '222', title: 'Trang lá', children: { page: { results: [] } } },
          // No children block at all → undefined (unknown, not "no children").
          { id: '333', title: 'Không rõ' },
        ],
      }),
    ) as any;
  }) as any;

  const hits = await searchConfluencePages(null, 'Đăng nhập', 25, { base: 'https://wiki.test', token: 'pat' });
  assert.deepEqual(hits, [
    {
      id: '301',
      title: 'Đăng nhập',
      url: 'https://wiki.test/spaces/XPOS/pages/301/Dang-nhap',
      space: 'XPOS',
      ancestors: ['Space XPOS', 'Dự án XPOS'],
    },
    {
      id: '777',
      title: 'Đăng nhập',
      space: 'VNPAY',
      ancestors: ['Space VNPAY', 'Dự án VNPAY'],
    },
    { id: '888', title: 'Trang gốc' },
    { id: '111', title: 'Thư mục cha', hasChildren: true },
    { id: '222', title: 'Trang lá', hasChildren: false },
    { id: '333', title: 'Không rõ' },
  ]);
  // Every existing field stayed intact for the no-ancestors hit — no stray
  // `ancestors: []` key.
  assert.equal('ancestors' in hits[2]!, false);
  // The unknown-children hit must not carry a guessed `hasChildren` key.
  assert.equal('hasChildren' in hits[5]!, false);
});

test('searchConfluencePages (direct PAT) prefers children.page.size over results.length when both are present', async () => {
  globalThis.fetch = vi.fn(async () =>
    makeRes(
      JSON.stringify({
        results: [
          // size says 3 children even though this page's results array (the
          // default-limited preview) happens to be empty.
          { id: '444', title: 'Size wins (true)', children: { page: { size: 3, results: [] } } },
          // size says 0 even though a stale/truncated results array is non-empty.
          { id: '555', title: 'Size wins (false)', children: { page: { size: 0, results: [{ id: '556' }] } } },
        ],
      }),
    ) as any,
  ) as any;

  const hits = await searchConfluencePages(null, 'x', 25, { base: 'https://wiki.test', token: 'pat' });
  assert.deepEqual(hits, [
    { id: '444', title: 'Size wins (true)', hasChildren: true },
    { id: '555', title: 'Size wins (false)', hasChildren: false },
  ]);
});

test('searchConfluencePages (BAS gateway fallback) leaves ancestors and hasChildren undefined — the tool has no equivalent field', async () => {
  stubFetch((name) => {
    assert.equal(name, 'confluence_search');
    return makeRes(toolResult(2, [{ page_id: '301', title: 'Đăng nhập', space_key: 'XPOS' }]));
  });
  const hits = await searchConfluencePages(EP, 'Đăng nhập');
  assert.deepEqual(hits, [{ id: '301', title: 'Đăng nhập', space: 'XPOS' }]);
  assert.equal('ancestors' in hits[0]!, false);
  assert.equal('hasChildren' in hits[0]!, false);
});

test('fetchConfluencePages nests sub-tree pages into folders and depth-corrects the image prefix', async () => {
  const attachmentsDir = await mkdtemp(join(tmpdir(), 'bas-tree-'));
  try {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.startsWith('https://wiki.test/rest/api/content/100?')) {
        return makeRes(
          JSON.stringify({ title: 'B1. PRD', body: { view: { value: '<p>seed</p>' } }, _links: { base: 'https://wiki.test', webui: '/x/100' } }),
        ) as any;
      }
      if (u.startsWith('https://wiki.test/rest/api/content/301?')) {
        return makeRes(
          JSON.stringify({
            title: '1. Thiết lập',
            body: { view: { value: '<p><img src="/download/attachments/301/pic.png" alt="mh"></p>' } },
            _links: { base: 'https://wiki.test', webui: '/x/301' },
          }),
        ) as any;
      }
      if (u.startsWith('https://wiki.test/download/attachments/301/pic.png')) {
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer } as any;
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;
    const pages = await fetchConfluencePages(
      { creds: { base: 'https://wiki.test', token: 'pat' } },
      ['100'],
      { attachmentsDir, followLinks: false, treePages: [{ pageId: '301', title: '1. Thiết lập', treePath: ['I. Tài khoản'] }] },
    );
    const seed = pages.find((p) => p.pageId === '100')!;
    const child = pages.find((p) => p.pageId === '301')!;
    // Seed stays flat; child nests one folder deep by its treePath slug
    // (slug() de-accents Vietnamese, so "I. Tài khoản" → "I.-Tai-khoan").
    assert.equal(seed.relPath, 'docs/confluence/B1.-PRD.md');
    assert.equal(child.relPath, 'docs/confluence/I.-Tai-khoan/1.-Thiet-lap.md');
    assert.equal(child.viaTree, true);
    // A page one folder deep reaches the shared attachments dir via ../.
    assert.match(child.content, /!\[mh\]\(\.\.\/attachments\/pic\.png\)/);
  } finally {
    await rm(attachmentsDir, { recursive: true, force: true });
  }
});

// Regression: App-pool import (apps/daemon/src/app-pool.ts) reported a broken
// pool tree — direct children of a picked page landed FLAT (top-level)
// instead of nested under it, and some folders showed a raw un-paired slug
// with no title. Root cause: 'flat' layout was reusing the 'confluence'
// layout's "fold ALL picked pages' shared ancestor PREFIX away" logic, which
// is right for a single feature's doc bundle but wrong for a pool meant to
// MIRROR the real tree. Fixed by computing `dir` from each page's OWN real
// ancestors, filtered to ancestors that are THEMSELVES part of this fetch —
// so a folder segment always pairs with the ancestor page's own file (same
// `slug()` call on the same title), at whatever depth the picked set reaches.
function directPageRes(page: {
  title: string;
  ancestors?: Array<{ id: string; title: string }>;
}) {
  return makeRes(
    JSON.stringify({
      title: page.title,
      body: { view: { value: `<p>${page.title}</p>` } },
      ancestors: page.ancestors ?? [],
      _links: { base: 'https://wiki.test', webui: '/x' },
    }),
  );
}

function directLinkedPageRes(page: {
  title: string;
  html?: string;
  ancestors?: Array<{ id: string; title: string }>;
}, status = 200) {
  return makeRes(
    JSON.stringify({
      title: page.title,
      body: { view: { value: page.html ?? `<p>${page.title}</p>` } },
      ancestors: page.ancestors ?? [],
      _links: { base: 'https://wiki.test', webui: '/x' },
    }),
    { status },
  );
}

test('discoverLinkedConfluencePages discovers unique depth-1 links with seed provenance and ancestors', async () => {
  const pages: Record<string, ReturnType<typeof directLinkedPageRes>> = {
    '1': directLinkedPageRes({ title: 'Seed A', html: '<a href="/pages/3/X">X</a><a href="/pages/2/B">B</a><a href="/pages/1/A">A</a>' }),
    '2': directLinkedPageRes({ title: 'Seed B', html: '<a href="/pages/3/X">X</a>' }),
    '3': directLinkedPageRes({ title: 'X', ancestors: [{ id: '0', title: 'Root' }, { id: '9', title: 'Parent' }] }),
  };
  globalThis.fetch = vi.fn(async (url: any) => pages[/\/content\/(\d+)\?/.exec(String(url))?.[1] ?? ''] as any);
  const result = await discoverLinkedConfluencePages({ base: 'https://wiki.test', token: 'pat' }, ['1', '2']);
  assert.deepEqual(result, [{ pageId: '3', title: 'X', ancestors: ['Root', 'Parent'], linkedFrom: 'Seed A' }]);
  assert.equal((globalThis.fetch as any).mock.calls.length, 3);
});

test('discoverLinkedConfluencePages applies cap and skips failed candidates', async () => {
  const pages: Record<string, ReturnType<typeof directLinkedPageRes>> = {
    '1': directLinkedPageRes({ title: 'Seed', html: '<a href="/pages/2/A">A</a><a href="/pages/3/B">B</a>' }),
    '2': directLinkedPageRes({ title: 'A' }),
    '3': directLinkedPageRes({ title: 'B' }, 404),
  };
  globalThis.fetch = vi.fn(async (url: any) => pages[/\/content\/(\d+)\?/.exec(String(url))?.[1] ?? ''] as any);
  const capped = await discoverLinkedConfluencePages({ base: 'https://wiki.test', token: 'pat' }, ['1'], { cap: 1 });
  assert.deepEqual(capped.map((p) => p.pageId), ['2']);

  pages['2'] = directLinkedPageRes({ title: 'A' }, 404);
  const afterError = await discoverLinkedConfluencePages({ base: 'https://wiki.test', token: 'pat' }, ['1']);
  assert.deepEqual(afterError, []);
});

test('fetchConfluencePages (flat pathLayout) mirrors the FULL real ancestor chain for a sub-tree scan — nested at every level, not flattened', async () => {
  const attachmentsDir = await mkdtemp(join(tmpdir(), 'bas-flat-tree-'));
  try {
    const byId: Record<string, ReturnType<typeof directPageRes>> = {
      '2': directPageRes({ title: 'Parent Doc' }),
      '21': directPageRes({ title: 'Child A', ancestors: [{ id: '2', title: 'Parent Doc' }] }),
      '211': directPageRes({
        title: 'Grandchild B',
        ancestors: [
          { id: '2', title: 'Parent Doc' },
          { id: '21', title: 'Child A' },
        ],
      }),
    };
    globalThis.fetch = vi.fn(async (url: any) => {
      const m = /\/rest\/api\/content\/(\d+)\?/.exec(String(url));
      if (m && byId[m[1]!]) return byId[m[1]!] as any;
      throw new Error(`unexpected fetch: ${url}`);
    }) as any;

    const pages = await fetchConfluencePages({ creds: { base: 'https://wiki.test', token: 'pat' } }, ['2'], {
      attachmentsDir,
      followLinks: false,
      pathLayout: 'flat',
      treePages: [
        { pageId: '21', title: 'Child A', treePath: ['Parent Doc'] },
        { pageId: '211', title: 'Grandchild B', treePath: ['Parent Doc', 'Child A'] },
      ],
    });

    const parent = pages.find((p) => p.pageId === '2')!;
    const child = pages.find((p) => p.pageId === '21')!;
    const grandchild = pages.find((p) => p.pageId === '211')!;

    // Every level nests under its OWN parent — not flattened to siblings.
    assert.equal(parent.relPath, 'docs/Parent-Doc.md');
    assert.equal(child.relPath, 'docs/Parent-Doc/Child-A.md');
    assert.equal(grandchild.relPath, 'docs/Parent-Doc/Child-A/Grandchild-B.md');

    // Slug pairing BY CONSTRUCTION: the folder segment a child nests under is
    // the SAME string as that ancestor's own file basename (both `slug(title)`
    // on the identical title) — no orphan raw-slug folder with no title.
    assert.equal(parent.relPath.replace(/^docs\//, '').replace(/\.md$/, ''), 'Parent-Doc');
    assert.ok(child.relPath.startsWith('docs/Parent-Doc/'));
    assert.equal(child.relPath.replace(/^docs\/Parent-Doc\//, '').replace(/\.md$/, ''), 'Child-A');
    assert.ok(grandchild.relPath.startsWith('docs/Parent-Doc/Child-A/'));
  } finally {
    await rm(attachmentsDir, { recursive: true, force: true });
  }
});

test('fetchConfluencePages (flat pathLayout) with MANY individually-ticked seeds still mirrors real per-page ancestors — NOT the commonLen-fold "flatten siblings" behavior', async () => {
  // Reproduces the actual App-pool import shape: every page (root AND every
  // descendant) is ticked individually via the search picker, so ALL of them
  // arrive as separate `refs` (seeds) — no treePages/includeDescendants.
  const attachmentsDir = await mkdtemp(join(tmpdir(), 'bas-flat-seeds-'));
  try {
    const byId: Record<string, ReturnType<typeof directPageRes>> = {
      '2': directPageRes({ title: 'Parent Doc' }),
      '21': directPageRes({ title: 'Child A', ancestors: [{ id: '2', title: 'Parent Doc' }] }),
      '211': directPageRes({
        title: 'Grandchild B',
        ancestors: [
          { id: '2', title: 'Parent Doc' },
          { id: '21', title: 'Child A' },
        ],
      }),
    };
    globalThis.fetch = vi.fn(async (url: any) => {
      const m = /\/rest\/api\/content\/(\d+)\?/.exec(String(url));
      if (m && byId[m[1]!]) return byId[m[1]!] as any;
      throw new Error(`unexpected fetch: ${url}`);
    }) as any;

    const pages = await fetchConfluencePages(
      { creds: { base: 'https://wiki.test', token: 'pat' } },
      ['2', '21', '211'], // all three ticked as PEER seeds — this is the ≥2-seed path
      { attachmentsDir, followLinks: false, pathLayout: 'flat' },
    );

    const parent = pages.find((p) => p.pageId === '2')!;
    const child = pages.find((p) => p.pageId === '21')!;
    const grandchild = pages.find((p) => p.pageId === '211')!;

    // With the OLD (non-flat) fold-by-commonLen behavior, "Child A" (a direct
    // child of the shared root) would land FLAT at the same level as the
    // root — this asserts it stays nested instead.
    assert.equal(parent.relPath, 'docs/Parent-Doc.md');
    assert.equal(child.relPath, 'docs/Parent-Doc/Child-A.md');
    assert.equal(grandchild.relPath, 'docs/Parent-Doc/Child-A/Grandchild-B.md');
  } finally {
    await rm(attachmentsDir, { recursive: true, force: true });
  }
});

test('fetchConfluencePages (flat pathLayout) giữ cấp của tổ tiên KHÔNG được fetch — tick lá mà không tick cha thì cha vẫn thành folder (cây soi gương Confluence gốc)', async () => {
  // Bug thật từ App-pool import: user tick trang gốc + các trang lá, KHÔNG
  // tick trang giữa ("2.2 …") → hành vi cũ lọc tổ tiên theo fetched-set làm
  // các lá bị đôn lên thành sibling của trang gốc. Hành vi mới: chuỗi tổ
  // tiên dùng nguyên văn (trừ prefix chung), tổ tiên chưa fetch = folder trơn.
  const attachmentsDir = await mkdtemp(join(tmpdir(), 'bas-flat-unfetched-anc-'));
  try {
    const byId: Record<string, ReturnType<typeof directPageRes>> = {
      '2': directPageRes({ title: 'Parent Doc' }),
      '221': directPageRes({
        title: 'Leaf One',
        ancestors: [
          { id: '2', title: 'Parent Doc' },
          { id: '22', title: 'Sub Section' }, // KHÔNG nằm trong refs
        ],
      }),
      '222': directPageRes({
        title: 'Leaf Two',
        ancestors: [
          { id: '2', title: 'Parent Doc' },
          { id: '22', title: 'Sub Section' },
        ],
      }),
    };
    globalThis.fetch = vi.fn(async (url: any) => {
      const m = /\/rest\/api\/content\/(\d+)\?/.exec(String(url));
      if (m && byId[m[1]!]) return byId[m[1]!] as any;
      throw new Error(`unexpected fetch: ${url}`);
    }) as any;

    const pages = await fetchConfluencePages(
      { creds: { base: 'https://wiki.test', token: 'pat' } },
      ['2', '221', '222'],
      { attachmentsDir, followLinks: false, pathLayout: 'flat' },
    );

    assert.equal(pages.find((p) => p.pageId === '2')!.relPath, 'docs/Parent-Doc.md');
    // Cấp "Sub Section" GIỮ NGUYÊN dù trang 22 không được fetch.
    assert.equal(pages.find((p) => p.pageId === '221')!.relPath, 'docs/Parent-Doc/Sub-Section/Leaf-One.md');
    assert.equal(pages.find((p) => p.pageId === '222')!.relPath, 'docs/Parent-Doc/Sub-Section/Leaf-Two.md');
  } finally {
    await rm(attachmentsDir, { recursive: true, force: true });
  }
});

test('fetchConfluencePages slug() collapses runs of dashes from " - " in a title (no "---" artifacts)', async () => {
  const attachmentsDir = await mkdtemp(join(tmpdir(), 'bas-slug-dash-'));
  try {
    globalThis.fetch = vi.fn(async (url: any) => {
      if (/\/rest\/api\/content\/2\?/.test(String(url))) {
        return directPageRes({ title: '2.2. URD - Danh muc vat tu hang hoa' }) as any;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as any;
    const pages = await fetchConfluencePages({ creds: { base: 'https://wiki.test', token: 'pat' } }, ['2'], {
      attachmentsDir,
      followLinks: false,
      pathLayout: 'flat',
    });
    assert.equal(pages[0]!.relPath, 'docs/2.2.-URD-Danh-muc-vat-tu-hang-hoa.md');
    assert.doesNotMatch(pages[0]!.relPath, /--/);
  } finally {
    await rm(attachmentsDir, { recursive: true, force: true });
  }
});

test('renderConfluenceIndex lists sub-tree pages in their own group with folder-relative links', async () => {
  const md = renderConfluenceIndex([
    { pageId: '100', title: 'B1. PRD', url: 'u', relPath: 'docs/confluence/B1.-PRD.md', content: '', linked: false },
    {
      pageId: '301',
      title: '1. Thiết lập',
      url: 'u',
      relPath: 'docs/confluence/I.-Tai-khoan/1.-Thiet-lap.md',
      content: 'tree_path: I. Tài khoản\n',
      viaTree: true,
    },
  ]);
  assert.match(md, /## Trang con \(quét theo cây phân cấp\)/);
  assert.match(md, /\[1\. Thiết lập\]\(\.\/I\.-Tai-khoan\/1\.-Thiet-lap\.md\)/);
});

test('fetchConfluencePages localizes a real Confluence screenshot (src + data-image-src) — not the data attr', async () => {
  // Regression: body.view renders embedded screenshots with BOTH src and
  // data-image-src. A greedy IMG_SRC_RE bound to data-image-src, so the real
  // src stayed a Confluence URL and htmlToMarkdown dropped the image — only
  // single-src draw.io previews survived. Here the REAL src must be localized.
  const attachmentsDir = await mkdtemp(join(tmpdir(), 'bas-embed-'));
  try {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.startsWith('https://wiki.test/rest/api/content/12')) {
        return makeRes(
          JSON.stringify({
            title: 'Màn hình',
            body: {
              view: {
                value:
                  '<p>Xem <img class="confluence-embedded-image" width="1000" ' +
                  'src="/download/attachments/12/shot.png?version=1&amp;api=v2" ' +
                  'data-image-src="/download/attachments/12/shot.png?version=1&amp;api=v2" ' +
                  'data-linked-resource-id="99" alt="màn hình"></p>',
              },
            },
            _links: { base: 'https://wiki.test', webui: '/spaces/X/pages/12/T' },
          }),
        ) as any;
      }
      if (u.startsWith('https://wiki.test/download/attachments/12/shot.png')) {
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer } as any;
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;
    const pages = await fetchConfluencePages(
      { creds: { base: 'https://wiki.test', token: 'pat' } },
      ['12'],
      { attachmentsDir, followLinks: false },
    );
    assert.equal(pages.length, 1);
    // The real screenshot survives as a localized markdown image (not dropped).
    assert.match(pages[0]!.content, /!\[màn hình\]\(attachments\/shot\.png\)/);
    // And the file was actually downloaded.
    const files = await readdir(attachmentsDir);
    assert.ok(files.includes('shot.png'), `expected shot.png in ${files.join(', ')}`);
  } finally {
    await rm(attachmentsDir, { recursive: true, force: true });
  }
});

test('htmlToMarkdown keeps a localized image that sits INSIDE a table cell', async () => {
  // Regression (prod, PRD Mockup Review no-op): a Confluence spec page embeds
  // its mockups inside table cells. The table pass strips tags to build the GFM
  // row and ran BEFORE the <img> handler, so every in-cell screenshot vanished —
  // the PNGs were downloaded but the markdown had zero `![](attachments/…)`
  // refs, listMockupPages found no pages, and the review stage finished in
  // seconds with an empty report.
  const { htmlToMarkdown } = await import('../src/bas/bas-client.js');
  const md = htmlToMarkdown(
    '<table><tr><th>Mô tả</th><th>Giao diện</th></tr>' +
      '<tr><td>Màn danh sách</td><td><img src="attachments/shot.png" alt="ds khách hàng"></td></tr></table>',
    undefined,
    'attachments',
  );
  assert.match(md, /!\[ds khách hàng\]\(attachments\/shot\.png\)/);
  // Still ONE table row — the image must not break the row across lines.
  assert.match(md, /\|[^\n|]*!\[ds khách hàng\]\(attachments\/shot\.png\)[^\n|]*\|/);
  // And an unlocalized in-cell image still degrades to alt text only.
  const noPrefix = htmlToMarkdown('<table><tr><td><img src="https://wiki/x.png" alt="ảnh"></td></tr></table>');
  assert.ok(!noPrefix.includes(']('), noPrefix);
  assert.match(noPrefix, /\(ảnh\)/);
});

test('fetchConfluencePages localizes a screenshot embedded in a TABLE cell', async () => {
  // End-to-end twin of the converter test above: download + markdown ref, for
  // the exact shape wiki.servicehub.vn ships (mockups in a table).
  const attachmentsDir = await mkdtemp(join(tmpdir(), 'bas-cell-'));
  try {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.startsWith('https://wiki.test/rest/api/content/33')) {
        return makeRes(
          JSON.stringify({
            title: 'URD Quản lý khách hàng',
            body: {
              view: {
                value:
                  '<table><tr><th>Bước</th><th>Giao diện</th></tr><tr><td>1</td><td>' +
                  '<img class="confluence-embedded-image" height="400" ' +
                  'src="/download/attachments/33/mockup.png?version=1&amp;api=v2" ' +
                  'data-image-src="/download/attachments/33/mockup.png?version=1&amp;api=v2" ' +
                  'alt="màn danh sách"></td></tr></table>',
              },
            },
            _links: { base: 'https://wiki.test', webui: '/spaces/X/pages/33/T' },
          }),
        ) as any;
      }
      if (u.startsWith('https://wiki.test/download/attachments/33/mockup.png')) {
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer } as any;
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;
    const pages = await fetchConfluencePages(
      { creds: { base: 'https://wiki.test', token: 'pat' } },
      ['33'],
      { attachmentsDir, followLinks: false },
    );
    assert.equal(pages.length, 1);
    assert.match(pages[0]!.content, /!\[màn danh sách\]\(attachments\/mockup\.png\)/);
    const files = await readdir(attachmentsDir);
    assert.ok(files.includes('mockup.png'), `expected mockup.png in ${files.join(', ')}`);
  } finally {
    await rm(attachmentsDir, { recursive: true, force: true });
  }
});

test('naturalSegsCompare orders roman sections + arabic sub-pages like the wiki sidebar', () => {
  const paths = [
    ['X. Lập báo cáo'],
    ['I. Tài khoản', '10. Cuối'],
    ['I. Tài khoản', '2. Đăng nhập'],
    ['I. Tài khoản', '1. Thiết lập'],
    ['II. Danh mục', '2.2.3. Nhóm'],
    ['II. Danh mục', '2.2.10. Khác'],
    ['II. Danh mục', '2.2.3. Nhóm', 'a. con'],
    ['IX. Tạm ứng'],
    ['V. Bán hàng'],
  ];
  const sorted = paths.slice().sort(naturalSegsCompare).map((p) => p.join('/'));
  assert.deepEqual(sorted, [
    'I. Tài khoản/1. Thiết lập',
    'I. Tài khoản/2. Đăng nhập',
    'I. Tài khoản/10. Cuối', // 10 AFTER 2 (numeric, not "10" < "2")
    'II. Danh mục/2.2.3. Nhóm',
    'II. Danh mục/2.2.3. Nhóm/a. con', // child under its parent
    'II. Danh mục/2.2.10. Khác', // 2.2.10 AFTER 2.2.3
    'V. Bán hàng', // V(5) before IX(9) — roman-aware, not "IX" < "V"
    'IX. Tạm ứng',
    'X. Lập báo cáo',
  ]);
});

test('fetchConfluencePages drops empty-body sub-tree pages but keeps an empty SEED', async () => {
  globalThis.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.startsWith('https://wiki.test/rest/api/content/10')) {
      // seed — empty body, but explicitly picked → kept.
      return makeRes(JSON.stringify({ title: 'Seed', body: { view: { value: '<p></p>' } }, _links: { base: 'https://wiki.test', webui: '/x/10' } })) as any;
    }
    if (u.startsWith('https://wiki.test/rest/api/content/20')) {
      // sub-tree child — empty overview stub → dropped.
      return makeRes(JSON.stringify({ title: 'IV. Overview', body: { view: { value: '<p>&nbsp;</p>' } }, _links: { base: 'https://wiki.test', webui: '/x/20' } })) as any;
    }
    if (u.startsWith('https://wiki.test/rest/api/content/21')) {
      // sub-tree child WITH content → kept.
      return makeRes(JSON.stringify({ title: 'IV.1 Detail', body: { view: { value: '<p>Nội dung thật</p>' } }, _links: { base: 'https://wiki.test', webui: '/x/21' } })) as any;
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as any;
  const pages = await fetchConfluencePages(
    { creds: { base: 'https://wiki.test', token: 'pat' } },
    ['10'],
    { followLinks: false, treePages: [{ pageId: '20', title: 'IV. Overview', treePath: ['IV'] }, { pageId: '21', title: 'IV.1 Detail', treePath: ['IV'] }] },
  );
  const ids = pages.map((p) => p.pageId).sort();
  assert.deepEqual(ids, ['10', '21']); // empty seed kept, empty sub-tree dropped, real sub-tree kept
});

test('fetchConfluencePages prefers the direct PAT REST fetch and converts body.view HTML', async () => {
  globalThis.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    assert.match(u, /^https:\/\/wiki\.test\/rest\/api\/content\/12\?expand=/);
    return makeRes(
      JSON.stringify({
        title: 'Thiết kế thẻ',
        body: { view: { value: '<h1>Tổng quan</h1><p>Thẻ <strong>ghi nợ</strong></p><ul><li>Bước 1</li></ul>' } },
        _links: { base: 'https://wiki.test', webui: '/spaces/X/pages/12/T' },
      }),
    ) as any;
  }) as any;
  const pages = await fetchConfluencePages(
    { creds: { base: 'https://wiki.test', token: 'pat' } },
    ['12'],
  );
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.title, 'Thiết kế thẻ');
  assert.equal(pages[0]!.url, 'https://wiki.test/spaces/X/pages/12/T');
  assert.match(pages[0]!.content, /# Tổng quan/);
  assert.match(pages[0]!.content, /\*\*ghi nợ\*\*/);
  assert.match(pages[0]!.content, /- Bước 1/);
});

// `body.export_view` is the STATIC-EXPORT rendering — the one Confluence's own
// "Export to Markdown" reads, and the only one where macros that render
// client-side (table of contents, …) are already expanded. Measured on four
// real pages, every metric was equal or better than `body.view`.
test('fetchConfluencePages prefers body.export_view and falls back to body.view', async () => {
  const asked: string[] = [];
  globalThis.fetch = vi.fn(async (url: any) => {
    asked.push(String(url));
    return makeRes(
      JSON.stringify({
        title: 'Trang',
        body: {
          view: { value: '<p>bản trình duyệt</p>' },
          export_view: { value: '<p>bản xuất file</p>' },
        },
        _links: { base: 'https://wiki.test', webui: '/x/12' },
      }),
    ) as any;
  }) as any;
  const pages = await fetchConfluencePages({ creds: { base: 'https://wiki.test', token: 'pat' } }, ['12']);
  assert.match(asked[0]!, /expand=body\.export_view,body\.view/);
  assert.match(pages[0]!.content, /bản xuất file/);
  assert.doesNotMatch(pages[0]!.content, /bản trình duyệt/);

  // A deployment that serves no export_view must still work.
  globalThis.fetch = vi.fn(async () =>
    makeRes(
      JSON.stringify({
        title: 'Trang',
        body: { view: { value: '<p>chỉ có view</p>' } },
        _links: { base: 'https://wiki.test', webui: '/x/13' },
      }),
    ) as any,
  ) as any;
  const fallback = await fetchConfluencePages({ creds: { base: 'https://wiki.test', token: 'pat' } }, ['13']);
  assert.match(fallback[0]!.content, /chỉ có view/);
});

// Confluence emits plenty of `<strong> </strong>` / `<strong><br></strong>`.
// Wrapping nothing in emphasis markers leaves literal `** **` mid-sentence
// ("Tham** **chiếu tài liệu") — 43 such runs across four real pages. Asterisks
// that are page CONTENT (masked numbers) must survive untouched.
test('htmlToMarkdown drops emphasis markers around blank content, keeps literal asterisks', async () => {
  const { htmlToMarkdown } = await import('../src/bas/bas-client.js');
  assert.equal(htmlToMarkdown('<p>Tham<strong> </strong>chiếu tài liệu</p>'), 'Tham chiếu tài liệu');
  // The blank run collapses to a single space — markers dropped, the words
  // still separated. (The regex converter echoed the run verbatim, `a  b`;
  // a DOM converter collapses runs of whitespace the way HTML itself does.)
  assert.equal(htmlToMarkdown('<p>a<em>  </em>b</p>'), 'a b');
  assert.equal(htmlToMarkdown('<p><strong><br></strong></p>'), '');
  // Real emphasis is untouched.
  assert.equal(htmlToMarkdown('<p>Số <strong>bắt buộc</strong></p>'), 'Số **bắt buộc**');
  // Masking asterisks are content, not markup.
  assert.equal(htmlToMarkdown('<p>ví dụ 094****000</p>'), 'ví dụ 094****000');
});

// A GFM table row must stay on ONE line, so block boundaries inside a cell
// become `<br>`. Collapsing them to a space ran opposite branches of a flow
// step together — "Hoàn tất xác thực trên webview ĐÓNG webview giữa chừng" —
// which a downstream agent then reads as a single instruction.
test('fetchConfluencePages keeps line breaks inside a table cell as <br>, on one row', async () => {
  globalThis.fetch = vi.fn(async () =>
    makeRes(
      JSON.stringify({
        title: 'Luồng',
        body: {
          export_view: {
            value:
              '<table><tr><th>Bước</th><th>Mô tả</th></tr>' +
              '<tr><td>5</td><td><p>Điều hướng theo số doanh nghiệp</p>' +
              '<ul><li>ĐÚNG 1 doanh nghiệp: vào thẳng. KẾT THÚC.</li>' +
              '<li>CHƯA có doanh nghiệp nào: tiếp Bước 6</li></ul></td></tr></table>',
          },
        },
        _links: { base: 'https://wiki.test', webui: '/x/14' },
      }),
    ) as any,
  ) as any;
  const [page] = await fetchConfluencePages({ creds: { base: 'https://wiki.test', token: 'pat' } }, ['14']);
  const rows = page!.content.split('\n').filter((l) => l.startsWith('|'));

  // Every row is closed — a stray newline inside a cell would split the row and
  // silently destroy the table.
  for (const r of rows) assert.match(r, /\|\s*$/, `hàng bảng chưa đóng: ${r}`);
  const dataRow = rows.find((r) => r.includes('Điều hướng'))!;
  assert.match(dataRow, /Điều hướng theo số doanh nghiệp<br>/);
  assert.match(dataRow, /<br>• ĐÚNG 1 doanh nghiệp/);
  assert.match(dataRow, /<br>• CHƯA có doanh nghiệp nào/);
  // The two branches must NOT read as one sentence.
  assert.doesNotMatch(dataRow, /doanh nghiệp ĐÚNG 1/);
});

test('fetchConfluencePages downloads a same-host <img> into attachmentsDir and rewrites src to a Markdown image', async () => {
  const attachmentsDir = await mkdtemp(join(tmpdir(), 'bas-img-'));
  try {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.startsWith('https://wiki.test/rest/api/content/12')) {
        return makeRes(
          JSON.stringify({
            title: 'Trang có ảnh',
            body: {
              view: {
                value: '<p>Xem <img src="/download/attachments/12/pic.png?version=1" alt="minh họa"></p>',
              },
            },
            _links: { base: 'https://wiki.test', webui: '/spaces/X/pages/12/T' },
          }),
        ) as any;
      }
      if (u.startsWith('https://wiki.test/download/attachments/12/pic.png')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new TextEncoder().encode('FAKE-PNG-BYTES').buffer,
        } as any;
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;
    const pages = await fetchConfluencePages(
      { creds: { base: 'https://wiki.test', token: 'pat' } },
      ['12'],
      { attachmentsDir },
    );
    assert.equal(pages.length, 1);
    assert.match(pages[0]!.content, /!\[minh họa\]\(attachments\/pic\.png\)/);
    const files = await readdir(attachmentsDir);
    assert.deepEqual(files, ['pic.png']);
    assert.equal(await readFile(join(attachmentsDir, 'pic.png'), 'utf8'), 'FAKE-PNG-BYTES');
  } finally {
    await rm(attachmentsDir, { recursive: true, force: true });
  }
});

test('fetchConfluencePages leaves an other-host <img> untouched (falls back to alt-text)', async () => {
  const attachmentsDir = await mkdtemp(join(tmpdir(), 'bas-img-'));
  try {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.startsWith('https://wiki.test/rest/api/content/12')) {
        return makeRes(
          JSON.stringify({
            title: 'Trang có ảnh ngoài',
            body: { view: { value: '<p>Xem <img src="https://cdn.example.com/logo.png" alt="logo"></p>' } },
            _links: { base: 'https://wiki.test', webui: '/spaces/X/pages/12/T' },
          }),
        ) as any;
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;
    const pages = await fetchConfluencePages(
      { creds: { base: 'https://wiki.test', token: 'pat' } },
      ['12'],
      { attachmentsDir },
    );
    assert.equal(pages.length, 1);
    assert.match(pages[0]!.content, /\(logo\)/);
    assert.doesNotMatch(pages[0]!.content, /!\[/);
    assert.deepEqual(await readdir(attachmentsDir), []);
  } finally {
    await rm(attachmentsDir, { recursive: true, force: true });
  }
});

test('fetchConfluencePages without attachmentsDir keeps the old alt-text-only behavior (no download attempted)', async () => {
  globalThis.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.startsWith('https://wiki.test/rest/api/content/12')) {
      return makeRes(
        JSON.stringify({
          title: 'Trang có ảnh',
          body: { view: { value: '<p>Xem <img src="/download/attachments/12/pic.png" alt="minh họa"></p>' } },
          _links: { base: 'https://wiki.test', webui: '/spaces/X/pages/12/T' },
        }),
      ) as any;
    }
    throw new Error(`unexpected fetch (no attachmentsDir should mean no image download): ${u}`);
  }) as any;
  const pages = await fetchConfluencePages({ creds: { base: 'https://wiki.test', token: 'pat' } }, ['12']);
  assert.equal(pages.length, 1);
  assert.match(pages[0]!.content, /\(minh họa\)/);
  assert.doesNotMatch(pages[0]!.content, /!\[/);
});

test('fetchConfluencePages follows seed links depth-1, rewrites cross-page links, marks linked pages', async () => {
  const BODIES: Record<string, { title: string; html: string }> = {
    '12': {
      title: 'Thiết kế thẻ',
      html: '<p>Xem <a href="https://wiki.test/spaces/X/pages/34/BO+SPEC">BO spec</a> và <a href="https://jira.test/browse/PRJ-1">ticket</a></p>',
    },
    // Linked page links onward to page 56 — depth 2, must NOT be fetched.
    '34': { title: 'BO SPEC', html: '<p>Chi tiết <a href="/spaces/X/pages/56/Deep">sâu hơn</a></p>' },
  };
  globalThis.fetch = vi.fn(async (url: any) => {
    const id = /\/content\/(\d+)\?/.exec(String(url))?.[1] ?? '';
    const b = BODIES[id];
    if (!b) return makeRes('not found', { status: 404 }) as any;
    return makeRes(
      JSON.stringify({
        title: b.title,
        body: { view: { value: b.html } },
        _links: { base: 'https://wiki.test', webui: `/spaces/X/pages/${id}/x` },
      }),
    ) as any;
  }) as any;
  const pages = await fetchConfluencePages({ creds: { base: 'https://wiki.test', token: 'pat' } }, ['12']);
  assert.deepEqual(pages.map((p) => [p.pageId, p.linked ?? false]), [['12', false], ['34', true]]);
  // Cross-page link rewritten to the local file; external (JIRA) link untouched.
  assert.match(pages[0]!.content, /\[BO spec\]\(\.\/BO-SPEC\.md\)/);
  assert.match(pages[0]!.content, /https:\/\/jira\.test\/browse\/PRJ-1/);
  // Depth-2 target not fetched → its link stays a wiki URL (relative href kept).
  assert.match(pages[1]!.content, /\[sâu hơn\]\(\/spaces\/X\/pages\/56\/Deep\)/);
  assert.match(pages[1]!.content, /fetched_via: linked-from-seed/);
  // Index groups the auto-fetched pages separately.
  const index = renderConfluenceIndex(pages);
  assert.match(index, /## Trang liên kết/);
  assert.ok(index.indexOf('Thiết kế thẻ') < index.indexOf('## Trang liên kết'));
});

test('fetchConfluencePages followLinks:false fetches only the picked pages', async () => {
  globalThis.fetch = vi.fn(async (url: any) => {
    const id = /\/content\/(\d+)\?/.exec(String(url))?.[1] ?? '';
    assert.equal(id, '12'); // page 34 must never be requested
    return makeRes(
      JSON.stringify({
        title: 'Seed',
        body: { view: { value: '<a href="/pages/34">link</a>' } },
        _links: { base: 'https://wiki.test', webui: '/spaces/X/pages/12/x' },
      }),
    ) as any;
  }) as any;
  const pages = await fetchConfluencePages(
    { creds: { base: 'https://wiki.test', token: 'pat' } },
    ['12'],
    { followLinks: false },
  );
  assert.equal(pages.length, 1);
});

test('fetchConfluencePages falls back to the gateway when the direct fetch fails', async () => {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    if (u.startsWith('https://wiki.test/rest/')) return makeRes('denied', { status: 401 }) as any;
    // Gateway MCP protocol (initialize → tools/call).
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return makeRes(rpcResult(msg.id, { protocolVersion: '2025-03-26' }), { sessionId: 's1' }) as any;
    if (msg.method === 'notifications/initialized') return makeRes('', { status: 202 }) as any;
    if (msg.method === 'tools/call') {
      return makeRes(toolResult(msg.id, { page_id: '12', title: 'Via gateway', markdown: 'gw body' })) as any;
    }
    return makeRes(rpcResult(msg.id, {})) as any;
  }) as any;
  const pages = await fetchConfluencePages(
    { creds: { base: 'https://wiki.test', token: 'bad' }, ep: EP },
    ['12'],
  );
  assert.equal(pages[0]!.title, 'Via gateway');
  assert.match(pages[0]!.content, /gw body/);
});

test('fetchConfluencePages dedupes slug collisions with the page id suffix', async () => {
  stubFetch((_name, args) =>
    makeRes(toolResult(2, { page_id: args.page_id, title: 'Same Title', markdown: 'x' })),
  );
  const pages = await fetchConfluencePages({ ep: EP }, ['11', '22']);
  assert.notEqual(pages[0]!.relPath, pages[1]!.relPath);
  assert.match(pages[1]!.relPath, /-22\.md$/);
});

test('fetchSourceFiles(bas) renders a selected feature detail into markdown', async () => {
  stubFetch((name, args) => {
    assert.equal(name, 'kg_get_feature_detail');
    assert.deepEqual(args, { document_id: 'my-project-001', feature_id: 'F-001' });
    return makeRes(toolResult(2, {
      feature_id: 'F-001',
      feature_name: 'Đăng nhập',
      document_id: 'my-project-001',
      business_rules: [{ summary: 'Mật khẩu tối thiểu 8 ký tự' }],
    }));
  });
  const files = await fetchSourceFiles(EP, { kind: 'bas', documentId: 'my-project-001', featureIds: ['F-001'] });
  assert.equal(files.length, 1);
  assert.match(files[0]!.relPath, /^docs\/source\/bas\/feature-F-001\.md$/);
  assert.match(files[0]!.content, /# Đăng nhập/);
  assert.match(files[0]!.content, /## Business rules/);
  assert.match(files[0]!.content, /Mật khẩu tối thiểu 8 ký tự/);
});

test('fetchSourceFiles(bas) with no featureIds ingests the whole document subgraph', async () => {
  stubFetch((name) => {
    assert.equal(name, 'kg_get_document_subgraph');
    return makeRes(toolResult(2, { nodes: [{ type: 'FEATURE', summary: 'Đăng nhập', description: 'User login' }] }));
  });
  const files = await fetchSourceFiles(EP, { kind: 'bas', documentId: 'my-project-001' });
  assert.equal(files.length, 1);
  assert.match(files[0]!.relPath, /^docs\/source\/bas\/my-project-001\.md$/);
  assert.match(files[0]!.content, /## Feature\n- \*\*Đăng nhập\*\* — User login/);
});

// ── parseRunSource validator ────────────────────────────────────────────────

test('parseRunSource returns undefined for null/absent source', () => {
  assert.equal(parseRunSource(undefined), undefined);
  assert.equal(parseRunSource(null), undefined);
});

test('parseRunSource accepts a confluence source and trims the ref', () => {
  assert.deepEqual(parseRunSource({ kind: 'confluence', ref: '  https://wiki/9  ' }), {
    kind: 'confluence',
    ref: 'https://wiki/9',
  });
});

test('parseRunSource rejects a confluence source with no ref', () => {
  assert.throws(() => parseRunSource({ kind: 'confluence', ref: '' }), /ref/);
});

test('parseRunSource accepts a bas source with featureIds and drops empties', () => {
  assert.deepEqual(
    parseRunSource({ kind: 'bas', documentId: 'doc-1', featureIds: ['f1', '', 'f2'] }),
    { kind: 'bas', documentId: 'doc-1', featureIds: ['f1', 'f2'] },
  );
});

test('parseRunSource accepts a bas source with NO featureIds (whole document)', () => {
  assert.deepEqual(parseRunSource({ kind: 'bas', documentId: 'doc-1' }), { kind: 'bas', documentId: 'doc-1' });
});

test('parseRunSource rejects a bas source with no documentId', () => {
  assert.throws(() => parseRunSource({ kind: 'bas', featureIds: ['f1'] }), /documentId/);
});

test('parseRunSource rejects an unknown source kind', () => {
  assert.throws(() => parseRunSource({ kind: 'sharepoint', ref: 'x' }), /must be "confluence", "bas" or "app-pool"/);
});

// --- Multi-page draw.io splitting (drawio-render.ts) ----------------------
import { splitMxfilePages } from '../src/bas/drawio-render.js';

test('splitMxfilePages: one single-page mxfile per <diagram>, header preserved', () => {
  const xml =
    '<mxfile host="wiki" pages="3"><diagram id="a" name="Page-1"><data>A</data></diagram>' +
    '<diagram id="b" name="Page-2"><data>B</data></diagram>' +
    '<diagram id="c" name="Page-3"><data>C</data></diagram></mxfile>';
  const pages = splitMxfilePages(xml);
  assert.equal(pages.length, 3);
  assert.ok(pages[0]!.startsWith('<mxfile host="wiki" pages="3">'));
  assert.ok(pages[0]!.includes('name="Page-1"') && pages[0]!.endsWith('</mxfile>'));
  assert.ok(pages[1]!.includes('name="Page-2"') && !pages[1]!.includes('Page-1'));
  assert.ok(pages[2]!.includes('name="Page-3"') && !pages[2]!.includes('Page-2'));
});

test('splitMxfilePages: single-page diagram → one page', () => {
  const xml = '<mxfile><diagram id="only">X</diagram></mxfile>';
  assert.equal(splitMxfilePages(xml).length, 1);
});
