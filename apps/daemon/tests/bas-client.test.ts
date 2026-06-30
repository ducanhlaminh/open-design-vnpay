import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  basConfluenceMeta,
  basListDocuments,
  basListFeatures,
  extractPageId,
  fetchSourceFiles,
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
