import { createHash } from 'node:crypto';
import path from 'node:path';

export const SCREEN_RECOVERY_SCHEMA_VERSION = 1 as const;

export type ScreenProvenance = 'document' | 'flow' | 'inferred-flow';

export interface ScreenDiagramEvidence {
  cellId: string;
  label: string;
}

export interface ScreenEvidence {
  source: string;
  anchorText?: string;
  diagramEvidence?: ScreenDiagramEvidence[];
}

export interface ScreenMetadata {
  provenance: ScreenProvenance;
  confidence?: number;
  evidence?: ScreenEvidence;
}

/** Backwards-compatible superset of the file consumed by finalizeFlowUx. */
export interface RecoveryScreensFile {
  cells?: Record<string, string>;
  names?: Record<string, string>;
  note?: string;
  title?: string;
  source?: string;
  meta?: Record<string, ScreenMetadata>;
  /** screen-variants WP-V3 (docs/screen-variants-spec.md §3.3): khi màn có
   *  biến thể, key trong `cells`/`names` được phép là groupKey; map ở đây
   *  từ groupKey → các screen key thành viên. File cũ không có field này —
   *  mọi key là màn đơn, hành vi không đổi. */
  groups?: Record<string, string[]>;
}

export interface ScreenRecoveryCandidate {
  flowId: string;
  name: string;
  source: string;
  cells: string[];
  confidence?: number;
  reason: string;
  anchorText?: string;
  diagramEvidence?: ScreenDiagramEvidence[];
}

export interface ScreenRecoveryDocument {
  schema_version: 1;
  candidates: ScreenRecoveryCandidate[];
}

export interface ScreenRecoveryParseResult {
  document: ScreenRecoveryDocument | null;
  issues: string[];
}

export interface ScreenRecoveryCell {
  id: string;
  label: string;
  type?: string;
  kind?: string;
}

export interface ScreenRecoveryContext {
  markdownBySource: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  flows:
    | ReadonlyMap<string, { cells: readonly ScreenRecoveryCell[] }>
    | Readonly<Record<string, { cells: readonly ScreenRecoveryCell[] }>>;
}

export interface AcceptedRecoveredScreen extends ScreenRecoveryCandidate {
  key: string;
  provenance: 'inferred-flow';
}

export interface RejectedRecoveredScreen {
  index: number;
  candidate: ScreenRecoveryCandidate;
  reasons: string[];
}

export interface ScreenRecoveryValidationResult {
  accepted: AcceptedRecoveredScreen[];
  rejected: RejectedRecoveredScreen[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanString).filter(Boolean))];
}

