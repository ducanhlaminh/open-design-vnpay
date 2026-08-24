// doc-highlight — whitespace-tolerant text-node highlighting for a rendered
// markdown DOM.
//
// FORK, not a shared import: SpecPreview.tsx already has an internal (unexported)
// `fuzzyRegex` + `highlightMatch` pair (SpecPreview.tsx:507-559) doing the exact
// same DOM walk. Both functions are private to that file, so DocRedlinePreview
// cannot import them directly — must_not forbids touching SpecPreview.tsx to
// export them (it is a reference-only file for this change). This module is a
// light fork of that logic with two additions the redline view needs:
//   - `className` is passed in by the caller instead of hardcoded, because the
//     class comes from a CSS Module (`Component.module.css`) and CSS Modules
//     hash class names at build time — a literal string here would not match.
//   - `dataAttrs` lets the caller stamp e.g. `data-change-id` onto the <mark>,
//     which is how the reason-card list finds "its" highlight to scroll/flash.
// If SpecPreview.tsx is ever touched for an unrelated reason, it should switch
// to importing this module instead of keeping its own copy.

/** Turn `text` into a whitespace-tolerant RegExp: each `\s+`-separated token is
 *  regex-escaped, tokens re-joined with `\s+` so a quote that line-wraps or
 *  re-spaces in the rendered doc still matches. Returns null for an empty/blank
 *  or unparseable input. */
export function fuzzyRegex(q: string): RegExp | null {
  const toks = q
    .trim()
    .split(/\s+/)
    .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean);
  if (!toks.length) return null;
  try {
    return new RegExp(toks.join('\\s+'), 'i');
  } catch {
    return null;
  }
}

/**
 * Cắt một `quote` (nguyên văn lấy từ MÃ NGUỒN markdown) thành các đoạn có thể
 * neo được vào DOM ĐÃ RENDER.
 *
 * Vì sao cần: `quote` mang cú pháp markdown — dấu đầu dòng `- `, vách ô bảng
 * `|`, `<br>`, ảnh `![](…)`, nhấn mạnh `**` — nhưng những thứ đó BIẾN MẤT khi
 * render, nên không có trong text node. `fuzzyRegex` đòi mọi token khớp theo
 * thứ tự, nên neo cả quote như một khối là trượt. Đo trên một tài liệu URD
 * thật: neo cả khối được 4/13 chỗ sửa; cắt đoạn như dưới đây được 13/13.
 *
 * Điểm dễ làm sai: `|` và `<br>` phải TÁCH ĐOẠN, không được thay bằng khoảng
 * trắng. Hai ô bảng cạnh nhau cho ra hai text node dính liền KHÔNG có khoảng
 * trắng ở giữa, nên `\s+` mà `fuzzyRegex` chèn giữa các token sẽ không khớp
 * qua ranh giới đó.
 *
 * Ngưỡng 2 từ loại các mảnh vụn quá ngắn — chúng dễ khớp bừa vào chỗ khác.
 */
