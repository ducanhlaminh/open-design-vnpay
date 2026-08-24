/**
 * Chỉ mục vị trí annotation trong tài liệu Markdown.
 *
 * Sidecar mới có heading ordinal do daemon đóng dấu. Sidecar cũ không có
 * provenance, nên phải suy từ `quote`/`anchor` còn tồn tại trong bản đã sửa.
 * Cùng một chỉ mục được dùng cho cả thứ tự rail lẫn scope highlight để số thứ
 * tự, Trước/Sau và vị trí bôi không thể lệch nhau.
 */

export interface RedlineDocumentAnnotation {
  quote?: string;
  anchor?: string;
  before?: string;
  sectionIndex?: number;
  sectionHeading?: string;
  sectionStartHeadingOrdinal?: number;
  sectionEndHeadingOrdinalExclusive?: number;
}

export interface RedlineDocumentScope {
  sectionIndex?: number;
  sectionHeading?: string;
  sectionStartHeadingOrdinal?: number;
  sectionEndHeadingOrdinalExclusive?: number;
}

interface MarkdownHeading {
  ordinal: number;
  level: number;
  start: number;
  line: string;
}

interface SourceRange {
  start: number;
  end: number;
}

export interface RedlineDocumentIndex {
  scopeFor(annotation: RedlineDocumentAnnotation): RedlineDocumentScope | undefined;
  positionOf(annotation: RedlineDocumentAnnotation): number;
  sort<T extends RedlineDocumentAnnotation>(annotations: readonly T[]): T[];
}

function markdownHeadings(source: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let offset = 0;
  let fence: '```' | '~~~' | null = null;

  for (const line of lines) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line)?.[1] as '```' | '~~~' | undefined;
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch;
      else if (fence === fenceMatch) fence = null;
    } else if (fence === null) {
      const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (heading) {
        headings.push({
          ordinal: headings.length,
          level: heading[1]!.length,
          start: offset,
          line,
        });
      }
    }
    offset += line.length + 1;
  }
  return headings;
}

function explicitScope(annotation: RedlineDocumentAnnotation): RedlineDocumentScope | undefined {
  if (
    annotation.sectionIndex == null
    && annotation.sectionHeading == null
    && annotation.sectionStartHeadingOrdinal == null
    && annotation.sectionEndHeadingOrdinalExclusive == null
  ) return undefined;
  return {
    sectionIndex: annotation.sectionIndex,
    sectionHeading: annotation.sectionHeading,
    sectionStartHeadingOrdinal: annotation.sectionStartHeadingOrdinal,
    sectionEndHeadingOrdinalExclusive: annotation.sectionEndHeadingOrdinalExclusive,
  };
}

function primarySourceText(annotation: RedlineDocumentAnnotation): string | null {
  // `before` của edit/delete không còn trong bản đã sửa. `quote` hoặc `anchor`
  // mới là nguồn xác định được vị trí hiện tại.
  const value = annotation.quote?.trim() || annotation.anchor?.trim();
  return value || null;
}

function ordinalRange(
  source: string,
  headings: readonly MarkdownHeading[],
  annotation: RedlineDocumentAnnotation,
): SourceRange | null {
  const hasRange = annotation.sectionStartHeadingOrdinal != null
    || annotation.sectionEndHeadingOrdinalExclusive != null;
  if (!hasRange) return null;
  const startOrdinal = annotation.sectionStartHeadingOrdinal;
  const endOrdinal = annotation.sectionEndHeadingOrdinalExclusive;
  if (startOrdinal != null && !headings[startOrdinal]) return null;
  if (endOrdinal != null && (endOrdinal < 0 || endOrdinal > headings.length)) return null;
  const start = startOrdinal == null ? 0 : headings[startOrdinal]!.start;
  const end = endOrdinal == null ? source.length : headings[endOrdinal]?.start ?? source.length;
  return start <= end ? { start, end } : null;
}

