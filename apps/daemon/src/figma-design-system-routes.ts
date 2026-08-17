import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type {
  FigmaDesignSystemSource,
  FigmaDesignSystemCatalogSummary,
  FigmaDesignSystemRefreshChanges,
  FigmaDesignSystemRefreshProgress,
  GetFigmaDesignSystemSourceResponse,
} from '@open-design/contracts';

import {
  commitFigmaDesignSystemSourceCatalog,
  deleteFigmaDesignSystemSource,
  getFigmaDesignSystemSource,
  insertFigmaDesignSystemSource,
  listFigmaDesignSystemSources,
  recoverInterruptedFigmaDesignSystemRefreshes,
  setFigmaDesignSystemSourceRefreshState,
  updateFigmaDesignSystemSource,
} from './db.js';
import { readFigmaConfig } from './figma-config.js';
import {
  renderFigmaComponentsMarkdown,
  type FigmaComponentCatalogSnapshot,
} from './figma-component-catalog.js';
import { buildFigmaComponentCatalog, describeFigmaError } from './figma-rest.js';
import type { RouteDeps } from './server-context.js';

export interface RegisterFigmaDesignSystemRoutesDeps extends RouteDeps<'db' | 'http' | 'paths'> {
  buildCatalog?: typeof buildFigmaComponentCatalog;
  timeoutMs?: number;
  now?: () => number;
}

type SourceRow = NonNullable<ReturnType<typeof getFigmaDesignSystemSource>>;
const activeRefreshes = new Set<string>();
const refreshProgress = new Map<string, FigmaDesignSystemRefreshProgress>();

/** Durable Markdown materialization of a reusable Figma catalogue. SQLite
 * remains the structured source of truth; this file is the human/agent-facing
 * closed catalogue and is replaced atomically after every successful refresh. */
export function figmaDesignSystemComponentsPath(runtimeDataDir: string, sourceId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceId)) {
    throw new Error('invalid Figma design-system source id');
  }
  return path.join(runtimeDataDir, 'figma-design-systems', sourceId, 'criteria', 'components.md');
}

async function writeFigmaDesignSystemComponents(
  runtimeDataDir: string,
  sourceId: string,
  snapshot: FigmaComponentCatalogSnapshot,
): Promise<void> {
  const target = figmaDesignSystemComponentsPath(runtimeDataDir, sourceId);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, renderFigmaComponentsMarkdown(snapshot), 'utf8');
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

async function readFigmaDesignSystemComponents(
  runtimeDataDir: string,
  sourceId: string,
  snapshot: FigmaComponentCatalogSnapshot | null,
): Promise<string | null> {
  const target = figmaDesignSystemComponentsPath(runtimeDataDir, sourceId);
  const stored = await fs.promises.readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // Older catalogues may predate the durable Markdown materialization. They
  // can still be previewed immediately; the next refresh writes this content
  // to disk as well.
  return stored ?? (snapshot ? renderFigmaComponentsMarkdown(snapshot) : null);
}

async function removeFigmaDesignSystemFiles(runtimeDataDir: string, sourceId: string): Promise<void> {
  const componentsPath = figmaDesignSystemComponentsPath(runtimeDataDir, sourceId);
  await fs.promises.rm(path.dirname(path.dirname(componentsPath)), { recursive: true, force: true });
}

function canonicalLinks(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    let parsed: URL;
    try { parsed = new URL(raw.trim()); } catch { return null; }
    if (!['figma.com', 'www.figma.com'].includes(parsed.hostname.toLowerCase())) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (!['design', 'file'].includes(parts[0] ?? '') || !/^[A-Za-z0-9]+$/.test(parts[1] ?? '')) return null;
    const key = parts[1]!;
    if (seen.has(key)) return null;
    seen.add(key);
    const canonical = new URL(`https://www.figma.com/design/${key}`);
    const nodeId = parsed.searchParams.get('node-id')?.trim();
    if (nodeId && /^[0-9]+[-:][0-9]+$/.test(nodeId)) canonical.searchParams.set('node-id', nodeId.replace(':', '-'));
    result.push(canonical.toString());
  }
  return result;
}

