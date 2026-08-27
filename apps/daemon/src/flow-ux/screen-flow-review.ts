// WP dr-review-screen-flow (2026-08-27) — "Luồng màn hình bản ĐÃ CHỌN" là
// thước đo đối chiếu tài liệu của bước dr-review (skill docs-spec-review).
//
// Trước WP này fan-out dr-review không đọc gì từ dr-flow/dr-flow-improve:
// nhánh thay sơ đồ tìm stem `as-is` trong trang (không có) → im lặng; mọi
// thứ về màn lấy từ `comp/index.json` (dr-comp nay ẩn) → tắt hết. Module này
// nạp MỘT ngữ cảnh gọn từ `flows/SCREEN-FLOW/` theo `selection.json`
// (vắng = original) để:
//   (1) daemon tất định: màn trong luồng ↔ mục tài liệu → note `gap`
//       (`screenFlowGapNotes` bên dưới);
//   (2)(3)(4) agent: cạnh ↔ câu điều hướng, kết cục/nhánh lỗi ↔ hành vi,
//       finding UX-xx ↔ chữ — kickoff (`buildEnrichKickoff.screenFlow`) trích
//       màn/cạnh/kết cục THUỘC section.
// Ngữ cảnh được ghi ra `review/_screen-flow-context.json` làm bằng chứng
// (web cũng đọc được) mỗi lần fan-out chạy.
//
// Hợp đồng `rule_id` có mảnh `#` (web tô cell): phần trước `#` = file thật
// trong workflow, phần sau = id trong file — `flows/SCREEN-FLOW/screens.json#<KEY>`,
// `flows/SCREEN-FLOW.flowchart.json#<from>→<to>`, `flows/SCREEN-FLOW/ux-review.json#UX-xx`.
import fs from 'node:fs';
import path from 'node:path';

import type { DocNote, DocSection } from '../docs-review.js';
import { mapScreensToSections } from '../docs-review-enrich.js';
import type { FlowchartDoc } from './to-flowchart.js';
import type { UxFinding, UxReview } from './index.js';
import { decodeMxfile, listCells, styleGet } from './mxfile.js';
import { parseScreenFlowScreensV2 } from './screen-flow-screens.js';
import {
  SCREEN_FLOW_ID,
  readScreenFlowSelection,
  readScreensImproved,
  screenFlowDir,
  type ScreenFlowSelectionSource,
  type ScreenFlowVariant,
} from './screen-flow-xml.js';

export const SCREEN_FLOW_SCREENS_REF = `flows/${SCREEN_FLOW_ID}/screens.json`;
export const SCREEN_FLOW_FLOWCHART_REF = `flows/${SCREEN_FLOW_ID}.flowchart.json`;
export const SCREEN_FLOW_UX_REVIEW_REF = `flows/${SCREEN_FLOW_ID}/ux-review.json`;
export const SCREEN_FLOW_AS_IS_REF = `flows/${SCREEN_FLOW_ID}/as-is.drawio`;
export const SCREEN_FLOW_PROPOSED_REF = `flows/${SCREEN_FLOW_ID}/proposed.drawio`;
/** Đường dẫn (tương đối cwd) file ngữ cảnh ghi ra cho web/bằng chứng. */
export const SCREEN_FLOW_CONTEXT_REL = 'review/_screen-flow-context.json';

/** `edgeKey` dùng trong rule_id `flows/SCREEN-FLOW.flowchart.json#<edgeKey>` —
 *  mũi tên unicode `→` vì `flowchart.json.edges[]` không có id. */
export function screenFlowEdgeKey(from: string, to: string): string {
  return `${from}→${to}`;
}

export interface ScreenFlowReviewScreen {
  key: string;
  code: string | null;
  name: string;
  anchorText: string;
  cell: string | null;
  why?: string;
  /** Trang nguồn (đã resolve: entry riêng, hoặc source cấp file). */
  source: string;
  /** Chỉ màn có ở `screens.improved.json` do bản cải thiện đề xuất. */
  provenance?: 'proposed';
  removedByProposal?: boolean;
}

export interface ScreenFlowReviewEdge {
  key: string;
  from: string;
  to: string;
  label?: string;
  fromName?: string;
  toName?: string;
}

export interface ScreenFlowReviewOutcome {
  cell: string;
  label: string;
  kind: 'success' | 'error' | 'end';
}

