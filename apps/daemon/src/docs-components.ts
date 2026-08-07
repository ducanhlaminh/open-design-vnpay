// Docs → Component theo MÀN HÌNH — pure helpers cho bước `dr-comp`
// (workflow `docs-review`, nằm GIỮA `dr-docs` và `dr-review`).
//
// Bước này trả lời đúng một câu hỏi cho mỗi trang tài liệu: MỖI MÀN HÌNH được
// mô tả trong tài liệu đang dùng những component nào, và những thứ đó có nằm
// trong danh mục component hợp lệ (`criteria/components.md`) hay không. Kết
// quả được ghi ra `<clone>.components.json` để bước cuối `dr-review` ĐỌC LẠI
// thay vì tự suy lại từ đầu — cùng một câu hỏi mà hỏi hai lần thì hai lần trả
// lời sẽ lệch nhau, và người đọc bản review không biết tin bản nào.
//
// Hình dạng dữ liệu ở đây bám sát tài liệu URD thật chứ không phải mô hình lý
// tưởng: màn hình khai bằng một dòng heading (`###### Màn hình 1: SCR-001 — …`),
// mỗi màn có một bảng mà cột "Kiểu hiển thị" là component do TÀI LIỆU tự khai
// (`Text field`, `Combobox`, `Label / Card`…). Những tên đó KHÔNG trùng tên
// trong danh mục Figma (`Input Field`, `Select`, `Typography`), nên việc map
// theo NGHĨA là việc của agent; module này chỉ giữ phần máy kiểm được: trích
// danh mục, kiểm shape file kết quả, đối chiếu với tài liệu gốc + danh mục, và
// gộp báo cáo mọi trang.
//
// Module này CỐ Ý thuần (không fetch, không DB) để unit-test được — cùng cách
// chia như docs-review.ts: phần chạy agent / vòng đời run nằm ở server.ts vì
// nó cần bộ máy design.runs. NGOẠI LỆ DUY NHẤT chạm đĩa là
// {@link writeDocsComponentFailureNote} ở cuối file: nó là primitive FAIL-SHUT
// cấp stage, phải nằm CÙNG CHỖ với hằng tên file nó ghi
// ({@link DOCS_COMPONENT_FAILURE_NOTE}) thì server.ts và test mới không thể
// lệch nhau về đường dẫn — đúng khuôn writeDocsReviewFailureNote bên
// docs-review.ts, và cũng vì lý do đó: một hằng tên file lặp lại ở hai nơi là
// một lần fail-shut hụt đang chờ xảy ra.

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Kết luận của một phần tử giao diện khi đối chiếu với danh mục. */
export type ComponentVerdict =
  | 'ok' // map được sang đúng một component có trong danh mục
  | 'not-in-catalog' // tài liệu dùng thứ không có trong danh mục
  | 'variant-mismatch' // component có thật nhưng biến thể/trạng thái không tồn tại
  | 'ambiguous' // tài liệu khai hai kiểu cho một phần tử ("Label / Card")
  | 'internal'; // mảnh dựng nội bộ (.btn-label…), không phải component tài liệu

export interface ScreenElement {
  /** Tên trường NGUYÊN VĂN trong bảng của tài liệu (cột "Tên trường"). */
  label: string;
  /** NGUYÊN VĂN cột "Kiểu hiển thị" — thứ tài liệu tự khai. */
  doc_type: string;
  /** Tên component trong danh mục. Bắt buộc khi verdict là 'ok' hoặc
   *  'variant-mismatch'; để trống với 'not-in-catalog'. */
  component?: string;
  verdict: ComponentVerdict;
  /** `criteria/components.md#<anchor>` — bắt buộc khi có `component`. */
  rule_id?: string;
  /** Chỉ cần khi verdict != 'ok': sai ở đâu, đề xuất dùng gì. Một câu. */
  note?: string;
}

export interface ScreenInventory {
  /** Mã màn hình nguyên văn, ví dụ "SCR-001" hoặc "SCR-002.1". */
  id: string;
  /** Tên màn hình. */
  name: string;
  /** Dòng heading NGUYÊN VĂN của màn — daemon dùng để xác nhận màn có thật. */
  anchor: string;
  /** Đường dẫn ảnh mockup của màn, giữ nguyên văn. */
  images: string[];
  elements: ScreenElement[];
}

