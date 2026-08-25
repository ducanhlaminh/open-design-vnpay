import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  ScreenFlowEdge,
  ScreenFlowEdgeKind,
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

export interface CollapseToScreenFlowOptions {
  /** Business nodes that received a deterministic screen mapping from their
   * labels rather than an explicit source-diagram mapping. */
  inferredNodeIds?: ReadonlySet<string>;
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
export function collapseToScreenFlow(doc: FlowchartDoc, inputs: ScreenInput[], options: CollapseToScreenFlowOptions = {}): ScreenFlowModel {
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
            kind: options.inferredNodeIds?.has(source.id) || options.inferredNodeIds?.has(node.id)
              ? 'inferred'
              : state.conditions.length
                ? 'branch'
                : 'primary',
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

  // A screen-flow is about navigation between screens, not every business
  // step that happened between them. Collapse parallel business paths into a
  // single visual direction and keep all raw paths in evidence.
  const grouped = new Map<string, {
    from: string;
    to: string;
    vias: Set<string>;
    conditions: Set<string>;
    kind: ScreenFlowEdgeKind;
    flowIds: string[];
    evidence: ScreenFlowEdge['evidence'];
  }>();
  for (const edge of candidates) {
    if (edge.from === edge.to) continue;
    const kind = edge.kind ?? 'primary';
    const signature = `${edge.from}\u0000${edge.to}\u0000${kind}`;
    const previous = grouped.get(signature);
    if (previous) {
      if (edge.via) previous.vias.add(edge.via);
      if (edge.condition) previous.conditions.add(edge.condition);
      previous.evidence.push(...edge.evidence);
      continue;
    }
    grouped.set(signature, {
      from: edge.from,
      to: edge.to,
      vias: new Set(edge.via ? [edge.via] : []),
      conditions: new Set(edge.condition ? [edge.condition] : []),
      kind,
      flowIds: [...edge.flowIds],
      evidence: [...edge.evidence],
    });
  }
  const order = new Map(ordered.map((screen, index) => [screen.key, index]));
  const edges: ScreenFlowEdge[] = [...grouped.values()]
    .map((group): Omit<ScreenFlowEdge, 'id'> => ({
      from: group.from,
      to: group.to,
      ...(group.vias.size === 1 ? { via: [...group.vias][0]! } : {}),
      ...(group.conditions.size > 0 ? { condition: [...group.conditions].join(' / ') } : {}),
      kind: group.kind,
      flowIds: group.flowIds,
      evidence: group.evidence,
    }))
    .sort((a, b) => (order.get(a.from)! - order.get(b.from)!) || (order.get(a.to)! - order.get(b.to)!) || (a.kind ?? 'primary').localeCompare(b.kind ?? 'primary') || (a.condition ?? '').localeCompare(b.condition ?? '') || (a.via ?? '').localeCompare(b.via ?? ''))
    .map((edge) => ({ ...edge, id: `edge-${stableToken([edge.from, edge.to, edge.kind ?? 'primary', edge.via ?? '', edge.condition ?? ''].join('|'))}` }));
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

function compactLabel(value: string, max = 64): string {
  const oneLine = value.replace(/<br\s*\/?\s*>/gi, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/** Canonical single-page Draw.io export. The app preview uses the responsive
 * SVG canvas; this remains an editable hand-off artifact. */
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
    cells.push(`<mxCell id="sf-screen-${stableToken(screen.key)}" od-screen-key="${xml(screen.key)}" value="${xml(compactLabel(screen.name, 72))}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${40 + column * 220}" y="${40 + row * 130}" width="180" height="72" as="geometry"/></mxCell>`);
  });
  unlinked.forEach((screen, index) => {
    cells.push(`<mxCell id="sf-screen-${stableToken(screen.key)}" od-screen-key="${xml(screen.key)}" value="${xml(compactLabel(screen.name, 72))}" style="rounded=1;whiteSpace=wrap;html=1;dashed=1;" vertex="1" parent="sf-unlinked"><mxGeometry x="30" y="${45 + index * 90}" width="300" height="60" as="geometry"/></mxCell>`);
  });
  model.edges.forEach((edge) => {
    const label = compactLabel([edge.condition, edge.via].filter(Boolean).join(' · '), 48);
    const auxiliary = edge.kind === 'return' || edge.kind === 'secondary';
    cells.push(`<mxCell id="sf-${xml(edge.id)}"${label ? ` value="${xml(label)}"` : ''} style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;${auxiliary ? 'dashed=1;strokeColor=#94a3b8;' : ''}" edge="1" parent="1" source="sf-screen-${stableToken(edge.from)}" target="sf-screen-${stableToken(edge.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
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

export interface ScreenNavigationRecovery {
  screens: ScreenInput[];
  recoveredScreens: string[];
  recoveredEdges: number;
  recoveredNavigation: Array<{ from: string; to: string }>;
  unresolvedScreens: string[];
  warnings: string[];
}

const normalizedWords = (value: string): string => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd')
  .replace(/Đ/g, 'D')
  .toLocaleLowerCase('vi')
  .replace(/<br\s*\/?\s*>/gi, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

function shortScreenCode(key: string): string {
  const marker = key.lastIndexOf('__');
  return marker >= 0 ? key.slice(marker + 2) : key;
}

function navigationAliases(screen: ScreenInput): string[] {
  const baseName = screen.name.split('(')[0]!.trim();
  const names = [screen.name, baseName]
    .map(normalizedWords)
    .flatMap((name) => {
      const withoutCode = name.replace(/^\d+(?:\s+\d+)*\s+/, '');
      return [name, withoutCode, withoutCode.replace(/^man hinh\s+/, '')];
    })
    .filter((name) => name.length >= 5);
  const aliases = new Set(names);
  for (const name of [...aliases]) {
    if (name.includes('voucher')) aliases.add(name.replace(/voucher/g, 'giam gia'));
    if (name.includes('giam gia')) aliases.add(name.replace(/giam gia/g, 'voucher'));
  }
  return [...aliases].sort((a, b) => b.length - a.length);
}

export interface RecoveredBusinessScreenMapping {
  nodeId: string;
  nodeLabel: string;
  screenKey: string;
}

export interface UnmappedBusinessScreenRecovery {
  doc: FlowchartDoc;
  screens: ScreenInput[];
  mappings: RecoveredBusinessScreenMapping[];
  inferredNodeIds: ReadonlySet<string>;
}

const PRESENTATION_WORDS = new Set(['man', 'hinh', 'hien', 'thi', 'giao', 'dien', 'screen']);

function strongLabelTokens(value: string): Set<string> {
  return new Set(normalizedWords(value).split(' ').filter((word) => word.length > 1 && !PRESENTATION_WORDS.has(word)));
}

/** Deterministically attach an unmapped business node to a screen only when
 * its normalized label has one unique, high-overlap match. This is evidence
 * recovery, not order-based guessing: short generic labels and duplicate
 * screen names deliberately remain unresolved. */
export function recoverUnmappedBusinessScreens(doc: FlowchartDoc, inputScreens: ScreenInput[]): UnmappedBusinessScreenRecovery {
  const screens = inputScreens.map((screen) => ({
    ...screen,
    navOut: screen.navOut.map((nav) => ({ ...nav })),
    navIn: [...screen.navIn],
  }));
  const explicitlyMapped = new Set(doc.nodes.map((node) => node.screen).filter((key): key is string => Boolean(key)));
  const eligibleScreens = screens.filter((screen) =>
    !explicitlyMapped.has(screen.key)
    && (!screen.flowId || screen.flowId === doc.id)
    && (!screen.source || !doc.source || screen.source === doc.source),
  );
  const proposals: Array<{ nodeId: string; nodeLabel: string; screen: ScreenInput }> = [];
  for (const node of doc.nodes) {
    if (node.screen || (node.type !== 'action' && node.type !== 'decision')) continue;
    const nodeTokens = strongLabelTokens(node.label);
    if (nodeTokens.size < 3) continue;
    const matches = eligibleScreens.filter((screen) => {
      const screenTokens = strongLabelTokens(screen.name);
      if (screenTokens.size < 3) return false;
      let common = 0;
      for (const token of screenTokens) if (nodeTokens.has(token)) common += 1;
      return common >= 3 && common / Math.min(nodeTokens.size, screenTokens.size) >= 0.8;
    });
    if (matches.length === 1) proposals.push({ nodeId: node.id, nodeLabel: node.label, screen: matches[0]! });
  }
  const proposalsPerScreen = new Map<string, number>();
  for (const proposal of proposals) proposalsPerScreen.set(proposal.screen.key, (proposalsPerScreen.get(proposal.screen.key) ?? 0) + 1);
  const accepted = proposals.filter((proposal) => proposalsPerScreen.get(proposal.screen.key) === 1);
  const byNode = new Map(accepted.map((mapping) => [mapping.nodeId, mapping.screen.key]));
  const inferredNodeIds = new Set(byNode.keys());
  const recoveredKeys = new Set(accepted.map((mapping) => mapping.screen.key));
  for (const screen of screens) {
    if (!recoveredKeys.has(screen.key) || screen.flowId) continue;
    screen.flowId = doc.id;
    screen.flowTitle = doc.title;
  }
  return {
    doc: {
      ...doc,
      nodes: doc.nodes.map((node) => byNode.has(node.id) ? { ...node, screen: byNode.get(node.id)! } : { ...node }),
      edges: doc.edges.map((edge) => ({ ...edge })),
    },
    screens,
    mappings: accepted.map((mapping) => ({ nodeId: mapping.nodeId, nodeLabel: mapping.nodeLabel, screenKey: mapping.screen.key })),
    inferredNodeIds,
  };
}

/** A document line is evidence of navigation only when it contains an
 * explicit transition phrase. Generic table actions such as Click/Readonly,
 * headings that merely reference another section, and "mô tả" must not create
 * screen edges. */
function hasExplicitNavigationCue(rawLine: string): boolean {
  const line = normalizedWords(rawLine);
  return /\b(?:hien thi|mo)\s+(?:man hinh|bottom sheet|popup|modal)\b/.test(line)
    || /\bchuyen(?:\s+tiep)?\s+(?:toi|sang)\b/.test(line)
    || /\bchuyen\s+(?:sang\s+)?tab\b/.test(line)
    || /\bquay lai(?:\s+(?:man hinh|trang))?\b/.test(line)
    || /\bdong\s+(?:bottom sheet|popup|modal)\b/.test(line)
    || /\bdieu huong\s+(?:toi|sang)\b/.test(line)
    || /\bnavigate(?:s|d)?\s+to\b/.test(line);
}

function recoveredNavigationLabel(rawLine: string): string {
  const line = normalizedWords(rawLine);
  if (/\bquay lai\b|\bdong\s+(?:bottom sheet|popup|modal)\b/.test(line)) return 'Quay lại';
  if (/\bchuyen\s+(?:sang\s+)?tab\b/.test(line)) return 'Chuyển tab';
  if (/\b(?:hien thi|mo)\s+bottom sheet\b/.test(line)) return 'Mở bottom sheet';
  if (/\b(?:hien thi|mo)\s+(?:popup|modal)\b/.test(line)) return 'Mở popup';
  if (/\bchuyen(?:\s+tiep)?\s+(?:toi|sang)\b|\bdieu huong\s+(?:toi|sang)\b|\bnavigate(?:s|d)?\s+to\b/.test(line)) return 'Điều hướng';
  return 'Mở màn hình';
}

function sectionRanges(md: string, screens: ScreenInput[]): Map<string, { start: number; end: number }> {
  const lines = md.split(/\r?\n/);
  const starts = screens
    .map((screen) => {
      const code = shortScreenCode(screen.key);
      const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const exact = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*{1,3})?${escaped}\\.?\\s`, 'i');
      const line = lines.findIndex((value) => exact.test(value.replace(/\u00a0/g, ' ')));
      const fallback = screen.section ? Math.max(0, screen.section.startLine - 1) : -1;
      return { key: screen.key, start: line >= 0 ? line : fallback };
    })
    .filter((entry) => entry.start >= 0)
    .sort((a, b) => a.start - b.start);
  const ranges = new Map<string, { start: number; end: number }>();
  starts.forEach((entry, index) => {
    const next = starts[index + 1];
    const nextNumberedHeading = lines.findIndex((value, lineIndex) =>
      lineIndex > entry.start && /^\s*#{1,6}\s+(?:\*{1,3})?\d+(?:\.\d+)*\.?\s/u.test(value.replace(/\u00a0/g, ' ')),
    );
    const candidates = [next?.start ?? lines.length, nextNumberedHeading >= 0 ? nextNumberedHeading : lines.length];
    ranges.set(entry.key, { start: entry.start, end: Math.min(...candidates) });
  });
  return ranges;
}

function addNav(screen: ScreenInput, to: ScreenInput, via: string): boolean {
  if (screen.key === to.key || screen.navOut.some((nav) => nav.to === to.key)) return false;
  screen.navOut.push({ to: to.key, via });
  return true;
}

/**
 * Recover navigation for screens discovered from document-only formats.
 *
 * The flow scanner intentionally only trusts nodes in the source diagram. A
 * document can still declare additional screens (bottom sheets, address
 * pickers, detail screens) and explicit transitions such as "hiển thị màn
 * hình 6.4.2". This pass reads only each screen's bounded source section,
 * resolves exact screen codes/names, then propagates an existing flow id over
 * those evidenced edges. It never joins two different seeded flows.
 */
export async function recoverScreenNavigationFromDocuments(
  cwd: string,
  inputScreens: ScreenInput[],
): Promise<ScreenNavigationRecovery> {
  const screens = inputScreens.map((screen) => ({
    ...screen,
    navOut: screen.navOut.map((nav) => ({ ...nav })),
    navIn: [...screen.navIn],
  }));
  const bySource = new Map<string, ScreenInput[]>();
  for (const screen of screens) {
    if (!screen.source) continue;
    bySource.set(screen.source, [...(bySource.get(screen.source) ?? []), screen]);
  }
  let recoveredEdges = 0;
  const recoveredNavigation: Array<{ from: string; to: string }> = [];
  for (const [source, sourceScreens] of bySource) {
    const md = await fs.readFile(path.join(cwd, source), 'utf8').catch(() => null);
    if (!md) continue;
    const lines = md.split(/\r?\n/);
    const ranges = sectionRanges(md, sourceScreens);
    const targets = sourceScreens.map((screen) => ({
      screen,
      code: shortScreenCode(screen.key),
      aliases: navigationAliases(screen),
    }));
    for (const from of sourceScreens) {
      const range = ranges.get(from.key);
      if (!range) continue;
      for (const rawLine of lines.slice(range.start, range.end)) {
        const line = normalizedWords(rawLine);
        if (!line) continue;
        if (!hasExplicitNavigationCue(rawLine)) continue;
        const matches = targets
          .filter(({ screen }) => screen.key !== from.key)
          // The source flowchart remains authoritative for pairs that are
          // already assigned. Document inference is only a recovery bridge
          // to/from a screen whose flow could not be detected.
          .filter(({ screen }) => !from.flowId || !screen.flowId)
          .map((target) => {
            const codeHit = new RegExp(`(^|[^0-9])${target.code.replace(/\./g, '\\.')}(?=$|[^0-9])`).test(rawLine);
            const alias = target.aliases.find((value) => line.includes(value));
            return { target, score: alias ? 4 + alias.length / 1000 : codeHit ? 3 : 0 };
          })
          .filter((match) => match.score > 0)
          .sort((a, b) => b.score - a.score);
        if (!matches.length) continue;
        // A line can contain a stale numeric cross-reference next to the
        // correct screen name. Prefer the strongest name match, but retain
        // genuinely separate references of equal strength.
        const match = matches[0]!;
        if (addNav(from, match.target.screen, recoveredNavigationLabel(rawLine))) {
          recoveredEdges += 1;
          recoveredNavigation.push({ from: from.key, to: match.target.screen.key });
        }
      }
    }
  }

  const seedTitle = new Map(screens.filter((screen) => screen.flowId).map((screen) => [screen.flowId, screen.flowTitle]));
  const recovered = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const screen of screens.filter((item) => !item.flowId)) {
      const neighborKeys = new Set([
        ...screen.navOut.map((nav) => nav.to),
        ...screens.filter((candidate) => candidate.navOut.some((nav) => nav.to === screen.key)).map((candidate) => candidate.key),
      ]);
      const flowIds = new Set(
        screens.filter((candidate) => neighborKeys.has(candidate.key) && candidate.flowId).map((candidate) => candidate.flowId),
      );
      if (flowIds.size !== 1) continue;
      screen.flowId = [...flowIds][0]!;
      screen.flowTitle = seedTitle.get(screen.flowId) ?? screen.flowId;
      recovered.add(screen.key);
      changed = true;
    }
  }

  for (const screen of screens) screen.navIn = [];
  const byKey = new Map(screens.map((screen) => [screen.key, screen]));
  for (const screen of screens) {
    screen.navOut = screen.navOut.filter((nav) => byKey.has(nav.to));
    for (const nav of screen.navOut) byKey.get(nav.to)!.navIn.push(screen.key);
  }
  for (const screen of screens) screen.navIn = [...new Set(screen.navIn)];
  const unresolvedScreens = screens.filter((screen) => !screen.flowId).map((screen) => screen.key);
  return {
    screens,
    recoveredScreens: [...recovered].sort(),
    recoveredEdges,
    recoveredNavigation,
    unresolvedScreens,
    warnings: unresolvedScreens.length
      ? [`${unresolvedScreens.length} màn chưa có đủ bằng chứng để gắn vào một flow.`]
      : [],
  };
}

