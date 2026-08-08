import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appDocsDir,
  appDocsPoolDirective,
  deletePoolPages,
  deriveBranch,
  generateIndexMd,
  poolPrefixLen,
  readManifest,
  rebalanceBranches,
  sha256,
  stageAppDocsPool,
  upsertPagesFromFetch,
  writeIndexMd,
  writeManifest,
  type AppPoolManifest,
} from '../src/app-pool.js';

let projectsDir: string;

beforeEach(async () => {
  projectsDir = await mkdtemp(path.join(tmpdir(), 'od-app-pool-'));
});

afterEach(async () => {
  await rm(projectsDir, { recursive: true, force: true });
});

function page(overrides: Partial<AppPoolManifest['pages'][number]> = {}): AppPoolManifest['pages'][number] {
  return {
    pageId: '1',
    path: 'branch-a/page-one.md',
    title: 'Page One',
    branch: 'branch-a',
    contentHash: sha256('v1'),
    fetchedAt: 1000,
    ...overrides,
  };
}

describe('app-pool — manifest round-trip', () => {
  it('reads an empty manifest when no file exists yet', async () => {
    const manifest = await readManifest(projectsDir, 'app-1');
    expect(manifest).toEqual({ version: 1, pages: [] });
  });

  it('writes then reads back the exact same manifest (atomic tmp+rename)', async () => {
    const manifest: AppPoolManifest = { version: 1, pages: [page()] };
    await writeManifest(projectsDir, 'app-1', manifest);
    const roundTripped = await readManifest(projectsDir, 'app-1');
    expect(roundTripped).toEqual(manifest);
    // No leftover tmp file next to the manifest.
    const dirPath = appDocsDir(projectsDir, 'app-1');
    const entries = await import('node:fs/promises').then((m) => m.readdir(dirPath));
    expect(entries).toEqual(['_manifest.json']);
  });

  it('normalizes a malformed on-disk manifest instead of throwing', async () => {
    const manifestFile = path.join(appDocsDir(projectsDir, 'app-1'), '_manifest.json');
    await import('node:fs/promises').then((m) => m.mkdir(path.dirname(manifestFile), { recursive: true }));
    await import('node:fs/promises').then((m) =>
      m.writeFile(manifestFile, JSON.stringify({ pages: [{ pageId: '1' /* missing path → dropped */ }, page()] })),
    );
    const manifest = await readManifest(projectsDir, 'app-1');
    expect(manifest.pages).toHaveLength(1);
    expect(manifest.pages[0]!.pageId).toBe('1');
    expect(manifest.pages[0]!.path).toBe('branch-a/page-one.md');
  });
});

describe('app-pool — deriveBranch (§2.1 "slug nhánh cấp-1")', () => {
  it('uses the first path segment as the branch for a nested page', () => {
    expect(deriveBranch('2-urd-cho-website-k-ton/i-urd-ti-khon.md')).toBe('2-urd-cho-website-k-ton');
  });

  it('deeper nesting still only takes the FIRST segment', () => {
    expect(deriveBranch('branch/sub/leaf.md')).toBe('branch');
  });

  it('a standalone (folder-less) page becomes its own one-page branch, minus the .md extension', () => {
    expect(deriveBranch('standalone-page.md')).toBe('standalone-page');
  });
});

describe('app-pool — poolPrefixLen + rebalanceBranches (path tuyệt đối, branch sau prefix)', () => {
  const page = (path: string) => ({
    pageId: path, path, title: path, branch: '', contentHash: 'h', fetchedAt: 1,
  });

  it('prefix = chuỗi folder chung của MỌI trang, không ăn vào tên file', () => {
    expect(poolPrefixLen([page('Home/Docs/A/x.md'), page('Home/Docs/B/y.md')])).toBe(2);
    // Một trang nằm NGAY tại mức prefix (file) → prefix dừng trước đó.
    expect(poolPrefixLen([page('Home/Docs.md'), page('Home/Docs/B/y.md')])).toBe(1);
    expect(poolPrefixLen([page('x.md')])).toBe(0);
    expect(poolPrefixLen([])).toBe(0);
  });

  it('rebalanceBranches: branch = segment đầu SAU prefix; trang tại gốc thành branch riêng', () => {
    const manifest = { version: 1 as const, pages: [
      page('Home/Docs/Root.md'),
      page('Home/Docs/Root/Sub/leaf.md'),
      page('Home/Docs/Other/z.md'),
    ] };
    rebalanceBranches(manifest);
    expect(manifest.pages.map((p) => p.branch)).toEqual(['Root', 'Root', 'Other']);
  });

  it('rebalanceBranches: import thêm trang ngoài gốc cũ → prefix co lại, branch tính lại nhất quán', () => {
    const manifest = { version: 1 as const, pages: [page('Home/Docs/A/x.md'), page('Home/Docs/A/y.md')] };
    rebalanceBranches(manifest);
    expect(manifest.pages.map((p) => p.branch)).toEqual(['x', 'y']);
    manifest.pages.push(page('Home/Wiki/B/z.md'));
    rebalanceBranches(manifest);
    expect(manifest.pages.map((p) => p.branch)).toEqual(['Docs', 'Docs', 'Wiki']);
  });
});

