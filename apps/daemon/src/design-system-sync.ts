import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  DesignSystemCriteriaSnapshot,
  DesignSystemCurrentPointer,
  DesignSystemFileChange,
  DesignSystemOwner,
  DesignSystemPackageFile,
  DesignSystemSyncDigest,
  DesignSystemSyncStatus,
  DesignSystemSyncVersion,
  DesignSystemUsage,
  DesignSystemVersionManifest,
  PullDesignSystemPlan,
  RemoteDesignSystemSummary,
} from '@open-design/contracts';

import { readDesignSystemUpdateState } from './design-system-update.js';
import type { LocalSyncFile } from './kg-sync/media-client.js';

export const DESIGN_SYSTEMS_MEDIA_FOLDER = 'design-systems';
const SYNC_STATE_FILE = '.sync.json';

export interface DesignSystemRemoteStore {
  listFiles(folder: string): Promise<Array<Record<string, unknown>>>;
  downloadFile(folder: string, filePath: string): Promise<Buffer>;
  syncProjectFiles(folder: string, files: LocalSyncFile[]): Promise<{ uploaded: number; skipped: number; deleted: number }>;
}

interface LocalSyncState {
  schemaVersion: 1;
  localDesignSystemId: string;
  remoteDesignSystemId: string;
  lastPulledDigest?: DesignSystemSyncDigest;
  updatedAt: string;
}

interface CollectedPackage {
  sourceVersion: number;
  figmaDigest: DesignSystemSyncDigest | null;
  criteria: DesignSystemVersionManifest['criteria'];
  files: Array<DesignSystemPackageFile & { content: Buffer }>;
  contentDigest: DesignSystemSyncDigest;
}

function digest(content: Buffer | string): DesignSystemSyncDigest {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function safeId(raw: string): string {
  const value = raw.replace(/^user:/, '').trim();
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw Object.assign(new Error('Invalid Design System id'), { code: 'BAD_REQUEST' });
  }
  return value;
}

function safeRelativePath(raw: string): string | null {
  const value = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value || value.includes('\0') || value.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return value;
}

function mimeFor(filePath: string): string {
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.md')) return 'text/markdown';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.html')) return 'text/html';
  if (filePath.endsWith('.js')) return 'text/javascript';
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'text/plain';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/i.test(filePath)) return 'image/jpeg';
  if (filePath.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function remotePath(remoteId: string, suffix: string): string {
  return `${safeId(remoteId)}/${suffix}`;
}

export function designSystemVersionPath(remoteId: string, version: DesignSystemSyncVersion, suffix = 'manifest.json'): string {
  return remotePath(remoteId, `versions/${version}/${suffix}`);
}

async function atomicJson(target: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.promises.rename(temporary, target);
}

async function readJson(target: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.promises.readFile(target, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function collectFiles(root: string): Promise<Array<DesignSystemPackageFile & { content: Buffer }>> {
  const files: Array<DesignSystemPackageFile & { content: Buffer }> = [];
  const walk = async (dir: string, relative = ''): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.figma-update' || entry.name === SYNC_STATE_FILE || entry.name === 'revisions') continue;
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute, nextRelative);
      else if (entry.isFile()) {
        const content = await fs.promises.readFile(absolute);
        files.push({ path: nextRelative, digest: digest(content), size: content.length, mime: mimeFor(nextRelative), content });
      }
    }
  };
  await walk(root);
  return files;
}

function packageDigest(files: DesignSystemPackageFile[]): DesignSystemSyncDigest {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path); hash.update('\0'); hash.update(file.digest); hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function criteriaSnapshot(root: string, kind: 'components' | 'rules', sourceVersion: number, status: 'current' | 'missing' = 'current'): Promise<DesignSystemCriteriaSnapshot> {
  const content = await fs.promises.readFile(path.join(root, 'criteria', `${kind}.md`)).catch(() => null);
  return {
    status: content ? status : 'missing',
    generatedFromVersion: content ? sourceVersion : null,
    digest: content ? digest(content) : null,
  };
}

async function packageFromRoot(root: string, sourceVersion: number, figmaDigest: DesignSystemSyncDigest | null): Promise<CollectedPackage> {
  const files = await collectFiles(root);
  return {
    sourceVersion,
    figmaDigest,
    criteria: {
      components: await criteriaSnapshot(root, 'components', sourceVersion),
      rules: await criteriaSnapshot(root, 'rules', sourceVersion),
    },
    files,
    contentDigest: packageDigest(files),
  };
}