export function classifyScreenFlowEdgeKind(via: string, condition?: string, inferred = false): ScreenFlowEdgeKind {
  const label = normalizedWords(via);
  if (/\bquay lai\b|\bdong\s+(?:bottom sheet|popup|modal)\b/.test(label)) return 'return';
  if (/\bchuyen\s+(?:sang\s+)?tab\b|\blich su\b/.test(label)) return 'secondary';
  if (inferred) return 'inferred';
  return condition ? 'branch' : 'primary';
}

function mergeDocumentNavigation(model: ScreenFlowModel, screens: ScreenInput[], recoveredPairs: ReadonlySet<string>): void {
  const keys = new Set(model.screens.map((screen) => screen.key));
  const directions = new Set(model.edges.map((edge) => `${edge.from}\0${edge.to}\0${edge.kind ?? 'primary'}`));
  for (const screen of screens) {
    for (const nav of screen.navOut) {
      if (!keys.has(nav.to) || nav.to === screen.key) continue;
      const pair = `${screen.key}\0${nav.to}`;
      const kind = classifyScreenFlowEdgeKind(nav.via, nav.condition, recoveredPairs.has(pair));
      const direction = `${pair}\0${kind}`;
      if (directions.has(direction)) continue;
      directions.add(direction);
      model.edges.push({
        id: `edge-${stableToken([screen.key, nav.to, kind, nav.via, nav.condition ?? ''].join('|'))}`,
        from: screen.key,
        to: nav.to,
        via: nav.via,
        ...(nav.condition ? { condition: nav.condition } : {}),
        kind,
        flowIds: [model.flowId],
        evidence: [{ flowId: model.flowId, fromNode: `doc:${screen.key}`, toNode: `doc:${nav.to}`, path: [screen.key, nav.to] }],
      });
    }
  }
  const linked = new Set(model.edges.flatMap((edge) => [edge.from, edge.to]));
  for (const screen of model.screens) screen.linked = linked.has(screen.key);
  model.unlinkedScreens = model.screens.filter((screen) => !screen.linked).map((screen) => screen.key);
}

