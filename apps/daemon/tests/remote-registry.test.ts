// Remote registry merge + loader. Pure logic (mergeRemoteProjects) plus the
// source-agnostic loadRemoteProjects driven by fakes — no KGS/media boot. Proves
// the LIST half of the remote registry (KGS ⊕ media, merged by projectId).

import { describe, expect, it } from 'vitest';

import {
  loadRemoteProjects,
  mergeRemoteProjects,
  projectIdFromWorkspace,
  type FolderSource,
  type WorkspaceSource,
} from '../src/kg-sync/remote-registry.js';

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
      { projectId: 'a-kgs', name: 'KgsOnly', inKgs: true, inMedia: false, files: 0 },
      { projectId: 'b-both', name: 'Both', inKgs: true, inMedia: true, files: 5 },
      { projectId: 'c-media', name: 'c-media', inKgs: false, inMedia: true, files: 2 },
    ]);
  });

  it('uses projectId as name when a media-only project has no KGS name', () => {
    const merged = mergeRemoteProjects([], [{ projectId: 'orphan', files: 1 }]);
    expect(merged[0]).toMatchObject({ projectId: 'orphan', name: 'orphan', inKgs: false, inMedia: true });
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
    expect(byId.XPOS).toEqual({ projectId: 'XPOS', name: 'X POS', inKgs: true, inMedia: true, files: 3 });
    expect(byId['media-only']).toEqual({
      projectId: 'media-only',
      name: 'media-only',
      inKgs: false,
      inMedia: true,
      files: 1,
    });
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
    expect(rows).toEqual([{ projectId: 'XPOS', name: 'XPOS', inKgs: false, inMedia: true, files: 2 }]);
  });
});
