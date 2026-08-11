import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectApprovedDesignSystemPackages,
  DESIGN_SYSTEMS_MEDIA_FOLDER,
  designSystemSyncStatus,
  installPulledDesignSystem,
  listRemoteDesignSystems,
  planPullDesignSystem,
  publishDesignSystem,
  type DesignSystemRemoteStore,
} from '../src/design-system-sync.js';

class MemoryStore implements DesignSystemRemoteStore {
  readonly files = new Map<string, Buffer>();
  uploads = 0;
  async listFiles(folder: string) {
    expect(folder).toBe(DESIGN_SYSTEMS_MEDIA_FOLDER);
    return [...this.files.entries()].map(([filePath, content], index) => ({ id: String(index), path: filePath, checksum: '', size: content.length }));
  }
  async downloadFile(_folder: string, filePath: string) {
    const content = this.files.get(filePath);
    if (!content) throw new Error(`missing ${filePath}`);
    return Buffer.from(content);
  }
  async syncProjectFiles(_folder: string, files: Array<{ path: string; content: Buffer }>) {
    let uploaded = 0; let skipped = 0;
    for (const file of files) {
      const old = this.files.get(file.path);
      if (old?.equals(file.content)) skipped += 1;
      else { this.files.set(file.path, Buffer.from(file.content)); uploaded += 1; this.uploads += 1; }
    }
    return { uploaded, skipped, deleted: 0 };
  }
}

async function makeApprovedDs(root: string, id = 'payments') {
  const dir = path.join(root, id);
  await fs.promises.mkdir(path.join(dir, 'ir'), { recursive: true });
  await fs.promises.mkdir(path.join(dir, 'react'), { recursive: true });
  await fs.promises.mkdir(path.join(dir, 'criteria'), { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: 'Payments DS' }));
  await fs.promises.writeFile(path.join(dir, 'ir', 'figma.json'), '{"figma":1}\n');
  await fs.promises.writeFile(path.join(dir, 'react', 'Button.tsx'), 'export const Button = 1;\n');
  await fs.promises.writeFile(path.join(dir, 'criteria', 'components.md'), '# Components\n\n### `button` Button\n');
  await fs.promises.writeFile(path.join(dir, 'criteria', 'rules.md'), '# Rules\n\n### `r1` Rule\n');
  return dir;
}

