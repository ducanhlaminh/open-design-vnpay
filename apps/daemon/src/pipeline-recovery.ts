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
import { buildScreenFlowArtifacts, SCREEN_FLOWS_DIR, validateScreenFlowTopology } from './screen-flow.js';
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
  /** Screens that still need an evidenced navigation edge/user decision.
   *  `advisory: true` (UNLINKED / orphan / unreachable) means the run-all
   *  gate no longer blocks on it — a navigation gap warns instead of
   *  failing the stage. `advisory: false` is a genuine BLOCKING defect (a
   *  screen owned by more than one flow) that still fails the stage. */
  needsHelp?: Array<{ key: string; name: string; flowId: string; reason: string; advisory: boolean }>;
  /** True when at least one BLOCKING (non-advisory) issue exists: multi-flow
   *  screen ownership, index/model corruption, or screen-count coverage
   *  mismatch. UNLINKED/orphan/unreachable screens never set this — they
   *  are pure linkage warnings. Consumers that used to gate on `ok` for
   *  topology correctness should gate on `blocking` instead. */
  blocking?: boolean;
}

async function readJson<T>(absolute: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(absolute, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface ScreenFlowIndexLike {
  totalScreens?: number;
  flows?: Array<{ id?: string; files?: { model?: string } }>;
}

interface ScreenFlowModelLike {
  flowId: string;
  title: string;
  entryScreens: string[];
  screens: Array<{ key: string; name: string }>;
  edges: Array<{ id: string; from: string; to: string; kind?: 'primary' | 'branch' | 'return' | 'secondary' | 'inferred' }>;
  unlinkedScreens: string[];
}

function screenFlowModelShape(value: unknown): value is ScreenFlowModelLike {
  if (!value || typeof value !== 'object') return false;
  const model = value as Partial<ScreenFlowModelLike>;
  return typeof model.flowId === 'string'
    && typeof model.title === 'string'
    && Array.isArray(model.entryScreens)
    && Array.isArray(model.screens)
    && Array.isArray(model.edges)
    && Array.isArray(model.unlinkedScreens);
}

/**
 * Validate daemon-owned screen-flow artifacts without trusting index counts.
 * This is intentionally separate from component validation: recovery chat can
 * repair navigation evidence and then re-check/rebuild topology without
 * re-running the expensive per-screen agent fan-out.
 */
export async function validateScreenFlowRecoveryArtifacts(cwd: string): Promise<PipelineRecoveryValidation> {
  const indexPath = path.join(cwd, SCREEN_FLOWS_DIR, 'index.json');
  const index = await readJson<ScreenFlowIndexLike>(indexPath);
  if (!index || !Array.isArray(index.flows) || index.flows.length === 0) {
    return { ok: false, issues: [`Thiếu hoặc hỏng "${SCREEN_FLOWS_DIR}/index.json".`], repaired: [], blocking: true };
  }

  const issues: string[] = [];
  const repaired: string[] = [];
  const needsHelp = new Map<string, { key: string; name: string; flowId: string; reason: string; advisory: boolean }>();
  const ownerByScreen = new Map<string, string>();
  const seenScreens = new Set<string>();
  const cwdRoot = path.resolve(cwd);
  // Structural defects (missing/corrupt model files, corrupt edges, coverage
  // mismatch) are the only things that still fail dr-comp. UNLINKED/orphan/
  // unreachable are linkage GAPS, not defects — they stay advisory.
  let structuralBlocking = false;

  for (const entry of index.flows) {
    const flowId = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : '(không-id)';
    const modelRel = entry.files?.model;
    if (!modelRel) {
      issues.push(`${flowId}: index thiếu đường dẫn screen-flow model.`);
      structuralBlocking = true;
      continue;
    }
    const modelPath = path.resolve(cwd, modelRel);
    if (modelPath !== cwdRoot && !modelPath.startsWith(`${cwdRoot}${path.sep}`)) {
      issues.push(`${flowId}: đường dẫn model vượt khỏi workspace: ${modelRel}.`);
      structuralBlocking = true;
      continue;
    }
    const rawModel = await readJson<unknown>(modelPath);
    if (!screenFlowModelShape(rawModel)) {
      issues.push(`${flowId}: thiếu hoặc hỏng "${modelRel}".`);
      structuralBlocking = true;
      continue;
    }
    const model = rawModel;
    const names = new Map(model.screens.map((screen) => [screen.key, screen.name || screen.key]));
    for (const screen of model.screens) {
      seenScreens.add(screen.key);
      const owner = ownerByScreen.get(screen.key);
      if (owner && owner !== model.flowId) {
        const reason = `screen xuất hiện trong nhiều flow (${owner}, ${model.flowId})`;
        issues.push(`Screen "${screen.name || screen.key}" (${screen.key}): ${reason}.`);
        // Multi-flow ownership is the one screen-level defect that still
        // BLOCKS — it means the model itself is inconsistent, not merely
        // unlinked.
        needsHelp.set(screen.key, { key: screen.key, name: screen.name || screen.key, flowId: model.flowId, reason, advisory: false });
      } else ownerByScreen.set(screen.key, model.flowId);
    }

    const topology = validateScreenFlowTopology(model as Parameters<typeof validateScreenFlowTopology>[0]);
    const problemKeys = new Set([
      ...(model.flowId === 'UNLINKED' ? model.screens.map((screen) => screen.key) : []),
      ...topology.orphanScreens,
      ...topology.unreachableScreens,
    ]);
    for (const key of problemKeys) {
      const name = names.get(key) ?? key;
      const reason = model.flowId === 'UNLINKED'
        ? 'chưa có bằng chứng để thuộc một flow hợp lệ (UNLINKED)'
        : topology.unreachableScreens.includes(key)
          ? 'không reachable từ entry qua cạnh primary|branch|inferred'
          : 'không có cạnh topology hợp lệ (orphan)';
      issues.push(`Screen "${name}" (${key}) · ${model.flowId}: ${reason}.`);
      // Never downgrade an already-BLOCKING (multi-flow) classification for
      // the same screen key to advisory.
      const existing = needsHelp.get(key);
      if (!existing || existing.advisory) needsHelp.set(key, { key, name, flowId: model.flowId, reason, advisory: true });
    }
    for (const error of topology.errors) {
      if (!issues.some((issue) => issue.includes(error))) issues.push(`${model.flowId}: ${error}`);
      // Orphan/unreachable aggregate lines, and the UNLINKED bucket's
      // always-invalid/no-entry-screen markers (that bucket is deliberately
      // built without entries), are linkage artifacts already accounted for
      // above — not a NEW structural defect. Anything else surfaced by
      // validateScreenFlowTopology on a real flow model (corrupt/duplicate
      // edges, dangling endpoints, a real flow missing an entry) is.
      const isLinkageSummary = /^Có \d+ screen (?:cô lập|không reachable)/.test(error);
      const isUnlinkedArtifact = model.flowId === 'UNLINKED'
        && (error === 'Flow UNLINKED không phải topology hợp lệ.' || error === 'Flow chưa khai entry screen hợp lệ.');
      if (!isLinkageSummary && !isUnlinkedArtifact) structuralBlocking = true;
    }
    if (topology.valid && model.flowId !== 'UNLINKED') repaired.push(model.flowId);
  }

  if (typeof index.totalScreens !== 'number' || index.totalScreens !== seenScreens.size) {
    issues.push(`Screen-flow coverage lệch: index khai ${index.totalScreens ?? 'không rõ'}, model có ${seenScreens.size} screen duy nhất.`);
    structuralBlocking = true;
  }
  const blocking = structuralBlocking || [...needsHelp.values()].some((help) => !help.advisory);
  return {
    ok: issues.length === 0,
    issues,
    repaired: [...new Set(repaired)].sort(),
    blocking,
    ...(needsHelp.size > 0 ? { needsHelp: [...needsHelp.values()].sort((a, b) => a.key.localeCompare(b.key)) } : {}),
  };
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
  let topology: PipelineRecoveryValidation | null = null;
  if (failed.length === 0) {
    try {
      await buildScreenFlowArtifacts(cwd, inputs.screens);
      topology = await validateScreenFlowRecoveryArtifacts(cwd);
    } catch (error) {
      topology = {
        ok: false,
        issues: [`Không dựng/kiểm tra được screen-flow: ${error instanceof Error ? error.message : String(error)}`],
        repaired: [],
        blocking: true,
      };
    }
    // Advisory linkage gaps (UNLINKED/orphan/unreachable) no longer keep
    // "Kiểm tra & tiếp tục" from succeeding — only a BLOCKING defect does.
    if (!topology.blocking) {
      await fs.rm(path.join(cwd, 'recovery', 'dr-comp'), { recursive: true, force: true });
    } else {
      await fs.mkdir(path.join(cwd, 'recovery', 'dr-comp'), { recursive: true });
      await fs.writeFile(
        path.join(cwd, 'recovery', 'dr-comp', 'inputs.json'),
        `${JSON.stringify(inputs, null, 2)}\n`,
        'utf8',
      );
    }
  }
  const topologyIssues = topology?.issues ?? [];
  return {
    ok: failed.length === 0 && !(topology?.blocking ?? true),
    issues: [
      ...failed.flatMap((item) => item.errors.map((error) => `${item.key}: ${error}`)),
      ...topologyIssues,
    ],
    repaired: docs.map((doc) => doc.key),
    ...(topology?.needsHelp ? { needsHelp: topology.needsHelp } : {}),
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
