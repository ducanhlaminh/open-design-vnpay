import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';

import {
  collectComponentCatalog,
  parseComponentReport,
  validateComponentReport,
  mergeComponentReports,
  writeDocsComponentFailureNote,
  COMPONENT_VERDICTS,
  DOCS_COMPONENT_FAILURE_NOTE,
  type PageComponentReport,
  type ScreenElement,
} from '../src/docs-components.js';
import { stagesForOutput, deriveStateFromLocalFiles } from '../src/pipelines.js';

// Trích từ `criteria/components.md` thật (48 component, heading dạng
// "### `#button` Button" nằm dưới tiêu đề nhóm "## CONTROL").
const CATALOG_MD = [
  '# Danh mục component hợp lệ — VNPAY Web Lib (SDK)',
  '',
  '## Danh sách theo nhóm',
  '',
  '| Nhóm | Component |',
  '|---|---|',
  '| CONTROL | Button, Chip |',
  '',
  '## CONTROL',
  '',
  '### `#button` Button',
  '',
  '| Biến thể | Trạng thái |',
  '|---|---|',
  '| Primary | Default, Hover, Disabled |',
  '',
  '## INPUT',
  '',
  '### `#input-field` Input Field',
  '',
  '### `#select` Select',
  '',
  '## DATA DISPLAY',
  '',
  '### `#typography` Typography',
  '',
].join('\n');

/** Tài liệu URD rút gọn: màn hình khai bằng heading `###### Màn hình N: SCR-…`,
 *  mỗi màn một bảng có cột "Kiểu hiển thị". */
const DOC_MD = [
  '---',
  'title: I. Quản lý nhân sự',
  '---',
  '',
  '###### Màn hình 1: SCR-001 — Danh sách Nhân viên',
  '',
  '![mockup](attachments/scr-001.png)',
  '',
  '| STT | Tên trường | Kiểu hiển thị | Bắt buộc |',
  '|---|---|---|---|',
  '| 1 | Từ khoá tìm kiếm | Text field | Không |',
  '| 2 | Phòng ban | Combobox | Không |',
  '| 3 | Nút Tìm kiếm | Button | Không |',
  '| 4 | Thẻ tóm tắt | Label / Card | Không |',
  '| 5 | Sơ đồ tổ chức | Org chart | Không |',
  '',
].join('\n');

function okElement(overrides: Partial<ScreenElement> = {}): ScreenElement {
  return {
    label: 'Nút Tìm kiếm',
    doc_type: 'Button',
    component: 'Button',
    verdict: 'ok',
    rule_id: 'criteria/components.md#button',
    ...overrides,
  };
}

function reportWith(elements: ScreenElement[]): PageComponentReport {
  return {
    schema_version: '1.0',
    page: 'I. Quản lý nhân sự',
    doc_path: 'docs/confluence/i-quan-ly-nhan-su.md',
    screens: [
      {
        id: 'SCR-001',
        name: 'Danh sách Nhân viên',
        anchor: '###### Màn hình 1: SCR-001 — Danh sách Nhân viên',
        images: ['attachments/scr-001.png'],
        elements,
      },
    ],
  };
}

// ---------------------------------------------------------------- catalog

test('collectComponentCatalog: khoá là TÊN component, giá trị là criteria/components.md#<anchor>', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  assert.equal(catalog.get('Button'), 'criteria/components.md#button');
  assert.equal(catalog.get('Input Field'), 'criteria/components.md#input-field');
  assert.equal(catalog.get('Select'), 'criteria/components.md#select');
  assert.equal(catalog.get('Typography'), 'criteria/components.md#typography');
  assert.equal(catalog.size, 4);
});

test('collectComponentCatalog: heading KHÔNG có token backtick (tiêu đề nhóm) bị bỏ qua', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  assert.ok(!catalog.has('CONTROL'));
  assert.ok(!catalog.has('INPUT'));
  assert.ok(!catalog.has('Danh sách theo nhóm'));
  assert.ok(!catalog.has('Danh mục component hợp lệ — VNPAY Web Lib (SDK)'));
});