describe('Design System media sync', () => {
  let root: string;
  let store: MemoryStore;

  beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'od-ds-sync-')); store = new MemoryStore(); });
  afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }); });

  it('publishes an immutable version, persists mapping, and does not duplicate it on retry', async () => {
    const dsDir = await makeApprovedDs(root);
    const first = await publishDesignSystem({ dsDir, localDesignSystemId: 'user:payments', store,
      owner: { id: 'user-1', name: 'Designer' }, usage: [{ kind: 'app', appId: 'checkout' }],
      now: new Date('2026-08-10T01:00:00Z') });
    expect(first).toMatchObject({ unchanged: false, uploadedVersions: ['v1'], summary: { currentVersion: 'v1', visibility: 'workspace' } });
    expect(store.files.has('payments/versions/v1/manifest.json')).toBe(true);
    expect(store.files.has('payments/versions/v1/files/ir/figma.json')).toBe(true);
    expect(JSON.parse(await fs.promises.readFile(path.join(dsDir, '.sync.json'), 'utf8'))).toMatchObject({ remoteDesignSystemId: 'payments' });

    const second = await publishDesignSystem({ dsDir, localDesignSystemId: 'user:payments', store,
      owner: { id: 'user-1' }, usage: [{ kind: 'app', appId: 'checkout' }],
      expectedRemoteDigest: first.summary.currentDigest, now: new Date('2026-08-10T02:00:00Z') });
    expect(second.unchanged).toBe(true);
    expect(second.uploadedVersions).toEqual([]);
    expect(second.summary.versions).toEqual(['v1']);
  });

  it('blocks active candidates and approved versions whose criteria remain stale', async () => {
    const dsDir = await makeApprovedDs(root);
    const base = await collectApprovedDesignSystemPackages(dsDir, 'user:payments', false);
    await fs.promises.mkdir(path.join(dsDir, '.figma-update'), { recursive: true });
    await fs.promises.writeFile(path.join(dsDir, '.figma-update', 'state.json'), JSON.stringify({
      schemaVersion: 1, designSystemId: 'user:payments', lifecycle: 'approved', currentVersion: 2,
      currentFigmaDigest: base.current.contentDigest, candidateVersion: null, candidateFigmaDigest: null,
      candidateCreatedAt: null, deleteOldSourceAfterApproval: false, approvedAt: null,
      contextVersioning: 'completed', contextVersioningError: null,
      criteria: {
        components: { kind: 'components', status: 'current', hasApprovedFile: true, hasDraft: false, approvedContent: null, draftContent: null, count: 1, generatedFromVersion: 2, generatedFromFigmaDigest: null, generatedAt: null },
        rules: { kind: 'rules', status: 'stale', hasApprovedFile: true, hasDraft: false, approvedContent: null, draftContent: null, count: 1, generatedFromVersion: 1, generatedFromFigmaDigest: null, generatedAt: null },
      },
    }));
    const status = await designSystemSyncStatus({ dsDir, localDesignSystemId: 'user:payments', store, usage: [] });
    expect(status).toMatchObject({ canPush: false, blockReason: 'criteria_stale' });
    await expect(publishDesignSystem({ dsDir, localDesignSystemId: 'user:payments', store, owner: { id: 'user-1' }, usage: [] }))
      .rejects.toMatchObject({ code: 'DS_SYNC_BLOCKED', reason: 'criteria_stale' });
  });

  it('includes archived DS versions when local Apps or Features still use the Design System', async () => {
    const dsDir = await makeApprovedDs(root);
    const archive = path.join(dsDir, '.figma-update', 'versions', 'v1');
    await fs.promises.mkdir(path.join(archive, 'ir'), { recursive: true });
    await fs.promises.mkdir(path.join(archive, 'criteria'), { recursive: true });
    await fs.promises.writeFile(path.join(archive, 'ir', 'figma.json'), '{"figma":"old"}\n');
    await fs.promises.writeFile(path.join(archive, 'criteria', 'components.md'), '# Components\n\n### `old` Old\n');
    await fs.promises.writeFile(path.join(archive, 'criteria', 'rules.md'), '# Rules\n\n### `old` Old\n');
    await fs.promises.writeFile(path.join(dsDir, '.figma-update', 'state.json'), JSON.stringify({
      schemaVersion: 1, designSystemId: 'user:payments', lifecycle: 'approved', currentVersion: 2,
      currentFigmaDigest: 'sha256:new', candidateVersion: null, candidateFigmaDigest: null,
      candidateCreatedAt: null, deleteOldSourceAfterApproval: false, approvedAt: '2026-08-10T00:00:00Z',
      contextVersioning: 'completed', contextVersioningError: null,
      criteria: {
        components: { kind: 'components', status: 'current', hasApprovedFile: true, hasDraft: false, approvedContent: null, draftContent: null, count: 1, generatedFromVersion: 2, generatedFromFigmaDigest: 'sha256:new', generatedAt: null },
        rules: { kind: 'rules', status: 'current', hasApprovedFile: true, hasDraft: false, approvedContent: null, draftContent: null, count: 1, generatedFromVersion: 2, generatedFromFigmaDigest: 'sha256:new', generatedAt: null },
      },
    }));
    const result = await publishDesignSystem({ dsDir, localDesignSystemId: 'user:payments', store,
      owner: { id: 'user-1' }, usage: [{ kind: 'feature', appId: 'checkout', featureId: 'pay', contextVersion: 'v1' }] });
    expect(result.uploadedVersions).toEqual(['v1', 'v2']);
    expect(result.summary.versions).toEqual(['v1', 'v2']);
    expect(JSON.parse(store.files.get('payments/versions/v1/manifest.json')!.toString('utf8'))).toMatchObject({ sourceVersion: 1 });
    expect(JSON.parse(store.files.get('payments/versions/v2/manifest.json')!.toString('utf8'))).toMatchObject({ sourceVersion: 2 });
  });

  it('plans conflicts, verifies checksums, and pulls atomically without touching App/Feature state', async () => {
    const sourceDir = await makeApprovedDs(path.join(root, 'source'));
    const published = await publishDesignSystem({ dsDir: sourceDir, localDesignSystemId: 'user:payments', store,
      owner: { id: 'user-1' }, usage: [] });
    const targetRoot = path.join(root, 'target');
    await fs.promises.mkdir(path.join(targetRoot, 'payments'), { recursive: true });
    await fs.promises.writeFile(path.join(targetRoot, 'payments', 'local.txt'), 'local');
    const plan = await planPullDesignSystem({ userDesignSystemsDir: targetRoot, remoteDesignSystemId: 'payments', store });
    expect(plan).toMatchObject({ localExists: true, conflict: true, manifest: { contentDigest: published.manifest.contentDigest } });
    await installPulledDesignSystem({ userDesignSystemsDir: targetRoot, plan: plan!, store });
    expect(await fs.promises.readFile(path.join(targetRoot, 'payments', 'react', 'Button.tsx'), 'utf8')).toContain('Button');
    await expect(fs.promises.stat(path.join(targetRoot, 'payments', 'local.txt'))).rejects.toThrow();
    expect(JSON.parse(await fs.promises.readFile(path.join(targetRoot, 'payments', '.sync.json'), 'utf8'))).toMatchObject({ lastPulledDigest: published.manifest.contentDigest });
  });

  it('isolates malformed artifacts while listing workspace-visible packages', async () => {
    const dsDir = await makeApprovedDs(root);
    await publishDesignSystem({ dsDir, localDesignSystemId: 'user:payments', store, owner: { id: 'user-1' }, usage: [] });
    store.files.set('broken/summary.json', Buffer.from('{not-json'));
    store.files.set('wrong/summary.json', Buffer.from('{}'));
    const rows = await listRemoteDesignSystems(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ remoteDesignSystemId: 'payments', visibility: 'workspace' });
  });
});
