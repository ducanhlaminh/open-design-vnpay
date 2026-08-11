// MediaClient ↔ media-service HTTP integration. Spins up an in-process mock of
// the media-service REST surface (folders + files, multipart upload parsed with
// multer) and drives the real MediaClient against it — proving the data layer
// the conflict-aware pull sits on: find-or-create folder, paginated list with
// path/stage tag decoding + `sha256:`-prefix stripping + size, download-by-path,
// and the content-hash `syncProjectFiles` (upload / skip-unchanged / replace-
// changed / drop same-path duplicates). See media-file-sync-design.md.

import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import multer from 'multer';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MediaClient } from '../src/kg-sync/media-client.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface StoredFile {
  id: string;
  name: string;
  folder_id: string;
  checksum: string;
  tags: string[];
  content: Buffer;
  size: number;
  mime_type: string;
}

// Minimal in-memory media-service. `db` is reset between tests.
const db = { folders: new Map<string, { id: string; name: string }>(), files: new Map<string, StoredFile>() };
let seq = 0;
const nextId = () => `obj-${++seq}`;

function buildMockMediaService() {
  const app = express();
  app.use(express.json());
  const upload = multer({ storage: multer.memoryStorage() });

  app.get('/api/v1/folders', (_req, res) => {
    res.json({ folders: [...db.folders.values()] });
  });
  app.post('/api/v1/folders', (req, res) => {
    const id = nextId();
    const folder = { id, name: String(req.body?.name ?? '') };
    db.folders.set(id, folder);
    res.json({ ...folder, path: `/${folder.name}` });
  });
  app.delete('/api/v1/folders/:id', (req, res) => {
    db.folders.delete(req.params.id);
    res.status(204).end();
  });

  app.get('/api/v1/files', (req, res) => {
    const folderId = String(req.query.folder_id ?? '');
    const limit = Number(req.query.limit ?? 20);
    const offset = Number(req.query.offset ?? 0);
    const all = [...db.files.values()].filter((f) => f.folder_id === folderId);
    const page = all.slice(offset, offset + limit).map((f) => ({
      id: f.id,
      name: f.name,
      checksum: f.checksum,
      tags: f.tags,
      mime_type: f.mime_type,
      size: f.size,
    }));
    res.json({ items: page, total: all.length, limit, offset });
  });
  app.post('/api/v1/files', upload.single('file'), (req, res) => {
    const content = req.file?.buffer ?? Buffer.alloc(0);
    const id = nextId();
    const file: StoredFile = {
      id,
      name: req.file?.originalname ?? 'file',
      folder_id: String(req.body?.folder_id ?? ''),
      checksum: `sha256:${sha(content)}`,
      tags: JSON.parse(String(req.body?.tags ?? '[]')),
      content,
      size: content.length,
      mime_type: req.file?.mimetype ?? 'application/octet-stream',
    };
    db.files.set(id, file);
    res.json({ id: file.id, name: file.name, checksum: file.checksum, tags: file.tags });
  });
  app.get('/api/v1/files/:id/download', (req, res) => {
    const f = db.files.get(req.params.id);
    if (!f) return res.status(404).end();
    res.setHeader('content-type', f.mime_type);
    res.end(f.content);
  });
  app.delete('/api/v1/files/:id', (req, res) => {
    db.files.delete(req.params.id);
    res.status(204).end();
  });
  return app;
}

let baseUrl: string;
let server: ReturnType<express.Express['listen']>;
let client: MediaClient;

beforeAll(async () => {
  const app = buildMockMediaService();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new MediaClient({ baseUrl, appId: 'app', userId: 'u', role: 'admin' });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  db.folders.clear();
  db.files.clear();
});

const lf = (path: string, content: string, stage = 'ux-spec') => ({
  path,
  stage,
  mime: 'application/json',
  content: Buffer.from(content),
});

