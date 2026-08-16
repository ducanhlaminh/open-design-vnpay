// Remote registry loader. Pure logic (mergeRemoteProjects) plus the
// source-agnostic loadRemoteProjects driven by a fake — no media-service boot.
// Proves the LIST half of the remote registry (media-service files).

import { describe, expect, it, vi } from 'vitest';

import {
  APP_MARKER_PATH,
  filterLifecycleVisibleProjects,
  filterVisibleProjects,
  isLifecycleHidden,
  isProjectVisible,
  loadRemoteProjects,
  mergeRemoteProjects,
  PROJECT_LIFECYCLE_PATH,
  type FolderSource,
} from '../src/kg-sync/remote-registry.js';
import type { RemoteProject } from '@open-design/contracts';

describe('mergeRemoteProjects', () => {
  it('builds project rows from media, sorted by id', () => {
    const merged = mergeRemoteProjects([
      { projectId: 'b-both', name: 'b-both', files: 5, isApp: false },
      { projectId: 'c-media', name: 'c-media', files: 2, isApp: false },
    ]);
    expect(merged).toEqual([
      { projectId: 'b-both', name: 'b-both', inMedia: true, files: 5, isApp: false, visibility: 'visible' },
      { projectId: 'c-media', name: 'c-media', inMedia: true, files: 2, isApp: false, visibility: 'visible' },
    ]);
  });

  it('passes the caller-resolved name through verbatim — NOT derived from projectId', () => {
    // mergeRemoteProjects is a pure passthrough; resolving a real display
    // name from project.json (falling back to the folder id) is
    // loadRemoteProjects' job, covered separately below.
    const merged = mergeRemoteProjects([{ projectId: 'orphan', name: 'Orphan Feature', files: 1, isApp: false }]);
    expect(merged[0]).toMatchObject({ projectId: 'orphan', name: 'Orphan Feature', inMedia: true });
  });

  it('passes the caller-resolved isApp flag through verbatim — NOT derived from projectId shape', () => {
    // Deliberately named with no 'app--'-style prefix: isApp is resolved by
    // loadRemoteProjects from the media folder's own file listing (an
    // `app.json` marker — see APP_MARKER_PATH), never from the id string.
    // mergeRemoteProjects itself is a pure passthrough for that flag.
    const app = mergeRemoteProjects([{ projectId: 'bidv', name: 'bidv', files: 2, isApp: true }]);
    expect(app[0]).toMatchObject({ projectId: 'bidv', isApp: true });

    const feature = mergeRemoteProjects([{ projectId: 'app--onboarding', name: 'app--onboarding', files: 0, isApp: false }]);
    expect(feature[0]).toMatchObject({ projectId: 'app--onboarding', isApp: false });
  });
});

