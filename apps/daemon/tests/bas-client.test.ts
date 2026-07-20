import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  basConfluenceMeta,
  basListDocuments,
  basListFeatures,
  extractPageId,
  fetchConfluencePages,
  fetchSourceFiles,
  listDescendantPages,
  looksLikeConfluenceRef,
  renderConfluenceIndex,
  resolveBasEndpoint,
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
  // Opaque short links / JIRA keys / JQL → agent path, not deterministic.
  assert.equal(looksLikeConfluenceRef('https://wiki.test/x/AbCd'), false);
  assert.equal(looksLikeConfluenceRef('PROJ-123'), false);
  assert.equal(looksLikeConfluenceRef('project = PROJ ORDER BY created'), false);
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
    // (slug() collapses non-ASCII accents to '-', so "I. Tài khoản" → "I.-T-i-kho-n").
    assert.equal(seed.relPath, 'docs/confluence/B1.-PRD.md');
    assert.equal(child.relPath, 'docs/confluence/I.-T-i-kho-n/1.-Thi-t-l-p.md');
    assert.equal(child.viaTree, true);
    // A page one folder deep reaches the shared attachments dir via ../.
    assert.match(child.content, /!\[mh\]\(\.\.\/attachments\/pic\.png\)/);
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
  assert.throws(() => parseRunSource({ kind: 'sharepoint', ref: 'x' }), /must be "confluence" or "bas"/);
});
