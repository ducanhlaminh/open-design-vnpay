import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemFigmaUpdateState } from '@open-design/contracts';

import {
  createAppContextVersion,
  featureContextBindingFromMetadata,
  listAppContextVersions,
  metadataWithFeatureContextBinding,
  readCurrentAppContextManifest,
} from '../src/app-context-version.js';
import {
  approveFigmaDesignSystemUpdate,
} from '../src/design-system-update.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'od-ds-context-integration-'));
  roots.push(root);
  const projectsDir = path.join(root, 'projects');
  const dsDir = path.join(root, 'design-systems', 'payments');
  const candidate = path.join(dsDir, '.figma-update', 'candidate');
  await fs.promises.mkdir(path.join(projectsDir, 'banking', 'app-context'), { recursive: true });
  await fs.promises.writeFile(path.join(projectsDir, 'banking', 'app-context', 'ux-charter.json'), '{}\n');
  await fs.promises.mkdir(path.join(dsDir, 'criteria'), { recursive: true });
  await fs.promises.writeFile(path.join(dsDir, 'criteria', 'components.md'), '# Components\n- Button\n');
  await fs.promises.writeFile(path.join(dsDir, 'criteria', 'rules.md'), '# Rules\n- Use tokens\n');
  await fs.promises.writeFile(path.join(dsDir, 'tokens.json'), '{"primary":"old"}\n');

  const v1 = (await createAppContextVersion({
    projectsDir,
    appId: 'banking',
    appName: 'Banking',
    designSystemId: 'user:payments',
    designSystemDir: dsDir,
  })).manifest;
  const featureMetadata = metadataWithFeatureContextBinding({}, {
    schemaVersion: 1,
    appId: 'banking',
    contextVersion: v1.contextVersion,
    contentDigest: v1.contentDigest,
    boundAt: '2026-08-10T01:00:00.000Z',
  });

  await fs.promises.mkdir(path.join(candidate, 'criteria'), { recursive: true });
  await fs.promises.writeFile(path.join(candidate, 'criteria', 'components.md'), '# Components\n- Button\n');
  await fs.promises.writeFile(path.join(candidate, 'criteria', 'rules.md'), '# Rules\n- Use tokens\n');
  await fs.promises.writeFile(path.join(candidate, 'tokens.json'), '{"primary":"new"}\n');
  const staleCriterion = (kind: 'components' | 'rules') => ({
    kind,
    status: 'stale' as const,
    hasApprovedFile: true,
    hasDraft: false,
    approvedContent: null,
    draftContent: null,
    count: 1,
    generatedFromVersion: 1,
    generatedFromFigmaDigest: 'sha256:old',
    generatedAt: '2026-08-09T01:00:00.000Z',
  });
  const state: DesignSystemFigmaUpdateState = {
    schemaVersion: 1,
    designSystemId: 'user:payments',
    lifecycle: 'criteria_pending',
    currentVersion: 1,
    currentFigmaDigest: 'sha256:old',
    candidateVersion: 2,
    candidateFigmaDigest: 'sha256:new',
    candidateCreatedAt: '2026-08-10T02:00:00.000Z',
    deleteOldSourceAfterApproval: false,
    approvedAt: null,
    contextVersioning: 'not_started',
    contextVersioningError: null,
    criteria: { components: staleCriterion('components'), rules: staleCriterion('rules') },
  };
  await fs.promises.writeFile(
    path.join(dsDir, '.figma-update', 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  return { projectsDir, dsDir, v1, featureMetadata };
}

describe('Figma DS final approval → App Context', () => {
  it('creates Context only after final approval and leaves Feature binding unchanged', async () => {
    const { projectsDir, dsDir, v1, featureMetadata } = await fixture();
    const versionAppContexts = vi.fn(async () => {
      const result = await createAppContextVersion({
        projectsDir,
        appId: 'banking',
        appName: 'Banking',
        designSystemId: 'user:payments',
        designSystemDir: dsDir,
      });
      return [{
        appId: 'banking',
        status: result.status,
        contextVersion: result.manifest.contextVersion,
      }];
    });

    await expect(approveFigmaDesignSystemUpdate({
      dsDir,
      designSystemId: 'user:payments',
      versionAppContexts,
    })).rejects.toMatchObject({
      code: 'STALE_CRITERIA_CONFIRMATION_REQUIRED',
    });
    expect(versionAppContexts).not.toHaveBeenCalled();
    expect(await listAppContextVersions(projectsDir, 'banking')).toHaveLength(1);
    expect((await readCurrentAppContextManifest(projectsDir, 'banking'))?.contextVersion).toBe('v1');

    const approved = await approveFigmaDesignSystemUpdate({
      dsDir,
      designSystemId: 'user:payments',
      confirmStaleCriteria: true,
      versionAppContexts,
      now: new Date('2026-08-10T03:00:00.000Z'),
    });
    expect(approved.state).toMatchObject({
      lifecycle: 'approved',
      currentVersion: 2,
      contextVersioning: 'completed',
    });
    expect(approved.staleCriteriaAccepted).toEqual(['components', 'rules']);
    expect(approved.contextUpdates).toEqual([{ appId: 'banking', status: 'created', contextVersion: 'v2' }]);
    expect((await readCurrentAppContextManifest(projectsDir, 'banking'))?.contextVersion).toBe('v2');
    expect((await listAppContextVersions(projectsDir, 'banking')).map((item) => item.contextVersion)).toEqual(['v2', 'v1']);
    expect(featureContextBindingFromMetadata(featureMetadata)).toMatchObject({
      contextVersion: v1.contextVersion,
      contentDigest: v1.contentDigest,
    });
  });
});
