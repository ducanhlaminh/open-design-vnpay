// App Docs Pool — one deterministic Confluence fetch per App, stored under
// `<PROJECTS_DIR>/<appId>/docs/`. The pool contains fetched source pages and
// a mechanical `_index.md`; legacy derived artifacts are never staged.
//
// Storage layout (all under `<PROJECTS_DIR>/<appId>/docs/`):
//   _manifest.json   — §2.1, the single source of truth for pool state.
//   _index.md        — mechanical (0 LLM), regenerated on every pool change.
//   <branch>/<slug>.md (+ attachments/) — the actual fetched pages; `path` in
//     the manifest is relative to this `docs/` root, e.g.
//     "2-urd-cho-website-k-ton/i-urd-ti-khon.md".
//
// An App has no `projects` DB row of its own in the pre-existing pipeline
// model (see pipeline-routes.ts's collectLocalApps comment) — the pool lives
// purely on disk, keyed by appId exactly like a project cwd (`ensureProject`
// works unmodified because appId and projectId share the same id-safety

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AppPoolPage } from '@open-design/contracts';

import {
  extractPageId,
  fetchConfluencePages,
  listDescendantPages,
  resolveBasEndpoint,
  resolveConfluenceCreds,
  type ConfluenceDocPage,
} from './bas/bas-client.js';

export type ManifestPage = AppPoolPage;

export interface AppPoolManifest {
  version: 1;
  pages: ManifestPage[];
}

const EMPTY_MANIFEST: AppPoolManifest = { version: 1, pages: [] };

export function appDocsDir(projectsDir: string, appId: string): string {
  return path.join(projectsDir, appId, 'docs');
}

export function manifestPath(projectsDir: string, appId: string): string {
  return path.join(appDocsDir(projectsDir, appId), '_manifest.json');
}

export function indexPath(projectsDir: string, appId: string): string {
  return path.join(appDocsDir(projectsDir, appId), '_index.md');
}

function normalizeManifest(raw: unknown): AppPoolManifest {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawPages = Array.isArray(obj.pages) ? obj.pages : [];
  const pages: ManifestPage[] = rawPages
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      pageId: String(p.pageId ?? ''),
      path: String(p.path ?? ''),
      title: String(p.title ?? ''),
      branch: String(p.branch ?? ''),
      contentHash: String(p.contentHash ?? ''),
      fetchedAt: typeof p.fetchedAt === 'number' ? p.fetchedAt : 0,
      ...(p.related === true ? { related: true } : {}),
    }))
    .filter((p) => p.pageId && p.path);
  return { version: 1, pages };
}

/** Read the manifest; a missing file is a fresh, empty pool (not an error) —
 *  mirrors every other daemon store that treats "no file yet" as day zero. */
export async function readManifest(projectsDir: string, appId: string): Promise<AppPoolManifest> {
  try {
    const raw = await fs.promises.readFile(manifestPath(projectsDir, appId), 'utf8');
    return normalizeManifest(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ...EMPTY_MANIFEST, pages: [] };
    throw err;
  }
}

/** Atomic write: tmp file + rename, so a crash mid-write never leaves a
 *  truncated/corrupt manifest for the next reader (same pattern as every
 *  other daemon on-disk store). */
export async function writeManifest(
  projectsDir: string,
  appId: string,
  manifest: AppPoolManifest,
): Promise<void> {
  const target = manifestPath(projectsDir, appId);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.promises.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, target);
}

