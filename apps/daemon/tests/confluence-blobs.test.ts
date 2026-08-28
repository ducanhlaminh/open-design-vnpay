import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  attachmentDirOf,
  confluencePreflight,
  fetchConfluenceBlob,
  isAttachmentsLedgerPath,
  mapLimit,
  parseConfluenceLedgerBuffer,
  resolveLocalConfluenceSources,
  synthesizeOriginConfluenceEntries,
} from '../src/confluence-blobs.js';
import type { ConfluenceSourcesLedger } from '../src/confluence-sources.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const item = (name: string, content: string, extra: Partial<ConfluenceSourcesLedger['items'][number]> = {}) => ({
  name, sha256: sha(content), size: content.length, pageId: '100', spaceKey: 'SMB', attachment: name, attachmentVersion: 3, fetchedAt: 1, ...extra,
});
const ledger = (items: ConfluenceSourcesLedger['items'], base = 'https://wiki.test'): ConfluenceSourcesLedger => ({ version: 1, base, items });
const creds = { base: 'https://wiki.test', token: 'pat' };
const source = { base: 'https://wiki.test', pageId: '100', spaceKey: 'SMB', attachment: 'a b.png', attachmentVersion: 3 };

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response> | Response;
function stubFetch(impl: FetchImpl): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => { calls.push(String(input)); return impl(String(input), init); }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('confluence-blobs path helpers', () => {
  it('recognizes ledger paths and attachment dirs', () => {
    expect(isAttachmentsLedgerPath('docs-review/docs-feature/attachments/_sources.json')).toBe(true);
    expect(isAttachmentsLedgerPath('attachments/_sources.json')).toBe(true);
    expect(isAttachmentsLedgerPath('docs/_sources.json')).toBe(false);
    expect(isAttachmentsLedgerPath('docs/attachments/other.json')).toBe(false);
    expect(attachmentDirOf('docs/attachments/a.png')).toBe('docs/attachments');
    expect(attachmentDirOf('attachments/a.png')).toBe('attachments');
    expect(attachmentDirOf('docs/a.png')).toBeNull();
    expect(attachmentDirOf('docs/attachments/sub/a.png')).toBeNull();
  });

  it('parses a media-side ledger and rejects malformed blobs', () => {
    const parsed = parseConfluenceLedgerBuffer(Buffer.from(JSON.stringify({ version: 1, base: 'https://wiki.test/', items: [item('a.png', 'A'), { name: 'bad' }] })));
    expect(parsed).toEqual({ version: 1, base: 'https://wiki.test', items: [item('a.png', 'A')] });
    expect(parseConfluenceLedgerBuffer(Buffer.from('{not json'))).toBeNull();
    expect(parseConfluenceLedgerBuffer(Buffer.from(JSON.stringify({ version: 2, base: 'x', items: [] })))).toBeNull();
  });

  it('resolves local files against sibling ledgers by name AND sha', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-confluence-blobs-'));
    try {
      const dir = path.join(root, 'docs', 'attachments');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '_sources.json'), JSON.stringify(ledger([item('a.png', 'A'), item('stale.png', 'OLD')])));
      const resolved = await resolveLocalConfluenceSources(root, [
        { rel: 'docs/attachments/a.png', checksum: sha('A') },
        { rel: 'docs/attachments/stale.png', checksum: sha('NEW') },
        { rel: 'docs/attachments/unlisted.png', checksum: sha('U') },
        { rel: 'docs/attachments/_sources.json', checksum: sha('L') },
        { rel: 'docs/other/attachments/a.png', checksum: sha('A') },
      ]);
      expect([...resolved.keys()]).toEqual(['docs/attachments/a.png']);
      expect(resolved.get('docs/attachments/a.png')).toEqual({ base: 'https://wiki.test', pageId: '100', spaceKey: 'SMB', attachment: 'a.png', attachmentVersion: 3 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('synthesizes origin entries only for ledger items without a media file', () => {
    const out = synthesizeOriginConfluenceEntries(
      [{ dirRel: 'docs/attachments', ledger: ledger([item('a.png', 'A'), item('on-media.png', 'M')]) }, { dirRel: 'x/attachments', ledger: ledger([item('a.png', 'A')], '') }],
      new Set(['docs/attachments/on-media.png', 'docs/attachments/_sources.json']),
    );
    expect(out).toEqual([{ rel: 'docs/attachments/a.png', checksum: sha('A'), size: 1, confluence: { base: 'https://wiki.test', pageId: '100', spaceKey: 'SMB', attachment: 'a.png', attachmentVersion: 3 } }]);
  });
});

describe('fetchConfluenceBlob', () => {
  it('returns the pinned bytes when they match', async () => {
    const calls = stubFetch(() => new Response('A', { status: 200 }));
    const out = await fetchConfluenceBlob(creds, source, sha('A'));
    expect(out).toEqual({ kind: 'ok', bytes: Buffer.from('A') });
    expect(calls).toEqual(['https://wiki.test/download/attachments/100/a%20b.png?api=v2&version=3']);
  });

  it('falls back to the latest version and reports ok / drifted / missing', async () => {
    const calls = stubFetch((url) => new Response(url.includes('version=') ? 'X' : 'A', { status: 200 }));
    expect(await fetchConfluenceBlob(creds, source, sha('A'))).toEqual({ kind: 'ok', bytes: Buffer.from('A') });
    expect(calls).toEqual([
      'https://wiki.test/download/attachments/100/a%20b.png?api=v2&version=3',
      'https://wiki.test/download/attachments/100/a%20b.png?api=v2',
    ]);
    stubFetch(() => new Response('Z', { status: 200 }));
    expect(await fetchConfluenceBlob(creds, source, sha('A'))).toEqual({ kind: 'drifted', bytes: Buffer.from('Z') });
    stubFetch(() => new Response('', { status: 404 }));
    expect(await fetchConfluenceBlob(creds, source, sha('A'))).toEqual({ kind: 'missing', reason: 'HTTP 404' });
    stubFetch((url) => new Response('', { status: url.includes('version=') ? 401 : 401 }));
    expect(await fetchConfluenceBlob(creds, source, sha('A'))).toEqual({ kind: 'missing', reason: 'HTTP 401' });
    stubFetch(() => { throw new Error('ECONNRESET'); });
    expect(await fetchConfluenceBlob(creds, source, sha('A'))).toEqual({ kind: 'missing', reason: 'ECONNRESET' });
  });

  it('fetches once when there is no version to pin', async () => {
    const calls = stubFetch(() => new Response('Q', { status: 200 }));
    expect(await fetchConfluenceBlob(creds, { ...source, attachmentVersion: 0 }, sha('A'))).toEqual({ kind: 'drifted', bytes: Buffer.from('Q') });
    expect(calls).toEqual(['https://wiki.test/download/attachments/100/a%20b.png?api=v2']);
  });
});

describe('mapLimit', () => {
  it('bounds concurrency and preserves order', async () => {
    let active = 0; let peak = 0;
    const out = await mapLimit([30, 10, 20, 5, 1], 2, async (ms, index) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, ms));
      active -= 1;
      return `${index}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:10', '2:20', '3:5', '4:1']);
    expect(peak).toBe(2);
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe('confluencePreflight', () => {
  const sources = [source, { ...source, pageId: '200', spaceKey: 'OPS' }, { ...source, pageId: '300', spaceKey: '' }];

  it('is trivially ok without Confluence entries', async () => {
    expect(await confluencePreflight(null, [], [])).toMatchObject({ required: false, files: 0, bytes: 0, token: 'missing', spaces: [], ok: true });
  });

  it('reports a missing PAT without touching the network', async () => {
    const calls = stubFetch(() => new Response('', { status: 200 }));
    const out = await confluencePreflight(null, sources, [1, 2, 3]);
    expect(out).toMatchObject({ required: true, files: 3, bytes: 6, base: 'https://wiki.test', credsBase: null, baseMatches: false, token: 'missing', ok: false });
    expect(out.spaces.map((space) => [space.key, space.ok, space.status, space.files])).toEqual([['SMB', false, null, 1], ['OPS', false, null, 1], ['(unknown)', false, null, 1]]);
    expect(calls).toEqual([]);
  });

  it('classifies the PAT and probes one sample page per space', async () => {
    stubFetch(() => new Response('', { status: 401 }));
    expect(await confluencePreflight(creds, sources, [1, 1, 1])).toMatchObject({ token: 'invalid', ok: false, baseMatches: true });
    stubFetch(() => { throw new Error('timeout'); });
    expect(await confluencePreflight(creds, sources, [1, 1, 1])).toMatchObject({ token: 'unreachable', ok: false });
    const calls = stubFetch((url) => url.endsWith('/rest/api/user/current')
      ? new Response(JSON.stringify({ displayName: 'Anh' }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('', { status: url.endsWith('/rest/api/content/200') ? 404 : 200 }));
    const partial = await confluencePreflight(creds, sources, [1, 1, 1]);
    expect(partial).toMatchObject({ token: 'ok', displayName: 'Anh', ok: false });
    expect(partial.spaces).toEqual([
      { key: 'SMB', samplePageId: '100', ok: true, status: 200, files: 1 },
      { key: 'OPS', samplePageId: '200', ok: false, status: 404, files: 1 },
      { key: '(unknown)', samplePageId: '300', ok: true, status: 200, files: 1 },
    ]);
    expect(calls).toEqual([
      'https://wiki.test/rest/api/user/current',
      'https://wiki.test/rest/api/content/100',
      'https://wiki.test/rest/api/content/200',
      'https://wiki.test/rest/api/content/300',
    ]);
    stubFetch(() => new Response('{}', { status: 200 }));
    expect(await confluencePreflight(creds, sources, [1, 1, 1])).toMatchObject({ token: 'ok', ok: true });
    expect(await confluencePreflight({ ...creds, base: 'https://wiki.test/' }, sources, [1])).toMatchObject({ baseMatches: true, ok: true });
    expect(await confluencePreflight({ ...creds, base: 'https://other.test' }, sources, [1])).toMatchObject({ baseMatches: false, credsBase: 'https://other.test', ok: false });
  });
});
