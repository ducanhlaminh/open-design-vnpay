import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  ApproveFigmaDesignSystemUpdateResponse,
  DesignSystemCriteriaKind,
  DesignSystemCriteriaVersionState,
  DesignSystemFigmaUpdateState,
  UpdateFigmaDesignSystemResponse,
} from '@open-design/contracts';

import {
  commitGeneratedComponentsMd,
  commitGeneratedRulesMd,
  dsCriteriaDir,
  validateComponentsMd,
  validateRulesMd,
} from './ds-criteria.js';
import { importFigmaIRDesignSystem, type FigmaIRImportFile } from './figma-ds-import.js';

const CONTROL_DIR = '.figma-update';
const STATE_FILE = 'state.json';
const CANDIDATE_DIR = 'candidate';
const GENERATED_ENTRIES = [
  'react', 'ir', 'assets', 'preview', 'tokens',
  'DESIGN.md', 'tokens.css', 'tokens.json', 'components.html',
  'components.manifest.json', 'USAGE.md', 'manifest.json',
] as const;
const CRITERIA_FILES = ['components.md', 'rules.md', '_meta.json'] as const;

export type DesignSystemContextUpdate = ApproveFigmaDesignSystemUpdateResponse['contextUpdates'][number];

export class DesignSystemUpdateError extends Error {
  constructor(
    public readonly code:
      | 'BAD_REQUEST'
      | 'NOT_FOUND'
      | 'NO_ACTIVE_UPDATE'
      | 'DRAFT_CRITERIA_PENDING'
      | 'STALE_CRITERIA_CONFIRMATION_REQUIRED',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type PersistedState = DesignSystemFigmaUpdateState;

function controlDir(dsDir: string): string { return path.join(dsDir, CONTROL_DIR); }
function statePath(dsDir: string): string { return path.join(controlDir(dsDir), STATE_FILE); }
function candidateDir(dsDir: string): string { return path.join(controlDir(dsDir), CANDIDATE_DIR); }

function safeBareId(designSystemId: string): string {
  const id = designSystemId.replace(/^user:/, '');
  if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) {
    throw new DesignSystemUpdateError('BAD_REQUEST', 'invalid design system id');
  }
  return id;
}

async function exists(target: string): Promise<boolean> {
  return fs.promises.stat(target).then(() => true, () => false);
}

async function readText(target: string): Promise<string | null> {
  return fs.promises.readFile(target, 'utf8').catch(() => null);
}

async function atomicJson(target: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.promises.rename(temp, target);
}

async function digestTree(root: string): Promise<string | null> {
  if (!await exists(root)) return null;
  const hash = createHash('sha256');
  const walk = async (dir: string, rel = ''): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute, childRel);
      else if (entry.isFile()) {
        hash.update(childRel); hash.update('\0'); hash.update(await fs.promises.readFile(absolute)); hash.update('\0');
      }
    }
  };
  await walk(root);
  return `sha256:${hash.digest('hex')}`;
}