test('collectComponentCatalog: dòng không phải heading không sinh mục nào; text rỗng => Map rỗng', () => {
  assert.equal(collectComponentCatalog('').size, 0);
  // Backtick trong một dòng văn xuôi bình thường không phải khai báo component.
  assert.equal(collectComponentCatalog('Xem mục `#button` Button ở dưới.\n').size, 0);
});

// ------------------------------------------------------------------ parse

test('parseComponentReport: chấp nhận một báo cáo hợp lệ và giữ nguyên nội dung', () => {
  const raw = JSON.stringify(reportWith([okElement()]));
  const result = parseComponentReport(raw);
  assert.ok('report' in result, 'expected a report result, not errors');
  if ('report' in result) {
    assert.equal(result.report.screens.length, 1);
    assert.equal(result.report.screens[0]!.id, 'SCR-001');
    assert.equal(result.report.screens[0]!.images[0], 'attachments/scr-001.png');
    assert.equal(result.report.screens[0]!.elements[0]!.component, 'Button');
  }
});

test('parseComponentReport: element thiếu label => lỗi nêu chỉ số screen và element', () => {
  const raw = JSON.stringify(
    reportWith([{ doc_type: 'Button', verdict: 'ok', component: 'Button' } as unknown as ScreenElement]),
  );
  const result = parseComponentReport(raw);
  assert.ok('errors' in result);
  if ('errors' in result) {
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /label/);
    assert.match(result.errors[0]!, /Màn hình thứ 0/);
    assert.match(result.errors[0]!, /phần tử thứ 0/);
  }
});

// Dòng PHÂN NHÓM — bảng URD thật chèn dòng chỉ có tên nhóm in đậm, cột "Kiểu
// hiển thị" trống ("Khối Thông tin pháp lý", "Nút thao tác"…). Prompt bắt agent
// chép MỌI dòng, nên parser phải LOẠI chúng thay vì đánh hỏng cả trang.

test('parseComponentReport: dòng phân nhóm (label có, doc_type "") bị LOẠI khỏi report, không phải lỗi', () => {
  const raw = JSON.stringify(
    reportWith([
      { label: 'Khối Thông tin pháp lý', doc_type: '', verdict: 'ok' } as ScreenElement,
      okElement(),
      { label: 'Nút thao tác', doc_type: '   ', verdict: 'internal' } as ScreenElement,
    ]),
  );
  const result = parseComponentReport(raw);
  assert.ok('report' in result, 'expected a report result, not errors');
  if ('report' in result) {
    const els = result.report.screens[0]!.elements;
    assert.equal(els.length, 1);
    assert.equal(els[0]!.label, 'Nút Tìm kiếm');
  }
});

test('parseComponentReport: dòng phân nhóm được loại TRƯỚC khi kiểm verdict/component — thiếu verdict vẫn qua', () => {
  const raw = JSON.stringify(
    reportWith([
      { label: 'Khối thông tin liên hệ', doc_type: '' } as unknown as ScreenElement,
      okElement(),
    ]),
  );
  const result = parseComponentReport(raw);
  assert.ok('report' in result, 'expected a report result, not errors');
  if ('report' in result) assert.equal(result.report.screens[0]!.elements.length, 1);
});

test('parseComponentReport: doc_type VẮNG MẶT hẳn (khác "" — agent quên khai) vẫn là lỗi shape', () => {
  const raw = JSON.stringify(
    reportWith([
      { label: 'Nút Tìm kiếm', verdict: 'ok', component: 'Button' } as unknown as ScreenElement,
    ]),
  );
  const result = parseComponentReport(raw);
  assert.ok('errors' in result);
  if ('errors' in result) {
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /doc_type/);
  }
});

test('parseComponentReport: dòng rác (label rỗng + doc_type rỗng) vẫn lỗi ở label', () => {
  const raw = JSON.stringify(
    reportWith([{ label: '', doc_type: '', verdict: 'ok' } as ScreenElement]),
  );
  const result = parseComponentReport(raw);
  assert.ok('errors' in result);
  if ('errors' in result) {
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /label/);
  }
});