export interface ScreenFlowReviewContext {
  variant: ScreenFlowVariant;
  selectionSource: ScreenFlowSelectionSource | 'default';
  /** original → as-is trang 0; improved → proposed trang 1. */
  diagram: { file: typeof SCREEN_FLOW_AS_IS_REF | typeof SCREEN_FLOW_PROPOSED_REF; page: number };
  /** Trang tài liệu của luồng (source cấp file của screens.json). */
  source: string;
  screens: ScreenFlowReviewScreen[];
  /** Từ `flows/SCREEN-FLOW.flowchart.json` (đã dựng theo selection, xem flow-ux/index.ts). */
  edges: ScreenFlowReviewEdge[];
  /** Node kết cục theo legend skill docs-screen-flow (fill #d5e8d4 / #f8cecc) — best-effort. */
  outcomes: ScreenFlowReviewOutcome[];
  /** improved: findings của ux-review.json; original: []. */
  findings: UxFinding[];
}

async function readText(p: string): Promise<string | null> {
  return fs.promises.readFile(p, 'utf8').catch(() => null);
}
async function readJson<T>(p: string): Promise<T | null> {
  const raw = await readText(p);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const OK_FILL = '#d5e8d4';
const ERR_FILL = '#f8cecc';
const ELLIPSE_STYLE = /(^|;)(ellipse|shape=ellipse)(;|$)/;

/** Phân loại node kết cục trên MỘT trang draw.io theo bảng style của skill
 *  docs-screen-flow: fill lỗi → `error`; fill OK không phải ellipse → `success`;
 *  ellipse fill OK không có cạnh ra → `end` (ellipse có cạnh ra là "Bắt đầu",
 *  không phải kết cục). Legend (`od-legend-*`) bỏ. Best-effort: style lạ →
 *  không có kết cục, không lỗi. */
export function classifyOutcomes(graphXml: string): ScreenFlowReviewOutcome[] {
  let cells;
  try {
    cells = listCells(graphXml);
  } catch {
    return [];
  }
  const outdeg = new Map<string, number>();
  for (const c of cells) {
    if (c.kind !== 'edge' || !c.source) continue;
    outdeg.set(c.source, (outdeg.get(c.source) ?? 0) + 1);
  }
  const out: ScreenFlowReviewOutcome[] = [];
  for (const c of cells) {
    if (c.kind !== 'vertex' || c.id.startsWith('od-legend-')) continue;
    const fill = (styleGet(c.style, 'fillColor') ?? '').toLowerCase();
    if (fill === ERR_FILL) out.push({ cell: c.id, label: c.label, kind: 'error' });
    else if (fill === OK_FILL) {
      if (!ELLIPSE_STYLE.test(c.style)) out.push({ cell: c.id, label: c.label, kind: 'success' });
      else if ((outdeg.get(c.id) ?? 0) === 0) out.push({ cell: c.id, label: c.label, kind: 'end' });
    }
  }
  return out;
}

/** Nạp ngữ cảnh Luồng màn hình bản đã chọn. `null` khi dự án chưa có
 *  `flows/SCREEN-FLOW/as-is.drawio` (chưa chạy dr-flow) — caller coi như
 *  không có thước đo luồng, hành vi y hệt trước WP. Chọn `improved` CHỈ khi
 *  selection.json nói vậy VÀ proposed.drawio có trang 1 (cùng luật với
 *  finalizeFlowUx); ngược lại lùi về original. */
export async function loadScreenFlowReviewContext(cwd: string): Promise<ScreenFlowReviewContext | null> {
  const dir = screenFlowDir(cwd);
  const asIsXml = await readText(path.join(dir, 'as-is.drawio'));
  if (asIsXml == null) return null;

  const selection = await readScreenFlowSelection(cwd);
  let proposedGraphXml: string | null = null;
  if (selection?.variant === 'improved') {
    const proposedRaw = await readText(path.join(dir, 'proposed.drawio'));
    try {
      proposedGraphXml = proposedRaw != null ? (decodeMxfile(proposedRaw)[1]?.graphXml ?? null) : null;
    } catch {
      proposedGraphXml = null;
    }
  }
  const variant: ScreenFlowVariant = proposedGraphXml != null ? 'improved' : 'original';

  // Màn theo screens.json v2 (v1 cũ: dẫn từ cells/names, anchorText rỗng).
  const screensRaw = await readJson<Record<string, unknown>>(path.join(dir, 'screens.json'));
  const fileSource = typeof screensRaw?.source === 'string' ? screensRaw.source.trim() : '';
  const screens: ScreenFlowReviewScreen[] = [];
  const parsed = screensRaw ? parseScreenFlowScreensV2(screensRaw) : null;
  if (parsed && 'doc' in parsed) {
    for (const s of parsed.doc.screens) {
      screens.push({
        key: s.key,
        code: s.code,
        name: s.name,
        anchorText: s.anchorText,
        cell: s.cell,
        ...(s.why ? { why: s.why } : {}),
        source: s.source ?? fileSource,
      });
    }
  } else if (parsed && 'v1' in parsed) {
    const cells = (screensRaw?.cells ?? {}) as Record<string, string>;
    const names = (screensRaw?.names ?? {}) as Record<string, string>;
    const cellOf = new Map<string, string>();
    for (const [cell, key] of Object.entries(cells)) if (typeof key === 'string' && !cellOf.has(key)) cellOf.set(key, cell);
    for (const [key, name] of Object.entries(names)) {
      if (typeof name !== 'string') continue;
      screens.push({ key, code: null, name, anchorText: '', cell: cellOf.get(key) ?? null, source: fileSource });
    }
  }

  // Bản cải thiện: màn đề xuất mới + cờ removedByProposal cho màn có sẵn.
  let findings: UxFinding[] = [];
  if (variant === 'improved') {
    const improved = await readScreensImproved(cwd);
    const byKey = new Map(screens.map((s) => [s.key, s] as const));
    for (const s of improved?.screens ?? []) {
      const existing = byKey.get(s.key);
      if (existing) {
        if (s.removedByProposal) existing.removedByProposal = true;
        continue;
      }
      if (s.provenance !== 'proposed') continue;
      const entry: ScreenFlowReviewScreen = {
        key: s.key,
        code: null,
        name: s.name,
        anchorText: s.anchorText ?? '',
        cell: s.cell,
        ...(s.why ? { why: s.why } : {}),
        source: s.source ?? fileSource,
        provenance: 'proposed',
      };
      screens.push(entry);
      byKey.set(s.key, entry);
    }
    const review = await readJson<UxReview>(path.join(dir, 'ux-review.json'));
    findings = Array.isArray(review?.findings) ? review!.findings : [];
  }

  // Cạnh từ flowchart.json (đã theo selection). Tên đầu/cuối = tên màn nếu
  // node mang screen, không thì nhãn node.
  const flowchart = await readJson<FlowchartDoc>(path.join(cwd, 'flows', `${SCREEN_FLOW_ID}.flowchart.json`));
  const nameByKey = new Map(screens.map((s) => [s.key, s.name] as const));
  const nodeName = new Map<string, string>();
  for (const n of flowchart?.nodes ?? []) nodeName.set(n.id, (n.screen && nameByKey.get(n.screen)) || n.label);
  const edges: ScreenFlowReviewEdge[] = (flowchart?.edges ?? []).map((e) => ({
    key: screenFlowEdgeKey(e.from, e.to),
    from: e.from,
    to: e.to,
    ...(e.label ? { label: e.label } : {}),
    ...(nodeName.get(e.from) ? { fromName: nodeName.get(e.from)! } : {}),
    ...(nodeName.get(e.to) ? { toName: nodeName.get(e.to)! } : {}),
  }));

  let graphForOutcomes: string | null = proposedGraphXml;
  if (graphForOutcomes == null) {
    try {
      graphForOutcomes = decodeMxfile(asIsXml)[0]?.graphXml ?? null;
    } catch {
      graphForOutcomes = null;
    }
  }
  const outcomes = graphForOutcomes ? classifyOutcomes(graphForOutcomes) : [];

  return {
    variant,
    selectionSource: selection?.source ?? 'default',
    diagram: variant === 'improved' ? { file: SCREEN_FLOW_PROPOSED_REF, page: 1 } : { file: SCREEN_FLOW_AS_IS_REF, page: 0 },
    source: fileSource,
    screens,
    edges,
    outcomes,
    findings,
  };
}

/** Ghi `review/_screen-flow-context.json` (bằng chứng + web đọc). Fail-soft. */
export async function writeScreenFlowReviewContext(cwd: string, ctx: ScreenFlowReviewContext): Promise<void> {
  const abs = path.join(cwd, SCREEN_FLOW_CONTEXT_REL);
  try {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...ctx }, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn('[docs-review] không ghi được _screen-flow-context.json:', error);
  }
}

