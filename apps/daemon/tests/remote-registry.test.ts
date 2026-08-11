// Remote registry merge + loader. Pure logic (mergeRemoteProjects) plus the
// source-agnostic loadRemoteProjects driven by fakes — no KGS/media boot. Proves
// the LIST half of the remote registry (KGS ⊕ media, merged by projectId).

import { describe, expect, it } from 'vitest';

import {
  filterVisibleProjects,
  isProjectVisible,
  loadRemoteProjects,
  mergeRemoteProjects,
  projectIdFromWorkspace,
  type FolderSource,
  type WorkspaceSource,
} from '../src/kg-sync/remote-registry.js';
import type { RemoteProject } from '@open-design/contracts';

describe('projectIdFromWorkspace', () => {
  it('prefers the explicit projectId property', () => {
    expect(projectIdFromWorkspace({ properties: { projectId: 'XPOS' } })).toBe('XPOS');
  });
  it('falls back to the ws-project-<id> entityId', () => {
    expect(projectIdFromWorkspace({ entityId: 'ws-project-demo' })).toBe('demo');
  });
  it('returns null for non-project workspaces', () => {
    expect(projectIdFromWorkspace({ entityId: 'ws-catalog-shadcn' })).toBeNull();
    expect(projectIdFromWorkspace({})).toBeNull();
  });
});

describe('mergeRemoteProjects', () => {
  it('merges by projectId with correct flags + file counts, sorted by id', () => {
    const merged = mergeRemoteProjects(
      [
        { projectId: 'b-both', name: 'Both' },
        { projectId: 'a-kgs', name: 'KgsOnly' },
      ],
      [
        { projectId: 'b-both', files: 5 },
        { projectId: 'c-media', files: 2 },
      ],
    );
    expect(merged).toEqual([
      { projectId: 'a-kgs', name: 'KgsOnly', inKgs: true, inMedia: false, files: 0, isApp: false },
      { projectId: 'b-both', name: 'Both', inKgs: true, inMedia: true, files: 5, isApp: false },
      { projectId: 'c-media', name: 'c-media', inKgs: false, inMedia: true, files: 2, isApp: false },
    ]);
  });

  it('uses projectId as name when a media-only project has no KGS name', () => {
    const merged = mergeRemoteProjects([], [{ projectId: 'orphan', files: 1 }]);
    expect(merged[0]).toMatchObject({ projectId: 'orphan', name: 'orphan', inKgs: false, inMedia: true });
  });

  it('flags an App container (media folder app--<slug>) via isApp, whether seen from KGS or media', () => {
    const fromKgs = mergeRemoteProjects([{ projectId: 'app--bidv', name: 'BIDV' }], []);
    expect(fromKgs[0]).toMatchObject({ projectId: 'app--bidv', isApp: true });

    const fromMedia = mergeRemoteProjects([], [{ projectId: 'app--bidv', files: 2 }]);
    expect(fromMedia[0]).toMatchObject({ projectId: 'app--bidv', isApp: true });

    const feature = mergeRemoteProjects([{ projectId: 'BIDV-onboarding', name: 'Onboarding' }], []);
    expect(feature[0]).toMatchObject({ projectId: 'BIDV-onboarding', isApp: false });
  });
});