function digestUploads(files: FigmaIRImportFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.filename.localeCompare(b.filename))) {
    hash.update(file.filename); hash.update('\0'); hash.update(file.content); hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function emptyCriterion(kind: DesignSystemCriteriaKind): DesignSystemCriteriaVersionState {
  return {
    kind, status: 'missing', hasApprovedFile: false, hasDraft: false,
    approvedContent: null, draftContent: null, count: 0,
    generatedFromVersion: null, generatedFromFigmaDigest: null, generatedAt: null,
  };
}

function tolerantState(raw: unknown, designSystemId: string): PersistedState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Partial<PersistedState>;
  if (r.schemaVersion !== 1) return null;
  const currentVersion = Number.isInteger(r.currentVersion) && Number(r.currentVersion) > 0 ? Number(r.currentVersion) : 1;
  return {
    schemaVersion: 1,
    designSystemId,
    lifecycle: ['drafting', 'criteria_pending', 'ready_for_review', 'approved'].includes(String(r.lifecycle))
      ? r.lifecycle! : 'approved',
    currentVersion,
    currentFigmaDigest: typeof r.currentFigmaDigest === 'string' ? r.currentFigmaDigest : null,
    candidateVersion: Number.isInteger(r.candidateVersion) ? Number(r.candidateVersion) : null,
    candidateFigmaDigest: typeof r.candidateFigmaDigest === 'string' ? r.candidateFigmaDigest : null,
    candidateCreatedAt: typeof r.candidateCreatedAt === 'string' ? r.candidateCreatedAt : null,
    deleteOldSourceAfterApproval: r.deleteOldSourceAfterApproval === true,
    approvedAt: typeof r.approvedAt === 'string' ? r.approvedAt : null,
    contextVersioning: ['not_started', 'pending', 'completed', 'failed'].includes(String(r.contextVersioning))
      ? r.contextVersioning! : 'not_started',
    contextVersioningError: typeof r.contextVersioningError === 'string' ? r.contextVersioningError : null,
    criteria: {
      components: { ...emptyCriterion('components'), ...(r.criteria?.components ?? {}), kind: 'components' },
      rules: { ...emptyCriterion('rules'), ...(r.criteria?.rules ?? {}), kind: 'rules' },
    },
  };
}

async function hydrateCriterion(
  dir: string,
  criterion: DesignSystemCriteriaVersionState,
): Promise<DesignSystemCriteriaVersionState> {
  const name = `${criterion.kind}.md`;
  const [approvedContent, draftContent] = await Promise.all([
    readText(path.join(dsCriteriaDir(dir), name)),
    readText(path.join(dsCriteriaDir(dir), `${name}.next`)),
  ]);
  const count = approvedContent === null ? 0 : criterion.kind === 'components'
    ? validateComponentsMd(approvedContent).components
    : validateRulesMd(approvedContent).rules;
  return {
    ...criterion,
    status: draftContent !== null ? 'draft' : criterion.status,
    hasApprovedFile: approvedContent !== null,
    hasDraft: draftContent !== null,
    approvedContent,
    draftContent,
    count,
  };
}

async function persist(dsDir: string, state: PersistedState): Promise<void> {
  await atomicJson(statePath(dsDir), state);
}

/** Tolerant reader: legacy DS folders are exposed as approved v1. */
export async function readDesignSystemUpdateState(
  dsDir: string,
  designSystemId: string,
): Promise<DesignSystemFigmaUpdateState> {
  const raw = await readText(statePath(dsDir));
  let state: PersistedState | null = null;
  if (raw) {
    try { state = tolerantState(JSON.parse(raw), designSystemId); } catch { state = null; }
  }
  if (!state) {
    const currentDigest = await digestTree(path.join(dsDir, 'ir'));
    state = {
      schemaVersion: 1, designSystemId, lifecycle: 'approved', currentVersion: 1,
      currentFigmaDigest: currentDigest, candidateVersion: null, candidateFigmaDigest: null,
      candidateCreatedAt: null, deleteOldSourceAfterApproval: false, approvedAt: null,
      contextVersioning: 'not_started', contextVersioningError: null,
      criteria: { components: emptyCriterion('components'), rules: emptyCriterion('rules') },
    };
    for (const kind of ['components', 'rules'] as const) {
      if (await exists(path.join(dsCriteriaDir(dsDir), `${kind}.md`))) {
        state.criteria[kind] = {
          ...state.criteria[kind], status: 'current', generatedFromVersion: 1,
          generatedFromFigmaDigest: currentDigest,
        };
      }
    }
  }
  const workDir = state.candidateVersion && await exists(candidateDir(dsDir)) ? candidateDir(dsDir) : dsDir;
  state.criteria.components = await hydrateCriterion(workDir, state.criteria.components);
  state.criteria.rules = await hydrateCriterion(workDir, state.criteria.rules);
  return state;
}