describe('app-pool — upsertPagesFromFetch (§2.2 import-confluence)', () => {
  it('a brand-new pageId is imported as "fetched"', () => {
    const { manifest, imported, updated } = upsertPagesFromFetch(
      { version: 1, pages: [] },
      [{ pageId: '1', title: 'Page', path: 'a/p.md', contentHash: sha256('v1') }],
      1000,
    );
    expect(imported).toBe(1);
    expect(updated).toBe(0);
    expect(manifest.pages).toHaveLength(1);
    expect(manifest.pages[0]!.branch).toBe('a');
  });

  it('groups pages by branch and lists title + path', () => {
    const manifest: AppPoolManifest = {
      version: 1,
      pages: [
        page({ pageId: '1', branch: 'a', path: 'a/one.md', title: 'One' }),
        page({ pageId: '2', branch: 'b', path: 'b/two.md', title: 'Two' }),
      ],
    };
    const md = generateIndexMd(manifest);
    expect(md).toContain('## a');
    expect(md).toContain('## b');
    expect(md).toContain('[One](a/one.md)');
    expect(md).toContain('[Two](b/two.md)');
  });

  it('writeIndexMd persists the SAME content generateIndexMd computes', async () => {
    const manifest: AppPoolManifest = { version: 1, pages: [page()] };
    await writeIndexMd(projectsDir, 'app-1', manifest);
    const written = await readFile(path.join(appDocsDir(projectsDir, 'app-1'), '_index.md'), 'utf8');
    expect(written).toBe(generateIndexMd(manifest));
  });

  it('regenerating after every pool change always covers 100% of pages', () => {
    const manifest: AppPoolManifest = {
      version: 1,
      pages: [page({ pageId: '1' }), page({ pageId: '2', path: 'branch-a/page-two.md', title: 'Page Two' })],
    };
    const md = generateIndexMd(manifest);
    expect(md).toContain('branch-a/page-one.md');
    expect(md).toContain('branch-a/page-two.md');
    expect(md).toContain('2 trang');
  });
});

describe('app-pool — deletePoolPages', () => {
  it('removes the manifest entry AND the file, and regenerates _index.md', async () => {
    const appId = 'app-1';
    const docsDir = appDocsDir(projectsDir, appId);
    const fsp = await import('node:fs/promises');
    await fsp.mkdir(path.join(docsDir, 'branch-a'), { recursive: true });
    await fsp.writeFile(path.join(docsDir, 'branch-a/page-one.md'), '# Page One');
    await writeManifest(projectsDir, appId, { version: 1, pages: [page()] });

    const next = await deletePoolPages(projectsDir, appId, ['1']);
    expect(next.pages).toHaveLength(0);
    await expect(fsp.access(path.join(docsDir, 'branch-a/page-one.md'))).rejects.toThrow();
    const index = await readFile(path.join(docsDir, '_index.md'), 'utf8');
    expect(index).not.toContain('page-one.md');
  });

  it('is best-effort when the file is already missing (manifest entry still drops)', async () => {
    const appId = 'app-1';
    await writeManifest(projectsDir, appId, { version: 1, pages: [page()] });
    const next = await deletePoolPages(projectsDir, appId, ['1']);
    expect(next.pages).toHaveLength(0);
  });
});