describe('MediaClient', () => {
  it('ensureFolder is find-or-create (idempotent on name)', async () => {
    const a = await client.ensureFolder('XPOS');
    const b = await client.ensureFolder('XPOS');
    expect(a).toBe(b);
    expect(db.folders.size).toBe(1);
  });

  it('syncProjectFiles uploads, then skips unchanged, then replaces changed', async () => {
    const first = await client.syncProjectFiles('XPOS', [lf('a.json', 'one'), lf('b.json', 'two')]);
    expect(first).toEqual({ uploaded: 2, skipped: 0, deleted: 0 });

    const again = await client.syncProjectFiles('XPOS', [lf('a.json', 'one'), lf('b.json', 'two')]);
    expect(again).toEqual({ uploaded: 0, skipped: 2, deleted: 0 });

    const changed = await client.syncProjectFiles('XPOS', [lf('a.json', 'one'), lf('b.json', 'CHANGED')]);
    expect(changed.uploaded).toBe(1); // b.json replaced
    expect(changed.skipped).toBe(1); // a.json unchanged
    expect(changed.deleted).toBe(1); // old b.json removed
  });

  it('listAllFiles decodes path/stage tags, strips sha256: prefix, carries size', async () => {
    await client.syncProjectFiles('XPOS', [lf('ux/spec.json', 'hello', 'ux-spec')]);
    const folderId = await client.ensureFolder('XPOS');
    const files = await client.listAllFiles(folderId);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe('ux/spec.json');
    expect(f.stage).toBe('ux-spec');
    expect(f.checksum).toBe(sha(Buffer.from('hello'))); // no `sha256:` prefix
    expect(f.size).toBe(5);
  });

  it('listFiles maps to {path, stage, checksum, id} rows', async () => {
    await client.syncProjectFiles('XPOS', [lf('a.json', 'one')]);
    const rows = await client.listFiles('XPOS');
    expect(rows[0]).toMatchObject({ path: 'a.json', stage: 'ux-spec', checksum: sha(Buffer.from('one')) });
  });

  it('downloadFile resolves a file by its path tag', async () => {
    await client.syncProjectFiles('XPOS', [lf('ux/spec.json', 'payload')]);
    const buf = await client.downloadFile('XPOS', 'ux/spec.json');
    expect(buf.toString('utf8')).toBe('payload');
  });

  it('listFolders returns every app folder (one per project)', async () => {
    await client.ensureFolder('XPOS');
    await client.ensureFolder('socchat');
    const folders = await client.listFolders();
    expect(folders.map((f) => f.name).sort()).toEqual(['XPOS', 'socchat']);
  });

  it('deleteProjectFiles removes all files + the folder, returns the count', async () => {
    await client.syncProjectFiles('XPOS', [lf('a.json', 'one'), lf('b.json', 'two')]);
    const res = await client.deleteProjectFiles('XPOS');
    expect(res).toEqual({ filesDeleted: 2, folderRemoved: true });
    // Folder is gone from the registry, and no files remain.
    expect((await client.listFolders()).some((f) => f.name === 'XPOS')).toBe(false);
    expect([...db.files.values()].length).toBe(0);
  });

  it('deleteProjectFiles is a no-op when the project has no media folder', async () => {
    const res = await client.deleteProjectFiles('does-not-exist');
    expect(res).toEqual({ filesDeleted: 0, folderRemoved: false });
  });

  it('drops same-path duplicates down to one on sync (self-healing)', async () => {
    const folderId = await client.ensureFolder('XPOS');
    // Inject two rows with the same path tag (simulating an old double-upload bug).
    for (const i of [1, 2]) {
      const content = Buffer.from('dup');
      db.files.set(`dup-${i}`, {
        id: `dup-${i}`,
        name: 'spec.json',
        folder_id: folderId,
        checksum: `sha256:${sha(content)}`,
        tags: ['path:ux/spec.json', 'stage:ux-spec'],
        content,
        size: content.length,
        mime_type: 'application/json',
      });
    }
    const res = await client.syncProjectFiles('XPOS', [lf('ux/spec.json', 'dup', 'ux-spec')]);
    expect(res.skipped).toBe(1);
    expect(res.deleted).toBe(1); // one duplicate removed, one kept
    const remaining = (await client.listAllFiles(folderId)).filter((f) => f.path === 'ux/spec.json');
    expect(remaining).toHaveLength(1);
  });
});

// Reads must not have side effects on the store. This is load-bearing for the
// staging/approval gate: a project that only exists locally has no media
// folder, and the Push-all modal runs a per-project sync-status diff (which
// calls listFiles) BEFORE the user pushes. If that read created the folder, the
// remote registry would then report the project as already living on the
// studio, the push would resolve to "overwrite origin", and the approval step
// would be skipped without anyone noticing. See docs/guides/staging-approval-design.md.
describe('MediaClient reads never materialise a folder', () => {
  it('listFiles on an unknown project returns [] and creates nothing', async () => {
    const before = db.folders.size;
    expect(await client.listFiles('never-pushed')).toEqual([]);
    expect(db.folders.size).toBe(before);
  });

  it('downloadFile on an unknown project throws and creates nothing', async () => {
    const before = db.folders.size;
    await expect(client.downloadFile('never-pushed', 'project.json')).rejects.toThrow();
    expect(db.folders.size).toBe(before);
  });
});