function parseDiagramEvidence(value: unknown): ScreenDiagramEvidence[] {
  if (!Array.isArray(value)) return [];
  const out: ScreenDiagramEvidence[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = record(item);
    if (!parsed) continue;
    const cellId = cleanString(parsed.cellId);
    const label = cleanString(parsed.label);
    if (!cellId || !label) continue;
    const identity = `${cellId}\0${label}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({ cellId, label });
  }
  return out;
}

/**
 * Parse the agent-owned `flows/_screen-recovery.json` without trusting it.
 * Unknown fields are ignored and malformed candidates are reported/skipped;
 * a bad root/version is fatal for the document but never throws.
 */
export function parseScreenRecovery(raw: string | unknown): ScreenRecoveryParseResult {
  const issues: string[] = [];
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return { document: null, issues: ['JSON không hợp lệ'] };
    }
  }

  const root = record(value);
  if (!root) return { document: null, issues: ['root phải là object'] };
  if (root.schema_version !== SCREEN_RECOVERY_SCHEMA_VERSION) {
    return { document: null, issues: [`schema_version phải là ${SCREEN_RECOVERY_SCHEMA_VERSION}`] };
  }
  if (!Array.isArray(root.candidates)) return { document: null, issues: ['candidates phải là array'] };

  const candidates: ScreenRecoveryCandidate[] = [];
  root.candidates.forEach((item, index) => {
    const input = record(item);
    if (!input) {
      issues.push(`candidates[${index}]: phải là object`);
      return;
    }
    const flowId = cleanString(input.flowId);
    const name = cleanString(input.name);
    const source = cleanString(input.source);
    const reason = cleanString(input.reason);
    if (!flowId || !name || !source || !reason) {
      issues.push(`candidates[${index}]: thiếu flowId/name/source/reason`);
      return;
    }
    const candidate: ScreenRecoveryCandidate = {
      flowId,
      name,
      source,
      reason,
      cells: uniqueStrings(input.cells),
    };
    const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? Math.min(1, Math.max(0, input.confidence))
      : undefined;
    if (confidence !== undefined) candidate.confidence = confidence;
    const anchorText = cleanString(input.anchorText);
    if (anchorText) candidate.anchorText = anchorText;
    const diagramEvidence = parseDiagramEvidence(input.diagramEvidence);
    if (diagramEvidence.length) candidate.diagramEvidence = diagramEvidence;
    candidates.push(candidate);
  });

  return { document: { schema_version: SCREEN_RECOVERY_SCHEMA_VERSION, candidates }, issues };
}

function mapGet<T>(collection: ReadonlyMap<string, T> | Readonly<Record<string, T>>, key: string): T | undefined {
  if (collection instanceof Map) return (collection as ReadonlyMap<string, T>).get(key);
  return (collection as Readonly<Record<string, T>>)[key];
}

/** Return source lines outside fenced code blocks, preserving exact line text. */
function markdownEvidenceLines(markdown: string): string[] {
  const lines: string[] = [];
  let fence: { marker: '`' | '~'; width: number } | null = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) {
      const token = match[1]!;
      const marker = token[0] as '`' | '~';
      if (!fence) fence = { marker, width: token.length };
      else if (marker === fence.marker && token.length >= fence.width) fence = null;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines;
}

function exactAnchorCount(markdown: string, anchorText: string): number {
  const wanted = anchorText.trim();
  return markdownEvidenceLines(markdown).filter((line) => line.trim() === wanted).length;
}

const BACKEND_TERMS = /\b(?:backend|server|api|database|db|billing|sdk|ncc|service|worker|cron|queue|webhook)\b|gạch nợ|đối soát/i;
// Bug #6d40d52e: thiếu "nhấn" (đồng nghĩa "bấm", rất phổ biến trong URD) và
// "MH" (viết tắt màn hình, xuất hiện ở mọi dòng "**MH n: ...**") khiến
// candidate hợp lệ như label `Nhấn "Thêm vào Ví Apple"` + anchor
// `**MH 6: Chi tiết thẻ**` bị từ chối "không có bằng chứng UI".
const UI_TERMS = /\b(?:screen|page|form|dialog|modal|button|tab|app|web|ui|mh|click|tap)\b|màn(?: hình)?|trang|khách hàng|người dùng|bấm|nhấn|chạm|chọn|nhập|xác nhận|hiển thị/i;

function isUiCell(cell: ScreenRecoveryCell): boolean {
  const type = (cell.type ?? cell.kind ?? '').toLowerCase();
  // KHÔNG loại thẳng kind 'edge' (bug #ba03366c): sơ đồ kiểu sequence đặt
  // thao tác UI TRÊN mũi tên ("Chọn icon Apple Pay ở MH trang chủ") — cell
  // duy nhất mang bằng chứng UI chính là cạnh, và SKILL.md docs-flow-ux đã
  // dặn agent trỏ cells vào id cạnh cho sơ đồ dạng này. Cạnh được xét label
  // như node thường; label backend thuần vẫn bị loại ở dòng dưới.
  if (type === 'start' || type === 'end') return false;
  if (BACKEND_TERMS.test(cell.label) && !UI_TERMS.test(cell.label)) return false;
  return UI_TERMS.test(cell.label);
}

function anchorLooksLikeUi(anchor: string): boolean {
  return UI_TERMS.test(anchor) && !(BACKEND_TERMS.test(anchor) && !UI_TERMS.test(anchor.replace(BACKEND_TERMS, '')));
}

function sourceStem(source: string): string {
  const base = path.posix.basename(source.replace(/\\/g, '/'));
  return base.replace(/\.md$/i, '') || 'document';
}

/** Extract explicit document screen codes without inventing one from prose. */
function screenCode(anchorText?: string): string | null {
  if (!anchorText) return null;
  const scr = /\b(SCR[-_. ]?[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)\b/i.exec(anchorText);
  if (scr?.[1]) return scr[1].replace(/[ _]/g, '-');
  const heading = /^#{1,6}\s+(\d+(?:\.\d+)+)\b/.exec(anchorText.trim());
  return heading?.[1] ?? null;
}

function autoKey(candidate: ScreenRecoveryCandidate): string {
  const primaryEvidence = candidate.anchorText ?? [...candidate.cells].sort()[0] ?? '';
  const digest = createHash('sha256')
    .update(`${candidate.source}\0${candidate.flowId}\0${primaryEvidence}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `AUTO-${digest}`;
}

export function recoveredScreenKey(candidate: ScreenRecoveryCandidate): string {
  return `${sourceStem(candidate.source)}__${screenCode(candidate.anchorText) ?? autoKey(candidate)}`;
}

function uniqueDiagramEvidence(values: readonly ScreenDiagramEvidence[]): ScreenDiagramEvidence[] {
  const byIdentity = new Map<string, ScreenDiagramEvidence>();
  for (const value of values) byIdentity.set(`${value.cellId}\0${value.label}`, value);
  return [...byIdentity.values()].sort((a, b) => a.cellId.localeCompare(b.cellId) || a.label.localeCompare(b.label));
}

/** Validate every candidate solely against caller-provided source/as-is data. */
export function validateScreenRecovery(
  document: ScreenRecoveryDocument,
  context: ScreenRecoveryContext,
): ScreenRecoveryValidationResult {
  // One canonical screen key may legitimately appear in multiple flows. Keep
  // those mappings separate so the server can write each flow's cells while
  // still reusing the same document-derived screen identity.
  const acceptedByFlowAndKey = new Map<string, AcceptedRecoveredScreen>();
  const rejected: RejectedRecoveredScreen[] = [];

  document.candidates.forEach((candidate, index) => {
    const reasons: string[] = [];
    const markdown = mapGet(context.markdownBySource, candidate.source);
    const flow = mapGet(context.flows, candidate.flowId);
    if (markdown === undefined) reasons.push(`source không tồn tại: ${candidate.source}`);
    if (!flow) reasons.push(`flow không tồn tại: ${candidate.flowId}`);

    const cellsById = new Map((flow?.cells ?? []).map((cell) => [cell.id, cell]));
    if (candidate.cells.length === 0) reasons.push('cells phải có ít nhất một cell as-is');
    for (const cellId of candidate.cells) {
      if (/^(?:od-|OD_)/.test(cellId)) reasons.push(`cell chỉ tồn tại ở bản đề xuất: ${cellId}`);
      if (!cellsById.has(cellId)) reasons.push(`cell không tồn tại trong as-is: ${cellId}`);
    }

    let validAnchor = false;
    if (candidate.anchorText) {
      if (/\r|\n/.test(candidate.anchorText)) reasons.push('anchorText phải là đúng một dòng duy nhất ngoài code fence trong source');
      else if (markdown !== undefined) {
        const count = exactAnchorCount(markdown, candidate.anchorText);
        if (count !== 1) {
          reasons.push(
            count === 0
              ? 'anchor không xuất hiện ngoài code fence trong source'
              : 'anchorText phải là đúng một dòng duy nhất ngoài code fence trong source',
          );
        } else validAnchor = true;
      }
    }

    const verifiedDiagram: ScreenDiagramEvidence[] = [];
    for (const evidence of candidate.diagramEvidence ?? []) {
      const cell = cellsById.get(evidence.cellId);
      if (!cell) {
        reasons.push(`diagramEvidence cell không tồn tại trong as-is: ${evidence.cellId}`);
        continue;
      }
      if (!candidate.cells.includes(evidence.cellId)) {
        reasons.push(`diagramEvidence cell không có trong cells: ${evidence.cellId}`);
        continue;
      }
      if (cell.label !== evidence.label) {
        reasons.push(`diagramEvidence label không khớp cell ${evidence.cellId}`);
        continue;
      }
      verifiedDiagram.push(evidence);
    }

    if (!validAnchor && verifiedDiagram.length === 0) reasons.push('candidate không có evidence kiểm chứng được');
    const uiFromAnchor = validAnchor && candidate.anchorText !== undefined && anchorLooksLikeUi(candidate.anchorText);
    const uiFromDiagram = verifiedDiagram.some((evidence) => {
      const cell = cellsById.get(evidence.cellId);
      return cell !== undefined && isUiCell(cell);
    });
    if (!uiFromAnchor && !uiFromDiagram && (validAnchor || verifiedDiagram.length > 0)) {
      reasons.push('candidate chỉ mô tả start/end/backend, không có bằng chứng UI');
    }

    if (reasons.length) {
      rejected.push({ index, candidate, reasons: [...new Set(reasons)] });
      return;
    }

    const key = recoveredScreenKey(candidate);
    const flowAndKey = `${candidate.flowId}\0${key}`;
    const accepted: AcceptedRecoveredScreen = {
      ...candidate,
      cells: [...candidate.cells].sort(),
      key,
      provenance: 'inferred-flow',
    };
    if (verifiedDiagram.length) accepted.diagramEvidence = uniqueDiagramEvidence(verifiedDiagram);
    else delete accepted.diagramEvidence;
    const previous = acceptedByFlowAndKey.get(flowAndKey);
    if (!previous) {
      acceptedByFlowAndKey.set(flowAndKey, accepted);
      return;
    }
    previous.cells = [...new Set([...previous.cells, ...accepted.cells])].sort();
    previous.diagramEvidence = uniqueDiagramEvidence([...(previous.diagramEvidence ?? []), ...(accepted.diagramEvidence ?? [])]);
    if (previous.diagramEvidence.length === 0) delete previous.diagramEvidence;
    if (accepted.confidence !== undefined && accepted.confidence > (previous.confidence ?? -1)) {
      previous.confidence = accepted.confidence;
    }
  });

  return {
    accepted: [...acceptedByFlowAndKey.values()].sort(
      (a, b) => a.key.localeCompare(b.key) || a.flowId.localeCompare(b.flowId),
    ),
    rejected,
  };
}

/** Merge validated inferred mappings while preserving every explicit mapping. */
export function canonicalizeRecoveredScreens(
  existing: RecoveryScreensFile | null | undefined,
  accepted: readonly AcceptedRecoveredScreen[],
): RecoveryScreensFile {
  const base = existing ?? {};
  const cells = { ...(base.cells ?? {}) };
  const names = { ...(base.names ?? {}) };
  const meta = { ...(base.meta ?? {}) };
  const explicitKeys = new Set([...Object.values(base.cells ?? {}), ...Object.keys(base.names ?? {})]);

  const ordered = [...accepted].sort(
    (a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) || a.key.localeCompare(b.key),
  );
  for (const recovered of ordered) {
    let used = false;
    for (const cellId of recovered.cells) {
      if (cells[cellId] !== undefined) continue;
      cells[cellId] = recovered.key;
      used = true;
    }
    if (!used && !Object.values(cells).includes(recovered.key)) continue;
    if (names[recovered.key] === undefined) names[recovered.key] = recovered.name;
    if (explicitKeys.has(recovered.key) || meta[recovered.key] !== undefined) continue;

    const evidence: ScreenEvidence = { source: recovered.source };
    if (recovered.anchorText) evidence.anchorText = recovered.anchorText;
    if (recovered.diagramEvidence?.length) evidence.diagramEvidence = [...recovered.diagramEvidence];
    meta[recovered.key] = {
      provenance: 'inferred-flow',
      ...(recovered.confidence !== undefined ? { confidence: recovered.confidence } : {}),
      evidence,
    };
  }

  return {
    ...base,
    cells,
    names,
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}
