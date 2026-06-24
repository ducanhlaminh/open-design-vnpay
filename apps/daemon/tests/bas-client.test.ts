import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  basConfluenceMeta,
  basListProjects,
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

// Route the stub by JSON-RPC method so initialize/notifications/tools-call all
// resolve. `onToolCall(name, args)` returns the body string for tools/call.
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

test('basListProjects decodes content[].text JSON into BasProject[]', async () => {
  let calledName = '';
  stubFetch((name, _args) => {
    calledName = name;
    return makeRes(toolResult(2, { projects: [{ id: 'XPOS', name: 'X-POS', description: 'POS app' }] }));
  });
  const projects = await basListProjects(EP);
  assert.equal(calledName, 'workspace_list_projects');
  assert.deepEqual(projects, [{ id: 'XPOS', name: 'X-POS', description: 'POS app' }]);
});

test('basConfluenceMeta strips HTML body into a plain-text excerpt', async () => {
  stubFetch(() => makeRes(toolResult(2, {
    id: '874352117',
    title: 'Login Flow',
    space: 'CONSOC',
    url: 'https://wiki.test/pages/874352117',
    body: '<p>Hello <b>world</b> from Confluence</p>',
  })));
  const meta = await basConfluenceMeta(EP, 'https://wiki.test/pages/874352117');
  assert.equal(meta.title, 'Login Flow');
  assert.equal(meta.space, 'CONSOC');
  assert.equal(meta.excerpt, 'Hello world from Confluence');
});

test('basListProjects parses a text/event-stream (SSE) tools/call response', async () => {
  const payload = toolResult(2, { projects: [{ id: 'A', name: 'Alpha' }] });
  stubFetch(() => makeRes(`event: message\ndata: ${payload}\n\n`, { contentType: 'text/event-stream' }));
  const projects = await basListProjects(EP);
  assert.deepEqual(projects, [{ id: 'A', name: 'Alpha' }]);
});

test('fetchSourceFiles(confluence) writes one cwd-relative markdown file with frontmatter', async () => {
  stubFetch(() => makeRes(toolResult(2, { id: '12', title: 'Spec Page', url: 'https://wiki/12', markdown: '# Spec\nbody text' })));
  const files = await fetchSourceFiles(EP, { kind: 'confluence', ref: 'https://wiki/12' });
  assert.equal(files.length, 1);
  assert.match(files[0]!.relPath, /^docs\/source\/confluence\/.*\.md$/);
  assert.match(files[0]!.content, /^---\n/);
  assert.match(files[0]!.content, /source: confluence/);
  assert.match(files[0]!.content, /# Spec/);
});

test('fetchSourceFiles(bas) writes one file per selected document', async () => {
  stubFetch((name) => {
    assert.equal(name, 'workspace_get_document');
    return makeRes(toolResult(2, { title: 'Requirement A', markdown: '## A\ndetails' }));
  });
  const files = await fetchSourceFiles(EP, { kind: 'bas', projectId: 'XPOS', documentIds: ['doc-1'] });
  assert.equal(files.length, 1);
  assert.match(files[0]!.relPath, /^docs\/source\/bas\/.*\.md$/);
  assert.match(files[0]!.content, /document_id: doc-1/);
  assert.match(files[0]!.content, /## A/);
});

test('fetchSourceFiles(bas) with no ids selected throws', async () => {
  stubFetch(() => makeRes(toolResult(2, {})));
  await assert.rejects(
    () => fetchSourceFiles(EP, { kind: 'bas', projectId: 'XPOS' }),
    /no documentIds or featureIds/,
  );
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

test('parseRunSource accepts a bas source and drops empty id entries', () => {
  assert.deepEqual(
    parseRunSource({ kind: 'bas', projectId: 'XPOS', featureIds: ['f1', '', 'f2'], documentIds: [] }),
    { kind: 'bas', projectId: 'XPOS', featureIds: ['f1', 'f2'] },
  );
});

test('parseRunSource rejects a bas source with no ids', () => {
  assert.throws(() => parseRunSource({ kind: 'bas', projectId: 'XPOS' }), /featureId or documentId/);
});

test('parseRunSource rejects an unknown source kind', () => {
  assert.throws(() => parseRunSource({ kind: 'sharepoint', ref: 'x' }), /must be "confluence" or "bas"/);
});