describe('loadRemoteProjects', () => {
  it('lists media folders with per-folder file counts', async () => {
    const media: FolderSource = {
      listFolders: async () => [
        { id: 'f1', name: 'XPOS' },
        { id: 'f2', name: 'media-only' },
      ],
      listAllFiles: async (id) => (id === 'f1' ? [1, 2, 3] : [1]),
    };

    const rows = await loadRemoteProjects(media);
    const byId = Object.fromEntries(rows.map((r) => [r.projectId, r]));
    expect(rows).toHaveLength(2);
    expect(byId.XPOS).toEqual({
      projectId: 'XPOS',
      name: 'XPOS',
      inMedia: true,
      files: 3,
      isApp: false,
      visibility: 'visible',
    });
    expect(byId['media-only']).toEqual({
      projectId: 'media-only',
      name: 'media-only',
      inMedia: true,
      files: 1,
      isApp: false,
      visibility: 'visible',
    });
  });

  it('flags a folder as an App container only when it carries the app.json marker', async () => {
    // `uploadProjectFiles` (server.ts) unconditionally writes app.json into an
    // App's own media folder whenever a linked Feature is pushed — the real,
    // already-live signal isApp now reads (never the projectId shape/prefix).
    const media: FolderSource = {
      listFolders: async () => [
        { id: 'f1', name: 'bidv' },
        { id: 'f2', name: 'bidv-onboarding' },
      ],
      listAllFiles: async (id) =>
        id === 'f1' ? [{ path: APP_MARKER_PATH }, { path: 'context/current.json' }] : [{ path: 'dr-docs/spec.md' }],
    };

    const rows = await loadRemoteProjects(media);
    const byId = Object.fromEntries(rows.map((r) => [r.projectId, r]));
    expect(byId.bidv).toMatchObject({ isApp: true });
    expect(byId['bidv-onboarding']).toMatchObject({ isApp: false });
  });

  it('hides `pending--…` folders — an approval request is not a pullable project', async () => {
    // Open Design enumerates EVERY media folder, so without this filter every
    // machine in the app would see other people's unapproved work as a
    // project it could pull.
    const media: FolderSource = {
      listFolders: async () => [
        { id: 'f1', name: 'checkout' },
        { id: 'f2', name: 'pending--checkout--a1b2c3' },
        { id: 'f3', name: 'pending--decisions' },
      ],
      listAllFiles: async () => [1],
    };
    const rows = await loadRemoteProjects(media);
    expect(rows.map((r) => r.projectId)).toEqual(['checkout']);
  });

  it('returns an empty list when media is unreachable (best-effort)', async () => {
    const media: FolderSource = {
      listFolders: async () => {
        throw new Error('media unreachable');
      },
      listAllFiles: async () => [],
    };
    const rows = await loadRemoteProjects(media);
    expect(rows).toEqual([]);
  });

  it('reads a valid Studio lifecycle sidecar without creating any folder', async () => {
    const downloads: string[] = [];
    const media: FolderSource = {
      listFolders: async () => [{ id: 'folder-old', name: 'old-project' }],
      listAllFiles: async () => [{ path: 'project.json' }, { path: PROJECT_LIFECYCLE_PATH }],
      downloadFile: async (projectId, filePath) => {
        downloads.push(`${projectId}/${filePath}`);
        return Buffer.from(JSON.stringify({
          schemaVersion: 1,
          projectId,
          visibility: 'hidden',
          hiddenAt: '2026-08-12T00:00:00.000Z',
        }));
      },
    };

    await expect(loadRemoteProjects(media)).resolves.toEqual([
      expect.objectContaining({
        projectId: 'old-project',
        files: 1,
        visibility: 'hidden',
        hiddenAt: '2026-08-12T00:00:00.000Z',
      }),
    ]);
    expect(downloads.sort()).toEqual([
      `old-project/${PROJECT_LIFECYCLE_PATH}`,
      'old-project/project.json',
    ]);
  });

  it("reads the display name from project.json, falling back to the folder id", async () => {
    const media: FolderSource = {
      listFolders: async () => [
        { id: 'f1', name: 'app--bidv--fe206e0a' },
        { id: 'f2', name: 'app--ke_toan--3e3b2ac4' },
      ],
      listAllFiles: async () => [{ path: 'project.json' }],
      downloadFile: async (projectId) => Buffer.from(JSON.stringify(
        projectId === 'app--bidv--fe206e0a' ? { name: 'BIDV' } : { appId: null },
      )),
    };

    const rows = await loadRemoteProjects(media);
    const byId = Object.fromEntries(rows.map((r) => [r.projectId, r.name]));
    expect(byId).toEqual({
      'app--bidv--fe206e0a': 'BIDV',
      'app--ke_toan--3e3b2ac4': 'app--ke_toan--3e3b2ac4',
    });
  });

  it("prefers an App row's app.json name over project.json — app.json is what Open Design actually publishes", async () => {
    // Regression: the share/pull pickers were showing raw folder ids
    // (app--bidv--fe206e0a) for Apps because loadRemoteProjects either read
    // no name at all, or (once that was fixed) only checked project.json —
    // an App's real name lives in app.json (server.ts's syncStudioConfig
    // resolves an App's name the same way: app.json first, project.json as
    // legacy fallback).
    const media: FolderSource = {
      listFolders: async () => [{ id: 'f1', name: 'app--bidv--fe206e0a' }],
      listAllFiles: async () => [{ path: APP_MARKER_PATH }, { path: 'project.json' }],
      downloadFile: async (_projectId, filePath) => Buffer.from(JSON.stringify(
        filePath === APP_MARKER_PATH ? { kind: 'app', name: 'BIDV' } : { name: 'stale-legacy-name' },
      )),
    };

    const rows = await loadRemoteProjects(media);
    expect(rows[0]).toMatchObject({ projectId: 'app--bidv--fe206e0a', name: 'BIDV', isApp: true });
  });

  it('keeps legacy and malformed lifecycle projects visible and isolates the warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const downloads: string[] = [];
    const media: FolderSource = {
      listFolders: async () => [
        { id: 'legacy-folder', name: 'legacy' },
        { id: 'bad-folder', name: 'bad' },
      ],
      listAllFiles: async (folderId) => folderId === 'bad-folder'
        ? [{ path: PROJECT_LIFECYCLE_PATH }]
        : [{ path: 'project.json' }],
      downloadFile: async (projectId) => {
        downloads.push(projectId);
        return Buffer.from('{not-json');
      },
    };

    const rows = await loadRemoteProjects(media);
    expect(rows.map(({ projectId, visibility, name }) => ({ projectId, visibility, name }))).toEqual([
      { projectId: 'bad', visibility: 'visible', name: 'bad' },
      { projectId: 'legacy', visibility: 'visible', name: 'legacy' },
    ]);
    expect(downloads.sort()).toEqual(['bad', 'legacy']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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
      { projectId: 'app--bidv', name: 'BIDV', inMedia: true, files: 0, isApp: true },
      {
        projectId: 'TN1',
        name: 'Tính năng 1',
        inMedia: true,
        files: 1,
        isApp: false,
        appId: 'app--bidv',
      },
      {
        projectId: 'unrelated',
        name: 'Unrelated',
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

  it('filters a hidden project and cascades a hidden App to its Features', () => {
    const data: RemoteProject[] = [
      { projectId: 'app--old', name: 'Old', inMedia: true, files: 1, isApp: true, visibility: 'hidden' },
      { projectId: 'child', name: 'Child', inMedia: true, files: 1, isApp: false, appId: 'app--old', visibility: 'visible' },
      { projectId: 'standalone-hidden', name: 'Hidden', inMedia: true, files: 1, isApp: false, visibility: 'hidden' },
      { projectId: 'visible', name: 'Visible', inMedia: true, files: 1, isApp: false, visibility: 'visible' },
    ];

    expect(filterLifecycleVisibleProjects(data).map((p) => p.projectId)).toEqual(['visible']);
    expect(isLifecycleHidden(data, 'child', 'app--old')).toBe(true);
    expect(isLifecycleHidden(data, 'visible', null)).toBe(false);
  });
});