test('parseComponentReport: verdict sai giá trị => lỗi liệt kê tập hợp lệ', () => {
  const raw = JSON.stringify(reportWith([okElement({ verdict: 'khong-biet' as never })]));
  const result = parseComponentReport(raw);
  assert.ok('errors' in result);
  if ('errors' in result) {
    assert.match(result.errors.join(' '), /verdict/);
    for (const v of COMPONENT_VERDICTS) assert.match(result.errors.join(' '), new RegExp(v));
  }
});

test('parseComponentReport: screens không phải mảng => lỗi', () => {
  const result = parseComponentReport(JSON.stringify({ schema_version: '1.0', screens: {} }));
  assert.ok('errors' in result);
  if ('errors' in result) assert.match(result.errors.join(' '), /'screens' phải là một mảng/);
});

test('parseComponentReport: JSON hỏng => lỗi, không ném exception', () => {
  const result = parseComponentReport('{ screens: [ }');
  assert.ok('errors' in result);
  if ('errors' in result) assert.match(result.errors[0]!, /không phải JSON hợp lệ/);
});

test('parseComponentReport: rule_id/note không phải chuỗi => lỗi (cast không kiểm được lúc chạy)', () => {
  const raw = JSON.stringify(
    reportWith([okElement({ rule_id: 42 as unknown as string, note: {} as unknown as string })]),
  );
  const result = parseComponentReport(raw);
  assert.ok('errors' in result);
  if ('errors' in result) {
    assert.match(result.errors.join(' '), /rule_id/);
    assert.match(result.errors.join(' '), /note/);
  }
});

// --------------------------------------------------------------- validate

test('validateComponentReport: báo cáo khớp tài liệu + danh mục => không lỗi', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const report = reportWith([
    okElement(),
    {
      label: 'Từ khoá tìm kiếm',
      doc_type: 'Text field',
      component: 'Input Field',
      verdict: 'ok',
      rule_id: 'criteria/components.md#input-field',
    },
    {
      label: 'Thẻ tóm tắt',
      doc_type: 'Label / Card',
      verdict: 'ambiguous',
      note: 'Tài liệu khai hai kiểu cho một phần tử; chọn Card nếu có viền, Typography nếu chỉ là chữ.',
    },
  ]);
  assert.deepEqual(validateComponentReport(DOC_MD, report, catalog), []);
});

test('validateComponentReport: anchor màn hình không có trong tài liệu => lỗi', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const report = reportWith([okElement()]);
  report.screens[0]!.anchor = '###### Màn hình 9: SCR-999 — Màn không tồn tại';
  const errors = validateComponentReport(DOC_MD, report, catalog);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /SCR-001/);
  assert.match(errors[0]!, /anchor không tìm thấy/);
});

test('validateComponentReport: anchor khác khoảng trắng/xuống dòng vẫn khớp (fuzzy)', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const report = reportWith([okElement()]);
  report.screens[0]!.anchor = '######   Màn hình 1: SCR-001\n— Danh sách Nhân viên';
  assert.deepEqual(validateComponentReport(DOC_MD, report, catalog), []);
});

test('validateComponentReport: label không có trong tài liệu => lỗi', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const report = reportWith([okElement({ label: 'Nút Xoá vĩnh viễn' })]);
  const errors = validateComponentReport(DOC_MD, report, catalog);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Nút Xoá vĩnh viễn/);
  assert.match(errors[0]!, /không tìm thấy trong tài liệu/);
});

test('validateComponentReport: verdict ok nhưng component BỊA (không có trong danh mục) => lỗi', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const report = reportWith([
    okElement({
      label: 'Sơ đồ tổ chức',
      doc_type: 'Org chart',
      component: 'Org Chart',
      rule_id: 'criteria/components.md#org-chart',
    }),
  ]);
  const errors = validateComponentReport(DOC_MD, report, catalog);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Org Chart/);
  assert.match(errors[0]!, /không có trong danh mục/);
});