describe('loadRemoteProjects', () => {
  it('combines KGS workspaces with media folders + per-folder file counts', async () => {
    const kgs: WorkspaceSource = {
      queryEntities: async () => [
        { entityId: 'ws-project-XPOS', properties: { projectId: 'XPOS', name: 'X POS' } },
        { entityId: 'ws-catalog-shadcn' }, // not a project → skipped
      ],
    };
    const media: FolderSource = {
      listFolders: async () => [
        { id: 'f1', name: 'XPOS' },
        { id: 'f2', name: 'media-only' },
      ],
      listAllFiles: async (id) => (id === 'f1' ? [1, 2, 3] : [1]),
    };

    const rows = await loadRemoteProjects(kgs, media);
    const byId = Object.fromEntries(rows.map((r) => [r.projectId, r]));
    expect(rows).toHaveLength(2);
    expect(byId.XPOS).toEqual({
      projectId: 'XPOS',
      name: 'X POS',
      inKgs: true,
      inMedia: true,
      files: 3,
      isApp: false,
    });
    expect(byId['media-only']).toEqual({
      projectId: 'media-only',
      name: 'media-only',
      inKgs: false,
      inMedia: true,
      files: 1,
      isApp: false,
    });
  });

  it('hides `pending--…` folders — an approval request is not a pullable project', async () => {
    // Studio hides them for free (it enumerates KGS workspaces and a staged
    // push writes none); Open Design enumerates EVERY media folder, so without
    // this filter every machine in the app would see other people's unapproved
    // work as a project it could pull.
    const kgs: WorkspaceSource = { queryEntities: async () => [] };
    const media: FolderSource = {
      listFolders: async () => [
        { id: 'f1', name: 'checkout' },
        { id: 'f2', name: 'pending--checkout--a1b2c3' },
        { id: 'f3', name: 'pending--decisions' },
      ],
      listAllFiles: async () => [1],
    };
    const rows = await loadRemoteProjects(kgs, media);
    expect(rows.map((r) => r.projectId)).toEqual(['checkout']);
  });

  it('still lists media when KGS is down (best-effort per source)', async () => {
    const kgs: WorkspaceSource = {
      queryEntities: async () => {
        throw new Error('KGS unreachable');
      },
    };
    const media: FolderSource = {
      listFolders: async () => [{ id: 'f1', name: 'XPOS' }],
      listAllFiles: async () => [1, 2],
    };
    const rows = await loadRemoteProjects(kgs, media);
    expect(rows).toEqual([
      { projectId: 'XPOS', name: 'XPOS', inKgs: false, inMedia: true, files: 2, isApp: false },
    ]);
  });
});

describe('isProjectVisible / filterVisibleProjects', () => {
  it('scope.all sees everything regardless of ids', () => {
    expect(isProjectVisible('anything', null, { all: true, ids: new Set() })).toBe(true);
  });

  it('a direct member sees their own project', () => {
    const scope = { all: false, ids: new Set(['TN1']) };
    expect(isProjectVisible('TN1', null, scope)).toBe(true);
  });

  it("cascades: a feature is visible when its PARENT APP is in scope, even if the feature itself isn't", () => {
    const scope = { all: false, ids: new Set(['app--bidv']) };
    expect(isProjectVisible('TN1', 'app--bidv', scope)).toBe(true);
  });

  it('neither the project nor its app is in scope → not visible', () => {
    const scope = { all: false, ids: new Set(['app--other']) };
    expect(isProjectVisible('TN1', 'app--bidv', scope)).toBe(false);
  });

  it('an unlinked feature (no appId) needs its own direct membership', () => {
    const scope = { all: false, ids: new Set(['app--bidv']) };
    expect(isProjectVisible('standalone-feature', null, scope)).toBe(false);
  });

  it('filterVisibleProjects applies the cascade across a full project list', () => {
    const data: RemoteProject[] = [
      { projectId: 'app--bidv', name: 'BIDV', inKgs: false, inMedia: true, files: 0, isApp: true },
      {
        projectId: 'TN1',
        name: 'Tính năng 1',
        inKgs: true,
        inMedia: true,
        files: 1,
        isApp: false,
        appId: 'app--bidv',
      },
      {
        projectId: 'unrelated',
        name: 'Unrelated',
        inKgs: true,
        inMedia: false,
        files: 0,
        isApp: false,
        appId: null,
      },
    ];
    const scope = { all: false, ids: new Set(['app--bidv']) };
    const visible = filterVisibleProjects(data, scope);
    expect(visible.map((p) => p.projectId)).toEqual(['app--bidv', 'TN1']);
  });
});