function allOccurrences(source: string, needle: string, range?: SourceRange): number[] {
  const out: number[] = [];
  const start = range?.start ?? 0;
  const end = range?.end ?? source.length;
  let cursor = start;
  while (cursor <= end - needle.length) {
    const found = source.indexOf(needle, cursor);
    if (found < 0 || found + needle.length > end) break;
    out.push(found);
    cursor = found + Math.max(needle.length, 1);
  }
  return out;
}

function legacyPosition(source: string, headings: readonly MarkdownHeading[], needle: string): number | null {
  const positions = allOccurrences(source, needle);
  if (positions.length === 0) return null;
  if (positions.length === 1 || headings.length === 0) return positions[0]!;

  // Confluence thường xuất một "Mục lục" chữ thường trước heading đầu tiên.
  // Khi cùng anchor còn xuất hiện trong thân tài liệu, ưu tiên thân tài liệu;
  // đây chính là ca "Phân quyền theo tính năng" từng bị bôi ở mục lục.
  const bodyStart = headings[0]!.start;
  return positions.find((position) => position >= bodyStart) ?? positions[0]!;
}

function enclosingHeadingScope(
  headings: readonly MarkdownHeading[],
  position: number,
): RedlineDocumentScope | undefined {
  let owner: MarkdownHeading | undefined;
  for (const heading of headings) {
    if (heading.start > position) break;
    owner = heading;
  }
  if (!owner) {
    return headings.length > 0
      ? { sectionHeading: '', sectionEndHeadingOrdinalExclusive: 0 }
      : undefined;
  }
  const next = headings.find(
    (heading) => heading.ordinal > owner!.ordinal && heading.level <= owner!.level,
  );
  return {
    sectionHeading: owner.line,
    sectionStartHeadingOrdinal: owner.ordinal,
    ...(next ? { sectionEndHeadingOrdinalExclusive: next.ordinal } : {}),
  };
}

export function createRedlineDocumentIndex(source: string): RedlineDocumentIndex {
  const normalized = source.replace(/\r\n/g, '\n');
  const headings = markdownHeadings(normalized);

  const positionOf = (annotation: RedlineDocumentAnnotation): number => {
    const needle = primarySourceText(annotation);
    const range = ordinalRange(normalized, headings, annotation);
    if (needle) {
      const positions = range
        ? allOccurrences(normalized, needle, range)
        : [legacyPosition(normalized, headings, needle)].filter((value): value is number => value != null);
      if (positions.length > 0) return positions[0]!;
    }
    if (range) return range.start;
    return Number.POSITIVE_INFINITY;
  };

  const scopeFor = (annotation: RedlineDocumentAnnotation): RedlineDocumentScope | undefined => {
    const scope = explicitScope(annotation);
    // Heading text/range mới là provenance đủ tin cậy. `sectionIndex` đơn lẻ
    // là số lát fan-out cũ, không phải heading ordinal, nên vẫn cần suy vị trí.
    if (
      scope
      && (
        scope.sectionHeading != null
        || scope.sectionStartHeadingOrdinal != null
        || scope.sectionEndHeadingOrdinalExclusive != null
      )
    ) return scope;

    const needle = primarySourceText(annotation);
    const position = needle ? legacyPosition(normalized, headings, needle) : null;
    if (position != null) {
      const derived = enclosingHeadingScope(headings, position);
      return derived
        ? { ...(annotation.sectionIndex != null ? { sectionIndex: annotation.sectionIndex } : {}), ...derived }
        : scope;
    }
    return scope;
  };

  return {
    scopeFor,
    positionOf,
    sort<T extends RedlineDocumentAnnotation>(annotations: readonly T[]): T[] {
      return annotations
        .map((annotation, index) => ({ annotation, index, position: positionOf(annotation) }))
        .sort((a, b) => a.position - b.position || a.index - b.index)
        .map(({ annotation }) => annotation);
    },
  };
}