function catalogSummary(snapshot: FigmaComponentCatalogSnapshot, digest: string): FigmaDesignSystemCatalogSummary {
  const files = snapshot.files.map((file) => ({
    fileKey: file.fileKey,
    name: file.name,
    url: file.url,
    componentCount: file.components.length,
  }));
  return {
    generatedAt: snapshot.generatedAt,
    digest,
    fileCount: files.length,
    componentCount: files.reduce((sum, file) => sum + file.componentCount, 0),
    files,
  };
}

function componentMap(snapshot: FigmaComponentCatalogSnapshot | null): Map<string, string> {
  const components = new Map<string, string>();
  for (const file of snapshot?.files ?? []) {
    for (const component of file.components) {
      components.set(`${file.fileKey}\0${component.nodeId}`, JSON.stringify(component));
    }
  }
  return components;
}

export function diffFigmaComponentCatalogs(
  previous: FigmaComponentCatalogSnapshot | null,
  current: FigmaComponentCatalogSnapshot,
): FigmaDesignSystemRefreshChanges {
  const before = componentMap(previous);
  const after = componentMap(current);
  let addedComponents = 0;
  let changedComponents = 0;
  let unchangedComponents = 0;
  for (const [key, component] of after) {
    const previousComponent = before.get(key);
    if (previousComponent === undefined) addedComponents += 1;
    else if (previousComponent !== component) changedComponents += 1;
    else unchangedComponents += 1;
  }
  let removedComponents = 0;
  for (const key of before.keys()) {
    if (!after.has(key)) removedComponents += 1;
  }
  return {
    previousComponentCount: before.size,
    currentComponentCount: after.size,
    addedComponents,
    removedComponents,
    changedComponents,
    unchangedComponents,
  };
}

