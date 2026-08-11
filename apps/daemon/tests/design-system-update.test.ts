import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  approveDesignSystemCriteriaDraft,
  approveFigmaDesignSystemUpdate,
  DesignSystemUpdateError,
  designSystemCriteriaWorkDir,
  markDesignSystemCriteriaDraft,
  readDesignSystemUpdateState,
  startFigmaDesignSystemUpdate,
} from '../src/design-system-update.js';

const oldComponents = '# Components\n\n### `#old-button` Old Button\n';
const newComponents = '# Components\n\n### `#new-button` New Button\n';
const oldRules = '# Rules\n\n### `R-OLD` Old rule\n';
const updateFiles = [{
  filename: 'payments.ir.json',
  content: JSON.stringify({
    meta: { file: 'Payments v2' }, collections: [], variables: [], components: [], icons: [],
    componentSets: [{ name: 'New Button', id: '1:1', props: {}, variants: [{ props: {}, tree: { name: 'New Button', type: 'FRAME', w: 100, h: 40, fills: [] } }] }],
  }),
}];

describe('controlled Figma Design System update', () => {
  let root: string;
  let dsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-ds-update-'));
    dsDir = path.join(root, 'payments');
    await mkdir(path.join(dsDir, 'ir'), { recursive: true });
    await mkdir(path.join(dsDir, 'react'), { recursive: true });
    await mkdir(path.join(dsDir, 'criteria'), { recursive: true });
    await writeFile(path.join(dsDir, 'ir', 'old.ir.json'), '{"old":true}\n');
    await writeFile(path.join(dsDir, 'react', 'old.tsx'), 'export const Old = true;\n');
    await writeFile(path.join(dsDir, 'criteria', 'components.md'), oldComponents);
    await writeFile(path.join(dsDir, 'criteria', 'rules.md'), oldRules);
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('keeps approved criteria live, marks them stale, and only versions contexts at final approval', async () => {
    let contextCalls = 0;
    const created = await startFigmaDesignSystemUpdate({
      dsDir, designSystemId: 'user:payments', files: updateFiles, now: new Date('2026-01-02T03:04:05Z'),
    });
    expect(created.state).toMatchObject({ lifecycle: 'criteria_pending', currentVersion: 1, candidateVersion: 2 });
    expect(created.state.criteria.components.status).toBe('stale');
    expect(created.state.criteria.rules.status).toBe('stale');
    expect(await readFile(path.join(dsDir, 'criteria', 'components.md'), 'utf8')).toBe(oldComponents);
    expect(contextCalls).toBe(0);

    const workDir = await designSystemCriteriaWorkDir(dsDir, 'user:payments');
    await writeFile(path.join(workDir, 'criteria', 'components.md.next'), newComponents);
    await markDesignSystemCriteriaDraft(dsDir, 'user:payments', 'components');
    const draft = await readDesignSystemUpdateState(dsDir, 'user:payments');
    expect(draft.criteria.components).toMatchObject({ status: 'draft', approvedContent: oldComponents, draftContent: newComponents });
    expect(await readFile(path.join(dsDir, 'criteria', 'components.md'), 'utf8')).toBe(oldComponents);

    const reviewed = await approveDesignSystemCriteriaDraft(dsDir, 'user:payments', 'components', new Date('2026-01-03T00:00:00Z'));
    expect(reviewed.criteria.components).toMatchObject({ status: 'current', generatedFromVersion: 2 });
    expect(reviewed.criteria.rules.status).toBe('stale');
    expect(contextCalls).toBe(0);

    await expect(approveFigmaDesignSystemUpdate({
      dsDir, designSystemId: 'user:payments', versionAppContexts: async () => { contextCalls += 1; return []; },
    })).rejects.toSatisfy((error: unknown) => error instanceof DesignSystemUpdateError && error.code === 'STALE_CRITERIA_CONFIRMATION_REQUIRED');
    expect(contextCalls).toBe(0);

    const approved = await approveFigmaDesignSystemUpdate({
      dsDir, designSystemId: 'user:payments', confirmStaleCriteria: true,
      versionAppContexts: async () => { contextCalls += 1; return [{ appId: 'checkout', status: 'created', contextVersion: 'v2' }]; },
      now: new Date('2026-01-04T00:00:00Z'),
    });
    expect(approved.state).toMatchObject({ lifecycle: 'approved', currentVersion: 2, candidateVersion: null, contextVersioning: 'completed' });
    expect(approved.staleCriteriaAccepted).toEqual(['rules']);
    expect(approved.contextUpdates).toEqual([{ appId: 'checkout', status: 'created', contextVersion: 'v2' }]);
    expect(contextCalls).toBe(1);
    expect(await readFile(path.join(dsDir, 'criteria', 'components.md'), 'utf8')).toBe(newComponents);
    expect(await readFile(path.join(dsDir, 'criteria', 'rules.md'), 'utf8')).toBe(oldRules);
    expect(await stat(path.join(dsDir, '.figma-update', 'versions', 'v1', 'ir', 'old.ir.json'))).toBeTruthy();
  });

  it('deletes archived old Figma source only after promotion when selected', async () => {
    await startFigmaDesignSystemUpdate({
      dsDir, designSystemId: 'user:payments', files: updateFiles, deleteOldSourceAfterApproval: true,
    });
    expect(await readFile(path.join(dsDir, 'ir', 'old.ir.json'), 'utf8')).toContain('old');
    await approveFigmaDesignSystemUpdate({
      dsDir, designSystemId: 'user:payments', confirmStaleCriteria: true, versionAppContexts: async () => [],
    });
    await expect(stat(path.join(dsDir, '.figma-update', 'versions', 'v1'))).rejects.toThrow();
    await expect(stat(path.join(dsDir, 'ir', 'old.ir.json'))).rejects.toThrow();
    expect(await readFile(path.join(dsDir, '.figma-update', 'criteria-history', 'v1', 'components.md'), 'utf8')).toBe(oldComponents);
  });
});