export interface PageComponentReport {
  schema_version: '1.0';
  page: string;
  doc_path: string;
  screens: ScreenInventory[];
}

/** Tập verdict hợp lệ — dùng chung cho parser và mọi chỗ hiển thị nên hai bên
 *  không thể lệch nhau. */
export const COMPONENT_VERDICTS: readonly ComponentVerdict[] = [
  'ok',
  'not-in-catalog',
  'variant-mismatch',
  'ambiguous',
  'internal',
];

/** Nhãn tiếng Việt của từng verdict, dùng trong `comp/summary.md`. Người đọc
 *  bản review là BA/PM chứ không phải người viết schema, nên summary không in
 *  thẳng chuỗi enum. */
const VERDICT_LABEL: Record<ComponentVerdict, string> = {
  ok: 'Đạt',
  'not-in-catalog': 'Không có trong danh mục',
  'variant-mismatch': 'Sai biến thể',
  ambiguous: 'Khai hai kiểu',
  internal: 'Mảnh dựng nội bộ',
};

/** Tên file danh mục — cũng là tiền tố của mọi `rule_id` bước này sinh ra. */
const CATALOG_FILE = 'criteria/components.md';

const HEADING_RE = /^#{1,6}\s/;

/** Trích DANH MỤC component từ nội dung `criteria/components.md`.
 *
 *  Khoá = TÊN component (phần chữ sau token backtick trong dòng heading, đã
 *  trim), giá trị = `criteria/components.md#<anchor>`. Thực tế file:
 *  "### `#button` Button" → `Button` → `criteria/components.md#button`;
 *  "### `#input-field` Input Field" → `Input Field` → `…#input-field`.
 *
 *  Vì sao khoá là TÊN chứ không phải anchor: agent làm việc bằng tên component
 *  (nó phải map "Text field" của tài liệu sang "Input Field" của danh mục), còn
 *  anchor chỉ là thứ đem đi trace. Map tên → rule_id cho phép
 *  {@link validateComponentReport} kiểm CẢ HAI bằng một lần tra: tên có thật
 *  không, và rule_id kèm theo có đúng của chính tên đó không.
 *
 *  Quy ước anchor GIỮ NGUYÊN như `collectCriteriaAnchors` trong docs-review.ts
 *  (token nằm trong backtick, bỏ dấu `#` đứng đầu) — hai bước cùng sinh
 *  `rule_id` nên nếu quy ước lệch nhau thì `dr-review` sẽ coi rule_id của
 *  `dr-comp` là bịa. Heading không có token backtick (vd "## CONTROL",
 *  "# Danh mục component hợp lệ") bị bỏ qua: đó là tiêu đề nhóm, không phải
 *  component. Trùng tên thì GIỮ LẦN XUẤT HIỆN ĐẦU — heading chính của
 *  component đứng trước mọi lần nhắc lại phía sau. */
export function collectComponentCatalog(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!HEADING_RE.test(line)) continue;
    const m = /`([^`]+)`(.*)$/.exec(line);
    if (!m) continue;
    const anchor = (m[1] ?? '').trim().replace(/^#/, '');
    const name = (m[2] ?? '').trim();
    if (!anchor || !name) continue;
    if (out.has(name)) continue;
    out.set(name, `${CATALOG_FILE}#${anchor}`);
  }
  return out;
}

/** Parse + kiểm SHAPE của một file `<clone>.components.json` (văn bản thô).
 *
 *  Cùng lý do tồn tại như {@link parseChangesFile} bên docs-review.ts: một
 *  `JSON.parse(raw) as PageComponentReport` KHÔNG kiểm gì lúc chạy — cast chỉ
 *  là khẳng định lúc biên dịch. Ở bước này hậu quả còn nặng hơn: một
 *  `verdict` sai chính tả sẽ lặng lẽ bị `mergeComponentReports` đếm vào cột
 *  "cần xem lại" (vì nó khác 'ok'), còn `dr-review` phía sau thì đọc phải một
 *  kết luận không có nghĩa. Trả `{ report }` khi đạt, `{ errors }` (tiếng
 *  Việt, mỗi lỗi nêu rõ chỉ số screen/element) khi hỏng — phía gọi (server.ts)
 *  coi `errors` là TRANG hỏng.
 *
 *  `page` / `doc_path` được chấp nhận khi vắng mặt (chuẩn hoá về chuỗi rỗng):
 *  chúng là siêu dữ liệu daemon tự biết và tự ghi đè, không phải kết luận của
 *  agent, nên đánh hỏng cả trang chỉ vì thiếu chúng là phạt sai chỗ. */