export async function collectApprovedDesignSystemPackages(dsDir: string, designSystemId: string, includeHistory: boolean): Promise<{
  current: CollectedPackage;
  history: CollectedPackage[];
  blockReason?: NonNullable<DesignSystemSyncStatus['blockReason']>;
}> {
  const state = await readDesignSystemUpdateState(dsDir, designSystemId);
  let blockReason: NonNullable<DesignSystemSyncStatus['blockReason']> | undefined;
  if (state.lifecycle !== 'approved' || state.candidateVersion !== null) blockReason = 'update_in_progress';
  else if (Object.values(state.criteria).some((criterion) => criterion.hasDraft || criterion.status === 'draft')) blockReason = 'criteria_draft';
  else if (Object.values(state.criteria).some((criterion) => criterion.status === 'stale' || criterion.status === 'missing')) blockReason = 'criteria_stale';
  const current = await packageFromRoot(dsDir, state.currentVersion, state.currentFigmaDigest as DesignSystemSyncDigest | null);
  const history: CollectedPackage[] = [];
  if (includeHistory) {
    const versionsDir = path.join(dsDir, '.figma-update', 'versions');
    const entries = await fs.promises.readdir(versionsDir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    for (const entry of entries.filter((item) => item.isDirectory() && /^v[1-9]\d*$/.test(item.name)).sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))) {
      history.push(await packageFromRoot(path.join(versionsDir, entry.name), Number(entry.name.slice(1)), null));
    }
  }
  return { current, history, ...(blockReason ? { blockReason } : {}) };
}

function parseUsage(value: unknown): DesignSystemUsage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is DesignSystemUsage => Boolean(item && typeof item === 'object' && !Array.isArray(item)
    && ((item as DesignSystemUsage).kind === 'app' || (item as DesignSystemUsage).kind === 'feature')
    && typeof (item as DesignSystemUsage).appId === 'string'));
}

export function parseRemoteDesignSystemSummary(value: unknown): RemoteDesignSystemSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Partial<RemoteDesignSystemSummary>;
  if (r.schemaVersion !== 1 || typeof r.remoteDesignSystemId !== 'string' || typeof r.name !== 'string'
    || !r.owner || typeof r.owner.id !== 'string' || typeof r.currentVersion !== 'string' || !/^v[1-9]\d*$/.test(r.currentVersion)
    || typeof r.currentDigest !== 'string' || !r.currentDigest.startsWith('sha256:') || typeof r.updatedAt !== 'string') return null;
  const versions = Array.isArray(r.versions) ? r.versions.filter((item): item is DesignSystemSyncVersion => typeof item === 'string' && /^v[1-9]\d*$/.test(item)) : [r.currentVersion as DesignSystemSyncVersion];
  return { schemaVersion: 1, remoteDesignSystemId: r.remoteDesignSystemId, name: r.name, owner: r.owner,
    currentVersion: r.currentVersion as DesignSystemSyncVersion, currentDigest: r.currentDigest as DesignSystemSyncDigest,
    updatedAt: r.updatedAt, versions, usage: parseUsage(r.usage), visibility: 'workspace' };
}

export function parseDesignSystemVersionManifest(value: unknown): DesignSystemVersionManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Partial<DesignSystemVersionManifest>;
  if (r.schemaVersion !== 1 || r.kind !== 'design-system-version' || typeof r.remoteDesignSystemId !== 'string'
    || typeof r.version !== 'string' || !/^v[1-9]\d*$/.test(r.version) || typeof r.contentDigest !== 'string'
    || !r.contentDigest.startsWith('sha256:') || !Array.isArray(r.files) || !r.owner || typeof r.owner.id !== 'string') return null;
  const files = r.files.filter((item): item is DesignSystemPackageFile => Boolean(item && typeof item.path === 'string'
    && safeRelativePath(item.path) === item.path && typeof item.digest === 'string' && item.digest.startsWith('sha256:')
    && typeof item.size === 'number' && typeof item.mime === 'string'));
  if (files.length !== r.files.length || packageDigest(files) !== r.contentDigest) return null;
  return { ...(r as DesignSystemVersionManifest), files, usage: parseUsage(r.usage) };
}