export function quoteSegments(quote: string): string[] {
  const out: string[] = [];
  for (const rawLine of quote.split('\n')) {
    for (const cell of rawLine.split(/\||<br\s*\/?>/i)) {
      const seg = cell
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // ảnh: không để lại chữ nào
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link: giữ phần chữ
        .replace(/<[^>]+>/g, ' ') // thẻ html còn lại
        .replace(/^\s*[-*+]\s+/, '') // dấu đầu dòng danh sách
        .replace(/^\s*\d+[.)]\s+/, '') // danh sách đánh số
        .replace(/^\s*#{1,6}\s+/, '') // tiêu đề
        .replace(/^\s*>\s?/, '') // trích dẫn
        .replace(/[*_`~]/g, '') // nhấn mạnh / code / gạch ngang
        .trim();
      if (seg.split(/\s+/).filter(Boolean).length >= 2) out.push(seg);
    }
  }
  return out;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface HighlightRequest {
  /** Id gắn vào `data-change-id` của vùng bôi. */
  id: string;
  /** Đoạn văn bản cần bôi, lấy từ quoteSegments. */
  text: string;
  /** Đè class cho RIÊNG request này; không có thì dùng tham số `className`.
   *  Vì sao cần: một lượt bôi chứa nhiều loại phép sửa (thêm bôi xanh, sửa bôi
   *  vàng) nhưng phải chạy CHUNG một lượt — chạy hai lượt thì lượt sau dò trên
   *  HTML đã có mark của lượt trước, nên một đoạn nằm gần chỗ đã bôi có thể
   *  trượt. Mang màu theo từng request thì một lượt lo được cả hai loại. */
  className?: string;
  /** Đè style nội tuyến cho RIÊNG request này; cùng lý do như `className`. */
  inlineStyle?: string;
  /** Giới hạn phép neo trong section sở hữu. File review cũ không có scope
   *  vẫn dò toàn tài liệu như trước. */
  scope?: HighlightScope;
}

export interface HighlightScope {
  /** Chỉ số lát fan-out; không phải heading ordinal. */
  sectionIndex?: number;
  /** Heading markdown nguyên văn, gồm dấu `#`; chuỗi rỗng là preamble. */
  sectionHeading?: string;
  /** Heading ordinal zero-based bắt đầu lát; omitted = document start. */
  sectionStartHeadingOrdinal?: number;
  /** Heading ordinal zero-based ngay sau lát; omitted = document end. */
  sectionEndHeadingOrdinalExclusive?: number;
}

export type HighlightBlockKind = 'paragraph' | 'list-item' | 'table' | 'heading';

/** Metadata để caller tint nguyên block mà không bọc `<mark>` qua biên block.
 *  `blockIndex` là chỉ số ổn định trong `querySelectorAll('p, li, table,
 *  h1, h2, h3, h4, h5, h6')` của HTML kết quả. */
export interface HighlightBlockTarget {
  id: string;
  blockIndex: number;
  tagName: string;
  kind: HighlightBlockKind;
}

export interface HighlightResult {
  html: string;
  matched: Set<string>;
  blocks: HighlightBlockTarget[];
}

/**
 * Chèn `<mark>` THẲNG VÀO CHUỖI HTML, trước khi React nhận nó.
 *
 * Vì sao không mổ DOM sau khi render (cách cũ, highlightMatch): mổ DOM sau lưng
 * React đẻ ra một loạt đường hỏng âm thầm — ref gắn muộn nên effect chạy sớm
 * trả về tay không, React dựng lại nút và xoá mất mark, thứ tự effect đổi khi
 * thêm state. Chèn vào chuỗi thì React sở hữu mark ngay từ đầu: nó có mặt cùng
 * lúc với phần còn lại của tài liệu, không có khoảng thời gian nào mark chưa
 * tồn tại, và không có bước nào để mà hỏng.
 *
 * Chỉ đụng vào phần TEXT giữa các thẻ, không bao giờ chạm nội dung bên trong
 * `<...>` — nếu không sẽ phá thuộc tính (ví dụ khớp trúng chữ nằm trong `src=`).
 *
 * Mỗi request chỉ bôi lần khớp ĐẦU TIÊN. Đoạn nào không khớp thì id của nó
 * vắng mặt trong `matched`, để phía gọi báo "không neo được" thay vì im lặng.
 *
 * `className`/`inlineStyle` là giá trị DỰ PHÒNG chung; request nào mang
 * `className`/`inlineStyle` riêng thì dùng của nó (xem HighlightRequest).
 */
export function injectHighlights(
  html: string,
  requests: readonly HighlightRequest[],
  className: string,
  inlineStyle?: string,
): HighlightResult {
  const matched = new Set<string>();
  const blocks: HighlightBlockTarget[] = [];
  const openTag = (req: HighlightRequest) => {
    const cls = req.className ?? className;
    const style = req.inlineStyle ?? inlineStyle;
    return `<mark class="${escapeHtmlText(cls)}" data-change-id="${escapeHtmlText(req.id)}"${
      style ? ` style="${escapeHtmlText(style)}"` : ''
    }>`;
  };

  // NFC cả hai phía: tài liệu Confluence nạp về có thể trộn NFC/NFD (tiếng
  // Việt), còn anchor/quote của agent là NFC → cùng chữ mà regex trượt.
  let current = html.normalize('NFC');
  for (const req of requests) {
    if (matched.has(req.id)) continue;
    const re = fuzzyRegex(escapeHtmlText(req.text.normalize('NFC')));
    if (!re) continue;
    const next = insertOneHighlight(current, re, openTag(req), req.scope);
    if (next != null) {
      blocks.push(...blockTargetsForMatch(req.id, next.layout, next.matchStart, next.matchEnd));
      current = next.html;
      matched.add(req.id);
    }
  }
  return { html: current, matched, blocks };
}

/**
 * Bôi lần khớp đầu tiên của `re` vào `html`, trả về null khi không khớp.
 *
 * Nối TẤT CẢ các khoảng text lại rồi mới dò, thay vì dò trong từng khoảng
 * riêng: một đoạn cần bôi thường trải qua nhiều thẻ (chữ in đậm giữa câu, hai
 * ô bảng liền nhau), dò từng khoảng sẽ trượt hết những ca đó. Đo trên một tài
 * liệu URD thật: dò từng khoảng được 10/13 chỗ sửa, nối lại rồi dò được 13/13.
 *
 * Khớp trải qua nhiều khoảng thì mỗi khoảng được bọc một `<mark>` riêng — cùng
 * `data-change-id`, nên phía gọi vẫn gom chúng về một chỗ sửa.
 */
function insertOneHighlight(
  html: string,
  re: RegExp,
  openTag: string,
  scope?: HighlightScope,
): { html: string; matchStart: number; matchEnd: number; layout: HtmlTextLayout } | null {
  const layout = buildHtmlTextLayout(html);
  const range = resolveScopeRange(layout, scope);
  if (!range) return null;
  const m = re.exec(layout.full.slice(range.start, range.end));
  if (!m || !m[0]) return null;
  const matchStart = range.start + m.index;
  const matchEnd = matchStart + m[0].length;

  // Chèn từ CUỐI về ĐẦU để các vị trí phía trước không bị lệch.
  for (let k = layout.spans.length - 1; k >= 0; k -= 1) {
    const span = layout.spans[k]!;
    const spanEnd = span.start + span.len;
    if (spanEnd <= matchStart || span.start >= matchEnd) continue;
    const localStart = Math.max(matchStart, span.start) - span.start;
    const localEnd = Math.min(matchEnd, spanEnd) - span.start;
    if (localEnd <= localStart) continue; // đừng đẻ ra <mark></mark> rỗng
    const text = layout.parts[span.part]!;
    layout.parts[span.part] =
      text.slice(0, localStart) + openTag + text.slice(localStart, localEnd) + '</mark>' + text.slice(localEnd);
  }
  return { html: layout.parts.join(''), matchStart, matchEnd, layout };
}

export interface DeletedRunRequest {
  /** Id gắn vào `data-change-id` của mark — chung một không gian id với
   *  injectHighlights, nên cơ chế click/cuộn/nháy sáng dùng lại được y nguyên. */
  id: string;
  /** Nguyên văn đoạn trong bản ĐÃ SỬA nằm cạnh chỗ xoá, dùng để NEO. Phía gọi
   *  phải cắt qua quoteSegments trước (ở đây nhận một segment thuần chữ). */
  anchor: string;
  /** Nguyên văn đoạn ĐÃ BỊ XOÁ, lấy từ bản gốc. */
  text: string;
  /** Cùng contract scope với HighlightRequest. */
  scope?: HighlightScope;
}

/** Đoạn xoá hiện trong tài liệu bị cắt ở 220 ký tự.
 *
 *  Vì sao phải cắt: đoạn bị xoá KHÔNG còn tồn tại trong bản đã sửa, nên nó là
 *  chữ chèn thêm vào một tài liệu người dùng đang đọc. Một `before` dài cả đoạn
 *  văn chèn vào giữa câu sẽ đẩy bản đã sửa ra khỏi tầm nhìn — đúng thứ mà cột
 *  tài liệu này tồn tại để hiển thị. Bản đầy đủ vẫn nằm nguyên trong thẻ lý do
 *  ở rail, nên không mất thông tin nào. */
const DELETED_RUN_MAX_CHARS = 220;

/**
 * Chèn đoạn ĐÃ BỊ XOÁ trở lại vào chuỗi HTML, ngay sau `anchor`.
 *
 * Vì sao cần một hàm riêng thay vì dùng injectHighlights: một chỗ xoá thuần
 * không có `quote`, nên trong bản đã sửa KHÔNG CÒN GÌ để bôi — chỗ xoá vô hình,
 * người review đọc tài liệu không thể biết ở đó từng có chữ. Neo bằng một đoạn
 * còn sống cạnh nó (`anchor`) rồi chèn chữ cũ vào sau, gạch ngang, là cách duy
 * nhất để chỗ xoá có mặt trên trang mà không phải dựng lại cột bản gốc.
 *
 * Khác injectHighlights ở đúng một điểm: KHÔNG bọc mark quanh anchor (anchor là
 * chữ của bản đã sửa, nó không bị sửa gì cả — bôi nó lên là nói sai), mà chèn
 * một node mới ngay SAU vị trí kết thúc match, trong cùng khoảng text.
 *
 * Không neo được thì id vắng mặt trong `matched`, y hệt injectHighlights, để
 * phía gọi báo "không tìm thấy trong tài liệu".
 */
export function injectDeletedRuns(
  html: string,
  requests: readonly DeletedRunRequest[],
  className: string,
  inlineStyle?: string,
): HighlightResult {
  const matched = new Set<string>();
  const blocks: HighlightBlockTarget[] = [];
  let current = html;
  for (const req of requests) {
    if (matched.has(req.id)) continue;
    const re = fuzzyRegex(escapeHtmlText(req.anchor));
    if (!re) continue;
    const node = deletedRunHtml(req.id, req.text, className, inlineStyle);
    const next = insertAfterOneMatch(current, re, node, req.scope);
    if (next != null) {
      blocks.push(...blockTargetsForMatch(req.id, next.layout, next.matchStart, next.matchEnd));
      current = next.html;
      matched.add(req.id);
    }
  }
  return { html: current, matched, blocks };
}

/** `<mark data-op="del"><del>…</del></mark>` cho một đoạn đã xoá. `data-op` chỉ
 *  do hàm này ghi: thêm/sửa phân biệt nhau bằng màu của mark là đủ, còn chỗ xoá
 *  là node do chúng ta tự sinh nên đánh dấu được rẻ và có ích khi soi DOM. */
function deletedRunHtml(id: string, text: string, className: string, inlineStyle?: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const clipped =
    collapsed.length > DELETED_RUN_MAX_CHARS ? `${collapsed.slice(0, DELETED_RUN_MAX_CHARS)}…` : collapsed;
  return `<mark class="${escapeHtmlText(className)}" data-change-id="${escapeHtmlText(id)}" data-op="del"${
    inlineStyle ? ` style="${escapeHtmlText(inlineStyle)}"` : ''
  }><del>${escapeHtmlText(clipped)}</del></mark>`;
}

/**
 * Chèn `node` ngay sau lần khớp đầu tiên của `re` trong `html`, trả về null khi
 * không khớp.
 *
 * Dùng đúng kỹ thuật parts/spans của insertOneHighlight — nối tất cả khoảng
 * text lại rồi mới dò, để một anchor trải qua nhiều thẻ vẫn khớp — nhưng chỉ
 * cần MỘT điểm chèn: khoảng text chứa vị trí kết thúc của match. Chèn vào trong
 * khoảng text đó chứ không chèn giữa hai thẻ, để node mới thừa hưởng đúng ngữ
 * cảnh inline của chỗ nó neo (trong ô bảng, trong mục danh sách) thay vì rơi ra
 * ngoài và phá cấu trúc khối.
 */
function insertAfterOneMatch(
  html: string,
  re: RegExp,
  node: string,
  scope?: HighlightScope,
): { html: string; matchStart: number; matchEnd: number; layout: HtmlTextLayout } | null {
  const layout = buildHtmlTextLayout(html);
  const range = resolveScopeRange(layout, scope);
  if (!range) return null;
  const m = re.exec(layout.full.slice(range.start, range.end));
  if (!m || !m[0]) return null;
  const matchStart = range.start + m.index;
  const matchEnd = matchStart + m[0].length;

  for (const span of layout.spans) {
    const spanEnd = span.start + span.len;
    // Khoảng text CHỨA điểm kết thúc match. `span.start < matchEnd` loại các
    // khoảng rỗng nằm đúng tại điểm chèn, `matchEnd <= spanEnd` chốt khoảng
    // đầu tiên đủ dài để chứa nó.
    if (span.start >= matchEnd || matchEnd > spanEnd) continue;
    const local = matchEnd - span.start;
    const text = layout.parts[span.part]!;
    layout.parts[span.part] = text.slice(0, local) + node + text.slice(local);
    return { html: layout.parts.join(''), matchStart, matchEnd, layout };
  }
  return null;
}

interface HtmlBlock {
  blockIndex: number;
  tagName: string;
  kind: HighlightBlockKind;
}

interface HtmlTextSpan {
  part: number;
  start: number;
  len: number;
  block?: HtmlBlock;
}

interface HtmlHeading {
  level: number;
  ordinal: number;
  start: number;
  end: number;
  text: string;
}

interface HtmlTextLayout {
  parts: string[];
  full: string;
  spans: HtmlTextSpan[];
  headings: HtmlHeading[];
}

interface ElementFrame {
  tagName: string;
  block?: HtmlBlock;
  heading?: HtmlHeading;
}

const BLOCK_KIND_BY_TAG: Partial<Record<string, HighlightBlockKind>> = {
  p: 'paragraph',
  li: 'list-item',
  table: 'table',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
};

/** Tạo chỉ mục text/heading/block trực tiếp từ chuỗi HTML. Không dùng DOM để
 *  module runtime vẫn thuần và chạy được trong server render. */
function buildHtmlTextLayout(html: string): HtmlTextLayout {
  const parts = html.split(/(<[^>]*>)/);
  const spans: HtmlTextSpan[] = [];
  const headings: HtmlHeading[] = [];
  const stack: ElementFrame[] = [];
  let full = '';
  let blockCount = 0;

  for (let part = 0; part < parts.length; part += 1) {
    const value = parts[part] ?? '';
    if (part % 2 === 0) {
      const block = preferredBlock(stack);
      spans.push({ part, start: full.length, len: value.length, ...(block ? { block } : {}) });
      full += value;
      continue;
    }

    const closing = /^<\s*\/\s*([a-zA-Z0-9-]+)/.exec(value);
    if (closing) {
      const tagName = closing[1]!.toLowerCase();
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const frame = stack[i]!;
        if (frame.tagName !== tagName) continue;
        const removed = stack.splice(i);
        for (const item of removed) {
          if (item.heading) {
            item.heading.end = full.length;
            item.heading.text = full.slice(item.heading.start, item.heading.end);
          }
        }
        break;
      }
      continue;
    }

    const opening = /^<\s*([a-zA-Z0-9-]+)/.exec(value);
    if (!opening || /^<\s*[!?]/.test(value)) continue;
    const tagName = opening[1]!.toLowerCase();
    const kind = BLOCK_KIND_BY_TAG[tagName];
    const block = kind ? { blockIndex: blockCount++, tagName, kind } : undefined;
    const headingLevel = /^h([1-6])$/.exec(tagName);
    const heading = headingLevel
      ? { level: Number(headingLevel[1]), ordinal: headings.length, start: full.length, end: full.length, text: '' }
      : undefined;
    if (heading) headings.push(heading);
    if (!/\/\s*>$/.test(value) && !/^(?:br|hr|img|input|meta|link|source|wbr)$/.test(tagName)) {
      stack.push({ tagName, ...(block ? { block } : {}), ...(heading ? { heading } : {}) });
    }
  }

  for (const frame of stack) {
    if (frame.heading) {
      frame.heading.end = full.length;
      frame.heading.text = full.slice(frame.heading.start);
    }
  }
  return { parts, full, spans, headings };
}

function preferredBlock(stack: readonly ElementFrame[]): HtmlBlock | undefined {
  for (const tagName of ['table', 'li', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const block = stack[i]?.block;
      if (block?.tagName === tagName) return block;
    }
  }
  return undefined;
}

function normalizedHeading(value: string): string {
  const markdownText = value
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return escapeHtmlText(markdownText.normalize('NFC')).toLocaleLowerCase('vi');
}

function resolveScopeRange(
  layout: HtmlTextLayout,
  scope?: HighlightScope,
): { start: number; end: number } | null {
  if (!scope || (
    scope.sectionIndex == null
    && scope.sectionHeading == null
    && scope.sectionStartHeadingOrdinal == null
    && scope.sectionEndHeadingOrdinalExclusive == null
  )) {
    return { start: 0, end: layout.full.length };
  }

  const hasOrdinalRange = scope.sectionStartHeadingOrdinal != null
    || scope.sectionEndHeadingOrdinalExclusive != null;
  if (hasOrdinalRange) {
    const startOrdinal = scope.sectionStartHeadingOrdinal;
    const endOrdinal = scope.sectionEndHeadingOrdinalExclusive;
    const startHeading = startOrdinal == null ? undefined : layout.headings[startOrdinal];
    if (startOrdinal != null && !startHeading) return null;
    if (endOrdinal != null && endOrdinal > layout.headings.length) return null;

    // sectionHeading là checksum dễ đọc cho range mới, không tham gia chọn
    // heading. Nhờ vậy duplicate heading vẫn được định vị hoàn toàn bằng ordinal.
    if (
      startHeading
      && scope.sectionHeading != null
      && normalizedHeading(startHeading.text) !== normalizedHeading(scope.sectionHeading)
    ) return null;

    const start = startHeading?.start ?? 0;
    const end = endOrdinal == null
      ? layout.full.length
      : (layout.headings[endOrdinal]?.start ?? layout.full.length);
    return start <= end ? { start, end } : null;
  }

  const headingValue = scope.sectionHeading;
  if (headingValue == null) {
    // Metadata cũ chỉ có sectionIndex không đủ để suy ra heading: một section
    // fan-out có thể chứa nhiều heading. Giữ fallback toàn tài liệu.
    return { start: 0, end: layout.full.length };
  }
  if (headingValue === '') {
    return { start: 0, end: layout.headings[0]?.start ?? layout.full.length };
  }

  let candidates = layout.headings;
  const wanted = normalizedHeading(headingValue);
  candidates = layout.headings.filter((heading) => normalizedHeading(heading.text) === wanted);
  if (candidates.length === 0) return null;

  // Legacy fallback: heading text only. sectionIndex is deliberately ignored
  // because it identifies a merged fan-out slice, never a rendered heading.
  const selected = candidates[0]!;

  const next = layout.headings.find(
    (heading) => heading.ordinal > selected.ordinal && heading.level <= selected.level,
  );
  return { start: selected.start, end: next?.start ?? layout.full.length };
}

function blockTargetsForMatch(
  id: string,
  layout: HtmlTextLayout,
  matchStart: number,
  matchEnd: number,
): HighlightBlockTarget[] {
  const seen = new Set<number>();
  const targets: HighlightBlockTarget[] = [];
  for (const span of layout.spans) {
    const spanEnd = span.start + span.len;
    if (spanEnd <= matchStart || span.start >= matchEnd || !span.block || seen.has(span.block.blockIndex)) continue;
    seen.add(span.block.blockIndex);
    targets.push({ id, ...span.block });
  }
  return targets;
}

/** Find `re` across `container`'s rendered text nodes and wrap the matched
 *  span(s) in a `<mark className={className} {...dataAttrs}>` — even when the
 *  passage straddles several nodes (e.g. a `<strong>` in the middle of the
 *  quote). Returns the first mark (for scroll-into-view), or null when there is
 *  no match — in which case the DOM is left completely untouched. */
export function highlightMatch(
  container: HTMLElement,
  re: RegExp,
  className: string,
  dataAttrs?: Record<string, string>,
): HTMLElement | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number; len: number }[] = [];
  let full = '';
  let cur: Node | null = walker.nextNode();
  while (cur) {
    const text = cur.nodeValue ?? '';
    nodes.push({ node: cur as Text, start: full.length, len: text.length });
    full += text;
    cur = walker.nextNode();
  }
  const m = re.exec(full);
  if (!m) return null;
  const ms = m.index;
  const me = m.index + m[0].length;
  let first: HTMLElement | null = null;
  // Wrap back-to-front so earlier offsets stay valid as nodes are split.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const info = nodes[i]!;
    const ns = info.start;
    const ne = info.start + info.len;
    if (ne <= ms || ns >= me) continue;
    const localStart = Math.max(ms, ns) - ns;
    const localEnd = Math.min(me, ne) - ns;
    try {
      const range = document.createRange();
      range.setStart(info.node, localStart);
      range.setEnd(info.node, localEnd);
      const mark = document.createElement('mark');
      mark.className = className;
      if (dataAttrs) {
        // camelCase key -> `data-kebab-case` attribute, same convention as
        // `HTMLElement.dataset` (e.g. `{ changeId: '1' }` -> `data-change-id`).
        for (const [key, value] of Object.entries(dataAttrs)) {
          mark.dataset[key] = value;
        }
      }
      range.surroundContents(mark);
      first = mark; // last wrapped = earliest node (reverse loop)
    } catch {
      /* skip a node we can't safely wrap */
    }
  }
  return first;
}