test('validateComponentReport: verdict ok mà thiếu hẳn component => lỗi', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const element = okElement();
  delete element.component;
  delete element.rule_id;
  const report = reportWith([element]);
  const errors = validateComponentReport(DOC_MD, report, catalog);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /bắt buộc phải có 'component'/);
});

test('validateComponentReport: rule_id không khớp danh mục của chính component đó => lỗi', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const report = reportWith([okElement({ rule_id: 'criteria/components.md#select' })]);
  const errors = validateComponentReport(DOC_MD, report, catalog);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /rule_id/);
  assert.match(errors[0]!, /criteria\/components\.md#button/);
});

test('validateComponentReport: có component nhưng thiếu rule_id => lỗi', () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const element = okElement();
  delete element.rule_id;
  const report = reportWith([element]);
  const errors = validateComponentReport(DOC_MD, report, catalog);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /bắt buộc phải có 'rule_id'/);
});

test("validateComponentReport: verdict 'not-in-catalog' mà thiếu note => lỗi", () => {
  const catalog = collectComponentCatalog(CATALOG_MD);
  const report = reportWith([
    {
      label: 'Sơ đồ tổ chức',
      doc_type: 'Org chart',
      verdict: 'not-in-catalog',
    },
  ]);
  const errors = validateComponentReport(DOC_MD, report, catalog);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /bắt buộc phải có 'note'/);
});

test('validateComponentReport: catalog RỖNG => bỏ qua mọi kiểm tra danh mục (component bịa, rule_id bịa đều qua)', () => {
  const report = reportWith([
    okElement({ component: 'Org Chart', rule_id: 'criteria/components.md#khong-ton-tai' }),
  ]);
  assert.deepEqual(validateComponentReport(DOC_MD, report, new Map()), []);
});

test('validateComponentReport: catalog RỖNG nhưng VẪN bắt anchor sai và note thiếu', () => {
  const report = reportWith([
    { label: 'Sơ đồ tổ chức', doc_type: 'Org chart', verdict: 'not-in-catalog' },
  ]);
  report.screens[0]!.anchor = '###### Màn hình 9: SCR-999 — Màn không tồn tại';
  const errors = validateComponentReport(DOC_MD, report, new Map());
  assert.equal(errors.length, 2);
  assert.match(errors.join(' '), /anchor không tìm thấy/);
  assert.match(errors.join(' '), /bắt buộc phải có 'note'/);
});

// ------------------------------------------------------------------ merge

test('mergeComponentReports: đếm đúng pages/screens/elements/ok/issues cho index.json', () => {
  const a = reportWith([
    okElement(),
    { label: 'Thẻ tóm tắt', doc_type: 'Label / Card', verdict: 'ambiguous', note: 'khai hai kiểu' },
  ]);
  const b: PageComponentReport = {
    schema_version: '1.0',
    page: 'II. Danh mục',
    doc_path: 'docs/confluence/ii-danh-muc.md',
    screens: [
      {
        id: 'SCR-010',
        name: 'Danh mục phòng ban',
        anchor: '###### Màn hình 1: SCR-010 — Danh mục phòng ban',
        images: [],
        elements: [okElement(), okElement({ label: 'Phòng ban' })],
      },
      {
        id: 'SCR-011',
        name: 'Chi tiết phòng ban',
        anchor: '###### Màn hình 2: SCR-011 — Chi tiết phòng ban',
        images: [],
        elements: [
          {
            label: 'Sơ đồ tổ chức',
            doc_type: 'Org chart',
            verdict: 'not-in-catalog',
            note: 'Danh mục không có Org chart; dựng bằng Table hoặc List lồng nhau.',
          },
        ],
      },
    ],
  };

  const { index } = mergeComponentReports([a, b]);
  const idx = index as any;
  assert.equal(idx.schema_version, '1.0');
  assert.equal(idx.kind, 'docs-component-audit-index');
  assert.equal(idx.summary.pages, 2);
  assert.equal(idx.summary.screens, 3);
  assert.equal(idx.summary.elements, 5);
  assert.equal(idx.summary.ok, 3);
  assert.equal(idx.summary.issues, 2);
  const pageA = idx.pages.find((p: any) => p.page === 'I. Quản lý nhân sự');
  assert.equal(pageA.doc_path, 'docs/confluence/i-quan-ly-nhan-su.md');
  assert.equal(pageA.screens, 1);
  assert.equal(pageA.elements, 2);
  assert.equal(pageA.issues, 1);
  const pageB = idx.pages.find((p: any) => p.page === 'II. Danh mục');
  assert.equal(pageB.screens, 2);
  assert.equal(pageB.elements, 3);
  assert.equal(pageB.issues, 1);
});