export async function listRemoteDesignSystems(store: DesignSystemRemoteStore): Promise<RemoteDesignSystemSummary[]> {
  const files = await store.listFiles(DESIGN_SYSTEMS_MEDIA_FOLDER);
  const summaries = files.map((row) => typeof row.path === 'string' ? row.path : '').filter((item) => /^[^/]+\/summary\.json$/.test(item));
  const out: RemoteDesignSystemSummary[] = [];
  for (const filePath of summaries) {
    try {
      const parsed = parseRemoteDesignSystemSummary(JSON.parse((await store.downloadFile(DESIGN_SYSTEMS_MEDIA_FOLDER, filePath)).toString('utf8')));
      if (parsed) out.push(parsed);
    } catch { /* malformed artifacts are isolated */ }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function remoteManifest(store: DesignSystemRemoteStore, remoteId: string, version: DesignSystemSyncVersion): Promise<DesignSystemVersionManifest | null> {
  try {
    return parseDesignSystemVersionManifest(JSON.parse((await store.downloadFile(DESIGN_SYSTEMS_MEDIA_FOLDER, designSystemVersionPath(remoteId, version))).toString('utf8')));
  } catch { return null; }
}

async function readLocalSyncState(dsDir: string): Promise<LocalSyncState | null> {
  const raw = await readJson(path.join(dsDir, SYNC_STATE_FILE));
  if (!raw || raw.schemaVersion !== 1 || typeof raw.localDesignSystemId !== 'string' || typeof raw.remoteDesignSystemId !== 'string') return null;
  return raw as unknown as LocalSyncState;
}

async function writeLocalSyncState(dsDir: string, state: LocalSyncState): Promise<void> {
  await atomicJson(path.join(dsDir, SYNC_STATE_FILE), state);
}

function changesBetween(local: DesignSystemPackageFile[], remote: DesignSystemPackageFile[]): DesignSystemFileChange[] {
  const left = new Map(local.map((item) => [item.path, item]));
  const right = new Map(remote.map((item) => [item.path, item]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return paths.flatMap((filePath) => {
    const l = left.get(filePath); const r = right.get(filePath);
    if (l?.digest === r?.digest) return [];
    return [{ path: filePath, operation: !l ? 'add' : !r ? 'delete' : 'edit', ...(l ? { localDigest: l.digest } : {}), ...(r ? { remoteDigest: r.digest } : {}) } as DesignSystemFileChange];
  });
}

export async function designSystemSyncStatus(options: {
  dsDir: string; localDesignSystemId: string; store: DesignSystemRemoteStore; usage: DesignSystemUsage[];
}): Promise<DesignSystemSyncStatus> {
  const packages = await collectApprovedDesignSystemPackages(options.dsDir, options.localDesignSystemId, options.usage.length > 0);
  const mapping = await readLocalSyncState(options.dsDir);
  const remoteId = mapping?.remoteDesignSystemId ?? null;
  const remote = remoteId ? (await listRemoteDesignSystems(options.store)).find((item) => item.remoteDesignSystemId === remoteId) ?? null : null;
  const remoteCurrent = remote ? await remoteManifest(options.store, remote.remoteDesignSystemId, remote.currentVersion) : null;
  return {
    localDesignSystemId: options.localDesignSystemId, remoteDesignSystemId: remoteId,
    localVersion: packages.current.sourceVersion, localDigest: packages.current.contentDigest, remote,
    changes: changesBetween(packages.current.files, remoteCurrent?.files ?? []),
    historicalVersions: packages.history.map((item) => `v${item.sourceVersion}` as DesignSystemSyncVersion),
    canPush: !packages.blockReason, ...(packages.blockReason ? { blockReason: packages.blockReason } : {}),
  };
}

async function designSystemName(dsDir: string, fallback: string): Promise<string> {
  for (const name of ['manifest.json', '_meta.json']) {
    const raw = await readJson(path.join(dsDir, name));
    if (raw && typeof raw.name === 'string' && raw.name.trim()) return raw.name.trim();
  }
  return fallback.replace(/[-_]+/g, ' ');
}

export async function publishDesignSystem(options: {
  dsDir: string; localDesignSystemId: string; store: DesignSystemRemoteStore; owner: DesignSystemOwner;
  usage: DesignSystemUsage[]; expectedRemoteDigest?: DesignSystemSyncDigest | null; now?: Date;
}): Promise<{ summary: RemoteDesignSystemSummary; manifest: DesignSystemVersionManifest; uploadedVersions: DesignSystemSyncVersion[]; unchanged: boolean }> {
  const packages = await collectApprovedDesignSystemPackages(options.dsDir, options.localDesignSystemId, options.usage.length > 0);
  if (packages.blockReason) throw Object.assign(new Error(`Design System cannot be shared: ${packages.blockReason}`), { code: 'DS_SYNC_BLOCKED', reason: packages.blockReason });
  const mapping = await readLocalSyncState(options.dsDir);
  const remoteId = mapping?.remoteDesignSystemId ?? safeId(options.localDesignSystemId);
  const allRemote = await listRemoteDesignSystems(options.store);
  const existing = allRemote.find((item) => item.remoteDesignSystemId === remoteId) ?? null;
  if (existing && existing.owner.id !== options.owner.id) throw Object.assign(new Error('Remote Design System belongs to another owner'), { code: 'DS_SYNC_CONFLICT', remote: existing });
  if (options.expectedRemoteDigest !== undefined && (existing?.currentDigest ?? null) !== options.expectedRemoteDigest) {
    throw Object.assign(new Error('Remote Design System changed since preview'), { code: 'DS_SYNC_CONFLICT', remote: existing });
  }
  const existingManifests = new Map<DesignSystemSyncDigest, DesignSystemVersionManifest>();
  for (const version of existing?.versions ?? []) {
    const manifest = await remoteManifest(options.store, remoteId, version);
    if (manifest) existingManifests.set(manifest.contentDigest, manifest);
  }
  const ordered = [...packages.history, packages.current].filter((item, index, list) => list.findIndex((candidate) => candidate.contentDigest === item.contentDigest) === index);
  let next = Math.max(0, ...(existing?.versions ?? []).map((version) => Number(version.slice(1)))) + 1;
  const publishedAt = (options.now ?? new Date()).toISOString();
  const uploadedVersions: DesignSystemSyncVersion[] = [];
  let currentManifest: DesignSystemVersionManifest | null = existingManifests.get(packages.current.contentDigest) ?? null;
  const newFiles: LocalSyncFile[] = [];
  for (const localPackage of ordered) {
    const known = existingManifests.get(localPackage.contentDigest);
    if (known) { if (localPackage === packages.current) currentManifest = known; continue; }
    const version = `v${next++}` as DesignSystemSyncVersion;
    const manifest: DesignSystemVersionManifest = {
      schemaVersion: 1, kind: 'design-system-version', remoteDesignSystemId: remoteId,
      name: await designSystemName(options.dsDir, safeId(options.localDesignSystemId)), version,
      sourceVersion: localPackage.sourceVersion, contentDigest: localPackage.contentDigest,
      figmaDigest: localPackage.figmaDigest, publishedAt, owner: options.owner,
      criteria: localPackage.criteria, usage: options.usage,
      files: localPackage.files.map(({ content: _content, ...file }) => file),
    };
    newFiles.push({ path: designSystemVersionPath(remoteId, version), stage: 'design-system', mime: 'application/json', content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
    for (const file of localPackage.files) newFiles.push({ path: designSystemVersionPath(remoteId, version, `files/${file.path}`), stage: 'design-system', mime: file.mime, content: file.content });
    uploadedVersions.push(version);
    existingManifests.set(localPackage.contentDigest, manifest);
    if (localPackage === packages.current) currentManifest = manifest;
  }
  if (!currentManifest) throw new Error('Current Design System package was not prepared');
  if (newFiles.length) await options.store.syncProjectFiles(DESIGN_SYSTEMS_MEDIA_FOLDER, newFiles);
  const versions = [...existingManifests.values()].sort((a, b) => Number(a.version.slice(1)) - Number(b.version.slice(1))).map((item) => item.version);
  const pointer: DesignSystemCurrentPointer = { schemaVersion: 1, remoteDesignSystemId: remoteId, version: currentManifest.version, contentDigest: currentManifest.contentDigest, updatedAt: publishedAt };
  const summary: RemoteDesignSystemSummary = { schemaVersion: 1, remoteDesignSystemId: remoteId, name: currentManifest.name,
    owner: options.owner, currentVersion: currentManifest.version, currentDigest: currentManifest.contentDigest,
    updatedAt: publishedAt, versions, usage: options.usage, visibility: 'workspace' };
  await options.store.syncProjectFiles(DESIGN_SYSTEMS_MEDIA_FOLDER, [
    { path: remotePath(remoteId, 'current.json'), stage: 'design-system', mime: 'application/json', content: Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`) },
    { path: remotePath(remoteId, 'summary.json'), stage: 'design-system', mime: 'application/json', content: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`) },
  ]);
  await writeLocalSyncState(options.dsDir, { schemaVersion: 1, localDesignSystemId: options.localDesignSystemId, remoteDesignSystemId: remoteId, updatedAt: publishedAt });
  return { summary, manifest: currentManifest, uploadedVersions, unchanged: uploadedVersions.length === 0 };
}

export async function planPullDesignSystem(options: {
  userDesignSystemsDir: string; remoteDesignSystemId: string; version?: DesignSystemSyncVersion;
  localDesignSystemId?: string; store: DesignSystemRemoteStore;
}): Promise<PullDesignSystemPlan | null> {
  const summary = (await listRemoteDesignSystems(options.store)).find((item) => item.remoteDesignSystemId === options.remoteDesignSystemId);
  if (!summary) return null;
  const version = options.version ?? summary.currentVersion;
  const manifest = await remoteManifest(options.store, summary.remoteDesignSystemId, version);
  if (!manifest) return null;
  const localDesignSystemId = `user:${safeId(options.localDesignSystemId ?? summary.remoteDesignSystemId)}`;
  const dsDir = path.join(options.userDesignSystemsDir, safeId(localDesignSystemId));
  const localExists = await fs.promises.stat(dsDir).then((item) => item.isDirectory(), () => false);
  const localPackage = localExists ? await collectFiles(dsDir) : [];
  const localDigest = localExists ? packageDigest(localPackage) : null;
  return { remote: summary, manifest, localDesignSystemId, localExists, localDigest,
    changes: changesBetween(localPackage, manifest.files), conflict: localExists && localDigest !== manifest.contentDigest };
}

export async function installPulledDesignSystem(options: {
  userDesignSystemsDir: string; plan: PullDesignSystemPlan; store: DesignSystemRemoteStore; now?: Date;
}): Promise<void> {
  const bare = safeId(options.plan.localDesignSystemId);
  const target = path.join(options.userDesignSystemsDir, bare);
  const temporary = path.join(options.userDesignSystemsDir, `.pull-${bare}-${randomUUID()}`);
  const backup = path.join(options.userDesignSystemsDir, `.pull-backup-${bare}-${randomUUID()}`);
  await fs.promises.mkdir(temporary, { recursive: false });
  let movedExisting = false;
  try {
    for (const file of options.plan.manifest.files) {
      const relative = safeRelativePath(file.path);
      if (!relative) throw new Error(`Unsafe package path: ${file.path}`);
      const content = await options.store.downloadFile(DESIGN_SYSTEMS_MEDIA_FOLDER,
        designSystemVersionPath(options.plan.remote.remoteDesignSystemId, options.plan.manifest.version, `files/${relative}`));
      if (digest(content) !== file.digest) throw new Error(`Package checksum mismatch: ${relative}`);
      const destination = path.join(temporary, ...relative.split('/'));
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.writeFile(destination, content, { flag: 'wx' });
    }
    const state = {
      schemaVersion: 1, designSystemId: options.plan.localDesignSystemId, lifecycle: 'approved',
      currentVersion: options.plan.manifest.sourceVersion, currentFigmaDigest: options.plan.manifest.figmaDigest,
      candidateVersion: null, candidateFigmaDigest: null, candidateCreatedAt: null,
      deleteOldSourceAfterApproval: false, approvedAt: options.plan.manifest.publishedAt,
      contextVersioning: 'not_started', contextVersioningError: null,
      criteria: {
        components: { kind: 'components', status: options.plan.manifest.criteria.components.status, hasApprovedFile: options.plan.manifest.criteria.components.status === 'current', hasDraft: false, approvedContent: null, draftContent: null, count: 0, generatedFromVersion: options.plan.manifest.criteria.components.generatedFromVersion, generatedFromFigmaDigest: options.plan.manifest.figmaDigest, generatedAt: options.plan.manifest.publishedAt },
        rules: { kind: 'rules', status: options.plan.manifest.criteria.rules.status, hasApprovedFile: options.plan.manifest.criteria.rules.status === 'current', hasDraft: false, approvedContent: null, draftContent: null, count: 0, generatedFromVersion: options.plan.manifest.criteria.rules.generatedFromVersion, generatedFromFigmaDigest: options.plan.manifest.figmaDigest, generatedAt: options.plan.manifest.publishedAt },
      },
    };
    await atomicJson(path.join(temporary, '.figma-update', 'state.json'), state);
    await writeLocalSyncState(temporary, { schemaVersion: 1, localDesignSystemId: options.plan.localDesignSystemId,
      remoteDesignSystemId: options.plan.remote.remoteDesignSystemId, lastPulledDigest: options.plan.manifest.contentDigest,
      updatedAt: (options.now ?? new Date()).toISOString() });
    if (await fs.promises.stat(target).then(() => true, () => false)) { await fs.promises.rename(target, backup); movedExisting = true; }
    await fs.promises.rename(temporary, target);
    if (movedExisting) await fs.promises.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (movedExisting && !await fs.promises.stat(target).then(() => true, () => false)) await fs.promises.rename(backup, target).catch(() => undefined);
    throw error;
  }
}
