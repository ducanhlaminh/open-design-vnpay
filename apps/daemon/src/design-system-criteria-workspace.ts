import type { Express } from 'express';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  CriteriaDocumentSnapshot,
  CriteriaGenerationDocumentResponse,
  CriteriaGenerationJob,
  CriteriaGenerationKind,
  CriteriaGenerationStartResponse,
} from '@open-design/contracts';

import { dsCriteriaDir, validateComponentsMd, validateRulesMd } from './ds-criteria.js';
import { designSystemCriteriaWorkDir, readDesignSystemUpdateState } from './design-system-update.js';

export function criteriaGenerationKind(value: unknown): CriteriaGenerationKind | null {
  return value === 'components' || value === 'rules' ? value : null;
}

export function isCriteriaGenerationJobActive(job: CriteriaGenerationJob | null | undefined): boolean {
  return job?.status === 'queued' || job?.status === 'running';
}

async function snapshot(
  filePath: string,
  kind: CriteriaGenerationKind,
  status: CriteriaDocumentSnapshot['status'],
): Promise<CriteriaDocumentSnapshot | null> {
  const [content, info] = await Promise.all([
    readFile(filePath, 'utf8').catch(() => null),
    stat(filePath).catch(() => null),
  ]);
  if (content === null || !info?.isFile()) return null;
  const count = kind === 'components'
    ? validateComponentsMd(content).components
    : validateRulesMd(content).rules;
  return { content, updatedAt: info.mtime.toISOString(), count, status };
}

/** Read both approved and draft content from the active update workdir. */
export async function readCriteriaGenerationDocument(options: {
  liveDsDir: string;
  designSystemId: string;
  kind: CriteriaGenerationKind;
  job: CriteriaGenerationJob | null;
}): Promise<CriteriaGenerationDocumentResponse> {
  const state = await readDesignSystemUpdateState(options.liveDsDir, options.designSystemId);
  const workDir = await designSystemCriteriaWorkDir(options.liveDsDir, options.designSystemId);
  const criterion = state.criteria[options.kind];
  const currentStatus: CriteriaDocumentSnapshot['status'] = state.candidateVersion !== null
    && criterion.generatedFromVersion !== state.candidateVersion
    ? 'stale'
    : 'current';
  const base = path.join(dsCriteriaDir(workDir), `${options.kind}.md`);
  const [current, draft] = await Promise.all([
    snapshot(base, options.kind, currentStatus),
    snapshot(`${base}.next`, options.kind, 'draft'),
  ]);
  return { kind: options.kind, current, draft, job: options.job };
}

export interface RegisterDesignSystemCriteriaWorkspaceRoutesDeps {
  resolveDesignSystemDir: (designSystemId: string) => Promise<string | null>;
  getJob: (designSystemId: string, kind: CriteriaGenerationKind) => CriteriaGenerationJob | null;
  startJob: (designSystemId: string, kind: CriteriaGenerationKind) => Promise<CriteriaGenerationStartResponse>;
}

/** New symmetric API used by the full-window criteria viewer/workspace. */
export function registerDesignSystemCriteriaWorkspaceRoutes(
  app: Express,
  deps: RegisterDesignSystemCriteriaWorkspaceRoutesDeps,
): void {
  app.get('/api/design-systems/:id/criteria/:kind', async (req, res) => {
    try {
      const kind = criteriaGenerationKind(req.params.kind);
      if (!kind) return res.status(400).json({ error: 'criteria kind must be components or rules' });
      const id = String(req.params.id ?? '');
      const liveDsDir = await deps.resolveDesignSystemDir(id);
      if (!liveDsDir) return res.status(404).json({ error: `design system not found: ${id}` });
      return res.json(await readCriteriaGenerationDocument({
        liveDsDir,
        designSystemId: id,
        kind,
        job: deps.getJob(id, kind),
      }));
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/design-systems/:id/criteria/:kind/generate', async (req, res) => {
    try {
      const kind = criteriaGenerationKind(req.params.kind);
      if (!kind) return res.status(400).json({ error: 'criteria kind must be components or rules' });
      const id = String(req.params.id ?? '');
      if (!await deps.resolveDesignSystemDir(id)) {
        return res.status(404).json({ error: `design system not found: ${id}` });
      }
      return res.status(202).json(await deps.startJob(id, kind));
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
