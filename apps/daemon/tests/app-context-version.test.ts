import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appContextManifestDigestIsValid,
  createAppContextVersion,
  featureContextBindingFromMetadata,
  filesForFeatureContextPublish,
  listAppContextVersions,
  materializeAppContextVersion,
  metadataWithFeatureContextBinding,
  parseAppContextManifest,
  readCurrentAppContextManifest,
  stageBoundAppContextForRun,
  writeRunContextLock,
} from '../src/app-context-version.js';

const roots: string[] = [];

async function fixture() {
  const projectsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'od-app-context-'));
  roots.push(projectsDir);
  const appRoot = path.join(projectsDir, 'banking');
  const dsDir = path.join(projectsDir, '_ds');
  await fs.promises.mkdir(path.join(appRoot, 'app-context'), { recursive: true });
  await fs.promises.mkdir(path.join(appRoot, 'docs'), { recursive: true });
  await fs.promises.mkdir(path.join(dsDir, 'criteria'), { recursive: true });
  await fs.promises.writeFile(path.join(appRoot, 'app-context', 'ux-charter.json'), '{"criteria":[]}\n');
  await fs.promises.writeFile(path.join(appRoot, 'docs', '_manifest.json'), '{"version":1,"pages":[]}\n');
  await fs.promises.writeFile(path.join(dsDir, 'criteria', 'components.md'), '# Components\n');
  await fs.promises.writeFile(path.join(dsDir, 'criteria', 'rules.md'), '# Rules\n');
  return { projectsDir, appRoot, dsDir };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe('App Context immutable versions', () => {
  it('does not increment when the same bytes are snapshotted again', async () => {
    const { projectsDir, dsDir } = await fixture();
    const options = {
      projectsDir,
      appId: 'banking',
      appName: 'Banking',
      designSystemId: 'vnpay',
      designSystemDir: dsDir,
      now: new Date('2026-08-10T01:00:00.000Z'),
    };
    const first = await createAppContextVersion(options);
    const second = await createAppContextVersion({ ...options, now: new Date('2026-08-10T02:00:00.000Z') });
    expect(first.status).toBe('created');
    expect(second.status).toBe('unchanged');
    expect(second.manifest.contextVersion).toBe('v1');
    expect(await listAppContextVersions(projectsDir, 'banking')).toHaveLength(1);
  });

  it('increments exactly once when context, docs, or DS criteria changes', async () => {
    const { projectsDir, appRoot, dsDir } = await fixture();
    const options = { projectsDir, appId: 'banking', appName: 'Banking', designSystemId: 'vnpay', designSystemDir: dsDir };
    await createAppContextVersion(options);
    await fs.promises.writeFile(path.join(dsDir, 'criteria', 'rules.md'), '# Rules v2\n');
    expect((await createAppContextVersion(options)).manifest.contextVersion).toBe('v2');
    expect((await createAppContextVersion(options)).status).toBe('unchanged');
    await fs.promises.writeFile(path.join(appRoot, 'docs', 'page.md'), '# Page\n');
    expect((await createAppContextVersion(options)).manifest.contextVersion).toBe('v3');
  });

  it('versions the App-level docs-review Figma source and validates it after restart', async () => {
    const { projectsDir, dsDir } = await fixture();
    const base = { projectsDir, appId: 'banking', appName: 'Banking', designSystemId: 'vnpay', designSystemDir: dsDir };
    const v1 = (await createAppContextVersion(base)).manifest;
    const source = {
      mode: 'figma-links' as const,
      links: [{ url: 'https://www.figma.com/design/ABC123', fileKey: 'ABC123' }],
    };
    const v2 = (await createAppContextVersion({ ...base, docsReviewComponentSource: source })).manifest;
    expect(v2.contextVersion).toBe('v2');
    expect(v2.docsReviewComponentSource).toEqual(source);
    expect(appContextManifestDigestIsValid(v2)).toBe(true);
    expect(appContextManifestDigestIsValid({ ...v2, docsReviewComponentSource: { mode: 'app-design-system' } })).toBe(false);
    expect(v1.docsReviewComponentSource).toEqual({ mode: 'app-design-system' });
  });

  it('reads a legacy draft manifest without rewriting it', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(parseAppContextManifest({
      appId: 'legacy', contextVersion: 'v2', contentDigest: digest,
      files: [{ path: 'docs/a.md', digest }],
    })).toMatchObject({
      schemaVersion: 1,
      appId: 'legacy',
      appName: 'legacy',
      contextVersion: 'v2',
      files: [{ source: 'docs', size: 0 }],
    });
  });

  it('detects tampered manifest identity or file metadata', async () => {
    const { projectsDir, dsDir } = await fixture();
    const manifest = (await createAppContextVersion({
      projectsDir, appId: 'banking', appName: 'Banking', designSystemId: 'vnpay', designSystemDir: dsDir,
    })).manifest;
    expect(appContextManifestDigestIsValid(manifest)).toBe(true);
    expect(appContextManifestDigestIsValid({ ...manifest, appName: 'Tampered' })).toBe(false);
  });

  it('keeps a Feature bound to an older immutable version and writes that run lock', async () => {
    const { projectsDir, appRoot, dsDir } = await fixture();
    const options = { projectsDir, appId: 'banking', appName: 'Banking', designSystemId: 'vnpay', designSystemDir: dsDir };
    const v1 = (await createAppContextVersion(options)).manifest;
    const binding = {
      schemaVersion: 1 as const,
      appId: 'banking',
      contextVersion: v1.contextVersion,
      contentDigest: v1.contentDigest,
      boundAt: '2026-08-10T01:00:00.000Z',
    };
    const metadata = metadataWithFeatureContextBinding({ keep: true }, binding);
    await fs.promises.writeFile(path.join(appRoot, 'app-context', 'ux-charter.json'), '{"criteria":[1]}\n');
    const v2 = (await createAppContextVersion(options)).manifest;
    expect(v2.contextVersion).toBe('v2');
    expect(featureContextBindingFromMetadata(metadata)?.contextVersion).toBe('v1');
    const runCwd = path.join(projectsDir, 'run');
    await fs.promises.mkdir(runCwd);
    const lock = await writeRunContextLock({
      projectsDir,
      appId: 'banking',
      featureId: 'pay',
      runId: 'run-1',
      workflowId: 'docs-to-ui',
      runCwd,
      binding,
    });
    expect(lock.contextVersion).toBe('v1');
    expect(JSON.parse(await fs.promises.readFile(path.join(runCwd, 'context-lock.json'), 'utf8'))).toEqual(lock);
  });

  it('materializes a pulled version without changing any Feature binding', async () => {
    const { projectsDir, appRoot, dsDir } = await fixture();
    const options = { projectsDir, appId: 'banking', appName: 'Banking', designSystemId: 'vnpay', designSystemDir: dsDir };
    const v1 = (await createAppContextVersion(options)).manifest;
    await fs.promises.writeFile(path.join(appRoot, 'app-context', 'ux-charter.json'), 'local dirty\n');
    await materializeAppContextVersion({ projectsDir, appId: 'banking', contextVersion: v1.contextVersion });
    expect(await fs.promises.readFile(path.join(appRoot, 'app-context', 'ux-charter.json'), 'utf8')).toBe('{"criteria":[]}\n');
    expect((await readCurrentAppContextManifest(projectsDir, 'banking'))?.contextVersion).toBe('v1');
  });

  it('stages a historical Feature context after the mutable DS source was deleted', async () => {
    const { projectsDir, dsDir } = await fixture();
    const v1 = (await createAppContextVersion({
      projectsDir,
      appId: 'banking',
      appName: 'Banking',
      designSystemId: 'vnpay',
      designSystemDir: dsDir,
    })).manifest;
    const binding = {
      schemaVersion: 1 as const,
      appId: 'banking',
      contextVersion: v1.contextVersion,
      contentDigest: v1.contentDigest,
      boundAt: '2026-08-10T01:00:00.000Z',
    };

    // Final DS approval may remove an old mutable source revision. Immutable
    // App Context versions remain the replay source for old Feature runs.
    await fs.promises.rm(dsDir, { recursive: true, force: true });
    const runCwd = path.join(projectsDir, 'historical-run');
    await fs.promises.mkdir(runCwd);
    const staged = await stageBoundAppContextForRun({
      projectsDir,
      appId: 'banking',
      featureId: 'pay',
      runId: 'run-after-ds-cleanup',
      runCwd,
      binding,
    });

    expect(staged.lock.contextVersion).toBe('v1');
    expect(staged.stagedDesignSystem).toEqual(expect.arrayContaining([
      'criteria/components.md',
      'criteria/rules.md',
    ]));
    expect(await fs.promises.readFile(path.join(runCwd, 'criteria', 'components.md'), 'utf8')).toBe('# Components\n');
    expect(await fs.promises.readFile(path.join(runCwd, 'criteria', 'rules.md'), 'utf8')).toBe('# Rules\n');
  });

  it('publishes the bound historical version together with the current App pointer', async () => {
    const { projectsDir, appRoot, dsDir } = await fixture();
    const options = {
      projectsDir,
      appId: 'banking',
      appName: 'Banking',
      designSystemId: 'vnpay',
      designSystemDir: dsDir,
    };
    const v1 = (await createAppContextVersion(options)).manifest;
    await fs.promises.writeFile(path.join(appRoot, 'app-context', 'ux-charter.json'), '{"criteria":["new"]}\n');
    const v2 = (await createAppContextVersion(options)).manifest;

    const files = await filesForFeatureContextPublish({
      projectsDir,
      appId: 'banking',
      currentContextVersion: v2.contextVersion,
      binding: {
        schemaVersion: 1,
        appId: 'banking',
        contextVersion: v1.contextVersion,
        contentDigest: v1.contentDigest,
        boundAt: '2026-08-10T01:00:00.000Z',
      },
    });
    const paths = files.map((file) => file.path);
    expect(paths).toContain('context/versions/v1/manifest.json');
    expect(paths).toContain('context/versions/v2/manifest.json');
    expect(paths.filter((filePath) => filePath === 'context/current.json')).toHaveLength(1);
    const pointer = JSON.parse(files.find((file) => file.path === 'context/current.json')!.content.toString('utf8'));
    expect(pointer.contextVersion).toBe('v2');
  });
});
