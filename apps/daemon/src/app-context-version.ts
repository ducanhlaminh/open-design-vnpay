import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AppContextCurrentPointer,
  AppContextFileDigest,
  AppContextFileSource,
  AppContextManifest,
  CreateAppContextVersionResult,
  DocsReviewComponentSource,
  FeatureContextBinding,
  RunContextLock,
} from '@open-design/contracts';

const CONTEXT_DIR = 'context';
const VERSIONS_DIR = 'versions';
const VERSION_FILES_DIR = 'files';
const CURRENT_FILE = 'current.json';
const MANIFEST_FILE = 'manifest.json';
const SHA_PREFIX = 'sha256:' as const;

export interface SnapshotAppContextOptions {
  projectsDir: string;
  appId: string;
  appName: string;
  designSystemId: string | null;
  docsReviewComponentSource?: DocsReviewComponentSource;
  designSystemDir?: string | null;
  expectedCurrentDigest?: `sha256:${string}` | null;
  now?: Date;
}

interface CollectedFile extends AppContextFileDigest {
  content: Buffer;
}

function assertSafeSegment(value: string, label: string): void {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error(`${label} is not a safe path segment`);
  }
}

function digestBuffer(content: Buffer): `sha256:${string}` {
  return `${SHA_PREFIX}${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function stablePackageDigest(
  appId: string,
  appName: string,
  designSystemId: string | null,
  docsReviewComponentSource: DocsReviewComponentSource,
  files: AppContextFileDigest[],
): `sha256:${string}` {
  const canonical = JSON.stringify({
    appId,
    appName,
    designSystemId,
    // Omit the legacy/default mode so manifests produced before this field
    // existed keep the exact same digest and remain verifiable.
    ...(docsReviewComponentSource.mode === 'figma-links' ? { docsReviewComponentSource } : {}),
    files: [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ path: filePath, source, digest, size }) => ({ path: filePath, source, digest, size })),
  });
  return digestBuffer(Buffer.from(canonical));
}

const DEFAULT_COMPONENT_SOURCE: DocsReviewComponentSource = { mode: 'app-design-system' };

/** Strict enough for remote manifests/app.json; request URL canonicalization is
 * still owned by pipeline-routes. Invalid remote values fail to the legacy DS
 * mode rather than becoming an executable/local-network input. */
export function parseManifestComponentSource(value: unknown): DocsReviewComponentSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_COMPONENT_SOURCE;
  const source = value as Record<string, unknown>;
  if (source.mode === 'app-design-system') return DEFAULT_COMPONENT_SOURCE;
  if (source.mode !== 'figma-links' || !Array.isArray(source.links) || source.links.length < 1 || source.links.length > 5) {
    return DEFAULT_COMPONENT_SOURCE;
  }
  const seen = new Set<string>();
  const links = source.links.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const link = item as Record<string, unknown>;
    if (typeof link.url !== 'string' || typeof link.fileKey !== 'string' || !/^[A-Za-z0-9]+$/.test(link.fileKey) || seen.has(link.fileKey)) return [];
    try {
      const url = new URL(link.url);
      if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname.toLowerCase())) return [];
      const parts = url.pathname.split('/').filter(Boolean);
      if (!['design', 'file'].includes(parts[0] ?? '') || parts[1] !== link.fileKey) return [];
      const nodeId = typeof link.nodeId === 'string' && /^\d+:\d+$/.test(link.nodeId) ? link.nodeId : undefined;
      seen.add(link.fileKey);
      return [{ url: link.url, fileKey: link.fileKey, ...(nodeId ? { nodeId } : {}) }];
    } catch {
      return [];
    }
  });
  return links.length === source.links.length ? { mode: 'figma-links', links } : DEFAULT_COMPONENT_SOURCE;
}

function sourceForPath(filePath: string): AppContextFileSource {
  if (filePath.startsWith('docs/')) return 'docs';
  if (filePath.startsWith('design-system/')) return 'design-system';
  return 'app-context';
}

function isSafeLogicalPath(filePath: string): boolean {
  if (!filePath || filePath.startsWith('/') || filePath.includes('\\')) return false;
  const segments = filePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  return filePath.startsWith('app-context/') || filePath.startsWith('docs/') || filePath.startsWith('design-system/');
}

function appRoot(projectsDir: string, appId: string): string {
  assertSafeSegment(appId, 'appId');
  return path.join(projectsDir, appId);
}

export function appContextCurrentPath(projectsDir: string, appId: string): string {
  return path.join(appRoot(projectsDir, appId), CONTEXT_DIR, CURRENT_FILE);
}

export function appContextVersionDir(
  projectsDir: string,
  appId: string,
  contextVersion: `v${number}`,
): string {
  if (!/^v[1-9]\d*$/.test(contextVersion)) throw new Error('invalid App Context version');
  return path.join(appRoot(projectsDir, appId), CONTEXT_DIR, VERSIONS_DIR, contextVersion);
}

export function appContextManifestPath(
  projectsDir: string,
  appId: string,
  contextVersion: `v${number}`,
): string {
  return path.join(appContextVersionDir(projectsDir, appId, contextVersion), MANIFEST_FILE);
}

async function atomicJson(target: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.promises.rename(temp, target);
}

function parseDigest(value: unknown): `sha256:${string}` | null {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/i.test(value)
    ? (value.toLowerCase() as `sha256:${string}`)
    : null;
}

/** Tolerant reader: accepts v1 manifests and derives fields omitted by early drafts. */
export function parseAppContextManifest(raw: unknown): AppContextManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const version = typeof r.contextVersion === 'string' && /^v[1-9]\d*$/.test(r.contextVersion)
    ? (r.contextVersion as `v${number}`)
    : null;
  const digest = parseDigest(r.contentDigest);
  if (!version || !digest || typeof r.appId !== 'string' || !r.appId) return null;
  const files: AppContextFileDigest[] = Array.isArray(r.files)
    ? r.files.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const f = item as Record<string, unknown>;
        const fileDigest = parseDigest(f.digest);
        if (typeof f.path !== 'string' || !f.path || !fileDigest) return [];
        const normalizedPath = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!isSafeLogicalPath(normalizedPath)) return [];
        return [{
          path: normalizedPath,
          source:
            f.source === 'docs' || f.source === 'design-system' || f.source === 'app-context'
              ? f.source
              : sourceForPath(normalizedPath),
          digest: fileDigest,
          size: typeof f.size === 'number' && f.size >= 0 ? f.size : 0,
        }];
      })
    : [];
  const ds = r.designSystem && typeof r.designSystem === 'object' && !Array.isArray(r.designSystem)
    ? (r.designSystem as Record<string, unknown>)
    : {};
  const previousVersion = typeof r.previousVersion === 'string' && /^v[1-9]\d*$/.test(r.previousVersion)
    ? (r.previousVersion as `v${number}`)
    : undefined;
  return {
    schemaVersion: 1,
    appId: r.appId,
    appName: typeof r.appName === 'string' && r.appName ? r.appName : r.appId,
    contextVersion: version,
    contentDigest: digest,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    ...(previousVersion ? { previousVersion } : {}),
    designSystem: {
      id: typeof ds.id === 'string' && ds.id ? ds.id : null,
      contentDigest: parseDigest(ds.contentDigest),
    },
    docsReviewComponentSource: parseManifestComponentSource(r.docsReviewComponentSource),
    files,
  };
}

export function appContextManifestDigestIsValid(manifest: AppContextManifest): boolean {
  return stablePackageDigest(
    manifest.appId,
    manifest.appName,
    manifest.designSystem.id,
    manifest.docsReviewComponentSource ?? DEFAULT_COMPONENT_SOURCE,
    manifest.files,
  ) === manifest.contentDigest;
}

async function readJson(target: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.promises.readFile(target, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function readAppContextManifest(
  projectsDir: string,
  appId: string,
  contextVersion: `v${number}`,
): Promise<AppContextManifest | null> {
  return parseAppContextManifest(await readJson(appContextManifestPath(projectsDir, appId, contextVersion)));
}

export async function readCurrentAppContextManifest(
  projectsDir: string,
  appId: string,
): Promise<AppContextManifest | null> {
  const pointer = await readJson(appContextCurrentPath(projectsDir, appId));
  if (pointer && typeof pointer === 'object' && !Array.isArray(pointer)) {
    const version = (pointer as Record<string, unknown>).contextVersion;
    if (typeof version === 'string' && /^v[1-9]\d*$/.test(version)) {
      const manifest = await readAppContextManifest(projectsDir, appId, version as `v${number}`);
      if (manifest) return manifest;
    }
  }
  // Legacy/torn-pointer fallback: newest valid immutable manifest wins in memory;
  // readers do not rewrite old data in bulk.
  const root = path.join(appRoot(projectsDir, appId), CONTEXT_DIR, VERSIONS_DIR);
  const entries = await fs.promises.readdir(root).catch(() => [] as string[]);
  const versions = entries
    .filter((entry): entry is `v${number}` => /^v[1-9]\d*$/.test(entry))
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  for (const version of versions) {
    const manifest = await readAppContextManifest(projectsDir, appId, version);
    if (manifest) return manifest;
  }
  return null;
}

export async function listAppContextVersions(projectsDir: string, appId: string): Promise<AppContextManifest[]> {
  const root = path.join(appRoot(projectsDir, appId), CONTEXT_DIR, VERSIONS_DIR);
  const entries = await fs.promises.readdir(root).catch(() => [] as string[]);
  const manifests = await Promise.all(
    entries
      .filter((entry): entry is `v${number}` => /^v[1-9]\d*$/.test(entry))
      .map((version) => readAppContextManifest(projectsDir, appId, version)),
  );
  return manifests
    .filter((item): item is AppContextManifest => item !== null)
    .sort((a, b) => Number(b.contextVersion.slice(1)) - Number(a.contextVersion.slice(1)));
}

async function collectTree(root: string, prefix: string, source: AppContextFileSource): Promise<CollectedFile[]> {
  const files: CollectedFile[] = [];
  const walk = async (dir: string, rel = ''): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, childRel);
      } else if (entry.isFile()) {
        const content = await fs.promises.readFile(absolute);
        files.push({
          path: `${prefix}/${childRel}`.replace(/\\/g, '/'),
          source,
          digest: digestBuffer(content),
          size: content.length,
          content,
        });
      }
    }
  };
  await walk(root);
  return files;
}

function includeDesignSystemFile(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/');
  const base = path.posix.basename(normalized).toLowerCase();
  if (normalized.startsWith('criteria/')) return base === 'components.md' || base === 'rules.md' || base === '_meta.json';
  if (normalized.startsWith('tokens/')) return /\.(json|css|ts|md)$/i.test(normalized);
  return ['design.md', 'manifest.json', 'components.manifest.json', 'tokens.json', '_meta.json', 'components.md', 'rules.md'].includes(base);
}

async function collectDesignSystem(root: string | null | undefined): Promise<CollectedFile[]> {
  if (!root) return [];
  const all = await collectTree(root, 'design-system', 'design-system');
  return all.filter((file) => includeDesignSystemFile(file.path.slice('design-system/'.length)));
}

export async function createAppContextVersion(
  options: SnapshotAppContextOptions,
): Promise<CreateAppContextVersionResult> {
  const current = await readCurrentAppContextManifest(options.projectsDir, options.appId);
  if (
    options.expectedCurrentDigest !== undefined &&
    (current?.contentDigest ?? null) !== options.expectedCurrentDigest
  ) {
    const error = new Error('App Context changed since preview') as Error & { code?: string };
    error.code = 'APP_CONTEXT_CHANGED';
    throw error;
  }
  const mutableRoot = appRoot(options.projectsDir, options.appId);
  const collected = [
    ...(await collectTree(path.join(mutableRoot, 'app-context'), 'app-context', 'app-context')),
    ...(await collectTree(path.join(mutableRoot, 'docs'), 'docs', 'docs')),
    ...(await collectDesignSystem(options.designSystemDir)),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const fileDigests = collected.map(({ content: _content, ...file }) => file);
  const contentDigest = stablePackageDigest(
    options.appId,
    options.appName,
    options.designSystemId,
    options.docsReviewComponentSource ?? DEFAULT_COMPONENT_SOURCE,
    fileDigests,
  );
  if (current?.contentDigest === contentDigest) return { status: 'unchanged', manifest: current };

  const contextVersion = `v${current ? Number(current.contextVersion.slice(1)) + 1 : 1}` as `v${number}`;
  const versionRoot = appContextVersionDir(options.projectsDir, options.appId, contextVersion);
  if (await fs.promises.stat(versionRoot).then(() => true, () => false)) {
    throw new Error(`immutable App Context ${contextVersion} already exists`);
  }
  const dsFiles = fileDigests.filter((file) => file.source === 'design-system');
  const designSystemDigest = options.designSystemId
    ? stablePackageDigest(options.appId, options.appName, options.designSystemId, DEFAULT_COMPONENT_SOURCE, dsFiles)
    : null;
  const manifest: AppContextManifest = {
    schemaVersion: 1,
    appId: options.appId,
    appName: options.appName,
    contextVersion,
    contentDigest,
    createdAt: (options.now ?? new Date()).toISOString(),
    ...(current ? { previousVersion: current.contextVersion } : {}),
    designSystem: { id: options.designSystemId, contentDigest: designSystemDigest },
    docsReviewComponentSource: options.docsReviewComponentSource ?? DEFAULT_COMPONENT_SOURCE,
    files: fileDigests,
  };
  await fs.promises.mkdir(path.join(versionRoot, VERSION_FILES_DIR), { recursive: true });
  try {
    for (const file of collected) {
      const target = path.join(versionRoot, VERSION_FILES_DIR, ...file.path.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, file.content, { flag: 'wx' });
    }
    await atomicJson(path.join(versionRoot, MANIFEST_FILE), manifest);
    const pointer: AppContextCurrentPointer = {
      schemaVersion: 1,
      appId: options.appId,
      contextVersion,
      contentDigest,
      updatedAt: manifest.createdAt,
    };
    await atomicJson(appContextCurrentPath(options.projectsDir, options.appId), pointer);
  } catch (error) {
    // The directory is a just-created incomplete version, never a prior user
    // snapshot. Removing it preserves the immutable-version invariant.
    await fs.promises.rm(versionRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { status: 'created', manifest };
}

export function featureContextBindingFromMetadata(metadata: unknown): FeatureContextBinding | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).appContextBinding;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const digest = parseDigest(r.contentDigest);
  if (
    typeof r.appId !== 'string' || !r.appId ||
    typeof r.contextVersion !== 'string' || !/^v[1-9]\d*$/.test(r.contextVersion) ||
    !digest
  ) return null;
  return {
    schemaVersion: 1,
    appId: r.appId,
    contextVersion: r.contextVersion as `v${number}`,
    contentDigest: digest,
    boundAt: typeof r.boundAt === 'string' ? r.boundAt : '',
  };
}

export function metadataWithFeatureContextBinding(
  metadata: unknown,
  binding: FeatureContextBinding,
): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  return { ...base, appContextBinding: binding };
}

export async function writeRunContextLock(options: {
  projectsDir: string;
  appId: string;
  featureId: string;
  runId: string;
  workflowId?: string;
  runCwd: string;
  binding: FeatureContextBinding;
}): Promise<RunContextLock> {
  const manifest = await readAppContextManifest(options.projectsDir, options.appId, options.binding.contextVersion);
  if (!manifest || manifest.contentDigest !== options.binding.contentDigest) {
    throw new Error(`bound App Context ${options.binding.contextVersion} is unavailable or changed`);
  }
  const lockedAt = new Date().toISOString();
  const lock: RunContextLock = {
    ...options.binding,
    featureId: options.featureId,
    runId: options.runId,
    ...(options.workflowId ? { workflowId: options.workflowId } : {}),
    lockedAt,
    manifestPath: `context/versions/${manifest.contextVersion}/manifest.json`,
  };
  await atomicJson(path.join(options.runCwd, 'context-lock.json'), lock);
  return lock;
}

/**
 * Stage the exact immutable package selected by a Feature. App context, docs
 * pool and DS criteria come from one version, so a later App update cannot
 * silently change a run halfway through.
 */
export async function stageBoundAppContextForRun(options: {
  projectsDir: string;
  appId: string;
  featureId: string;
  runId: string;
  workflowId?: string;
  runCwd: string;
  binding: FeatureContextBinding;
}): Promise<{ lock: RunContextLock; stagedAppContext: string[]; stagedDocs: number; stagedDesignSystem: string[] }> {
  const manifest = await readAppContextManifest(options.projectsDir, options.appId, options.binding.contextVersion);
  if (!manifest || manifest.contentDigest !== options.binding.contentDigest) {
    throw new Error(`bound App Context ${options.binding.contextVersion} is unavailable or changed`);
  }
  const root = appContextVersionDir(options.projectsDir, options.appId, options.binding.contextVersion);
  const appContextPaths: string[] = [];
  const designSystemPaths: string[] = [];
  let docs = 0;
  for (const file of manifest.files) {
    const content = await fs.promises.readFile(path.join(root, VERSION_FILES_DIR, ...file.path.split('/')));
    if (digestBuffer(content) !== file.digest) throw new Error(`corrupt App Context file: ${file.path}`);
    let relativeTarget: string;
    if (file.source === 'app-context') {
      const inner = file.path.slice('app-context/'.length);
      relativeTarget = `.app-context/${inner}`;
      appContextPaths.push(inner);
    } else if (file.source === 'docs') {
      const inner = file.path.slice('docs/'.length);
      relativeTarget = `docs-app/${inner}`;
      docs += 1;
    } else {
      const inner = file.path.slice('design-system/'.length);
      relativeTarget = inner.startsWith('criteria/') ? inner : `.app-design-system/${inner}`;
      designSystemPaths.push(inner);
    }
    const target = path.join(options.runCwd, ...relativeTarget.split('/'));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
  }
  const lock = await writeRunContextLock(options);
  return { lock, stagedAppContext: appContextPaths, stagedDocs: docs, stagedDesignSystem: designSystemPaths };
}

/** Copy one immutable package to mutable local sources. Used by Pull; bindings are untouched. */
export async function materializeAppContextVersion(options: {
  projectsDir: string;
  appId: string;
  contextVersion: `v${number}`;
}): Promise<AppContextManifest> {
  const manifest = await readAppContextManifest(options.projectsDir, options.appId, options.contextVersion);
  if (!manifest) throw new Error(`App Context ${options.contextVersion} not found`);
  const versionRoot = appContextVersionDir(options.projectsDir, options.appId, options.contextVersion);
  for (const file of manifest.files) {
    if (file.source === 'design-system') continue; // installed DS is not overwritten by pulling an App.
    const source = path.join(versionRoot, VERSION_FILES_DIR, ...file.path.split('/'));
    const target = path.join(appRoot(options.projectsDir, options.appId), ...file.path.split('/'));
    const content = await fs.promises.readFile(source);
    if (digestBuffer(content) !== file.digest) throw new Error(`corrupt App Context file: ${file.path}`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
  }
  const pointer: AppContextCurrentPointer = {
    schemaVersion: 1,
    appId: options.appId,
    contextVersion: manifest.contextVersion,
    contentDigest: manifest.contentDigest,
    updatedAt: new Date().toISOString(),
  };
  await atomicJson(appContextCurrentPath(options.projectsDir, options.appId), pointer);
  return manifest;
}

/** Install a downloaded immutable package. Existing versions are verified and never overwritten. */
export async function installAppContextVersion(options: {
  projectsDir: string;
  appId: string;
  manifest: AppContextManifest;
  files: ReadonlyMap<string, Buffer>;
  makeCurrent?: boolean;
}): Promise<'installed' | 'exists'> {
  if (options.manifest.appId !== options.appId) throw new Error('App Context manifest appId mismatch');
  if (!appContextManifestDigestIsValid(options.manifest)) {
    throw new Error('App Context manifest contentDigest is invalid');
  }
  const targetRoot = appContextVersionDir(options.projectsDir, options.appId, options.manifest.contextVersion);
  const existing = await readAppContextManifest(options.projectsDir, options.appId, options.manifest.contextVersion);
  if (existing) {
    if (existing.contentDigest !== options.manifest.contentDigest) {
      throw new Error(`immutable App Context ${options.manifest.contextVersion} has a different digest`);
    }
    return 'exists';
  }
  await fs.promises.mkdir(path.join(targetRoot, VERSION_FILES_DIR), { recursive: true });
  try {
    for (const file of options.manifest.files) {
      const content = options.files.get(file.path);
      if (!content || digestBuffer(content) !== file.digest) throw new Error(`missing or corrupt App Context file: ${file.path}`);
      const target = path.join(targetRoot, VERSION_FILES_DIR, ...file.path.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content, { flag: 'wx' });
    }
    await atomicJson(path.join(targetRoot, MANIFEST_FILE), options.manifest);
    if (options.makeCurrent !== false) {
      const pointer: AppContextCurrentPointer = {
        schemaVersion: 1,
        appId: options.appId,
        contextVersion: options.manifest.contextVersion,
        contentDigest: options.manifest.contentDigest,
        updatedAt: new Date().toISOString(),
      };
      await atomicJson(appContextCurrentPath(options.projectsDir, options.appId), pointer);
    }
  } catch (error) {
    await fs.promises.rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return 'installed';
}

export async function filesForAppContextPublish(options: {
  projectsDir: string;
  appId: string;
  contextVersion: `v${number}`;
}): Promise<Array<{ path: string; content: Buffer; digest: `sha256:${string}` }>> {
  const manifest = await readAppContextManifest(options.projectsDir, options.appId, options.contextVersion);
  if (!manifest) throw new Error(`App Context ${options.contextVersion} not found`);
  const root = appContextVersionDir(options.projectsDir, options.appId, options.contextVersion);
  const result: Array<{ path: string; content: Buffer; digest: `sha256:${string}` }> = [];
  const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  result.push({
    path: `context/versions/${manifest.contextVersion}/manifest.json`,
    content: manifestContent,
    digest: digestBuffer(manifestContent),
  });
  for (const file of manifest.files) {
    const content = await fs.promises.readFile(path.join(root, VERSION_FILES_DIR, ...file.path.split('/')));
    if (digestBuffer(content) !== file.digest) throw new Error(`corrupt App Context file: ${file.path}`);
    result.push({ path: `context/versions/${manifest.contextVersion}/files/${file.path}`, content, digest: file.digest });
  }
  const pointer: AppContextCurrentPointer = {
    schemaVersion: 1,
    appId: manifest.appId,
    contextVersion: manifest.contextVersion,
    contentDigest: manifest.contentDigest,
    updatedAt: manifest.createdAt,
  };
  const currentContent = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`);
  result.push({ path: 'context/current.json', content: currentContent, digest: digestBuffer(currentContent) });
  return result;
}

/**
 * Package the App pointer plus every immutable version needed to reproduce a
 * Feature publish. A Feature may intentionally remain bound to an older
 * Context after the App adopts a newly approved DS; publishing it must never
 * leave the remote Feature pointing at a version that was not transferred.
 */
export async function filesForFeatureContextPublish(options: {
  projectsDir: string;
  appId: string;
  currentContextVersion: `v${number}`;
  binding: FeatureContextBinding;
}): Promise<Array<{ path: string; content: Buffer; digest: `sha256:${string}` }>> {
  if (options.binding.appId !== options.appId) {
    throw new Error('Feature Context binding belongs to a different App');
  }
  const versions = options.binding.contextVersion === options.currentContextVersion
    ? [options.currentContextVersion]
    : [options.binding.contextVersion, options.currentContextVersion];
  const byPath = new Map<string, { path: string; content: Buffer; digest: `sha256:${string}` }>();
  for (const contextVersion of versions) {
    for (const file of await filesForAppContextPublish({
      projectsDir: options.projectsDir,
      appId: options.appId,
      contextVersion,
    })) {
      // The final/current version is processed last, so its current.json wins
      // while both immutable version directories remain in the package.
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()];
}