export function parseComponentReport(
  raw: string,
): { report: PageComponentReport } | { errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      errors: [
        `components.json không phải JSON hợp lệ: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { errors: ['components.json không phải một object.'] };
  }
  const root = parsed as Record<string, unknown>;

  const errors: string[] = [];
  if (root.schema_version !== undefined && root.schema_version !== '1.0') {
    errors.push(
      `'schema_version' phải là "1.0" khi có mặt, nhận được ${JSON.stringify(root.schema_version)}.`,
    );
  }
  if (root.page !== undefined && typeof root.page !== 'string') {
    errors.push(`'page' phải là chuỗi khi có mặt, nhận được ${JSON.stringify(root.page)}.`);
  }
  if (root.doc_path !== undefined && typeof root.doc_path !== 'string') {
    errors.push(`'doc_path' phải là chuỗi khi có mặt, nhận được ${JSON.stringify(root.doc_path)}.`);
  }
  if (!Array.isArray(root.screens)) {
    errors.push(`'screens' phải là một mảng, nhận được ${JSON.stringify(root.screens)}.`);
    return { errors };
  }

  const screens: ScreenInventory[] = [];
  root.screens.forEach((rawScreen, si) => {
    if (typeof rawScreen !== 'object' || rawScreen === null || Array.isArray(rawScreen)) {
      errors.push(`Màn hình thứ ${si} không phải một object.`);
      return;
    }
    const screen = rawScreen as Record<string, unknown>;
    for (const field of ['id', 'name', 'anchor'] as const) {
      const value = screen[field];
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(
          `Màn hình thứ ${si}: '${field}' phải là chuỗi không rỗng, nhận được ${JSON.stringify(value)}.`,
        );
      }
    }
    if (screen.images !== undefined) {
      if (!Array.isArray(screen.images)) {
        errors.push(
          `Màn hình thứ ${si}: 'images' phải là mảng chuỗi, nhận được ${JSON.stringify(screen.images)}.`,
        );
      } else {
        screen.images.forEach((img, j) => {
          if (typeof img !== 'string') {
            errors.push(
              `Màn hình thứ ${si}: 'images[${j}]' phải là chuỗi, nhận được ${JSON.stringify(img)}.`,
            );
          }
        });
      }
    }
    if (!Array.isArray(screen.elements)) {
      errors.push(
        `Màn hình thứ ${si}: 'elements' phải là một mảng, nhận được ${JSON.stringify(screen.elements)}.`,
      );
      return;
    }

    screen.elements.forEach((rawEl, ei) => {
      const where = `Màn hình thứ ${si}, phần tử thứ ${ei}`;
      if (typeof rawEl !== 'object' || rawEl === null || Array.isArray(rawEl)) {
        errors.push(`${where} không phải một object.`);
        return;
      }
      const el = rawEl as Record<string, unknown>;
      for (const field of ['label', 'doc_type'] as const) {
        const value = el[field];
        if (typeof value !== 'string' || value.trim() === '') {
          errors.push(
            `${where}: '${field}' phải là chuỗi không rỗng, nhận được ${JSON.stringify(value)}.`,
          );
        }
      }
      if (!COMPONENT_VERDICTS.includes(el.verdict as ComponentVerdict)) {
        errors.push(
          `${where}: 'verdict' phải là một trong (${COMPONENT_VERDICTS.join(', ')}), nhận được ${JSON.stringify(el.verdict)}.`,
        );
      }
      for (const field of ['component', 'rule_id', 'note'] as const) {
        if (el[field] !== undefined && typeof el[field] !== 'string') {
          errors.push(
            `${where}: '${field}' phải là chuỗi khi có mặt, nhận được ${JSON.stringify(el[field])}.`,
          );
        }
      }
    });

    screens.push({
      id: String(screen.id ?? ''),
      name: String(screen.name ?? ''),
      anchor: String(screen.anchor ?? ''),
      images: Array.isArray(screen.images) ? (screen.images as string[]) : [],
      elements: screen.elements as unknown as ScreenElement[],
    });
  });

  if (errors.length > 0) return { errors };
  return {
    report: {
      schema_version: '1.0',
      page: typeof root.page === 'string' ? root.page : '',
      doc_path: typeof root.doc_path === 'string' ? root.doc_path : '',
      screens,
    },
  };
}

// BẢN SAO CÓ CHỦ ĐÍCH của fuzzyPattern/fuzzyIncludes trong docs-review.ts.
// Hai hàm đó KHÔNG được export ở đó (chúng là chi tiết nội bộ của
// validateChanges), và docs-review.ts kéo theo `node:fs`/`node:path` cùng cả
// bộ máy clone/fan-out — import từ đó chỉ để lấy một phép so chuỗi 4 dòng sẽ
// buộc module thuần này phụ thuộc vào một module chạm đĩa, hoặc buộc phải nới
// bề mặt export của docs-review.ts (mà một phiên khác đang sửa). Chép sang là
// lựa chọn rẻ hơn cả hai. LUẬT KHỚP PHẢI GIỐNG HỆT bản gốc: cả hai bước đều
// neo phát hiện vào NGUYÊN VĂN tài liệu, nên nếu một bên nghiêm hơn bên kia
// thì cùng một anchor sẽ đạt ở bước này và hỏng ở bước sau.

/** Biến `text` thành RegExp source chịu được khác biệt khoảng trắng: mỗi token
 *  (cắt theo `\s+`) được escape rồi nối lại bằng `\s+`, nên một đoạn trích bị
 *  xuống dòng / giãn khoảng trắng khác đi vẫn khớp. */
function fuzzyPattern(text: string): string {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return tokens.map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
}

function fuzzyIncludes(haystack: string, needle: string): boolean {
  const pattern = fuzzyPattern(needle);
  if (!pattern) return false;
  return new RegExp(pattern).test(haystack);
}

/** Đối chiếu một báo cáo component của trang với TÀI LIỆU GỐC và DANH MỤC.
 *  Trả mảng lỗi tiếng Việt (rỗng = đạt). Bốn nhóm kiểm, không nhóm nào cần LLM:
 *
 *   (a) MÀN CÓ THẬT — `screen.anchor` phải tìm thấy trong `originalMd`, và
 *       (b) mọi `element.label` cũng vậy. Phép khớp chịu được khác biệt khoảng
 *       trắng (fuzzyIncludes ở trên) vì agent chép lại heading/ô bảng qua một
 *       vòng JSON, xuống dòng và khoảng trắng thường không giữ nguyên. Không
 *       có hai kiểm tra này thì agent có thể "phát hiện" ra màn hình và trường
 *       không tồn tại trong tài liệu.
 *
 *   (c) TÊN COMPONENT CÓ THẬT — với verdict 'ok'/'variant-mismatch',
 *       `component` là BẮT BUỘC và phải nằm trong `catalog`; khi có
 *       `component` thì `rule_id` bắt buộc và phải bằng đúng
 *       `catalog.get(component)`. Đây là kiểm tra QUAN TRỌNG NHẤT của cả bước:
 *       toàn bộ giá trị của nó nằm ở câu "màn này dùng đúng component X trong
 *       danh mục". Nếu X có thể là tên bịa, mọi kết luận phía sau — kể cả
 *       những dòng `dr-review` chép lại — đều vô nghĩa mà vẫn trông rất chắc
 *       chắn.
 *
 *   (d) NÓI ĐƯỢC SAI Ở ĐÂU — verdict != 'ok' thì `note` bắt buộc, không rỗng.
 *       Một phát hiện không nói được sai chỗ nào thì người đọc không dùng được
 *       nó, chỉ tổ làm phồng số đếm "cần xem lại".
 *
 *  `catalog` RỖNG nghĩa là dự án không upload `criteria/components.md`. Khi đó
 *  BỎ QUA HOÀN TOÀN nhóm (c) — cả phần "bắt buộc có `component`" lẫn phần tra
 *  danh mục — cùng tinh thần `validateRuleIds`: không có gì để đối chiếu thì
 *  không được đánh hỏng trang. Nhóm (a), (b), (d) vẫn chạy vì chúng chỉ cần
 *  bản thân tài liệu. */
export function validateComponentReport(
  originalMd: string,
  report: PageComponentReport,
  catalog: Map<string, string>,
): string[] {
  const errors: string[] = [];
  const hasCatalog = catalog.size > 0;

  for (const screen of report.screens) {
    const anchor = (screen.anchor ?? '').trim();
    if (!anchor || !fuzzyIncludes(originalMd, anchor)) {
      errors.push(`Màn hình "${screen.id}" có anchor không tìm thấy trong tài liệu: "${screen.anchor}"`);
    }

    for (const el of screen.elements ?? []) {
      const where = `Màn hình "${screen.id}", phần tử "${el.label}"`;
      const label = (el.label ?? '').trim();
      if (!label || !fuzzyIncludes(originalMd, label)) {
        errors.push(`${where}: tên trường không tìm thấy trong tài liệu.`);
      }

      const component = (el.component ?? '').trim();
      const ruleId = (el.rule_id ?? '').trim();

      if (hasCatalog) {
        const needsComponent = el.verdict === 'ok' || el.verdict === 'variant-mismatch';
        if (needsComponent && !component) {
          errors.push(
            `${where}: verdict "${el.verdict}" bắt buộc phải có 'component' — tên component trong danh mục.`,
          );
        }
        if (component) {
          const expected = catalog.get(component);
          if (expected === undefined) {
            errors.push(
              `${where}: component "${component}" không có trong danh mục ${CATALOG_FILE}.`,
            );
          } else if (!ruleId) {
            errors.push(`${where}: có 'component' thì bắt buộc phải có 'rule_id' ("${expected}").`);
          } else if (ruleId !== expected) {
            errors.push(
              `${where}: rule_id "${ruleId}" không khớp danh mục — component "${component}" phải là "${expected}".`,
            );
          }
        }
      }

      if (el.verdict !== 'ok' && (el.note ?? '').trim() === '') {
        errors.push(
          `${where}: verdict "${el.verdict}" bắt buộc phải có 'note' nêu sai ở đâu và đề xuất dùng gì.`,
        );
      }
    }
  }

  return errors;
}

/** Kết quả một trang, đã parse + validate, đưa vào bước gộp. */
export type ComponentPageResult = PageComponentReport;

/** Gộp báo cáo mọi trang thành `comp/index.json` + `comp/summary.md` (tiếng
 *  Việt) — cùng khuôn với `mergeChangeReports` bên docs-review.ts.
 *
 *  `issues` ở mọi cấp là SỐ ELEMENT có verdict != 'ok' (kể cả 'internal'):
 *  bất kỳ kết luận nào khác 'ok' đều là thứ con người phải nhìn lại, còn máy
 *  thì không phân biệt nổi "sai" với "cố ý" — đó chính là việc của người đọc.
 *
 *  Mục "Phần tử cần xem lại" in ĐỦ mọi element có vấn đề ngay trong summary.md
 *  (nhóm theo trang → màn), chủ ý y như phần nhận xét của `mergeChangeReports`:
 *  người đọc mở đúng MỘT file là hiểu hết, không phải lần theo từng
 *  `<clone>.components.json`. Một danh sách bị cắt bớt ("và 12 mục khác") thì
 *  đúng những mục bị cắt là những mục không ai xem. */
export function mergeComponentReports(
  reports: PageComponentReport[],
): { index: unknown; summaryMd: string } {
  const perPage = reports.map((r) => {
    const elements = r.screens.reduce((n, s) => n + (s.elements?.length ?? 0), 0);
    const issues = r.screens.reduce(
      (n, s) => n + (s.elements ?? []).filter((e) => e.verdict !== 'ok').length,
      0,
    );
    return {
      page: r.page,
      doc_path: r.doc_path,
      screens: r.screens.length,
      elements,
      issues,
    };
  });

  const screens = perPage.reduce((n, p) => n + p.screens, 0);
  const elements = perPage.reduce((n, p) => n + p.elements, 0);
  const issues = perPage.reduce((n, p) => n + p.issues, 0);
  const ok = elements - issues;

  const index = {
    schema_version: '1.0',
    kind: 'docs-component-audit-index',
    summary: { pages: reports.length, screens, elements, ok, issues },
    pages: perPage,
  };

  let summaryMd = `# Docs → Component theo màn hình\n\n`;
  summaryMd += `${reports.length} trang · ${screens} màn hình · ${elements} phần tử · ${ok} đạt · ${issues} cần xem lại\n\n`;

  summaryMd += `## Từng trang\n\n`;
  summaryMd += `| Trang | Số màn | Số phần tử | Đạt | Cần xem lại |\n| --- | --- | --- | --- | --- |\n`;
  for (const p of perPage) {
    summaryMd += `| ${p.page} | ${p.screens} | ${p.elements} | ${p.elements - p.issues} | ${p.issues} |\n`;
  }

  if (issues > 0) {
    summaryMd += `\n## Phần tử cần xem lại\n\n`;
    for (const r of reports) {
      const badScreens = r.screens.filter((s) =>
        (s.elements ?? []).some((e) => e.verdict !== 'ok'),
      );
      if (badScreens.length === 0) continue;
      summaryMd += `### ${r.page}\n\n`;
      for (const s of badScreens) {
        summaryMd += `#### ${s.id} — ${s.name}\n\n`;
        for (const el of s.elements.filter((e) => e.verdict !== 'ok')) {
          const label = VERDICT_LABEL[el.verdict] ?? el.verdict;
          const component = el.component ? ` → ${el.component}` : '';
          summaryMd += `- **${el.label}** · \`${el.doc_type}\`${component} · ${label}\n`;
          summaryMd += `  - Nhận xét: ${el.note ?? '—'}\n`;
        }
        summaryMd += `\n`;
      }
    }
  }

  return { index, summaryMd };
}

/** Đường dẫn (tương đối cwd) của thông báo "bước này không chạy được" — xem
 *  {@link writeDocsComponentFailureNote}. Export ra để server.ts dọn bản cũ ở
 *  đầu mỗi lần chạy mà không phải viết lại chuỗi này lần thứ hai. */
export const DOCS_COMPONENT_FAILURE_NOTE = 'comp-khong-chay-duoc.md';

/** Xoá SẠCH `comp/`, rồi ghi `body` ra `<cwd>/comp-khong-chay-duoc.md` — một
 *  đường dẫn CỐ Ý nằm NGANG HÀNG `comp/` chứ không lồng trong nó, nên nó không
 *  bao giờ khớp outputs khai báo của dr-comp (`outputs: ['comp/']` trong
 *  pipelines.ts — `stagesForOutput('docs-review/comp-khong-chay-duoc.md')` trả
 *  `[]`).
 *
 *  Gọi hàm này ở MỌI đường thoát của runDocsComponentAuditFanout trả về thứ
 *  khác 'succeeded' mà KHÔNG trang nào được xác nhận đạt. Lý do y hệt
 *  {@link writeDocsReviewFailureNote} bên docs-review.ts:
 *  `deriveStateFromLocalFiles` suy trạng thái stage từ SỰ CÓ MẶT của file dưới
 *  `outputs`, và tín hiệu đĩa THẮNG trạng thái vừa ghi vào DB. Một stage vừa
 *  ghi 'failed' mà còn để lại dù chỉ `comp/summary.md` (hoặc một
 *  `comp/<slug>.components.json` của trang hỏng) vẫn đọc ra 'succeeded' từ
 *  đĩa: UI hiện xanh, người dùng mở ra thấy một bản đối chiếu component rỗng
 *  hoặc thiếu quá nửa số trang, và kết luận nhầm rằng tài liệu sạch. Ghi thông
 *  báo lỗi VÀO `comp/` là tự tay bật đèn xanh cho một lần chạy hỏng — nên nó
 *  phải đi ra ngoài. */
export async function writeDocsComponentFailureNote(cwd: string, body: string): Promise<void> {
  await fs.rm(path.join(cwd, 'comp'), { recursive: true, force: true }).catch(() => null);
  await fs.writeFile(path.join(cwd, DOCS_COMPONENT_FAILURE_NOTE), body, 'utf8');
}