test('mergeComponentReports: summary.md có bảng từng trang và mục "Phần tử cần xem lại" chứa NGUYÊN VĂN note', () => {
  const note = 'Danh mục không có Org chart; dựng bằng Table hoặc List lồng nhau.';
  const report = reportWith([
    okElement(),
    { label: 'Sơ đồ tổ chức', doc_type: 'Org chart', verdict: 'not-in-catalog', note },
  ]);
  const { summaryMd } = mergeComponentReports([report]);

  assert.match(summaryMd, /1 trang · 1 màn hình · 2 phần tử · 1 đạt · 1 cần xem lại/);
  assert.match(summaryMd, /\| Trang \| Số màn \| Số phần tử \| Đạt \| Cần xem lại \|/);
  assert.match(summaryMd, /\| I\. Quản lý nhân sự \| 1 \| 2 \| 1 \| 1 \|/);
  assert.match(summaryMd, /## Phần tử cần xem lại/);
  assert.match(summaryMd, /SCR-001 — Danh sách Nhân viên/);
  assert.match(summaryMd, /Sơ đồ tổ chức/);
  assert.match(summaryMd, /Org chart/);
  assert.match(summaryMd, /Không có trong danh mục/);
  assert.ok(summaryMd.includes(note), 'summary.md phải in nguyên văn note của element hỏng');
  // Element đạt KHÔNG lọt vào mục "cần xem lại".
  const section = summaryMd.slice(summaryMd.indexOf('## Phần tử cần xem lại'));
  assert.ok(!section.includes('Nút Tìm kiếm'));
});

test('mergeComponentReports: mọi phần tử đều đạt => không in mục "Phần tử cần xem lại"', () => {
  const { summaryMd } = mergeComponentReports([reportWith([okElement()])]);
  assert.ok(!summaryMd.includes('Phần tử cần xem lại'));
});

test('mergeComponentReports: danh sách rỗng => index đếm 0, summary vẫn dựng được', () => {
  const { index, summaryMd } = mergeComponentReports([]);
  const idx = index as any;
  assert.deepEqual(idx.summary, { pages: 0, screens: 0, elements: 0, ok: 0, issues: 0 });
  assert.deepEqual(idx.pages, []);
  assert.match(summaryMd, /0 trang · 0 màn hình · 0 phần tử/);
});

// ------------------------------------------------------- fail-shut cấp stage
//
// Vì sao nhóm test này tồn tại: `deriveStateFromLocalFiles` suy trạng thái
// stage từ SỰ CÓ MẶT của file dưới `outputs` của nó. Tín hiệu này phục hồi
// preview được pull/legacy nhưng không được thắng trạng thái running/failed
// của lần chạy hiện tại. Fan-out vẫn dọn file lỗi để không preview dữ liệu dở.

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'docs-components-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test('stagesForOutput: comp-khong-chay-duoc.md (NGANG HÀNG comp/, không nằm trong nó) khớp KHÔNG stage nào', () => {
  assert.equal(DOCS_COMPONENT_FAILURE_NOTE, 'comp-khong-chay-duoc.md');
  assert.deepEqual(stagesForOutput(`docs-review/${DOCS_COMPONENT_FAILURE_NOTE}`), []);
});

