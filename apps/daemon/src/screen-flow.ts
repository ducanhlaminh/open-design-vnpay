import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  ScreenFlowEdge,
  ScreenFlowIndexEntry,
  ScreenFlowModel,
  ScreenFlowsIndex,
  ScreenFlowSource,
} from '@open-design/contracts';

import type { FlowIndexEntry } from './flow-ux/index.js';
import { decodeMxfile, encodeMxfile } from './flow-ux/mxfile.js';
import type { FlowchartDoc, FlowchartEdge } from './flow-ux/to-flowchart.js';
import type { ScreenInput } from './screen-components.js';

export const SCREEN_FLOWS_DIR = 'comp/screen-flows';

const byOrder = (a: ScreenInput, b: ScreenInput): number => a.order - b.order || a.key.localeCompare(b.key);
const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attrRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stableToken(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface ScreenFlowClassification {
  reusable: boolean;
  reasons: string[];
}

/** Conservative gate: false positives would expose a business process as a
 * screen-flow. A reusable source therefore needs one vertex per screen, no
 * unknown mapping, and a real transition between two distinct screens. */
export function classifySourceScreenFlow(doc: FlowchartDoc, validKeys: ReadonlySet<string>): ScreenFlowClassification {
  const reasons: string[] = [];
  const mapped = doc.nodes.filter((node) => clean(node.screen));
  const mappedKeys = new Set(mapped.map((node) => node.screen!));
  if (mappedKeys.size < 2) reasons.push('cần ít nhất hai màn được gắn');
  if ([...validKeys].some((key) => !mappedKeys.has(key))) reasons.push('có màn hợp lệ không tồn tại trong topology nguồn');
  if (mapped.some((node) => !validKeys.has(node.screen!))) reasons.push('có mapping màn không còn hợp lệ');
  if (doc.nodes.some((node) => (node.type === 'action' || node.type === 'start') && !node.screen)) {
    // An unmapped terminal start is notation; an unmapped action/start with an
    // outgoing flow is a business step and makes reuse unsafe.
    const meaningful = doc.nodes.some(
      (node) => (node.type === 'action' || node.type === 'start') && !node.screen && node.type !== 'start',
    );
    if (meaningful) reasons.push('có bước nghiệp vụ không phải màn hình');
  }
  const countByKey = new Map<string, number>();
  for (const node of mapped) countByKey.set(node.screen!, (countByKey.get(node.screen!) ?? 0) + 1);
  if ([...countByKey.values()].some((count) => count > 1)) reasons.push('một màn trải trên nhiều bước nghiệp vụ');
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const out = new Map<string, string[]>();
  for (const edge of doc.edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  let hasTransition = false;
  for (const source of mapped) {
    const queue = [...(out.get(source.id) ?? [])];
    const seen = new Set<string>();
    while (queue.length && !hasTransition) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const target = byId.get(id);
      if (!target) continue;
      if (target.screen) {
        if (validKeys.has(target.screen) && target.screen !== source.screen) hasTransition = true;
        continue;
      }
      // Unmapped actions already make the source non-reusable; do not use
      // them as proof of a screen transition. Decisions/start/end notation is
      // allowed between two screen vertices.
      if (target.type === 'action') continue;
      queue.push(...(out.get(id) ?? []));
    }
    if (hasTransition) break;
  }
  if (!hasTransition) reasons.push('không có transition giữa hai màn');
  return { reusable: reasons.length === 0, reasons };
}

interface WalkState {
  id: string;
  path: string[];
  conditions: string[];
}

function screenModel(input: ScreenInput, flowId: string) {
  return {
    key: input.key,
    name: input.name,
    cellIds: [`sf-screen-${stableToken(input.key)}`],
    origin: input.origin ?? ('flow' as const),
    source: input.source,
    line: input.section?.startLine ?? null,
    flowIds: flowId ? [flowId] : [],
    linked: false,
  };
}

/** Project a business graph onto screens. Invalid (removed) mapped screens are
 * barriers: walking through them would invent predecessor/successor links. */
export function collapseToScreenFlow(doc: FlowchartDoc, inputs: ScreenInput[]): ScreenFlowModel {
  const ordered = [...inputs].sort(byOrder);
  const validKeys = new Set(ordered.map((screen) => screen.key));
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const out = new Map<string, FlowchartEdge[]>();
  const indegree = new Map(doc.nodes.map((node) => [node.id, 0]));
  for (const edge of doc.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const candidates: Omit<ScreenFlowEdge, 'id'>[] = [];
  for (const source of doc.nodes) {
    const from = source.screen;
    if (!from || !validKeys.has(from)) continue;
    const queue: WalkState[] = (out.get(source.id) ?? []).map((edge) => ({
      id: edge.to,
      path: [source.id, edge.to],
      conditions: edge.label ? [edge.label] : [],
    }));
    const visited = new Set<string>();
    while (queue.length) {
      const state = queue.shift()!;
      const node = byId.get(state.id);
      if (!node) continue;
      // Preserve distinct branch labels while making cycles finite.
      const visitKey = `${state.id}\u0000${state.conditions.join('\u0001')}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      if (node.screen) {
        if (!validKeys.has(node.screen)) continue;
        if (node.screen !== from) {
          candidates.push({
            from,
            to: node.screen,
            ...(source.label ? { via: source.label } : {}),
            ...(state.conditions.length ? { condition: state.conditions.join(' → ') } : {}),
            flowIds: [doc.id],
            evidence: [{ flowId: doc.id, fromNode: source.id, toNode: node.id, path: state.path }],
          });
          continue;
        }
      }
      for (const edge of out.get(node.id) ?? []) {
        // A node already in this path is a cycle; following it cannot reveal
        // a new first screen without eventually taking an unvisited exit.
        if (state.path.includes(edge.to)) continue;
        queue.push({
          id: edge.to,
          path: [...state.path, edge.to],
          conditions: edge.label ? [...state.conditions, edge.label] : state.conditions,
        });
      }
    }
  }

  const deduped = new Map<string, Omit<ScreenFlowEdge, 'id'>>();
  for (const edge of candidates) {
    if (edge.from === edge.to) continue;
    const signature = [edge.from, edge.to, edge.via ?? '', edge.condition ?? ''].join('\u0000');
    const previous = deduped.get(signature);
    if (!previous) deduped.set(signature, edge);
    else previous.evidence.push(...edge.evidence);
  }
  const order = new Map(ordered.map((screen, index) => [screen.key, index]));
  const edges: ScreenFlowEdge[] = [...deduped.values()]
    .sort((a, b) => (order.get(a.from)! - order.get(b.from)!) || (order.get(a.to)! - order.get(b.to)!) || (a.condition ?? '').localeCompare(b.condition ?? '') || (a.via ?? '').localeCompare(b.via ?? ''))
    .map((edge) => ({ ...edge, id: `edge-${stableToken([edge.from, edge.to, edge.via ?? '', edge.condition ?? ''].join('|'))}` }));
  const linkedKeys = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const screens = ordered.map((input) => ({ ...screenModel(input, doc.id), linked: linkedKeys.has(input.key) }));
  const roots = doc.nodes.filter((node) => node.type === 'start' || (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const entryScreens: string[] = [];
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.screen) {
      if (validKeys.has(node.screen) && !entryScreens.includes(node.screen)) entryScreens.push(node.screen);
      // Removed screen is a barrier for entry discovery too.
      if (!validKeys.has(node.screen)) continue;
      if (entryScreens.length) continue;
    }
    for (const edge of out.get(id) ?? []) queue.push(edge.to);
  }
  return {
    schema_version: 1,
    flowId: doc.id,
    id: doc.id,
    title: doc.title,
    sourceMode: 'generated',
    entryScreens,
    screens,
    edges,
    unlinkedScreens: screens.filter((screen) => !screen.linked).map((screen) => screen.key),
    warnings: [],
  };
}

/** Canonical single-page Draw.io. Geometry is intentionally simple and stable;
 * screen identity lives in `od-screen-key`, never in the visible label. */
export function renderScreenFlowDrawio(model: ScreenFlowModel): string {
  const linked = model.screens.filter((screen) => screen.linked);
  const unlinked = model.screens.filter((screen) => !screen.linked);
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  if (unlinked.length) {
    const height = Math.max(120, 55 + unlinked.length * 90);
    cells.push(`<mxCell id="sf-unlinked" value="Chưa xác định điều hướng" style="swimlane;horizontal=1;rounded=1;" vertex="1" parent="1"><mxGeometry x="720" y="40" width="360" height="${height}" as="geometry"/></mxCell>`);
  }
  linked.forEach((screen, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    cells.push(`<mxCell id="sf-screen-${stableToken(screen.key)}" od-screen-key="${xml(screen.key)}" value="${xml(screen.name)}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${40 + column * 220}" y="${40 + row * 130}" width="180" height="72" as="geometry"/></mxCell>`);
  });
  unlinked.forEach((screen, index) => {
    cells.push(`<mxCell id="sf-screen-${stableToken(screen.key)}" od-screen-key="${xml(screen.key)}" value="${xml(screen.name)}" style="rounded=1;whiteSpace=wrap;html=1;dashed=1;" vertex="1" parent="sf-unlinked"><mxGeometry x="30" y="${45 + index * 90}" width="300" height="60" as="geometry"/></mxCell>`);
  });
  model.edges.forEach((edge) => {
    const label = [edge.via, edge.condition].filter(Boolean).join(' · ');
    cells.push(`<mxCell id="sf-${xml(edge.id)}"${label ? ` value="${xml(label)}"` : ''} style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="sf-screen-${stableToken(edge.from)}" target="sf-screen-${stableToken(edge.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  });
  const graphXml = `<mxGraphModel><root>${cells.join('')}</root></mxGraphModel>`;
  return encodeMxfile([{ id: `sf-${stableToken(model.flowId)}`, name: 'Luồng màn hình', graphXml }]);
}

function enrichReusedDrawio(raw: string, model: ScreenFlowModel, doc: FlowchartDoc): string | null {
  try {
    const page = decodeMxfile(raw)[0];
    if (!page) return null;
    let graphXml = page.graphXml;
    const names = new Map(model.screens.map((screen) => [screen.key, screen.name]));
    for (const node of doc.nodes) {
      if (!node.screen || !names.has(node.screen)) continue;
      const re = /<mxCell\b([^>]*)>/g;
      graphXml = graphXml.replace(re, (whole, rawAttrs: string) => {
        if (!new RegExp(`\\bid="${attrRe(node.id)}"`).test(rawAttrs)) return whole;
        const selfClosing = /\/\s*$/.test(rawAttrs);
        let next = rawAttrs.replace(/\/\s*$/, '').replace(/\sod-screen-key="[^"]*"/g, '').replace(/\svalue="[^"]*"/g, '');
        next += ` od-screen-key="${xml(node.screen!)}" value="${xml(names.get(node.screen!)!)}"`;
        return `<mxCell${next}${selfClosing ? '/>' : '>'}`;
      });
    }
    return encodeMxfile([{ ...page, name: 'Luồng màn hình', graphXml }]);
  } catch {
    return null;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export interface BuildScreenFlowOptions {
  generatedAt?: string;
}

/** Thin, fail-soft filesystem boundary invoked after dr-comp fan-out. */
export async function buildScreenFlowArtifacts(
  cwd: string,
  allScreens: ScreenInput[],
  options: BuildScreenFlowOptions = {},
): Promise<ScreenFlowsIndex> {
  const outputDir = path.join(cwd, SCREEN_FLOWS_DIR);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  const warnings: string[] = [];
  const rawIndex = await readJson<unknown>(path.join(cwd, 'flows/index.json'));
  const flows = Array.isArray(rawIndex) ? (rawIndex as FlowIndexEntry[]) : [];
  if (!Array.isArray(rawIndex)) warnings.push('Không đọc được flows/index.json — mọi màn được đưa vào UNLINKED.');
  const assigned = new Set<string>();
  const entries: ScreenFlowIndexEntry[] = [];
  const overrideDoc = await readJson<{ overrides?: Array<{ action?: string }> }>(path.join(cwd, 'screens-overrides.json'));
  const topologyChanged = (overrideDoc?.overrides ?? []).some((entry) => entry.action === 'add' || entry.action === 'remove');

  for (const flowEntry of flows) {
    const id = clean(flowEntry?.id);
    if (!id) {
      warnings.push('Bỏ qua một flow không có id hợp lệ.');
      continue;
    }
    const flowchartRel = flowEntry.files?.flowchart ?? `flows/${id}.flowchart.json`;
    const doc = await readJson<FlowchartDoc>(path.join(cwd, flowchartRel));
    if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
      warnings.push(`${id}: flowchart JSON hỏng hoặc thiếu — màn của flow được đưa vào UNLINKED.`);
      continue;
    }
    const flowScreens = allScreens.filter((screen) => screen.flowId === id).sort(byOrder);
    if (!flowScreens.length) continue;
    flowScreens.forEach((screen) => assigned.add(screen.key));
    const model = collapseToScreenFlow(doc, flowScreens);
    const source: ScreenFlowSource = {
      flowId: id,
      kind: flowEntry.kind,
      ...(flowEntry.diagram ? { diagram: flowEntry.diagram } : {}),
      ...(flowEntry.files?.asIs ? { asIs: flowEntry.files.asIs } : {}),
    };
    const classification = classifySourceScreenFlow(doc, new Set(flowScreens.map((screen) => screen.key)));
    const hasDroppedMappings = (flowEntry.screensDropped?.length ?? 0) > 0;
    const reusable = classification.reusable && !topologyChanged && !hasDroppedMappings;
    model.sourceMode = reusable ? 'reused' : 'generated';
    model.source = source;
    if (reusable && flowEntry.kind === 'drawio') {
      for (const screen of model.screens) {
        screen.cellIds = doc.nodes.filter((node) => node.screen === screen.key).map((node) => node.id);
      }
    }
    if (!reusable) model.warnings.push(...classification.reasons);
    if (hasDroppedMappings) model.warnings.push('Nguồn có mapping màn bị loại — không tái sử dụng nguyên topology.');
    if (topologyChanged && classification.reusable) model.warnings.push('Có override add/remove — dựng lại để không giữ topology đã lệch danh sách màn.');

    let drawio = renderScreenFlowDrawio(model);
    if (reusable && flowEntry.kind === 'drawio' && flowEntry.files?.asIs) {
      const raw = await fs.readFile(path.join(cwd, flowEntry.files.asIs), 'utf8').catch(() => null);
      const enriched = raw ? enrichReusedDrawio(raw, model, doc) : null;
      if (enriched) drawio = enriched;
      else {
        model.sourceMode = 'generated';
        model.warnings.push('Không đọc được Draw.io as-is — dùng bản canonical.');
      }
    }
    const modelRel = `${SCREEN_FLOWS_DIR}/${id}.screen-flow.json`;
    const drawioRel = `${SCREEN_FLOWS_DIR}/${id}.drawio`;
    await writeJson(path.join(cwd, modelRel), model);
    await fs.writeFile(path.join(cwd, drawioRel), drawio, 'utf8');
    entries.push({
      id,
      title: flowEntry.title || doc.title || id,
      sourceMode: model.sourceMode,
      files: { model: modelRel, drawio: drawioRel },
      source,
      screenCount: model.screens.length,
      edgeCount: model.edges.length,
      unlinkedCount: model.unlinkedScreens.length,
      warnings: model.warnings,
    });
  }

  const unassigned = allScreens.filter((screen) => !assigned.has(screen.key)).sort(byOrder);
  if (unassigned.length) {
    const model: ScreenFlowModel = {
      schema_version: 1,
      flowId: 'UNLINKED',
      id: 'UNLINKED',
      title: 'Chưa xác định điều hướng',
      sourceMode: 'generated',
      entryScreens: [],
      screens: unassigned.map((screen) => screenModel(screen, '')),
      edges: [],
      unlinkedScreens: unassigned.map((screen) => screen.key),
      warnings: ['Các màn này chưa có bằng chứng để quy về một flow cụ thể.'],
    };
    const modelRel = `${SCREEN_FLOWS_DIR}/UNLINKED.screen-flow.json`;
    const drawioRel = `${SCREEN_FLOWS_DIR}/UNLINKED.drawio`;
    await writeJson(path.join(cwd, modelRel), model);
    await fs.writeFile(path.join(cwd, drawioRel), renderScreenFlowDrawio(model), 'utf8');
    entries.push({
      id: model.flowId,
      title: model.title,
      sourceMode: model.sourceMode,
      files: { model: modelRel, drawio: drawioRel },
      screenCount: model.screens.length,
      edgeCount: 0,
      unlinkedCount: model.screens.length,
      warnings: model.warnings,
    });
  }

  const index: ScreenFlowsIndex = {
    schema_version: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    flows: entries,
    totalScreens: allScreens.length,
    warnings,
  };
  await writeJson(path.join(outputDir, 'index.json'), index);
  return index;
}
