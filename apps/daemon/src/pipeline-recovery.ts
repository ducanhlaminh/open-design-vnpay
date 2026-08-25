import fs from 'node:fs/promises';
import path from 'node:path';

import { collectComponentCatalog } from './docs-components.js';
import {
  listDocPages,
  mergeChangeReports,
  parseChangesFile,
  parseNotesFile,
  partitionNotesByAnchor,
  validateChanges,
  type DocPageResult,
} from './docs-review.js';
import { finalizeFlowUx } from './flow-ux/index.js';
import { buildScreenFlowArtifacts } from './screen-flow.js';
import {
  mergeScreenComponents,
  normalizeScreenComponentsDoc,
  parseScreenComponentsDoc,
  screenDocRel,
  wireframeRel,
  SCREEN_INPUTS_FILE,
  type ScreenComponentsDoc,
  type ScreenComponentsInputs,
} from './screen-components.js';

export interface PipelineRecoveryValidation {
  ok: boolean;
  issues: string[];
  repaired: string[];
}

async function readJson<T>(absolute: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(absolute, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Rebuild daemon-owned flow index after an interactive agent edited
 * screens.json/as-is artifacts in the recovery conversation. */
export async function validateFlowRecovery(cwd: string): Promise<PipelineRecoveryValidation> {
  const fin = await finalizeFlowUx(cwd);
  const issues: string[] = [];
  if (fin.index.length === 0) issues.push('Chưa có flow hợp lệ trong flows/index.json.');
  for (const entry of fin.index) {
    if (entry.screens.length === 0) issues.push(`Flow "${entry.id}" vẫn chưa có screen hợp lệ.`);
  }
  return {
    ok: issues.length === 0,
    issues,
    repaired: fin.index.filter((entry) => entry.screens.length > 0).map((entry) => entry.id),
  };
}

/** Validate every expected screen from the persisted manifest and rebuild
 * comp/index.json from per-screen files. This never trusts an index that an
 * interactive agent may have edited by hand. */
export async function validateComponentRecovery(cwd: string): Promise<PipelineRecoveryValidation> {
  const inputs =
    await readJson<ScreenComponentsInputs>(path.join(cwd, SCREEN_INPUTS_FILE))
    ?? await readJson<ScreenComponentsInputs>(path.join(cwd, 'recovery', 'dr-comp', 'inputs.json'));
  if (!inputs || !Array.isArray(inputs.screens) || inputs.screens.length === 0) {
    return { ok: false, issues: [`Thiếu hoặc hỏng "${SCREEN_INPUTS_FILE}".`], repaired: [] };
  }
  await fs.mkdir(path.join(cwd, 'comp'), { recursive: true });
  await fs.writeFile(path.join(cwd, SCREEN_INPUTS_FILE), `${JSON.stringify(inputs, null, 2)}\n`, 'utf8');
  const catalogText = await fs.readFile(path.join(cwd, 'criteria', 'components.md'), 'utf8').catch(() => null);
  const catalog = catalogText == null ? new Map<string, string>() : collectComponentCatalog(catalogText);
  const screenKeys = new Set(inputs.screens.map((screen) => screen.key));
  const docs: ScreenComponentsDoc[] = [];
  const failed: Array<{ key: string; name: string; errors: string[] }> = [];

  for (const screen of inputs.screens) {
    const errors: string[] = [];
    const raw = await fs.readFile(path.join(cwd, screenDocRel(screen.key)), 'utf8').catch(() => null);
    let doc: ScreenComponentsDoc | null = null;
    if (raw == null) errors.push(`Thiếu "${screenDocRel(screen.key)}".`);
    else {
      const parsed = parseScreenComponentsDoc(raw);
      if ('errors' in parsed) errors.push(...parsed.errors);
      else {
        const wireframeHtml = await fs.readFile(path.join(cwd, wireframeRel(screen.key)), 'utf8').catch(() => null);
        const normalized = normalizeScreenComponentsDoc(parsed.doc, {
          expectedKey: screen.key,
          screenKeys,
          catalog,
          wireframeHtml,
        });
        errors.push(...normalized.errors);
        if (errors.length === 0) {
          doc = {
            ...normalized.doc,
            key: screen.key,
            name: screen.name,
            flowId: screen.flowId,
            source: screen.source,
            layoutSource: (screen.mockups?.length ?? 0) > 0 ? 'doc-image' : 'agent',
            ...(screen.provenance ? { provenance: screen.provenance } : {}),
            ...(screen.confidence !== undefined ? { confidence: screen.confidence } : {}),
            ...(screen.evidence ? { evidence: screen.evidence } : {}),
          };
          await fs.writeFile(path.join(cwd, screenDocRel(screen.key)), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
          if (normalized.wireframeHtml != null && normalized.wireframeHtml !== wireframeHtml) {
            await fs.writeFile(path.join(cwd, wireframeRel(screen.key)), normalized.wireframeHtml, 'utf8');
          }
        }
      }
    }
    if (doc) docs.push(doc);
    else failed.push({ key: screen.key, name: screen.name, errors });
  }

  const merged = mergeScreenComponents(docs, inputs, failed, new Date().toISOString());
  await fs.mkdir(path.join(cwd, 'comp'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'comp', 'index.json'), `${JSON.stringify(merged.index, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(cwd, 'comp', 'summary.md'), merged.summaryMd, 'utf8');
  if (failed.length === 0) {
    await buildScreenFlowArtifacts(cwd, inputs.screens);
    await fs.rm(path.join(cwd, 'recovery', 'dr-comp'), { recursive: true, force: true });
  }
  return {
    ok: failed.length === 0,
    issues: failed.flatMap((item) => item.errors.map((error) => `${item.key}: ${error}`)),
    repaired: docs.map((doc) => doc.key),
  };
}

/** Rebuild review/index.json from canonical page + sidecar files after a
 * multi-turn recovery chat. Validation is page-level and deterministic; a
 * missing/invalid page stays unresolved and successful pages are retained. */
export async function validateReviewRecovery(cwd: string): Promise<PipelineRecoveryValidation> {
  const pages = await listDocPages(cwd);
  const results: DocPageResult[] = [];
  const issues: string[] = [];
  for (const page of pages) {
    const reviewPath = path.posix.join('review', page.mdPath);
    const pageErrors: string[] = [];
    const original = await fs.readFile(path.join(cwd, page.mdPath), 'utf8').catch(() => null);
    const revised = await fs.readFile(path.join(cwd, reviewPath), 'utf8').catch(() => null);
    const rawChanges = await fs.readFile(path.join(cwd, reviewPath.replace(/\.md$/i, '.changes.json')), 'utf8').catch(() => null);
    const rawNotes = await fs.readFile(path.join(cwd, reviewPath.replace(/\.md$/i, '.notes.json')), 'utf8').catch(() => null);
    let changes: DocPageResult['changes'] = [];
    let notes: DocPageResult['notes'] = [];
    const warnings: string[] = [];
    if (original == null) pageErrors.push(`Không đọc được tài liệu gốc "${page.mdPath}".`);
    if (revised == null) pageErrors.push(`Thiếu bản review "${reviewPath}".`);
    if (rawChanges == null) pageErrors.push(`Thiếu sidecar changes của "${page.mdPath}".`);
    else {
      const parsed = parseChangesFile(rawChanges);
      if ('errors' in parsed) pageErrors.push(...parsed.errors);
      else changes = parsed.changes;
    }
    if (rawNotes != null) {
      const parsed = parseNotesFile(rawNotes);
      if ('errors' in parsed) pageErrors.push(...parsed.errors);
      else notes = parsed.notes;
    }
    if (original != null && revised != null) pageErrors.push(...validateChanges(original, revised, changes));
    if (original != null) {
      const partitioned = partitionNotesByAnchor(original, notes);
      notes = partitioned.notes;
      warnings.push(...partitioned.warnings);
      pageErrors.push(...partitioned.errors);
    }
    if (pageErrors.length > 0) issues.push(...pageErrors.map((error) => `${page.mdPath}: ${error}`));
    results.push({
      slug: page.slug,
      page: page.page,
      docPath: page.mdPath,
      reviewPath,
      changes,
      notes,
      status: pageErrors.length === 0 ? 'succeeded' : 'failed',
      ...(pageErrors.length > 0 ? { errors: pageErrors } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }
  const merged = mergeChangeReports(results);
  await fs.mkdir(path.join(cwd, 'review'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'review', 'index.json'), `${JSON.stringify(merged.index, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(cwd, 'review', 'summary.md'), merged.summaryMd, 'utf8');
  return {
    ok: pages.length > 0 && issues.length === 0,
    issues: pages.length > 0 ? issues : ['Không có trang tài liệu đầu vào.'],
    repaired: results.filter((result) => result.status === 'succeeded').map((result) => result.docPath),
  };
}