// WP dr-mockup (2026-08-27): dr-comp ẨN khỏi pipelineIds của docs-review →
// stagesForOutput (lọc theo workflow) KHÔNG còn chấm dr-comp cho file dưới
// comp/ — không "Xong" ké từ đĩa, cũng không bị re-run clear generic đụng
// (fan-out tự dọn). Trước đây bất kỳ file nào dưới comp/ đủ suy dr-comp =
// succeeded; giữ test để khoá hành vi mới (giống dr-screens).
test('stagesForOutput/deriveStateFromLocalFiles: file dưới docs-review/comp/ không còn thuộc dr-comp (ẩn khỏi workflow)', () => {
  assert.deepEqual(stagesForOutput('docs-review/comp/summary.md'), []);
  assert.deepEqual(stagesForOutput('docs-review/comp/i-quan-ly-nhan-su.components.json'), []);
  const state = deriveStateFromLocalFiles(['docs-review/comp/summary.md']);
  assert.equal(state['dr-comp'], undefined);
});

test('writeDocsComponentFailureNote xoá SẠCH comp/ và ghi note NGANG HÀNG comp/, không nằm trong nó', async () => {
  // Dựng lại đúng hình dạng một lần chạy hỏng để lại: báo cáo của vài trang +
  // bản gộp, tất cả nằm dưới comp/.
  await mkdir(join(cwd, 'comp'), { recursive: true });
  await writeFile(join(cwd, 'comp', 'a.components.json'), '{"screens":[]}\n');
  await writeFile(join(cwd, 'comp', 'summary.md'), 'summary cũ\n');
  await writeFile(join(cwd, 'comp', 'index.json'), '{}\n');

  await writeDocsComponentFailureNote(cwd, '# Không chạy được\n');

  // comp/ biến mất hoàn toàn — không còn index.json, summary.md, hay báo cáo
  // trang nào để `deriveStateFromLocalFiles` bám vào.
  await assert.rejects(() => stat(join(cwd, 'comp')));
  const note = await readFile(join(cwd, DOCS_COMPONENT_FAILURE_NOTE), 'utf8');
  assert.equal(note, '# Không chạy được\n');
});

test('writeDocsComponentFailureNote: comp/ chưa từng tồn tại vẫn ghi được note (idempotent, không ném lỗi)', async () => {
  await writeDocsComponentFailureNote(cwd, 'nội dung\n');
  assert.equal(await readFile(join(cwd, DOCS_COMPONENT_FAILURE_NOTE), 'utf8'), 'nội dung\n');
});

test('writeDocsComponentFailureNote KHÔNG đụng tới các thư mục anh em (docs/, criteria/, review/)', async () => {
  // comp/ là output của RIÊNG dr-comp; docs/ là bản gốc của cả workflow và
  // criteria/ là input người dùng tải lên — dọn nhầm chúng thì lần chạy lại
  // không còn gì để đọc.
  await mkdir(join(cwd, 'docs'), { recursive: true });
  await mkdir(join(cwd, 'criteria'), { recursive: true });
  await mkdir(join(cwd, 'review'), { recursive: true });
  await mkdir(join(cwd, 'comp'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'a.md'), 'trang gốc\n');
  await writeFile(join(cwd, 'criteria', 'components.md'), '### `#button` Button\n');
  await writeFile(join(cwd, 'review', 'summary.md'), 'review cũ\n');
  await writeFile(join(cwd, 'comp', 'a.components.json'), '{}\n');

  await writeDocsComponentFailureNote(cwd, 'hỏng\n');

  await assert.rejects(() => stat(join(cwd, 'comp')));
  assert.equal(await readFile(join(cwd, 'docs', 'a.md'), 'utf8'), 'trang gốc\n');
  assert.equal(await readFile(join(cwd, 'criteria', 'components.md'), 'utf8'), '### `#button` Button\n');
  assert.equal(await readFile(join(cwd, 'review', 'summary.md'), 'utf8'), 'review cũ\n');
});