export interface ScreenFlowTopologyValidation {
  valid: boolean;
  errors: string[];
  orphanScreens: string[];
  unreachableScreens: string[];
}

/** Pure semantic validation. Layout and the legacy `linked` display hint do
 * not affect success. Old edges without `kind` are treated as primary. */
export function validateScreenFlowTopology(model: ScreenFlowModel): ScreenFlowTopologyValidation {
  const errors: string[] = [];
  const orderedKeys = model.screens.map((screen) => screen.key);
  const keys = new Set(orderedKeys);
  if (keys.size !== orderedKeys.length) errors.push('Screen key bị trùng trong cùng flow.');
  if (model.flowId === 'UNLINKED') errors.push('Flow UNLINKED không phải topology hợp lệ.');

  const degree = new Map(orderedKeys.map((key) => [key, 0]));
  const traversable = new Map<string, string[]>();
  const signatures = new Set<string>();
  const allowedKinds = new Set<ScreenFlowEdgeKind>(['primary', 'branch', 'return', 'secondary', 'inferred']);
  for (const edge of model.edges) {
    const kind = edge.kind ?? 'primary';
    if (!allowedKinds.has(kind)) {
      errors.push(`Cạnh ${edge.id} có kind không hợp lệ: ${String(kind)}.`);
      continue;
    }
    if (!keys.has(edge.from) || !keys.has(edge.to)) {
      errors.push(`Cạnh ${edge.id} có endpoint không tồn tại.`);
      continue;
    }
    if (edge.from === edge.to) {
      errors.push(`Cạnh ${edge.id} là self-loop.`);
      continue;
    }
    const signature = `${edge.from}\0${edge.to}\0${kind}`;
    if (signatures.has(signature)) {
      errors.push(`Cạnh trùng ${edge.from} → ${edge.to} (${kind}).`);
      continue;
    }
    signatures.add(signature);
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    if (kind === 'primary' || kind === 'branch' || kind === 'inferred') {
      traversable.set(edge.from, [...(traversable.get(edge.from) ?? []), edge.to]);
    }
  }

  const explicitEntries = [...new Set(model.entryScreens)].filter((key) => keys.has(key));
  if (model.entryScreens.some((key) => !keys.has(key))) errors.push('Entry screen không tồn tại trong flow.');
  if (orderedKeys.length > 0 && explicitEntries.length === 0) errors.push('Flow chưa khai entry screen hợp lệ.');
  const singleExplicit = orderedKeys.length === 1 && explicitEntries.includes(orderedKeys[0]!);
  const orphanSet = new Set(
    orderedKeys.filter((key) => !singleExplicit && (degree.get(key) ?? 0) === 0),
  );
  for (const key of model.unlinkedScreens) if (keys.has(key) && !singleExplicit) orphanSet.add(key);

  const reachable = new Set<string>();
  const queue = [...explicitEntries];
  while (queue.length) {
    const key = queue.shift()!;
    if (reachable.has(key)) continue;
    reachable.add(key);
    queue.push(...(traversable.get(key) ?? []));
  }
  const orphanScreens = orderedKeys.filter((key) => orphanSet.has(key));
  const unreachableScreens = orderedKeys.filter((key) => !reachable.has(key));
  if (orphanScreens.length) errors.push(`Có ${orphanScreens.length} screen cô lập: ${orphanScreens.join(', ')}.`);
  if (unreachableScreens.length) errors.push(`Có ${unreachableScreens.length} screen không reachable từ entry: ${unreachableScreens.join(', ')}.`);
  return { valid: errors.length === 0, errors, orphanScreens, unreachableScreens };
}