export function sha256(content: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

/** Branch = the first path segment (§2.1: "slug nhánh cấp-1 (phân hệ)"). A
 *  page with no subfolder (a lone top-level pick) becomes its own one-page
 *  branch — the filename minus nothing stripped, exactly the first (only)
 *  segment. */
/** Số segment FOLDER đầu path mà MỌI trang trong pool cùng chia sẻ — phần
 *  "giàn giáo wiki" (space home, thư mục gốc…) khi path lưu TUYỆT ĐỐI theo
 *  chuỗi tổ tiên thật. Branch chưng cất tính từ SAU prefix này (không thì cả
 *  pool dồn về một branch duy nhất); UI cũng ẩn nó khi render cây. Không bao
 *  giờ ăn vào segment cuối (tên file) của bất kỳ trang nào. */
export function poolPrefixLen(pages: Array<{ path: string }>): number {
  if (pages.length === 0) return 0;
  const segLists = pages.map((p) => p.path.replace(/\\/g, '/').split('/').filter(Boolean));
  const max = Math.min(...segLists.map((s) => s.length - 1));
  let len = 0;
  for (let i = 0; i < max; i += 1) {
    const seg = segLists[0]![i];
    if (!segLists.every((s) => s[i] === seg)) break;
    len = i + 1;
  }
  return len;
}

/** Gán lại `branch` cho MỌI trang từ prefix pool-wide hiện hành — gọi sau mỗi
 *  lần merge import (prefix có thể đổi khi trang mới nằm ngoài gốc cũ). */
export function rebalanceBranches(manifest: AppPoolManifest): void {
  const prefixLen = poolPrefixLen(manifest.pages);
  for (const page of manifest.pages) {
    const segments = page.path.replace(/\\/g, '/').split('/').filter(Boolean);
    page.branch = deriveBranch(segments.slice(prefixLen).join('/'));
  }
}

export function deriveBranch(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const idx = norm.indexOf('/');
  if (idx !== -1) return norm.slice(0, idx);
  // Folder-less page (no shared ancestor folding applied) — its branch is a
  // clean slug of its own filename (strip `.md`), not the literal filename
  // with extension, so `_branches/<branch>.md` never doubles up.
  return norm.replace(/\.md$/i, '') || norm;
}

/** §2.3: "_index.md CƠ HỌC (0 LLM): cây trang + title(heading) + path" —
 *  grouped by branch so it doubles as a map of "which pages make up which
 *  phân hệ" for a human skimming it. */
export function generateIndexMd(manifest: AppPoolManifest): string {
  const byBranch = new Map<string, ManifestPage[]>();
  for (const p of manifest.pages) {
    const list = byBranch.get(p.branch) ?? [];
    list.push(p);
    byBranch.set(p.branch, list);
  }
  const branches = [...byBranch.keys()].sort((a, b) => a.localeCompare(b));
  const lines: string[] = [
    '# Bản đồ tài liệu (sinh cơ học — không do agent viết)',
    '',
    `${manifest.pages.length} trang, ${branches.length} nhánh.`,
    '',
  ];
  for (const branch of branches) {
    lines.push(`## ${branch}`, '');
    const pages = [...byBranch.get(branch)!].sort((a, b) => a.path.localeCompare(b.path));
    for (const p of pages) lines.push(`- [${p.title}](${p.path}) — \`${p.path}\``);
    lines.push('');
  }
  return lines.join('\n');
}

export async function writeIndexMd(
  projectsDir: string,
  appId: string,
  manifest: AppPoolManifest,
): Promise<void> {
  const target = indexPath(projectsDir, appId);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, generateIndexMd(manifest), 'utf8');
}

/** Merge freshly-fetched pages into the manifest (§2.2 import-confluence):
 *  a brand-new pageId is added; unchanged content is left exactly as-is (not counted
 *  as updated). */
export function upsertPagesFromFetch(
  manifest: AppPoolManifest,
  fetched: Array<{ pageId: string; title: string; path: string; contentHash: string; related?: boolean }>,
  now: number,
): { manifest: AppPoolManifest; imported: number; updated: number } {
  const byId = new Map(manifest.pages.map((p) => [p.pageId, p] as const));
  let imported = 0;
  let updated = 0;
  for (const f of fetched) {
    const existing = byId.get(f.pageId);
    const branch = deriveBranch(f.path);
    if (!existing) {
      imported += 1;
      byId.set(f.pageId, {
        pageId: f.pageId,
        path: f.path,
        title: f.title,
        branch,
        contentHash: f.contentHash,
        fetchedAt: now,
        ...(f.related ? { related: true } : {}),
      });
      continue;
    }
    if (existing.contentHash === f.contentHash && existing.path === f.path) {
      // Nội dung không đổi — chỉ đồng bộ cờ related (import lại một trang
      // "liên quan" bằng tick trực tiếp thì nó thành docs chính, và ngược
      // lại); không tính là updated.
      if (f.related === true && existing.related !== true) byId.set(f.pageId, { ...existing, related: true });
      else if (f.related === false && existing.related === true) {
        const { related: _related, ...rest } = existing;
        byId.set(f.pageId, rest);
      }
      continue;
    }
    updated += 1;
    const nextRelated = f.related === undefined ? existing.related === true : f.related;
    const { related: _dropRelated, ...restExisting } = existing;
    byId.set(f.pageId, {
      ...restExisting,
      path: f.path,
      title: f.title,
      branch,
      contentHash: f.contentHash,
      fetchedAt: now,
      ...(nextRelated ? { related: true } : {}),
    });
  }
  return { manifest: { version: 1, pages: [...byId.values()] }, imported, updated };
}

