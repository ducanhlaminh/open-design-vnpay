import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  CONFLUENCE_SOURCES_FILE,
  type ConfluenceSourceItem,
  confluenceAttachmentDownloadUrl,
  mergeConfluenceSourcesLedger,
  parseConfluenceDownloadUrl,
  pruneConfluenceSourcesLedger,
  readConfluenceSourcesLedger,
  writeConfluenceSourcesLedger,
} from '../src/confluence-sources.js';

function item(name: string, extra: Partial<ConfluenceSourceItem> = {}): ConfluenceSourceItem {
  return {
    name,
    sha256: 'ab'.repeat(32),
    size: 1,
    pageId: '12',
    spaceKey: 'SP',
    attachment: name,
    attachmentVersion: 1,
    fetchedAt: 1000,
    ...extra,
  };
}

test('parseConfluenceDownloadUrl: attachments + thumbnails, with/without version, absolute + root-relative', () => {
  assert.deepEqual(parseConfluenceDownloadUrl('https://wiki.test/download/attachments/12/pic.png?version=3&api=v2'), {
    pageId: '12',
    attachment: 'pic.png',
    version: 3,
  });
  assert.deepEqual(parseConfluenceDownloadUrl('/download/thumbnails/987/shot.png'), {
    pageId: '987',
    attachment: 'shot.png',
    version: 0,
  });
  assert.deepEqual(parseConfluenceDownloadUrl('https://wiki.test/download/attachments/12/a.png?modificationDate=1'), {
    pageId: '12',
    attachment: 'a.png',
    version: 0,
  });
});

test('parseConfluenceDownloadUrl: decodes Vietnamese + URL-encoded spaces in the attachment name', () => {
  const r = parseConfluenceDownloadUrl('https://wiki.test/download/attachments/55/M%C3%A0n%20h%C3%ACnh%20ch%C3%ADnh.png?version=2');
  assert.deepEqual(r, { pageId: '55', attachment: 'Màn hình chính.png', version: 2 });
});

test('parseConfluenceDownloadUrl: non-attachment URLs → null', () => {
  assert.equal(parseConfluenceDownloadUrl('https://wiki.test/images/icons/emoticons/smile.png'), null);
  assert.equal(parseConfluenceDownloadUrl('https://wiki.test/plugins/servlet/confluence/placeholder/macro?x=1'), null);
  assert.equal(parseConfluenceDownloadUrl('https://wiki.test/download/attachments/notanid/pic.png'), null);
  assert.equal(parseConfluenceDownloadUrl('data:image/png;base64,AAAA'), null);
});

test('confluenceAttachmentDownloadUrl: pin adds &version only when known; base trailing slash trimmed; name encoded', () => {
  const it = { pageId: '12', attachment: 'Màn hình chính.png', attachmentVersion: 4 };
  assert.equal(
    confluenceAttachmentDownloadUrl('https://wiki.test/', it, true),
    'https://wiki.test/download/attachments/12/M%C3%A0n%20h%C3%ACnh%20ch%C3%ADnh.png?api=v2&version=4',
  );
  assert.equal(
    confluenceAttachmentDownloadUrl('https://wiki.test', it, false),
    'https://wiki.test/download/attachments/12/M%C3%A0n%20h%C3%ACnh%20ch%C3%ADnh.png?api=v2',
  );
  assert.equal(
    confluenceAttachmentDownloadUrl('https://wiki.test', { ...it, attachmentVersion: 0 }, true),
    'https://wiki.test/download/attachments/12/M%C3%A0n%20h%C3%ACnh%20ch%C3%ADnh.png?api=v2',
  );
});

test('mergeConfluenceSourcesLedger: replace by name, keep others, sort by name, version 1 + base', () => {
  const prev = { version: 1 as const, base: 'https://old.test', items: [item('b.png'), item('a.png', { sha256: 'old' })] };
  const merged = mergeConfluenceSourcesLedger(prev, 'https://wiki.test/', [item('a.png', { sha256: 'new' }), item('c.drawio')]);
  assert.equal(merged.version, 1);
  assert.equal(merged.base, 'https://wiki.test');
  assert.deepEqual(
    merged.items.map((i) => [i.name, i.sha256]),
    [
      ['a.png', 'new'],
      ['b.png', 'ab'.repeat(32)],
      ['c.drawio', 'ab'.repeat(32)],
    ],
  );
  // null prev → just the new items
  assert.deepEqual(mergeConfluenceSourcesLedger(null, 'https://wiki.test', [item('z')]).items.map((i) => i.name), ['z']);
});

test('pruneConfluenceSourcesLedger drops items whose file is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-prune-'));
  try {
    await writeFile(join(dir, 'keep.png'), 'x');
    const pruned = await pruneConfluenceSourcesLedger(
      { version: 1, base: 'https://wiki.test', items: [item('keep.png'), item('gone.png')] },
      dir,
    );
    assert.deepEqual(pruned.items.map((i) => i.name), ['keep.png']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('read: missing file → null; parse error → null; wrong shape → null; valid → ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-read-'));
  try {
    assert.equal(await readConfluenceSourcesLedger(dir), null);
    await writeFile(join(dir, CONFLUENCE_SOURCES_FILE), '{not json');
    assert.equal(await readConfluenceSourcesLedger(dir), null);
    await writeFile(join(dir, CONFLUENCE_SOURCES_FILE), JSON.stringify({ version: 2, items: [] }));
    assert.equal(await readConfluenceSourcesLedger(dir), null);
    await writeFile(
      join(dir, CONFLUENCE_SOURCES_FILE),
      JSON.stringify({ version: 1, base: 'https://wiki.test', items: [item('a.png'), { junk: true }] }),
    );
    const led = await readConfluenceSourcesLedger(dir);
    assert.ok(led);
    assert.equal(led.base, 'https://wiki.test');
    assert.deepEqual(led.items.map((i) => i.name), ['a.png']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('write: creates a valid 2-space JSON file with trailing newline via tmp+rename, no tmp left behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-write-'));
  try {
    const ledger = { version: 1 as const, base: 'https://wiki.test', items: [item('a.png')] };
    await writeConfluenceSourcesLedger(join(dir, 'attachments'), ledger);
    const raw = await readFile(join(dir, 'attachments', CONFLUENCE_SOURCES_FILE), 'utf8');
    assert.equal(raw, `${JSON.stringify(ledger, null, 2)}\n`);
    assert.deepEqual(await readdir(join(dir, 'attachments')), [CONFLUENCE_SOURCES_FILE]);
    assert.deepEqual(await readConfluenceSourcesLedger(join(dir, 'attachments')), ledger);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseConfluenceDownloadUrl: dạng embedded-page/<space>/<title>/<name> (export_view ảnh dán) → pageId rỗng + spaceKey/pageTitle decode', () => {
  assert.deepEqual(
    parseConfluenceDownloadUrl('https://wiki.test/download/attachments/embedded-page/SMB/Qu%E1%BA%A3n%20l%C3%BD%20th%E1%BA%BB/image-2026-8-14_9-21-5.png?api=v2'),
    { pageId: '', attachment: 'image-2026-8-14_9-21-5.png', version: 0, spaceKey: 'SMB', pageTitle: 'Quản lý thẻ' },
  );
  // Dạng numeric giữ nguyên, không có spaceKey/pageTitle.
  assert.deepEqual(parseConfluenceDownloadUrl('/download/attachments/12/a.png?version=2'), { pageId: '12', attachment: 'a.png', version: 2 });
});
