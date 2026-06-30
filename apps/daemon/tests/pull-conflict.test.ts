// Pull conflict resolution — pure helpers + the extracted PLAN/APPLY core.
//
// Proves the spec's three guarantees (docs/guides/pull-conflict-resolution-spec.md)
// at the cheapest runnable layer: an in-memory RemoteFileStore + a temp cwd, no
// daemon boot and no live media-service.
//   1. classification: new / unchanged / conflict (text vs binary).
//   2. resolutions: conflict=local keeps the file; conflict=remote overwrites.
//   3. TOCTOU: a remote checksum that drifts between PLAN and APPLY is reported
//      in `stale` and never written blind.

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PREVIEW_CAP,
  PullPlanStore,
  applyPullFiles,
  classify,
  conflictKind,
  isTextPath,
  planPullFiles,
  sha256hex,
  type RemoteFile,
  type RemoteFileStore,
} from '../src/kg-sync/pull-conflict.js';

const hex = (s: string) => createHash('sha256').update(Buffer.from(s)).digest('hex');

// A trivial in-memory media-service: one folder, files keyed by path. Tests can
// mutate `files` between plan and apply to simulate remote drift (TOCTOU).
class FakeStore implements RemoteFileStore {
  files = new Map<string, { stage: string; content: Buffer }>();

  set(p: string, content: string | Buffer, stage = 'misc') {
    this.files.set(p, { stage, content: Buffer.isBuffer(content) ? content : Buffer.from(content) });
  }

  async ensureFolder(): Promise<string> {
    return 'folder-1';
  }

  async listAllFiles(): Promise<RemoteFile[]> {
    return [...this.files.entries()].map(([p, f], i) => ({
      id: `id-${i}`,
      path: p,
      stage: f.stage,
      checksum: sha256hex(f.content),
      size: f.content.length,
    }));
  }

  async downloadFile(_projectId: string, filePath: string): Promise<Buffer> {
    const f = this.files.get(filePath);
    if (!f) throw new Error(`not found ${filePath}`);
    return f.content;
  }
}

describe('pure helpers', () => {
  it('classify by checksum', () => {
    expect(classify(null, 'abc')).toBe('new');
    expect(classify('abc', 'abc')).toBe('unchanged');
    expect(classify('abc', 'def')).toBe('conflict');
  });

  it('isTextPath by extension (case-insensitive)', () => {
    for (const p of ['a.md', 'b.json', 'c.TS', 'd/e.tsx', 'f.YAML', 'g.svg']) {
      expect(isTextPath(p)).toBe(true);
    }
    for (const p of ['a.png', 'b.pdf', 'c', '.gitignore', 'd.bin']) {
      expect(isTextPath(p)).toBe(false);
    }
  });

  it('conflictKind: text under cap is text; binary ext or oversize is binary', () => {
    expect(conflictKind('a.json', 10, 20)).toBe('text');
    expect(conflictKind('a.png', 10, 20)).toBe('binary');
    expect(conflictKind('a.json', PREVIEW_CAP + 1, 20)).toBe('binary');
    expect(conflictKind('a.json', 10, PREVIEW_CAP + 1)).toBe('binary');
  });

  it('sha256hex matches node crypto', () => {
    expect(sha256hex(Buffer.from('hello'))).toBe(hex('hello'));
  });

  it('PullPlanStore expires snapshots past the TTL', () => {
    let now = 1_000;
    const store = new PullPlanStore(100, () => now);
    const plan = {
      projectId: 'P',
      planId: 'plan_x',
      summary: { new: 0, unchanged: 0, conflicts: 0 },
      new: [],
      conflicts: [],
    };
    store.put(plan, new Map());
    expect(store.get('plan_x')).not.toBeNull();
    now = 1_050; // within TTL
    expect(store.get('plan_x')).not.toBeNull();
    now = 1_201; // past TTL
    expect(store.get('plan_x')).toBeNull();
  });
});