/** §2.2 import-confluence: fetch (dr-docs deterministic core, reused via
 *  `fetchConfluencePages({ pathLayout: 'flat' })` — NOT duplicated), write
 *  the pages under `<appId>/docs/`, update + persist the manifest, and
 *  regenerate `_index.md`. Throws when neither Confluence credential is
 *  configured (route maps that to 502), or when the fetch itself fails. */
export async function importConfluenceIntoPool(opts: {
  projectsDir: string;
  runtimeDataDir: string;
  appId: string;
  refs: string[];
  /** Tập con của refs được chọn từ "Quét tài liệu liên quan" — gắn cờ
   *  `related: true` trên manifest để UI tách nhóm "Docs liên quan". */
  relatedRefs?: string[];
  followLinks?: boolean;
  includeDescendants?: boolean;
  /** Explicit operation cancellation from the UI/HTTP route. */
  signal?: AbortSignal;
  /** Marks the irreversible directory-swap boundary. Cancellation requested
   *  after this callback is intentionally too late and the commit completes. */
  onCommitStart?: () => void | Promise<void>;
}): Promise<{ imported: number; updated: number; pages: ManifestPage[] }> {
  const { projectsDir, runtimeDataDir, appId, refs } = opts;
  const [creds, ep] = await Promise.all([
    resolveConfluenceCreds(runtimeDataDir).catch(() => null),
    resolveBasEndpoint(runtimeDataDir).catch(() => null),
  ]);
  if (!creds && !ep) {
    throw new Error(
      'Chưa có credential Confluence: thêm CONFLUENCE_URL + CONFLUENCE_PERSONAL_TOKEN (Settings → MCP) hoặc cấu hình BAS gateway.',
    );
  }
  opts.signal?.throwIfAborted();
  const docsDir = appDocsDir(projectsDir, appId);
  const docsParent = path.dirname(docsDir);
  const operationSuffix = `${process.pid}-${crypto.randomUUID()}`;
  const stagedDocsDir = path.join(docsParent, `.docs.import-${operationSuffix}`);
  const backupDocsDir = path.join(docsParent, `.docs.backup-${operationSuffix}`);
  try {
    await fs.promises.mkdir(docsParent, { recursive: true });
    const liveExists = await fs.promises.stat(docsDir).then((stat) => stat.isDirectory(), () => false);
    if (liveExists) await fs.promises.cp(docsDir, stagedDocsDir, { recursive: true });
    else await fs.promises.mkdir(stagedDocsDir, { recursive: true });

    const treePages: import('./bas/bas-client.js').DescendantPage[] = [];
    if (opts.includeDescendants && creds) {
      const seen = new Set<string>();
      for (const ref of refs) {
        opts.signal?.throwIfAborted();
        const seedId = extractPageId(ref);
        try {
          const desc = await listDescendantPages(creds, seedId, 500, opts.signal);
          for (const d of desc) {
            if (seen.has(d.pageId)) continue;
            seen.add(d.pageId);
            treePages.push(d);
          }
        } catch (err) {
          opts.signal?.throwIfAborted();
          console.warn(`[app-pool] sub-tree scan for seed ${seedId} failed (continuing):`, err);
        }
      }
    }
    const fetched: ConfluenceDocPage[] = await fetchConfluencePages({ creds, ep }, refs, {
      // Mặc định KHÔNG follow link (pool user-curated; xem app-pool-routes).
      followLinks: opts.followLinks === true,
      attachmentsDir: path.join(stagedDocsDir, 'attachments'),
      runtimeDataDir,
      pathLayout: 'flat',
      ...(treePages.length ? { treePages } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    // Everything below is prepared only inside the sibling staging tree. The
    // live pool stays byte-for-byte unchanged until the final directory swap.
    opts.signal?.throwIfAborted();
    const now = Date.now();
    // Cờ related theo pageId (refs của "Quét tài liệu liên quan" là page id/URL
    // — resolve như refs thường). Trang KHÔNG nằm trong relatedRefs được đánh
    // dấu tường minh false: tick trực tiếp một trang từng là "liên quan" sẽ
    // nâng nó lên docs chính.
    const relatedIds = new Set((opts.relatedRefs ?? []).map((r) => extractPageId(r)));
    const writable: Array<{ pageId: string; title: string; path: string; contentHash: string; related?: boolean }> = [];
    for (const p of fetched) {
      // `p.relPath` is `docs/<branch>/.../<slug>.md` (flat layout) — strip the
      // leading `docs/` so the manifest `path` is relative to the App's docs/
      // root, matching §2.1's example.
      const relInDocs = path.posix.relative('docs', p.relPath);
      const abs = path.join(stagedDocsDir, relInDocs);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, p.content, 'utf8');
      writable.push({
        pageId: p.pageId,
        title: p.title,
        path: relInDocs,
        contentHash: sha256(p.content),
        related: relatedIds.has(p.pageId),
      });
    }
    const current = await readManifest(projectsDir, appId);
    // Trang cũ đổi chỗ (cấu trúc cây theo tổ tiên thật có thể khác lần import
    // trước) → xóa file ở path CŨ, nếu không nó thành mồ côi trên đĩa và
    // stageAppDocsPool (copy mọi *.md) sẽ nạp trùng một trang hai chỗ.
    const oldPathById = new Map(current.pages.map((p) => [p.pageId, p.path] as const));
    for (const w of writable) {
      const oldPath = oldPathById.get(w.pageId);
      if (oldPath && oldPath !== w.path) {
        await fs.promises.rm(path.join(stagedDocsDir, oldPath), { force: true }).catch(() => null);
      }
    }
    const { manifest: next, imported, updated } = upsertPagesFromFetch(current, writable, now);
    // Path giờ TUYỆT ĐỐI theo tổ tiên thật → branch phải tính SAU prefix chung
    // của cả pool (không thì mọi trang chung một branch "giàn giáo wiki").
    rebalanceBranches(next);
    await fs.promises.writeFile(path.join(stagedDocsDir, '_manifest.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.promises.writeFile(path.join(stagedDocsDir, '_index.md'), generateIndexMd(next), 'utf8');

    // Last cancellable point. From onCommitStart onward the two renames form
    // one non-cancellable commit; a failed second rename restores the backup.
    opts.signal?.throwIfAborted();
    await opts.onCommitStart?.();
    if (liveExists) await fs.promises.rename(docsDir, backupDocsDir);
    try {
      await fs.promises.rename(stagedDocsDir, docsDir);
    } catch (err) {
      if (liveExists) await fs.promises.rename(backupDocsDir, docsDir).catch(() => undefined);
      throw err;
    }
    if (liveExists) {
      await fs.promises.rm(backupDocsDir, { recursive: true, force: true }).catch((err) => {
        console.warn(`[app-pool] committed import but could not remove backup ${backupDocsDir}:`, err);
      });
    }
    return { imported, updated, pages: next.pages };
  } finally {
    await fs.promises.rm(stagedDocsDir, { recursive: true, force: true }).catch(() => undefined);
    // A backup should only remain after an unexpected rollback failure. Never
    // delete it here: it is the sole recoverable copy of the previous pool.
  }
}

/** Dot-folder a pool's pool Markdown files + every page's markdown stage into
 *  inside a run cwd (§2.4). Mirrors `stageAppContext`'s shape (app-context.ts):
 *  a dot-folder so snapshot/push/re-run-clear never see it, wiped and
 *  rewritten on every stage run so it always reflects the CURRENT pool.
 *  Only `.md` files are staged (images/attachments and `_manifest.json` are
 *  deliberately excluded — §2.4: "toàn bộ `*.md` pool (KHÔNG ảnh)"). Returns
 *  the staged relative paths (empty when the app has no pool yet — a no-op,
 *  matching app-context.ts's unlinked-feature behavior) and whether
 *  legacy overview is excluded. */
export const STAGED_APP_DOCS = 'docs-app';

export async function stageAppDocsPool(
  projectsDir: string,
  appId: string,
  runCwd: string,
): Promise<{ staged: string[]; overviewExists: boolean }> {
  const docsDir = appDocsDir(projectsDir, appId);
  const files: string[] = [];
  await collectMarkdown(docsDir, '', files);
  if (files.length === 0) return { staged: [], overviewExists: false };
  const staged = path.join(runCwd, STAGED_APP_DOCS);
  await fs.promises.rm(staged, { recursive: true, force: true });
  for (const rel of files) {
    const src = path.join(docsDir, rel);
    const dst = path.join(staged, rel);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
  }
  return { staged: files, overviewExists: false };
}

async function collectMarkdown(dir: string, relDir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === '_branches') continue;
      await collectMarkdown(path.join(dir, entry.name), rel, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== '_overview.md') out.push(rel);
  }
}

/** Bước cần ĐƯỜNG VÀO app-level: flow/spec màn hình phải nói được người dùng
 *  đi từ đâu tới tính năng này (Trang chủ → menu nào → màn nào), mà thông tin
 *  đó chỉ có trong pool App chứ không có trong tài liệu riêng của feature.
 *  Với các bước này `docs-app/` là INPUT của deliverable, không phải tài liệu
 *  tham khảo — nên chỉ dẫn phải nói ngược lại câu "không deliverable từ
 *  docs-app" áp cho các bước còn lại. */
const APP_NAV_STAGES = new Set(['ux', 'dr-flow', 'cj', 'prd-cj']);

/** The kickoff directive appended when a feature's App has a staged pool
 *  (§2.4 — text pinned by the spec). Pure (no I/O); '' when nothing was
 *  staged keeps the kickoff byte-identical to the legacy one. */
export function appDocsPoolDirective(stagedFiles: string[], stageId?: string): string {
  if (stagedFiles.length === 0) return '';
  const base =
    ' Tài liệu App: trang cho feature này ở `docs-feature/` (nguồn sự thật). TOÀN BỘ pool App nạp read-only ở `docs-app/` — đọc `docs-app/_index.md` để nắm danh mục';
  if (stageId && APP_NAV_STAGES.has(stageId)) {
    return `${base}. Bước này PHẢI xác định ĐƯỜNG VÀO tính năng ở cấp app: người dùng đứng ở màn gốc nào, đi qua menu/bước nào để tới màn của feature. Căn cứ theo thứ tự: câu mô tả cách vào trong \`docs-feature/\`, rồi cây thư mục trong \`docs-app/_index.md\` (thường phản chiếu cấu trúc menu) — mở trang trong \`docs-app/\` để lấy đúng tên menu như tài liệu viết. KHÔNG bịa tên menu: không có căn cứ thì bỏ phần đường vào và ghi rõ là chưa xác định được.`;
  }
  return `${base}, chỉ mở trang khi cần đối chiếu ngoài phạm vi feature; KHÔNG audit/fan-out/deliverable từ \`docs-app/\`.`;
}

/** §2.2 DELETE pool/pages: remove manifest entries + their files, regenerate
 *  `_index.md`. Best-effort on the file removal (a page whose file is
 *  already gone still drops from the manifest). */
export async function deletePoolPages(
  projectsDir: string,
  appId: string,
  pageIds: string[],
): Promise<AppPoolManifest> {
  const manifest = await readManifest(projectsDir, appId);
  const toDelete = new Set(pageIds);
  const docsDir = appDocsDir(projectsDir, appId);
  for (const p of manifest.pages) {
    if (!toDelete.has(p.pageId)) continue;
    await fs.promises.rm(path.join(docsDir, p.path), { force: true }).catch(() => null);
  }
  const next: AppPoolManifest = {
    version: 1,
    pages: manifest.pages.filter((p) => !toDelete.has(p.pageId)),
  };
  await writeManifest(projectsDir, appId, next);
  await writeIndexMd(projectsDir, appId, next);
  return next;
}