/** Thin, fail-soft filesystem boundary invoked after dr-comp fan-out. */
export async function buildScreenFlowArtifacts(
  cwd: string,
  allScreens: ScreenInput[],
  options: BuildScreenFlowOptions = {},
): Promise<ScreenFlowsIndex> {
  const recovery = await recoverScreenNavigationFromDocuments(cwd, allScreens);
  allScreens = recovery.screens;
  const recoveredPairs = new Set(recovery.recoveredNavigation.map((edge) => `${edge.from}\0${edge.to}`));
  const outputDir = path.join(cwd, SCREEN_FLOWS_DIR);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  const warnings: string[] = [...recovery.warnings];
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
    const loadedDoc = await readJson<FlowchartDoc>(path.join(cwd, flowchartRel));
    if (!loadedDoc || !Array.isArray(loadedDoc.nodes) || !Array.isArray(loadedDoc.edges)) {
      warnings.push(`${id}: flowchart JSON hỏng hoặc thiếu — màn của flow được đưa vào UNLINKED.`);
      continue;
    }
    const inferred = recoverUnmappedBusinessScreens(loadedDoc, allScreens);
    const doc = inferred.doc;
    allScreens = inferred.screens;
    const flowScreens = allScreens.filter((screen) => screen.flowId === id).sort(byOrder);
    if (!flowScreens.length) continue;
    flowScreens.forEach((screen) => assigned.add(screen.key));
    const model = collapseToScreenFlow(doc, flowScreens, { inferredNodeIds: inferred.inferredNodeIds });
    mergeDocumentNavigation(model, flowScreens, recoveredPairs);
    if (inferred.mappings.length) {
      model.warnings.push(...inferred.mappings.map((mapping) =>
        `Suy luận ${mapping.screenKey} từ business node ${mapping.nodeId} “${mapping.nodeLabel}”.`,
      ));
    }
    const source: ScreenFlowSource = {
      flowId: id,
      kind: flowEntry.kind,
      ...(flowEntry.diagram ? { diagram: flowEntry.diagram } : {}),
      ...(flowEntry.files?.asIs ? { asIs: flowEntry.files.asIs } : {}),
    };
    const classification = classifySourceScreenFlow(doc, new Set(flowScreens.map((screen) => screen.key)));
    const hasDroppedMappings = (flowEntry.screensDropped?.length ?? 0) > 0;
    const reusable = classification.reusable && !topologyChanged && !hasDroppedMappings && inferred.mappings.length === 0;
    model.sourceMode = reusable ? 'reused' : 'generated';
    model.source = source;
    if (reusable && flowEntry.kind === 'drawio') {
      for (const screen of model.screens) {
        screen.cellIds = doc.nodes.filter((node) => node.screen === screen.key).map((node) => node.id);
      }
    }
    if (!reusable) model.warnings.push(...classification.reasons);
    if (hasDroppedMappings) model.warnings.push('Nguồn có mapping màn bị loại — không tái sử dụng nguyên topology.');
    if (inferred.mappings.length) model.warnings.push('Có mapping màn suy luận từ business node — dựng topology canonical.');
    if (topologyChanged && classification.reusable) model.warnings.push('Có override add/remove — dựng lại để không giữ topology đã lệch danh sách màn.');
    const topology = validateScreenFlowTopology(model);
    if (!topology.valid) model.warnings.push(...topology.errors);

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
