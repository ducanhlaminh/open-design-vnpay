import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONFLUENCE_CREDS_MISSING,
  attachmentDirOf,
  confluencePreflight,
  expandLedgerGroup,
  fetchConfluenceBlob,
  groupLocalLedgers,
  groupOriginLedgers,
  isAttachmentsLedgerPath,
  mapLimit,
  parseConfluenceLedgerBuffer,
  resolveLocalConfluenceSources,
  synthesizeOriginConfluenceEntries,
  type LazyLocalFile,
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

describe('ledger groups (one plan entry per ledger)', () => {
  const lazy = (rel: string, content: string, mtimeMs: number, reads?: string[]): LazyLocalFile => ({
    rel, size: content.length, mtimeMs,
    read: async () => { reads?.push(rel); return Buffer.from(content); },
  });

  it('groups local files by name + size + (mtime | sha) and reads bytes only for the sha rule', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-ledger-group-'));
    try {
      const dir = path.join(root, 'docs', 'attachments');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '_sources.json'), JSON.stringify(ledger([item('old.png', 'OLD'), item('new-ok.png', 'NEW'), item('new-bad.png', 'NEW'), item('short.png', 'SHORT')])));
      const ledgerMtime = (await fs.stat(path.join(dir, '_sources.json'))).mtimeMs;
      const reads: string[] = [];
      const out = await groupLocalLedgers(root, [
        lazy('docs/attachments/old.png', 'XXX', ledgerMtime - 1000, reads),     // older than the ledger, same size → matched without reading
        lazy('docs/attachments/new-ok.png', 'NEW', ledgerMtime + 1000, reads),  // newer → sha read → matches
        lazy('docs/attachments/new-bad.png', 'BAD', ledgerMtime + 1000, reads), // newer → sha read → differs
        lazy('docs/attachments/short.png', 'S', 0, reads),                      // size differs → never read
        lazy('docs/attachments/unlisted.png', 'U', 0, reads),
        lazy('docs/attachments/_sources.json', 'L', 0, reads),
        lazy('elsewhere/attachments/old.png', 'OLD', 0, reads),                 // no ledger there
        lazy('docs/plain.md', 'P', 0, reads),
      ]);
      expect([...out.matched].sort()).toEqual(['docs/attachments/new-ok.png', 'docs/attachments/old.png']);
      expect([...out.groups.keys()]).toEqual(['docs/attachments/_sources.json']);
      expect(out.groups.get('docs/attachments/_sources.json')).toMatchObject({ files: 2, bytes: 6 });
      expect(out.groups.get('docs/attachments/_sources.json')!.items.map((row) => row.name)).toEqual(['old.png', 'new-ok.png']);
      expect(reads.sort()).toEqual(['docs/attachments/new-bad.png', 'docs/attachments/new-ok.png']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('groups origin ledger items without a media file and stats local copies for missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-ledger-origin-'));
    try {
      const dir = path.join(root, 'docs', 'attachments');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'here.png'), 'HERE');
      await fs.writeFile(path.join(dir, 'wrong-size.png'), 'X');
      const ledgers = [
        { dirRel: 'docs/attachments', ledger: ledger([item('here.png', 'HERE'), item('wrong-size.png', 'RIGHT'), item('absent.png', 'ABSENT'), item('on-media.png', 'M'), item('../escape.png', 'E')]) },
        { dirRel: 'x/attachments', ledger: ledger([item('a.png', 'A')], '') }, // no base → ignored
      ];
      const present = new Set(['docs/attachments/on-media.png', 'docs/attachments/_sources.json']);
      const pull = await groupOriginLedgers(ledgers, present, { root });
      expect([...pull.keys()]).toEqual(['docs/attachments/_sources.json']);
      expect(pull.get('docs/attachments/_sources.json')).toMatchObject({ base: 'https://wiki.test', files: 3, bytes: 15, missing: 2 });
      expect(pull.get('docs/attachments/_sources.json')!.items.map((row) => row.name)).toEqual(['here.png', 'wrong-size.png', 'absent.png']);
      expect((await groupOriginLedgers(ledgers, present, null)).get('docs/attachments/_sources.json')).toMatchObject({ files: 3, missing: 0 });
      expect((await groupOriginLedgers(ledgers, present, { root: null })).get('docs/attachments/_sources.json')).toMatchObject({ files: 3, missing: 3 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('expands a ledger into files: skip present, fetch pinned/latest, report drifted/missing per item', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-ledger-expand-'));
    try {
      const target = path.join(root, 'docs', 'attachments');
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'have.png'), 'HAVE');
      const items = [item('have.png', 'HAVE'), item('ok.png', 'OK'), item('latest.png', 'LATEST'), item('drift.png', 'DRIFT'), item('gone.png', 'GONE')];
      const calls = stubFetch((url) => {
        const name = new URL(url).pathname.split('/').pop()!;
        const pinned = url.includes('version=');
        if (name === 'ok.png') return new Response('OK', { status: 200 });
        if (name === 'latest.png') return new Response(pinned ? 'STALE' : 'LATEST', { status: 200 });
        if (name === 'drift.png') return new Response('ELSE', { status: 200 });
        return new Response('', { status: 404 });
      });
      const seen: Array<[string, string]> = [];
      const out = await expandLedgerGroup(creds, { base: 'https://wiki.test', items }, target, { relDir: 'feature/docs/attachments', onItem: (name, outcome) => seen.push([name, outcome]) });
      expect(out).toEqual({
        fetched: 3, skipped: 1,
        drifted: [{ path: 'feature/docs/attachments/drift.png', reason: expect.stringContaining('v3') }],
        missing: [{ path: 'feature/docs/attachments/gone.png', reason: 'HTTP 404' }],
      });
      expect(seen.sort()).toEqual([['drift.png', 'drifted'], ['gone.png', 'missing'], ['have.png', 'skipped'], ['latest.png', 'fetched'], ['ok.png', 'fetched']]);
      expect(calls.some((url) => url.includes('/have.png'))).toBe(false);
      expect(await fs.readFile(path.join(target, 'latest.png'), 'utf8')).toBe('LATEST');
      expect(await fs.readFile(path.join(target, 'drift.png'), 'utf8')).toBe('ELSE');
      expect(await fs.stat(path.join(target, 'gone.png')).catch(() => null)).toBeNull();

      // No PAT: present files are still skipped, everything else is missing without touching the network.
      const noCredsCalls = stubFetch(() => new Response('', { status: 200 }));
      const none = await expandLedgerGroup(null, { base: 'https://wiki.test', items: [item('have.png', 'HAVE'), item('gone.png', 'GONE'), item('../escape.png', 'E')] }, target, { relDir: 'feature/docs/attachments' });
      expect({ ...none, missing: [...none.missing].sort((a, b) => a.path.localeCompare(b.path)) }).toEqual({ fetched: 0, skipped: 1, drifted: [], missing: [
        { path: 'feature/docs/attachments/../escape.png', reason: expect.stringContaining('không hợp lệ') },
        { path: 'feature/docs/attachments/gone.png', reason: CONFLUENCE_CREDS_MISSING },
      ] });
      expect(noCredsCalls).toEqual([]);
      expect(await fs.stat(path.join(root, 'docs', 'escape.png')).catch(() => null)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