export function figmaDesignSystemSourceToContract(row: SourceRow): FigmaDesignSystemSource {
  const snapshot = row.catalog as FigmaComponentCatalogSnapshot | null;
  return {
    id: row.id,
    name: row.name,
    kind: 'figma-links',
    links: row.links,
    status: row.status,
    refreshProgress: refreshProgress.get(row.id) ?? null,
    catalog: snapshot && row.catalogDigest ? catalogSummary(snapshot, row.catalogDigest) : null,
    lastError: row.lastError,
    hasShowcase: false,
    hasReactBundle: false,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function fileKeyOf(url: string): string {
  return new URL(url).pathname.split('/').filter(Boolean)[1]!;
}

export function registerFigmaDesignSystemRoutes(app: Express, deps: RegisterFigmaDesignSystemRoutesDeps): void {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  recoverInterruptedFigmaDesignSystemRefreshes(db, now());
  const guard = (req: any, res: any): boolean => {
    if (deps.http.isLocalSameOrigin(req, deps.http.resolvedPortRef.current)) return true;
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'cross-origin request rejected' } });
    return false;
  };
  const notFound = (res: any) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy Design system Figma.' } });

  app.get('/api/figma-design-systems', (req, res) => {
    if (!guard(req, res)) return;
    res.json({ sources: listFigmaDesignSystemSources(db).map(figmaDesignSystemSourceToContract) });
  });

  app.post('/api/figma-design-systems', (req, res) => {
    if (!guard(req, res)) return;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const links = canonicalLinks(req.body?.links);
    if (!name || name.length > 120 || !links) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Tên và 1–5 link file Figma hợp lệ là bắt buộc.' } });
    }
    const timestamp = now();
    const source = insertFigmaDesignSystemSource(db, { id: randomUUID(), name, links, createdAt: timestamp, updatedAt: timestamp });
    res.status(201).json({ source: figmaDesignSystemSourceToContract(source!) });
  });

  app.get('/api/figma-design-systems/:id', async (req, res) => {
    if (!guard(req, res)) return;
    const source = getFigmaDesignSystemSource(db, req.params.id);
    if (!source) return notFound(res);
    const body: GetFigmaDesignSystemSourceResponse = {
      source: figmaDesignSystemSourceToContract(source),
      componentsMarkdown: await readFigmaDesignSystemComponents(
        deps.paths.RUNTIME_DATA_DIR,
        source.id,
        source.catalog as FigmaComponentCatalogSnapshot | null,
      ),
    };
    res.json(body);
  });

  app.patch('/api/figma-design-systems/:id', async (req, res) => {
    if (!guard(req, res)) return;
    const current = getFigmaDesignSystemSource(db, req.params.id);
    if (!current) return notFound(res);
    const name = req.body?.name === undefined ? current.name : typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const links = req.body?.links === undefined ? current.links : canonicalLinks(req.body.links);
    if (!name || name.length > 120 || !links) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Tên và 1–5 link file Figma hợp lệ là bắt buộc.' } });
    }
    const linksChanged = JSON.stringify(links) !== JSON.stringify(current.links);
    if (linksChanged) await removeFigmaDesignSystemFiles(deps.paths.RUNTIME_DATA_DIR, current.id);
    const source = updateFigmaDesignSystemSource(db, current.id, { name, links, linksChanged, updatedAt: now() });
    res.json({ source: figmaDesignSystemSourceToContract(source!) });
  });

  app.delete('/api/figma-design-systems/:id', async (req, res) => {
    if (!guard(req, res)) return;
    if (activeRefreshes.has(req.params.id)) {
      return res.status(409).json({ error: { code: 'REFRESH_IN_PROGRESS', message: 'Design system đang được làm mới.' } });
    }
    const current = getFigmaDesignSystemSource(db, req.params.id);
    if (!current) return notFound(res);
    if (!deleteFigmaDesignSystemSource(db, req.params.id)) return notFound(res);
    await removeFigmaDesignSystemFiles(deps.paths.RUNTIME_DATA_DIR, current.id);
    res.status(204).send();
  });

  app.post('/api/figma-design-systems/:id/refresh', async (req, res) => {
    if (!guard(req, res)) return;
    const current = getFigmaDesignSystemSource(db, req.params.id);
    if (!current) return notFound(res);
    if (activeRefreshes.has(current.id)) {
      return res.status(409).json({ error: { code: 'REFRESH_IN_PROGRESS', message: 'Design system đang được làm mới.' } });
    }
    activeRefreshes.add(current.id);
    setFigmaDesignSystemSourceRefreshState(db, current.id, { status: 'refreshing', updatedAt: now() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Figma catalogue refresh timed out')), deps.timeoutMs ?? 120_000);
    try {
      const config = await readFigmaConfig(deps.paths.RUNTIME_DATA_DIR);
      if (!config?.token) {
        const message = 'Chưa cấu hình Personal Access Token Figma trên máy này.';
        const source = setFigmaDesignSystemSourceRefreshState(db, current.id, { status: 'error', lastError: message, updatedAt: now() });
        return res.status(400).json({ error: { code: 'FIGMA_TOKEN_REQUIRED', message }, source: figmaDesignSystemSourceToContract(source!) });
      }
      const links = current.links.map((url) => ({ url, fileKey: fileKeyOf(url) }));
      const snapshot = await (deps.buildCatalog ?? buildFigmaComponentCatalog)({
        token: config.token,
        links,
        signal: controller.signal,
        onProgress(progress) {
          refreshProgress.set(current.id, {
            completedFiles: progress.phase === 'done' ? progress.index : progress.index - 1,
            totalFiles: progress.total,
            phase: progress.phase,
            currentFileKey: progress.fileKey,
            ...(progress.name ? { currentFileName: progress.name } : {}),
          });
        },
      });
      const serialized = JSON.stringify(snapshot);
      const digest = createHash('sha256').update(serialized).digest('hex');
      const changes = diffFigmaComponentCatalogs(current.catalog as FigmaComponentCatalogSnapshot | null, snapshot);
      await writeFigmaDesignSystemComponents(deps.paths.RUNTIME_DATA_DIR, current.id, snapshot);
      const source = commitFigmaDesignSystemSourceCatalog(db, current.id, { catalog: snapshot, digest, updatedAt: now() });
      res.json({ source: figmaDesignSystemSourceToContract(source!), changes });
    } catch (error) {
      const message = controller.signal.aborted ? 'Hết thời gian chờ Figma phản hồi.' : describeFigmaError(error);
      const source = setFigmaDesignSystemSourceRefreshState(db, current.id, { status: 'error', lastError: message, updatedAt: now() });
      res.status(502).json({ error: { code: controller.signal.aborted ? 'FIGMA_TIMEOUT' : 'FIGMA_REFRESH_FAILED', message }, source: figmaDesignSystemSourceToContract(source!) });
    } finally {
      clearTimeout(timer);
      activeRefreshes.delete(current.id);
      refreshProgress.delete(current.id);
    }
  });
}