describe('planPullFiles + applyPullFiles', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'pull-conflict-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const writeLocal = async (rel: string, content: string) => {
    const dest = path.join(cwd, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  };

  it('classifies new / unchanged / conflict', async () => {
    const store = new FakeStore();
    store.set('same.md', 'identical', 'ux-spec');
    store.set('diff.md', 'remote version', 'ux-spec');
    store.set('remoteonly.md', 'brand new', 'ui');

    await writeLocal('same.md', 'identical'); // unchanged
    await writeLocal('diff.md', 'local version'); // conflict
    await writeLocal('localonly.md', 'not on remote'); // ignored (not remote)

    const { plan } = await planPullFiles('P', cwd, store);
    expect(plan.summary).toEqual({ new: 1, unchanged: 1, conflicts: 1 });
    expect(plan.new.map((e) => e.path)).toEqual(['remoteonly.md']);

    const conflict = plan.conflicts[0]!;
    expect(conflict.path).toBe('diff.md');
    expect(conflict.kind).toBe('text');
    expect(conflict.local.preview).toBe('local version');
    expect(conflict.remote.preview).toBe('remote version');
  });

  it('keep-local resolution leaves the file; new files still download', async () => {
    const store = new FakeStore();
    store.set('diff.md', 'remote version');
    store.set('remoteonly.md', 'brand new');
    await writeLocal('diff.md', 'local version');

    const { plan, remoteByPath } = await planPullFiles('P', cwd, store);
    const stored = { plan, remoteByPath, expiresAt: Number.MAX_SAFE_INTEGER };
    const result = await applyPullFiles('P', cwd, store, stored, { 'diff.md': 'local' }, 'local');

    expect(result.keptLocal).toBe(1);
    expect(result.downloaded).toBe(1); // remoteonly.md
    expect(result.stale).toEqual([]);
    expect(await readFile(path.join(cwd, 'diff.md'), 'utf8')).toBe('local version');
    expect(await readFile(path.join(cwd, 'remoteonly.md'), 'utf8')).toBe('brand new');
  });

  it('remote resolution overwrites the local file', async () => {
    const store = new FakeStore();
    store.set('diff.md', 'remote version');
    await writeLocal('diff.md', 'local version');

    const { plan, remoteByPath } = await planPullFiles('P', cwd, store);
    const stored = { plan, remoteByPath, expiresAt: Number.MAX_SAFE_INTEGER };
    const result = await applyPullFiles('P', cwd, store, stored, { 'diff.md': 'remote' }, 'local');

    expect(result.downloaded).toBe(1);
    expect(result.keptLocal).toBe(0);
    expect(await readFile(path.join(cwd, 'diff.md'), 'utf8')).toBe('remote version');
  });

  it('TOCTOU: remote drift between plan and apply is reported stale, not written', async () => {
    const store = new FakeStore();
    store.set('diff.md', 'remote v1');
    await writeLocal('diff.md', 'local version');

    const { plan, remoteByPath } = await planPullFiles('P', cwd, store);
    const stored = { plan, remoteByPath, expiresAt: Number.MAX_SAFE_INTEGER };

    // Remote changes AFTER the plan was snapshotted.
    store.set('diff.md', 'remote v2 (changed!)');

    const result = await applyPullFiles('P', cwd, store, stored, { 'diff.md': 'remote' }, 'local');
    expect(result.downloaded).toBe(0);
    expect(result.stale).toEqual([{ path: 'diff.md', reason: 'remote changed since plan' }]);
    // The local file is untouched — no blind overwrite.
    expect(await readFile(path.join(cwd, 'diff.md'), 'utf8')).toBe('local version');
  });

  it('binary conflict carries metadata but no preview', async () => {
    const store = new FakeStore();
    store.set('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    await writeLocal('logo.png', 'different bytes');

    const { plan } = await planPullFiles('P', cwd, store);
    expect(plan.conflicts).toHaveLength(1);
    const c = plan.conflicts[0]!;
    expect(c.kind).toBe('binary');
    expect(c.local.preview).toBeNull();
    expect(c.remote.preview).toBeNull();
    expect(c.remote.size).toBeGreaterThan(0);
  });
});