export async function designSystemCriteriaWorkDir(dsDir: string, designSystemId: string): Promise<string> {
  const state = await readDesignSystemUpdateState(dsDir, designSystemId);
  return state.candidateVersion && await exists(candidateDir(dsDir)) ? candidateDir(dsDir) : dsDir;
}

export async function startFigmaDesignSystemUpdate(options: {
  dsDir: string;
  designSystemId: string;
  files: FigmaIRImportFile[];
  deleteOldSourceAfterApproval?: boolean;
  now?: Date;
}): Promise<UpdateFigmaDesignSystemResponse> {
  const id = safeBareId(options.designSystemId);
  if (!await exists(options.dsDir)) throw new DesignSystemUpdateError('NOT_FOUND', 'design system not found');
  const current = await readDesignSystemUpdateState(options.dsDir, options.designSystemId);
  const figmaDigest = digestUploads(options.files);
  if (current.lifecycle === 'approved' && current.currentFigmaDigest === figmaDigest) {
    return { state: current, warnings: [], summary: emptySummary() };
  }
  if (current.candidateFigmaDigest === figmaDigest && await exists(candidateDir(options.dsDir))) {
    return { state: current, warnings: [], summary: emptySummary() };
  }

  const workRoot = path.join(controlDir(options.dsDir), `work-${randomUUID()}`);
  try {
    const result = await importFigmaIRDesignSystem(options.files, workRoot, { targetId: id });
    const compiledDir = result.dir;
    const candidate = candidateDir(options.dsDir);
    await fs.promises.mkdir(dsCriteriaDir(compiledDir), { recursive: true });
    for (const file of CRITERIA_FILES) {
      const source = path.join(dsCriteriaDir(options.dsDir), file);
      if (await exists(source)) await fs.promises.copyFile(source, path.join(dsCriteriaDir(compiledDir), file));
    }
    await fs.promises.rm(candidate, { recursive: true, force: true });
    await fs.promises.rename(compiledDir, candidate);
    const createdAt = (options.now ?? new Date()).toISOString();
    const criterion = (kind: DesignSystemCriteriaKind): DesignSystemCriteriaVersionState => {
      const previous = current.criteria[kind];
      return {
        ...previous,
        kind,
        status: previous.hasApprovedFile ? 'stale' : 'missing',
        hasDraft: false,
        draftContent: null,
      };
    };
    const next: PersistedState = {
      ...current,
      lifecycle: 'criteria_pending',
      candidateVersion: current.currentVersion + 1,
      candidateFigmaDigest: figmaDigest,
      candidateCreatedAt: createdAt,
      deleteOldSourceAfterApproval: options.deleteOldSourceAfterApproval === true,
      approvedAt: null,
      contextVersioning: 'not_started',
      contextVersioningError: null,
      criteria: { components: criterion('components'), rules: criterion('rules') },
    };
    await persist(options.dsDir, next);
    return { state: await readDesignSystemUpdateState(options.dsDir, options.designSystemId), warnings: result.warnings, summary: result.summary };
  } finally {
    await fs.promises.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function emptySummary() {
  return { componentSets: 0, components: 0, icons: 0, variables: 0, tokenClasses: 0, assets: 0, images: 0, missingImages: 0, errors: [], sources: [] };
}

export async function markDesignSystemCriteriaDraft(
  dsDir: string,
  designSystemId: string,
  kind: DesignSystemCriteriaKind,
): Promise<DesignSystemFigmaUpdateState> {
  const state = await readDesignSystemUpdateState(dsDir, designSystemId);
  if (!state.candidateVersion) return state;
  state.criteria[kind].status = 'draft';
  state.lifecycle = 'criteria_pending';
  await persist(dsDir, state);
  return readDesignSystemUpdateState(dsDir, designSystemId);
}

export async function approveDesignSystemCriteriaDraft(
  dsDir: string,
  designSystemId: string,
  kind: DesignSystemCriteriaKind,
  now = new Date(),
): Promise<DesignSystemFigmaUpdateState> {
  const state = await readDesignSystemUpdateState(dsDir, designSystemId);
  const workDir = state.candidateVersion ? candidateDir(dsDir) : dsDir;
  const result = kind === 'components'
    ? await commitGeneratedComponentsMd(workDir, { now })
    : await commitGeneratedRulesMd(workDir);
  if (!result.ok) throw new DesignSystemUpdateError('BAD_REQUEST', result.errors.join('; '));
  state.criteria[kind] = {
    ...state.criteria[kind],
    status: 'current',
    hasApprovedFile: true,
    hasDraft: false,
    draftContent: null,
    generatedFromVersion: state.candidateVersion ?? state.currentVersion,
    generatedFromFigmaDigest: state.candidateFigmaDigest ?? state.currentFigmaDigest,
    generatedAt: now.toISOString(),
  };
  state.lifecycle = state.candidateVersion
    ? (Object.values(state.criteria).every((item) => item.status === 'current') ? 'ready_for_review' : 'criteria_pending')
    : 'approved';
  await persist(dsDir, state);
  return readDesignSystemUpdateState(dsDir, designSystemId);
}

export async function discardDesignSystemCriteriaDraft(
  dsDir: string,
  designSystemId: string,
  kind: DesignSystemCriteriaKind,
): Promise<DesignSystemFigmaUpdateState> {
  const state = await readDesignSystemUpdateState(dsDir, designSystemId);
  const workDir = state.candidateVersion ? candidateDir(dsDir) : dsDir;
  await fs.promises.rm(path.join(dsCriteriaDir(workDir), `${kind}.md.next`), { force: true });
  state.criteria[kind].status = state.candidateVersion
    ? (state.criteria[kind].hasApprovedFile ? 'stale' : 'missing')
    : (state.criteria[kind].hasApprovedFile ? 'current' : 'missing');
  state.criteria[kind].hasDraft = false;
  state.criteria[kind].draftContent = null;
  state.lifecycle = state.candidateVersion ? 'criteria_pending' : 'approved';
  await persist(dsDir, state);
  return readDesignSystemUpdateState(dsDir, designSystemId);
}

async function replaceLiveFromCandidate(dsDir: string, currentVersion: number, deleteOld: boolean): Promise<void> {
  const control = controlDir(dsDir);
  const candidate = candidateDir(dsDir);
  const transaction = path.join(control, `promote-${randomUUID()}`);
  const backup = path.join(transaction, 'backup');
  await fs.promises.mkdir(backup, { recursive: true });
  const entries = [...GENERATED_ENTRIES, 'criteria'] as const;
  try {
    for (const entry of entries) {
      const live = path.join(dsDir, entry);
      if (await exists(live)) await fs.promises.cp(live, path.join(backup, entry), { recursive: true });
    }
    for (const entry of GENERATED_ENTRIES) {
      const live = path.join(dsDir, entry);
      const next = path.join(candidate, entry);
      await fs.promises.rm(live, { recursive: true, force: true });
      if (await exists(next)) await fs.promises.cp(next, live, { recursive: true });
    }
    await fs.promises.mkdir(dsCriteriaDir(dsDir), { recursive: true });
    for (const file of CRITERIA_FILES) {
      const live = path.join(dsCriteriaDir(dsDir), file);
      const next = path.join(dsCriteriaDir(candidate), file);
      await fs.promises.rm(live, { force: true });
      if (await exists(next)) await fs.promises.copyFile(next, live);
    }
    for (const kind of ['components', 'rules'] as const) {
      await fs.promises.rm(path.join(dsCriteriaDir(dsDir), `${kind}.md.next`), { force: true });
    }
    // Criteria history is independent from the "delete old Figma source"
    // option: reviewed Markdown is user knowledge and is never discarded.
    const oldCriteria = path.join(backup, 'criteria');
    if (await exists(oldCriteria)) {
      const criteriaArchive = path.join(control, 'criteria-history', `v${currentVersion}`);
      await fs.promises.rm(criteriaArchive, { recursive: true, force: true });
      await fs.promises.mkdir(path.dirname(criteriaArchive), { recursive: true });
      await fs.promises.cp(oldCriteria, criteriaArchive, { recursive: true });
    }
    if (!deleteOld) {
      const archive = path.join(control, 'versions', `v${currentVersion}`);
      await fs.promises.rm(archive, { recursive: true, force: true });
      await fs.promises.mkdir(path.dirname(archive), { recursive: true });
      await fs.promises.cp(backup, archive, { recursive: true });
    }
  } catch (error) {
    for (const entry of entries) {
      await fs.promises.rm(path.join(dsDir, entry), { recursive: true, force: true });
      const old = path.join(backup, entry);
      if (await exists(old)) await fs.promises.cp(old, path.join(dsDir, entry), { recursive: true });
    }
    throw error;
  } finally {
    await fs.promises.rm(transaction, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function approveFigmaDesignSystemUpdate(options: {
  dsDir: string;
  designSystemId: string;
  confirmStaleCriteria?: boolean;
  versionAppContexts: () => Promise<DesignSystemContextUpdate[]>;
  now?: Date;
}): Promise<ApproveFigmaDesignSystemUpdateResponse> {
  let state = await readDesignSystemUpdateState(options.dsDir, options.designSystemId);
  if (state.lifecycle === 'approved' && state.contextVersioning !== 'not_started') {
    const updates = state.contextVersioning === 'completed' ? [] : await options.versionAppContexts();
    if (updates.length) {
      state.contextVersioning = updates.some((item) => item.status === 'failed') ? 'failed' : 'completed';
      state.contextVersioningError = updates.find((item) => item.error)?.error ?? null;
      await persist(options.dsDir, state);
    }
    return { state, staleCriteriaAccepted: [], contextUpdates: updates };
  }
  if (!state.candidateVersion || !await exists(candidateDir(options.dsDir))) {
    throw new DesignSystemUpdateError('NO_ACTIVE_UPDATE', 'no active Figma update');
  }
  const drafts = (['components', 'rules'] as const).filter((kind) => state.criteria[kind].hasDraft);
  if (drafts.length) {
    throw new DesignSystemUpdateError('DRAFT_CRITERIA_PENDING', 'approve or discard criteria drafts first', { draftCriteria: drafts });
  }
  const stale = (['components', 'rules'] as const).filter((kind) => state.criteria[kind].status !== 'current');
  if (stale.length && options.confirmStaleCriteria !== true) {
    throw new DesignSystemUpdateError(
      'STALE_CRITERIA_CONFIRMATION_REQUIRED',
      'criteria files are still stale or missing',
      { staleCriteria: stale },
    );
  }
  const candidateVersion = state.candidateVersion;
  const candidateDigest = state.candidateFigmaDigest;
  await replaceLiveFromCandidate(options.dsDir, state.currentVersion, state.deleteOldSourceAfterApproval);
  state = {
    ...state,
    lifecycle: 'approved', currentVersion: candidateVersion,
    currentFigmaDigest: candidateDigest, candidateVersion: null, candidateFigmaDigest: null,
    candidateCreatedAt: null, approvedAt: (options.now ?? new Date()).toISOString(),
    contextVersioning: 'pending', contextVersioningError: null,
  };
  await fs.promises.rm(candidateDir(options.dsDir), { recursive: true, force: true });
  await persist(options.dsDir, state);

  let contextUpdates: DesignSystemContextUpdate[];
  try {
    contextUpdates = await options.versionAppContexts();
  } catch (error) {
    contextUpdates = [{ appId: '*', status: 'failed', contextVersion: null, error: String(error) }];
  }
  state.contextVersioning = contextUpdates.some((item) => item.status === 'failed') ? 'failed' : 'completed';
  state.contextVersioningError = contextUpdates.find((item) => item.error)?.error ?? null;
  await persist(options.dsDir, state);
  return { state: await readDesignSystemUpdateState(options.dsDir, options.designSystemId), staleCriteriaAccepted: stale, contextUpdates };
}