export function variantLabel(variant: ScreenFlowVariant): string {
  return variant === 'improved' ? 'Cải thiện' : 'Nguyên bản';
}

const normSrc = (p: string | null | undefined): string => (p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

export interface ScreenFlowPageMapping {
  /** Màn của luồng thuộc trang này (theo `source`), trừ màn bị đề xuất bỏ. */
  pageScreens: ScreenFlowReviewScreen[];
  /** sectionIndex → màn đã định vị được mục trong section đó. */
  placedBySection: Map<number, ScreenFlowReviewScreen[]>;
  /** Màn không định vị được mục (kể cả mọi màn `provenance: proposed`). */
  unplaced: ScreenFlowReviewScreen[];
  /** sectionIndex → cạnh có một đầu là cell của màn thuộc section. */
  edgesBySection: Map<number, ScreenFlowReviewEdge[]>;
  /** sectionIndex → kết cục nối với cạnh của section. */
  outcomesBySection: Map<number, ScreenFlowReviewOutcome[]>;
  /** Phép đối chiếu (1): note gap tất định cho từng màn `unplaced`. */
  gapNotes: DocNote[];
}

/** Phép đối chiếu (1) — màn trong luồng ↔ mục tài liệu — cho MỘT trang, thuần
 *  (không đọc đĩa) để test được. `pageLines`/`original` là bản trang TRƯỚC
 *  enrich (cùng thứ `mapScreensToSections` cần). Màn `provenance: proposed`
 *  (chỉ có ở bản cải thiện) LUÔN là gap: tài liệu chưa mô tả màn do bản cải
 *  thiện đề xuất. Màn bị đề xuất bỏ (`removedByProposal`) không tính — tài
 *  liệu không mô tả một màn sắp bỏ thì không phải khoảng trống. */
export function mapScreenFlowToPage(
  ctx: ScreenFlowReviewContext,
  input: {
    pageSrc: string;
    sections: ReadonlyArray<Pick<DocSection, 'index' | 'heading' | 'startLine' | 'endLine'>>;
    pageLines: string[];
    original: string;
  },
): ScreenFlowPageMapping {
  const thisPage = normSrc(input.pageSrc);
  const pageScreens = ctx.screens.filter((s) => !s.removedByProposal && normSrc(s.source) === thisPage);
  const byKey = new Map(pageScreens.map((s) => [s.key, s] as const));
  const documentKeys = pageScreens.filter((s) => s.provenance !== 'proposed').map((s) => s.key);
  const { placed, unplaced } = mapScreensToSections(input.sections, input.pageLines, documentKeys);

  const placedBySection = new Map<number, ScreenFlowReviewScreen[]>();
  for (const [sectionIndex, entries] of placed) {
    const list = entries.map((e) => byKey.get(e.key)).filter((s): s is ScreenFlowReviewScreen => !!s);
    if (list.length) placedBySection.set(sectionIndex, list);
  }
  const unplacedScreens: ScreenFlowReviewScreen[] = [
    ...unplaced.map((k) => byKey.get(k)).filter((s): s is ScreenFlowReviewScreen => !!s),
    ...pageScreens.filter((s) => s.provenance === 'proposed'),
  ];

  const edgesBySection = new Map<number, ScreenFlowReviewEdge[]>();
  const outcomesBySection = new Map<number, ScreenFlowReviewOutcome[]>();
  const outcomeByCell = new Map(ctx.outcomes.map((o) => [o.cell, o] as const));
  for (const [sectionIndex, list] of placedBySection) {
    const cells = new Set(list.map((s) => s.cell).filter((c): c is string => !!c));
    if (!cells.size) continue;
    const edges = ctx.edges.filter((e) => cells.has(e.from) || cells.has(e.to));
    if (edges.length) edgesBySection.set(sectionIndex, edges);
    const outcomes: ScreenFlowReviewOutcome[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
      for (const end of [e.from, e.to]) {
        const o = outcomeByCell.get(end);
        if (o && !seen.has(o.cell)) {
          seen.add(o.cell);
          outcomes.push(o);
        }
      }
    }
    if (outcomes.length) outcomesBySection.set(sectionIndex, outcomes);
  }

  const label = variantLabel(ctx.variant).toLowerCase();
  const gapNotes: DocNote[] = unplacedScreens.map((s) => {
    const anchor = s.anchorText && input.original.includes(s.anchorText) ? s.anchorText : '';
    const uxIds = s.provenance === 'proposed' ? ctx.findings.filter((f) => f.cells?.proposed?.includes(s.cell ?? '')).map((f) => f.id) : [];
    const finding =
      s.provenance === 'proposed'
        ? `Luồng màn hình (bản ${label}) có màn «${s.name}» do bản cải thiện đề xuất${uxIds.length ? ` (${uxIds.join(', ')})` : ''} nhưng tài liệu chưa có mục mô tả.`
        : `Luồng màn hình (bản ${label}) có màn «${s.name}» nhưng tài liệu chưa có mục mô tả.`;
    return {
      id: `sys-screen-flow-${s.key}`,
      kind: 'gap' as const,
      severity: 'major' as const,
      rule_id: `${SCREEN_FLOW_SCREENS_REF}#${s.key}`,
      anchor,
      finding,
      suggestion: `Bổ sung mục mô tả tường minh cho màn “${s.name}”: mục đích, trạng thái, nội dung, hành vi và điều hướng.`,
      ...(!anchor ? { anchor_unresolved: true as const } : {}),
    };
  });

  return { pageScreens, placedBySection, unplaced: unplacedScreens, edgesBySection, outcomesBySection, gapNotes };
}