describe('app-pool — stageAppDocsPool + appDocsPoolDirective (§2.4)', () => {
  it('is a no-op (empty staged list) for an App with no pool markdown yet', async () => {
    const runCwd = await mkdtemp(path.join(tmpdir(), 'od-app-pool-run-'));
    try {
      const result = await stageAppDocsPool(projectsDir, 'app-1', runCwd);
      expect(result).toEqual({ staged: [], overviewExists: false });
      expect(appDocsPoolDirective(result.staged)).toBe('');
    } finally {
      await rm(runCwd, { recursive: true, force: true });
    }
  });

  it('stages every *.md under docs/ into ./docs-app, excluding images and _manifest.json', async () => {
    const appId = 'app-1';
    const docsDir = appDocsDir(projectsDir, appId);
    const fsp = await import('node:fs/promises');
    await fsp.mkdir(path.join(docsDir, '_branches'), { recursive: true });
    await fsp.mkdir(path.join(docsDir, 'attachments'), { recursive: true });
    await fsp.writeFile(path.join(docsDir, '_overview.md'), '# Overview');
    await fsp.writeFile(path.join(docsDir, '_index.md'), '# Index');
    await fsp.writeFile(path.join(docsDir, '_branches/a.md'), '# Branch A');
    await fsp.writeFile(path.join(docsDir, 'attachments/logo.png'), 'not-a-real-png');
    await fsp.writeFile(path.join(docsDir, '_manifest.json'), '{}');

    const runCwd = await mkdtemp(path.join(tmpdir(), 'od-app-pool-run-'));
    try {
      const { staged, overviewExists } = await stageAppDocsPool(projectsDir, appId, runCwd);
      expect(overviewExists).toBe(false);
      expect(new Set(staged)).toEqual(new Set(['_index.md']));
            // Images/manifest never cross into the staged dot-folder.
      await expect(fsp.access(path.join(runCwd, 'docs-app/attachments/logo.png'))).rejects.toThrow();
      await expect(fsp.access(path.join(runCwd, 'docs-app/_manifest.json'))).rejects.toThrow();

      const directive = appDocsPoolDirective(staged);
      expect(directive).toContain('docs-app/_index.md');
      expect(directive).toContain('docs-feature/');
      expect(directive).toMatch(/KHÔNG audit\/fan-out/);

      // Bước sinh flow/spec màn hình phải BIẾT đường vào cấp app (Trang chủ →
      // menu → màn feature) — thông tin chỉ có trong pool App, nên với các
      // bước này docs-app là INPUT của deliverable chứ không phải tham khảo.
      for (const stage of ['ux', 'dr-flow', 'cj', 'prd-cj']) {
        const navDirective = appDocsPoolDirective(staged, stage);
        expect(navDirective).toMatch(/ĐƯỜNG VÀO/);
        expect(navDirective).toMatch(/KHÔNG bịa tên menu/);
        expect(navDirective).not.toMatch(/KHÔNG audit\/fan-out/);
      }
      // Bước khác giữ nguyên luật cũ: docs-app chỉ để tham khảo.
      expect(appDocsPoolDirective(staged, 'ui-html')).toMatch(/KHÔNG audit\/fan-out/);
    } finally {
      await rm(runCwd, { recursive: true, force: true });
    }
  });



// ── import-confluence with a stubbed fetch ─────────────────────────────────
vi.mock('../src/bas/bas-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bas/bas-client.js')>();
  return {
    ...actual,
    resolveConfluenceCreds: vi.fn(async () => ({ base: 'https://wiki.example', token: 'tok' })),
    resolveBasEndpoint: vi.fn(async () => null),
    fetchConfluencePages: vi.fn(async (_src: unknown, refs: string[], opts: Record<string, unknown>) => {
      expect(opts.pathLayout).toBe('flat');
      return refs.map((ref, i) => ({
        pageId: ref,
        title: `Page ${ref}`,
        url: `https://wiki.example/${ref}`,
        relPath: `docs/branch-x/page-${i}.md`,
        content: `# Page ${ref}\n\nbody`,
      }));
    }),
    listDescendantPages: vi.fn(async () => []),
  };
});

describe('app-pool — importConfluenceIntoPool (stubbed fetch core)', () => {
  it('reuses fetchConfluencePages({pathLayout:"flat"}) and writes pages + manifest + _index.md', async () => {
    const { importConfluenceIntoPool } = await import('../src/app-pool.js');
    const result = await importConfluenceIntoPool({
      projectsDir,
      runtimeDataDir: '/tmp/does-not-matter',
      appId: 'app-1',
      refs: ['111', '222'],
    });
    expect(result.imported).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.pages.map((p) => p.path).sort()).toEqual(['branch-x/page-0.md', 'branch-x/page-1.md']);
    // Path tuyệt đối + branch-sau-prefix: 'branch-x' là folder chung của MỌI
    // trang mà không trang nào nằm ngay mức đó → nó là prefix (giàn giáo),
    // branch tính từ segment sau — mỗi page thành branch riêng.
    expect(result.pages[0]!.branch).toBe('page-0');
    expect(result.pages.every((p) => !('distill' in p))).toBe(true);

    const manifest = await readManifest(projectsDir, 'app-1');
    expect(manifest.pages).toHaveLength(2);

    const written = await readFile(path.join(appDocsDir(projectsDir, 'app-1'), 'branch-x/page-0.md'), 'utf8');
    expect(written).toContain('body');

    const index = await readFile(path.join(appDocsDir(projectsDir, 'app-1'), '_index.md'), 'utf8');
    expect(index).toContain('branch-x/page-0.md');
  });
});

});
