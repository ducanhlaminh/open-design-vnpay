import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';

import {
  pageSlug,
  listDocPages,
  cloneDocsForReview,
  validateChanges,
  parseChangesFile,
  removePageOutputs,
  mergeChangeReports,
  writeDocsReviewFailureNote,
  DOCS_REVIEW_FAILURE_NOTE,
  splitSections,
  parseNotesFile,
  validateNotes,
  findReviewMarkers,
  collectCriteriaAnchors,
  validateRuleIds,
  DEFAULT_RULE_IDS,
  sliceSections,
  rebuildPageFromSlices,
  detectEol,
  sectionSlicePath,
  pageOutlinePath,
  systemChangesPath,
  renderPageOutline,
  type DocChange,
  type DocNote,
  type DocPageResult,
} from '../src/docs-review.js';
import { stagesForOutput, deriveStateFromLocalFiles } from '../src/pipelines.js';

test('pageSlug strips docs/confluence or docs/ prefix, flattens folders, drops .md', () => {
  assert.equal(pageSlug('docs/confluence/i-tai-khoan/1-thiet-lap.md'), 'i-tai-khoan__1-thiet-lap');
  assert.equal(pageSlug('docs/confluence/danh-sach.md'), 'danh-sach');
  assert.equal(pageSlug('./docs/confluence/a/b/c.md'), 'a__b__c');
  assert.equal(pageSlug('docs/a/b.md'), 'a__b');
  assert.equal(pageSlug('docs/x.md'), 'x');
});

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'docs-review-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test('listDocPages returns EVERY .md page under docs/ (with or without images), nested, excludes _index.md and attachments/', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(join(conf, 'i-tai-khoan'), { recursive: true });
  await mkdir(join(conf, 'attachments'), { recursive: true });
  await writeFile(
    join(conf, 'i-tai-khoan', '1-thiet-lap.md'),
    '---\ntitle: 1. Thiết lập tài khoản\n---\n\nText ![a](../attachments/x.png)\n',
  );
  // A page with NO image is still a fan-out unit for this stage (unlike prd-review).
  await writeFile(join(conf, 'danh-muc.md'), '---\ntitle: II. Danh mục\n---\n\nNo images here.\n');
  // The _index.md companion → excluded.
  await writeFile(join(conf, '_index.md'), '![i](attachments/z.png)\n');
  // A stray file under attachments/ → excluded.
  await writeFile(join(conf, 'attachments', 'note.md'), '![n](x.png)\n');

  const pages = await listDocPages(cwd);
  assert.equal(pages.length, 2);
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  assert.ok(bySlug.has('i-tai-khoan__1-thiet-lap'));
  assert.ok(bySlug.has('danh-muc'));
  assert.equal(bySlug.get('i-tai-khoan__1-thiet-lap')!.page, '1. Thiết lập tài khoản');
  assert.equal(bySlug.get('i-tai-khoan__1-thiet-lap')!.mdPath, 'docs/confluence/i-tai-khoan/1-thiet-lap.md');
});

test('listDocPages falls back to the file stem when frontmatter has no title', async () => {
  await mkdir(join(cwd, 'docs'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'no-title.md'), 'Just text, no frontmatter.\n');
  const pages = await listDocPages(cwd);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.page, 'no-title');
});

test('cloneDocsForReview writes review/docs/<same path>.md for every page, byte-for-byte — no markdown edits', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(join(conf, 'attachments'), { recursive: true });
  const original = '---\ntitle: Trang A\n---\n\nNội dung gốc ![mockup](attachments/a.png) không đổi.\n';
  await writeFile(join(conf, 'a.md'), original);

  const written = await cloneDocsForReview(cwd);
  assert.deepEqual(written, ['review/docs/confluence/a.md']);

  const cloned = await readFile(join(cwd, 'review/docs/confluence/a.md'), 'utf8');
  // Byte-for-byte: the image ref is left completely untouched (no rewrite —
  // the whole attachments/ folder was copied alongside, see below).
  assert.equal(cloned, original);
});

test('cloneDocsForReview copies attachments/ (including binary images) alongside the markdown, identical to the original', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(join(conf, 'attachments'), { recursive: true });
  await writeFile(join(conf, 'a.md'), '![mockup](attachments/a.png)\n');
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
  await writeFile(join(conf, 'attachments', 'a.png'), imageBytes);

  await cloneDocsForReview(cwd);

  const clonedImage = await readFile(join(cwd, 'review/docs/confluence/attachments/a.png'));
  assert.ok(clonedImage.equals(imageBytes), 'attachments/a.png should be copied byte-for-byte');
});

test('cloneDocsForReview clones an image ref whose attachment file name CONTAINS SPACES verbatim, unchanged', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(join(conf, 'attachments'), { recursive: true });
  const original = '![a](attachments/anh man hinh.png)\n';
  await writeFile(join(conf, 'a.md'), original);
  await writeFile(join(conf, 'attachments', 'anh man hinh.png'), Buffer.from('fake-png'));

  await cloneDocsForReview(cwd);

  const cloned = await readFile(join(cwd, 'review/docs/confluence/a.md'), 'utf8');
  assert.equal(cloned, original);
  const clonedImage = await readFile(join(cwd, 'review/docs/confluence/attachments/anh man hinh.png'), 'utf8');
  assert.equal(clonedImage, 'fake-png');
});

// SỬA LỖI VÒNG 3: cloneDocsForReview KHÔNG loại trừ file nào khi copy nữa
// (_index.md phải là bản sao nguyên vẹn của cây gốc — chỉ bị loại khỏi DANH
// SÁCH TRANG CẦN REVIEW, việc listDocPages đã làm rồi). Test này thay thế
// test cũ 'cloneDocsForReview excludes _index.md from the clone (not copied
// at all)', vốn khẳng định đúng hành vi NGƯỢC LẠI (hành vi bị coi là lỗi ở
// pass sửa lỗi vòng 3 — filter loại _index.md khỏi thao tác copy làm
// review/docs/ không còn là bản sao nguyên vẹn, zip gửi đi mất trang mục lục).
test('cloneDocsForReview copies _index.md TOO (full-tree copy, no exclusions) — but it stays out of the reviewable page list', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(conf, { recursive: true });
  await writeFile(join(conf, 'a.md'), 'Trang A.\n');
  const indexContent = 'index\n';
  await writeFile(join(conf, '_index.md'), indexContent);

  const written = await cloneDocsForReview(cwd);
  // _index.md is NOT a reviewable page → absent from the returned page list.
  assert.deepEqual(written, ['review/docs/confluence/a.md']);
  assert.ok(!written.includes('review/docs/confluence/_index.md'));
  // …but it MUST still exist in the clone, byte-for-byte identical, since the
  // clone is a full copy of docs/ with no exclusions.
  const clonedIndex = await readFile(join(cwd, 'review/docs/confluence/_index.md'), 'utf8');
  assert.equal(clonedIndex, indexContent);
});

test('cloneDocsForReview mirrors nested dirs; attachments/ note.md and _index.md stay out of the page LIST (listDocPages\' job, not the copy\'s)', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(join(conf, 'nested'), { recursive: true });
  await mkdir(join(conf, 'attachments'), { recursive: true });
  await writeFile(join(conf, 'nested', 'b.md'), '---\ntitle: B\n---\n\nText.\n');
  await writeFile(join(conf, '_index.md'), 'index\n');
  await writeFile(join(conf, 'attachments', 'note.md'), 'stray\n');

  const written = await cloneDocsForReview(cwd);
  assert.deepEqual(written, ['review/docs/confluence/nested/b.md']);
});

test('validateChanges: passes when a reflow (before+quote cùng nội dung, chỉ đổi khoảng trắng/xuống dòng) được khai báo đủ cả hai phía', () => {
  // Same wording as the original, only reflowed across a line break with
  // extra internal spaces in `revised`. Nội dung không đổi nhưng dòng đã
  // đổi (theo multiset) nên đây vẫn là ca sửa/thay => cần cả `before`
  // (nguyên văn ở original) và `quote` (nguyên văn ở revised) — cùng phủ
  // đúng phía của mình chứ không cho `quote` tự phủ dòng gốc.
  const original = 'Dòng một không đổi.\nDòng hai cũ và dài hơn.\nDòng ba không đổi.\n';
  const revised = 'Dòng một không đổi.\nDòng hai   cũ\nvà dài hơn.\nDòng ba không đổi.\n';
  const changes: DocChange[] = [
    {
      id: 'c1',
      kind: 'ux-writing',
      severity: 'minor',
      before: 'Dòng hai cũ và dài hơn.',
      quote: 'Dòng hai cũ và dài hơn.',
      reason: 'chỉ đổi cách xuống dòng, không đổi nội dung',
    },
  ];
  const errors = validateChanges(original, revised, changes);
  assert.deepEqual(errors, []);
});

test('validateChanges: fails when a changed line has no covering change', () => {
  const original = 'Dòng một.\n';
  const revised = 'Dòng một.\nDòng mới không được khai báo.\n';
  const errors = validateChanges(original, revised, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Dòng mới không được khai báo/);
});

test('validateChanges: fails when a change.quote is not found in the revised text', () => {
  const original = 'Dòng một.\n';
  const revised = 'Dòng một.\nDòng mới đã khai báo.\n';
  const changes: DocChange[] = [
    { id: 'c1', kind: 'gap', severity: 'major', quote: 'Dòng mới đã khai báo.', reason: 'ok' },
    { id: 'c2', kind: 'gap', severity: 'major', quote: 'câu không tồn tại trong bản đã sửa', reason: 'lỗi' },
  ];
  const errors = validateChanges(original, revised, changes);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /c2/);
});

test('validateChanges: a change with both quote and before blank/whitespace-only is an error', () => {
  const errors = validateChanges('a\n', 'a\n', [
    { id: 'c1', kind: 'gap', severity: 'minor', quote: '   ', before: '', reason: 'x' },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /không có cả 'quote' lẫn 'before'/);
});

test('validateChanges: a change missing both quote and before fields entirely is an error', () => {
  const errors = validateChanges('a\n', 'a\n', [{ id: 'c1', kind: 'gap', severity: 'minor', reason: 'x' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /không có cả 'quote' lẫn 'before'/);
});

test('validateChanges: catches a pure DELETION with no declared change (BUG FIX #1 — deleting a line must not sail through as changes=[])', () => {
  const original = 'Dòng một.\nNgười dùng phải nhập OTP.\nDòng ba.\n';
  // The revised copy drops the OTP sentence entirely — no addition, no rewrite.
  const revised = 'Dòng một.\nDòng ba.\n';
  const errors = validateChanges(original, revised, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /bị xoá/);
  assert.match(errors[0]!, /Người dùng phải nhập OTP/);
});

test('validateChanges: a change with BOTH before (nguyên văn dòng gốc) and quote (nguyên văn dòng đã sửa) clears a replace-with-a-note edit', () => {
  const original = 'Dòng một.\nNgười dùng phải nhập OTP.\nDòng ba.\n';
  // Agent replaces the sentence with a note that still contains the original
  // wording verbatim — a realistic "replacement" shape. `before` phủ đúng
  // dòng gốc bị xoá, `quote` phủ đúng dòng mới — KHÔNG dựa vào việc `quote`
  // tình cờ chứa lại chữ gốc (đó là kịch bản nhân tạo bị gỡ ở pass sửa lỗi).
  const revised = 'Dòng một.\nGhi chú: (Đã bỏ) Người dùng phải nhập OTP.\nDòng ba.\n';
  const changes: DocChange[] = [
    {
      id: 'c1',
      kind: 'flow',
      severity: 'major',
      before: 'Người dùng phải nhập OTP.',
      quote: 'Ghi chú: (Đã bỏ) Người dùng phải nhập OTP.',
      reason: 'Đánh dấu bỏ yêu cầu OTP, giữ lại ghi chú cho người đọc.',
    },
  ];
  const errors = validateChanges(original, revised, changes);
  assert.deepEqual(errors, []);
});

test('validateChanges: BUG FIX #2 (QUAN TRỌNG NHẤT) — một lần SỬA CHỮ THỰC TẾ với before+quote phải ĐẠT', () => {
  // Đây là ca đã bị lọt ở vòng 2: khi change chỉ có `quote` (lấy từ bản đã
  // sửa), dòng gốc 'Người dùng nhập OTP.' bị coi là xoá-không-khai-báo và
  // validator từ chối gần như MỌI lần chạy thật, dù test cũ vẫn xanh vì được
  // dựng theo kịch bản nhân tạo. Với cả before + quote, ca sửa chữ đời thật
  // này phải trả về mảng rỗng.
  const original = 'Người dùng nhập OTP.\n';
  const revised = 'Người dùng nhập mã OTP gồm 6 chữ số.\n';
  const changes: DocChange[] = [
    {
      id: 'c1',
      kind: 'ux-writing',
      severity: 'minor',
      before: 'Người dùng nhập OTP.',
      quote: 'Người dùng nhập mã OTP gồm 6 chữ số.',
      reason: 'Nêu rõ định dạng OTP (6 chữ số) để người đọc không phải đoán.',
    },
  ];
  const errors = validateChanges(original, revised, changes);
  assert.deepEqual(errors, []);
});

test('validateChanges: cùng kịch bản sửa chữ thực tế nhưng change THIẾU `before` => phải báo lỗi dòng bị xoá', () => {
  const original = 'Người dùng nhập OTP.\n';
  const revised = 'Người dùng nhập mã OTP gồm 6 chữ số.\n';
  const changes: DocChange[] = [
    {
      id: 'c1',
      kind: 'ux-writing',
      severity: 'minor',
      quote: 'Người dùng nhập mã OTP gồm 6 chữ số.',
      reason: 'Nêu rõ định dạng OTP (6 chữ số) để người đọc không phải đoán.',
    },
  ];
  const errors = validateChanges(original, revised, changes);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /bị xoá/);
  assert.match(errors[0]!, /Người dùng nhập OTP/);
});

test('validateChanges: bổ sung thuần — change chỉ có `quote`, không có `before` => đạt', () => {
  const original = 'Dòng một.\n';
  const revised = 'Dòng một.\nDòng mới hoàn toàn, không thay thế dòng nào.\n';
  const changes: DocChange[] = [
    {
      id: 'c1',
      kind: 'gap',
      severity: 'minor',
      quote: 'Dòng mới hoàn toàn, không thay thế dòng nào.',
      reason: 'Bổ sung mô tả còn thiếu.',
    },
  ];
  const errors = validateChanges(original, revised, changes);
  assert.deepEqual(errors, []);
});

test('validateChanges: xoá thuần — change chỉ có `before` (kèm `anchor` định vị), không có `quote` => đạt', () => {
  const original = 'Dòng một.\nDòng cần xoá vì dư thừa.\nDòng ba.\n';
  const revised = 'Dòng một.\nDòng ba.\n';
  const changes: DocChange[] = [
    {
      id: 'c1',
      kind: 'gap',
      severity: 'minor',
      before: 'Dòng cần xoá vì dư thừa.',
      // `anchor` là bắt buộc với xoá thuần kể từ khi UI phải hiện được chỗ xoá
      // TRONG tài liệu: không có `quote`, đây là toạ độ duy nhất trong bản đã
      // sửa để đặt đoạn chữ bị xoá vào đúng vị trí của nó.
      anchor: 'Dòng ba.',
      reason: 'Nội dung dư thừa, không còn hợp lệ.',
    },
  ];
  const errors = validateChanges(original, revised, changes);
  assert.deepEqual(errors, []);
});

test('removePageOutputs deletes both the clone and its .changes.json for exactly one page, and is idempotent on a second call', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(join(conf, 'attachments'), { recursive: true });
  await writeFile(join(conf, 'a.md'), '![a](attachments/a.png)\n');
  await writeFile(join(conf, 'b.md'), '![b](attachments/b.png)\n');
  await cloneDocsForReview(cwd);
  await mkdir(join(cwd, 'review', 'docs', 'confluence'), { recursive: true });
  await writeFile(join(cwd, 'review', 'docs', 'confluence', 'a.changes.json'), '[]\n');
  await writeFile(join(cwd, 'review', 'docs', 'confluence', 'b.changes.json'), '[]\n');

  await removePageOutputs(cwd, 'docs/confluence/a.md');

  // Page a's clone + changes.json are gone…
  await assert.rejects(() => stat(join(cwd, 'review/docs/confluence/a.md')));
  await assert.rejects(() => stat(join(cwd, 'review/docs/confluence/a.changes.json')));
  // …page b's are untouched.
  await stat(join(cwd, 'review/docs/confluence/b.md'));
  await stat(join(cwd, 'review/docs/confluence/b.changes.json'));

  // Calling it again on an already-removed page must not throw.
  await removePageOutputs(cwd, 'docs/confluence/a.md');
});

test('mergeChangeReports builds index with correct shape/summary and lists failed pages in the digest', () => {
  const results: DocPageResult[] = [
    {
      slug: 'a',
      page: 'Trang A',
      docPath: 'docs/a.md',
      reviewPath: 'review/docs/a.md',
      status: 'succeeded',
      changes: [
        { id: 'c1', kind: 'ux-writing', severity: 'minor', quote: 'q1', reason: 'r1' },
        { id: 'c2', kind: 'gap', severity: 'blocker', quote: 'q2', reason: 'r2' },
      ],
      notes: [],
    },
    {
      slug: 'b',
      page: 'Trang B',
      docPath: 'docs/b.md',
      reviewPath: 'review/docs/b.md',
      status: 'failed',
      changes: [],
      notes: [],
      errors: ['quote không tìm thấy'],
    },
  ];
  const { index, summaryMd } = mergeChangeReports(results);
  const idx = index as any;
  assert.equal(idx.kind, 'docs-spec-review-index');
  assert.equal(idx.summary.pages, 2);
  assert.equal(idx.summary.changed_pages, 1);
  assert.equal(idx.summary.changes, 2);
  assert.equal(idx.summary.blockers, 1);
  assert.equal(idx.summary.minors, 1);
  assert.equal(idx.pages.find((p: any) => p.slug === 'a').changes, 2);
  assert.equal(idx.pages.find((p: any) => p.slug === 'b').status, 'failed');
  assert.match(summaryMd, /Trang chạy hỏng/);
  assert.match(summaryMd, /Trang B/);
  assert.match(summaryMd, /quote không tìm thấy/);
});

// SỬA LỖI VÒNG 3 — parseChangesFile: `JSON.parse(...) as DocChange[]` không
// kiểm tra gì lúc chạy; parseChangesFile là hàm kiểm shape thật sự.
test('parseChangesFile: rejects an element missing id/kind/severity/reason (a cast alone would have let this through)', () => {
  const result = parseChangesFile('[{"quote":"x"}]');
  assert.ok('errors' in result, 'expected an errors result, not changes');
  if ('errors' in result) {
    assert.ok(result.errors.length > 0);
    assert.match(result.errors.join(' '), /0/); // element index 0 named in the message
  }
});

test('parseChangesFile: rejects an unknown `kind` value', () => {
  const raw = JSON.stringify([
    { id: 'c1', kind: 'typo', severity: 'minor', quote: 'q', reason: 'r' },
  ]);
  const result = parseChangesFile(raw);
  assert.ok('errors' in result);
  if ('errors' in result) {
    assert.match(result.errors.join(' '), /kind/);
  }
});

test('parseChangesFile: rejects an unknown `severity` value', () => {
  const raw = JSON.stringify([
    { id: 'c1', kind: 'gap', severity: 'critical', quote: 'q', reason: 'r' },
  ]);
  const result = parseChangesFile(raw);
  assert.ok('errors' in result);
  if ('errors' in result) {
    assert.match(result.errors.join(' '), /severity/);
  }
});

test('parseChangesFile: a fully-populated, valid array parses to the same number of changes', () => {
  const raw = JSON.stringify([
    { id: 'c1', kind: 'ux-writing', severity: 'minor', before: 'b1', quote: 'q1', reason: 'r1' },
    { id: 'c2', kind: 'gap', severity: 'blocker', quote: 'q2', reason: 'r2' },
  ]);
  const result = parseChangesFile(raw);
  assert.ok('changes' in result, 'expected a changes result, not errors');
  if ('changes' in result) {
    assert.equal(result.changes.length, 2);
    assert.equal(result.changes[0]!.id, 'c1');
    assert.equal(result.changes[1]!.id, 'c2');
  }
});

test('parseChangesFile: rejects non-array JSON and invalid JSON alike', () => {
  const notArray = parseChangesFile('{"id":"c1"}');
  assert.ok('errors' in notArray);
  const notJson = parseChangesFile('not json at all');
  assert.ok('errors' in notJson);
});

// SỬA LỖI VÒNG 3 — cloneDocsForReview: docs/ có _index.md thì
// review/docs/_index.md PHẢI tồn tại và giống hệt bản gốc; _index.md KHÔNG
// nằm trong mảng đường dẫn trang mà hàm trả về. (Test tương đương cũng nằm ở
// khối cloneDocsForReview phía trên — lặp lại ở đây theo đúng câu chữ accept
// criteria để không phụ thuộc lẫn nhau.)
test('cloneDocsForReview (accept-criteria wording): _index.md exists in the clone, byte-identical, and is absent from the returned page paths', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(conf, { recursive: true });
  await writeFile(join(conf, 'page.md'), 'Nội dung trang.\n');
  const indexContent = '# Mục lục\n\n- [page](page.md)\n';
  await writeFile(join(conf, '_index.md'), indexContent);

  const written = await cloneDocsForReview(cwd);

  const clonedIndex = await readFile(join(cwd, 'review/docs/confluence/_index.md'), 'utf8');
  assert.equal(clonedIndex, indexContent);
  assert.ok(!written.some((p) => p.endsWith('_index.md')));
});

// SỬA LỖI VÒNG 4 — nền tảng của cả bug lẫn bản vá: đây là lý do tồn tại của
// quy ước "review-khong-chay-duoc.md nằm NGOÀI review/". Hai khẳng định dưới
// đây khoá đúng cặp đối lập: một đường dẫn CỐ TÌNH không khớp outputs của
// dr-review (an toàn để ghi khi stage vừa tuyên bố thất bại), đối lập với
// MỌI đường dẫn dưới review/ đều khớp — kể cả chỉ một file duy nhất.
test('stagesForOutput: review-khong-chay-duoc.md (NGANG HÀNG review/, không nằm trong nó) khớp KHÔNG stage nào', () => {
  assert.deepEqual(stagesForOutput('docs-review/review-khong-chay-duoc.md'), []);
});

test('stagesForOutput/deriveStateFromLocalFiles: NGƯỢC LẠI — bất kỳ file nào dưới review/ (kể cả chỉ review/summary.md) đều khớp dr-review và tự nó đủ để suy ra dr-review = succeeded', () => {
  assert.deepEqual(
    stagesForOutput('docs-review/review/summary.md').map((d) => d.id),
    ['dr-review'],
  );
  // Tín hiệu file chỉ cho biết có nội dung có thể preview. mergePipelineState
  // vẫn phải ưu tiên lần chạy hiện tại nếu nó running/failed, nên một file dở
  // không thể biến lượt chạy lỗi thành succeeded. Fan-out vẫn dọn output lỗi
  // để preview không hiển thị nội dung không hợp lệ.
  const state = deriveStateFromLocalFiles(['docs-review/review/summary.md']);
  assert.equal(state['dr-review']?.status, 'succeeded');
});

test('writeDocsReviewFailureNote wipes review/ completely and writes the note as a SIBLING of review/, not inside it', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(conf, { recursive: true });
  await writeFile(join(conf, 'a.md'), 'Trang A.\n');
  // Simulate a prior (broken) run that already left files under review/ —
  // the exact shape the bug produced: review/summary.md + a stray clone.
  await cloneDocsForReview(cwd);
  await writeFile(join(cwd, 'review', 'summary.md'), 'stale summary\n');
  await writeFile(join(cwd, 'review', 'index.json'), '{}\n');

  await writeDocsReviewFailureNote(cwd, '# Không chạy được\n');

  // review/ is gone — no index.json, no summary.md, no docs/ clone left.
  await assert.rejects(() => stat(join(cwd, 'review')));
  // The note lives OUTSIDE review/, at the run cwd root, using the shared
  // constant so server.ts and this test can't drift on the filename.
  assert.equal(DOCS_REVIEW_FAILURE_NOTE, 'review-khong-chay-duoc.md');
  const note = await readFile(join(cwd, DOCS_REVIEW_FAILURE_NOTE), 'utf8');
  assert.equal(note, '# Không chạy được\n');
  // …and that sibling path is confirmed above to match NO stage's outputs.
  assert.deepEqual(stagesForOutput(`docs-review/${DOCS_REVIEW_FAILURE_NOTE}`), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// PASS "section + notes": đơn vị fan-out nhỏ hơn (SECTION thay vì cả trang) và
// đường ra thứ hai cho phát hiện không sửa được bằng chữ (notes.json). Các test
// dưới đây được viết ĐỎ trước phần cài đặt tương ứng trong docs-review.ts.
// ─────────────────────────────────────────────────────────────────────────────

test('splitSections: tài liệu không có heading nào => đúng MỘT section index 0 phủ cả file', () => {
  const md = 'Chỉ là văn bản.\nKhông có tiêu đề.\n';
  const secs = splitSections(md);
  assert.equal(secs.length, 1);
  assert.equal(secs[0]!.index, 0);
  assert.equal(secs[0]!.heading, '');
  assert.equal(secs[0]!.startLine, 1);
  assert.equal(secs[0]!.endLine, 3); // 2 dòng chữ + dòng rỗng cuối do '\n' kết thúc
  assert.equal(secs[0]!.bodyLines, 2);
  assert.deepEqual(secs[0]!.imageRefs, []);
});

test('splitSections: phần trước heading đầu tiên (frontmatter + preamble) là section index 0 với heading rỗng', () => {
  const md = ['---', 'title: Trang A', '---', '', 'Mở đầu.', '', '# Mục 1', '', 'Nội dung 1.'].join('\n');
  const secs = splitSections(md, { minLines: 1 });
  assert.ok(secs.length >= 2);
  assert.equal(secs[0]!.heading, '');
  assert.equal(secs[0]!.startLine, 1);
  assert.equal(secs[1]!.heading, '# Mục 1');
  assert.equal(secs[1]!.startLine, 7);
  // index liên tục từ 0
  assert.deepEqual(secs.map((s) => s.index), secs.map((_, i) => i));
});

test('splitSections: BỎ QUA heading nằm trong fenced code block (``` và ~~~)', () => {
  const md = [
    '# Thật',            // 1
    '',                  // 2
    '```md',             // 3
    '# Giả trong fence', // 4
    '```',               // 5
    '',                  // 6
    '~~~',               // 7
    '## Giả nữa',        // 8
    '~~~',               // 9
    '',                  // 10
    '# Thật hai',        // 11
    'Nội dung.',         // 12
  ].join('\n');
  const secs = splitSections(md, { minLines: 1 });
  const headings = secs.map((s) => s.heading);
  assert.deepEqual(headings, ['# Thật', '# Thật hai']);
});

test('splitSections: gộp tham lam các block heading liên tiếp cho tới khi đạt minLines, heading là heading ĐẦU TIÊN của nhóm', () => {
  // Ba block, mỗi block 1 dòng nội dung. minLines = 3 => gộp cả ba thành một.
  const md = ['# A', 'a1', '# B', 'b1', '# C', 'c1'].join('\n');
  const merged = splitSections(md, { minLines: 3 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.heading, '# A');
  assert.equal(merged[0]!.startLine, 1);
  assert.equal(merged[0]!.endLine, 6);
  assert.equal(merged[0]!.bodyLines, 3); // a1 + b1 + c1, KHÔNG tính dòng heading

  // minLines = 1 => không gộp gì, ba section riêng.
  const split = splitSections(md, { minLines: 1 });
  assert.deepEqual(split.map((s) => s.heading), ['# A', '# B', '# C']);
});

test('splitSections: mặc định minLines = 120 nên một tài liệu ngắn nhiều heading gộp về một section', () => {
  const md = Array.from({ length: 10 }, (_, i) => `## Mục ${i}\nNội dung ${i}.`).join('\n');
  const secs = splitSections(md);
  assert.equal(secs.length, 1);
  assert.equal(secs[0]!.heading, '## Mục 0');
});

test('splitSections: section chỉ có heading, không có nội dung => bodyLines === 0 (tín hiệu "sơ đồ rỗng" mục 2.1/3.1)', () => {
  const md = ['## 2.1 Sơ đồ luồng', '', '## 2.2 Có nội dung', 'Một dòng thật.'].join('\n');
  const secs = splitSections(md, { minLines: 1 });
  const empty = secs.find((s) => s.heading === '## 2.1 Sơ đồ luồng');
  assert.ok(empty, 'phải có section cho 2.1');
  assert.equal(empty!.bodyLines, 0);
  const filled = secs.find((s) => s.heading === '## 2.2 Có nội dung');
  assert.equal(filled!.bodyLines, 1);
});

test('splitSections: imageRefs thu đúng đường dẫn ảnh NGUYÊN VĂN trong phạm vi từng section (kể cả tên file có khoảng trắng)', () => {
  const md = [
    '# Một',
    '![a](attachments/anh man hinh.png)',
    '# Hai',
    'Không ảnh.',
    '# Ba',
    '![b](../attachments/b.png) và ![c](attachments/c.png)',
  ].join('\n');
  const secs = splitSections(md, { minLines: 1 });
  assert.deepEqual(secs[0]!.imageRefs, ['attachments/anh man hinh.png']);
  assert.deepEqual(secs[1]!.imageRefs, []);
  assert.deepEqual(secs[2]!.imageRefs, ['../attachments/b.png', 'attachments/c.png']);
});

test('splitSections: startLine/endLine 1-based, endLine INCLUSIVE, các section phủ liền mạch cả file', () => {
  const md = ['Mở đầu.', '# A', 'a1', '# B', 'b1'].join('\n');
  const secs = splitSections(md, { minLines: 1 });
  const total = md.split(/\r?\n/).length;
  assert.equal(secs[0]!.startLine, 1);
  assert.equal(secs[secs.length - 1]!.endLine, total);
  for (let i = 1; i < secs.length; i += 1) {
    assert.equal(secs[i]!.startLine, secs[i - 1]!.endLine + 1, 'các section phải phủ liền mạch, không hở dòng');
  }
});

test('parseNotesFile: một note đầy đủ parse ra đúng số lượng', () => {
  const raw = JSON.stringify([
    {
      id: 'n1',
      kind: 'component',
      severity: 'major',
      rule_id: 'criteria/components.md#button',
      anchor: 'Người dùng nhấn nút OK',
      finding: 'Dùng biến thể button không có trong danh mục.',
      suggestion: 'Đổi sang biến thể primary trong bảng biến thể.',
    },
  ]);
  const result = parseNotesFile(raw);
  assert.ok('notes' in result, 'expected notes result, not errors');
  if ('notes' in result) {
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0]!.id, 'n1');
    assert.equal(result.notes[0]!.anchor, 'Người dùng nhấn nút OK');
  }
});

test('parseNotesFile: thiếu anchor / finding / suggestion là lỗi, thông báo nêu chỉ số phần tử và tên trường', () => {
  const result = parseNotesFile(JSON.stringify([{ id: 'n1', kind: 'flow', severity: 'major' }]));
  assert.ok('errors' in result);
  if ('errors' in result) {
    const joined = result.errors.join(' ');
    assert.match(joined, /0/);
    assert.match(joined, /anchor/);
    assert.match(joined, /finding/);
    assert.match(joined, /suggestion/);
  }
});

test('parseNotesFile: kind lạ và severity lạ đều bị bắt', () => {
  const badKind = parseNotesFile(
    JSON.stringify([{ id: 'n1', kind: 'typo', severity: 'minor', anchor: 'a b', finding: 'f', suggestion: 's' }]),
  );
  assert.ok('errors' in badKind);
  if ('errors' in badKind) assert.match(badKind.errors.join(' '), /kind/);

  const badSev = parseNotesFile(
    JSON.stringify([{ id: 'n1', kind: 'flow', severity: 'critical', anchor: 'a b', finding: 'f', suggestion: 's' }]),
  );
  assert.ok('errors' in badSev);
  if ('errors' in badSev) assert.match(badSev.errors.join(' '), /severity/);
});

test('parseNotesFile: rule_id tuỳ chọn nhưng phải là chuỗi khi có mặt', () => {
  const ok = parseNotesFile(
    JSON.stringify([{ id: 'n1', kind: 'flow', severity: 'minor', anchor: 'a b', finding: 'f', suggestion: 's' }]),
  );
  assert.ok('notes' in ok);
  const bad = parseNotesFile(
    JSON.stringify([
      { id: 'n1', kind: 'flow', severity: 'minor', rule_id: 7, anchor: 'a b', finding: 'f', suggestion: 's' },
    ]),
  );
  assert.ok('errors' in bad);
  if ('errors' in bad) assert.match(bad.errors.join(' '), /rule_id/);
});

test('parseNotesFile: JSON hỏng / không phải mảng => errors, đúng khuôn parseChangesFile', () => {
  assert.ok('errors' in parseNotesFile('not json at all'));
  assert.ok('errors' in parseNotesFile('{"id":"n1"}'));
});

test('validateNotes: anchor có trong bản GỐC => không lỗi; chịu được khác biệt khoảng trắng/xuống dòng', () => {
  const original = 'Người dùng nhấn nút OK để hoàn tất\ngiao dịch.\n';
  const notes: DocNote[] = [
    {
      id: 'n1',
      kind: 'component',
      severity: 'major',
      anchor: 'nhấn nút OK để hoàn tất giao dịch',
      finding: 'f',
      suggestion: 's',
    },
  ];
  assert.deepEqual(validateNotes(original, notes), []);
});

test('validateNotes: anchor không có trong bản gốc => lỗi nêu id và anchor', () => {
  const errors = validateNotes('Nội dung gốc.\n', [
    { id: 'n9', kind: 'flow', severity: 'blocker', anchor: 'câu hoàn toàn không tồn tại', finding: 'f', suggestion: 's' },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /n9/);
  assert.match(errors[0]!, /câu hoàn toàn không tồn tại/);
});

test('validateNotes: mảng rỗng trả về mảng rỗng, và KHÔNG chạy line-multiset (note không sửa gì nên bản gốc dư dòng không phải lỗi)', () => {
  assert.deepEqual(validateNotes('a\nb\nc\n', []), []);
  // Ngay cả khi note phủ đúng một dòng, validateNotes cũng không quan tâm dòng
  // nào thêm/xoá — đó là việc của validateChanges.
  assert.deepEqual(
    validateNotes('Dòng một.\nDòng hai.\n', [
      { id: 'n1', kind: 'gap', severity: 'minor', anchor: 'Dòng hai.', finding: 'f', suggestion: 's' },
    ]),
    [],
  );
});

test('findReviewMarkers: phát hiện dòng bị chèn "[Rà soát …]" trong bản đã sửa, trả về dòng đã trim', () => {
  const revised = ['| Cột A | Cột B |', '| x | y [Rà soát — thiếu state rỗng] |', '  [ Rà soát ] lệch hoa thường  '].join('\n');
  const hits = findReviewMarkers(revised);
  assert.equal(hits.length, 2);
  assert.match(hits[0]!, /Rà soát/);
  assert.equal(hits[1]!, '[ Rà soát ] lệch hoa thường');
});

test('findReviewMarkers: bản đã sửa sạch => mảng rỗng', () => {
  assert.deepEqual(findReviewMarkers('Nội dung bình thường.\nKhông có chú giải nào.\n'), []);
});

test('collectCriteriaAnchors: trích anchor từ heading dạng `R-OVERLAY` và `#button` (bỏ dấu # đứng đầu)', () => {
  const anchors = collectCriteriaAnchors([
    { name: 'rules.md', text: '# Bộ rule\n\n## `R-OVERLAY` Khi nào dùng overlay\n\n## `R-TABLE-PIN` Ghim cột\n' },
    { name: 'components.md', text: '# Danh mục\n\n### `#button` Button\n\n### `#modal` Modal\n' },
  ]);
  assert.ok(anchors.has('criteria/rules.md#R-OVERLAY'));
  assert.ok(anchors.has('criteria/rules.md#R-TABLE-PIN'));
  assert.ok(anchors.has('criteria/components.md#button'));
  assert.ok(anchors.has('criteria/components.md#modal'));
  // Token trong backtick ở dòng KHÔNG phải heading thì không thành anchor.
  assert.ok(!anchors.has('criteria/rules.md#Bộ'));
});

test('collectCriteriaAnchors: mảng rỗng => Set rỗng', () => {
  assert.equal(collectCriteriaAnchors([]).size, 0);
});

test('validateRuleIds: anchors rỗng (không có criteria/) => bỏ qua hoàn toàn', () => {
  const errors = validateRuleIds(
    [{ id: 'c1', kind: 'flow', rule_id: 'criteria/rules.md#KHONG-TON-TAI' }],
    new Set<string>(),
  );
  assert.deepEqual(errors, []);
});

test('validateRuleIds: rule_id vắng mặt => hợp lệ (đang dùng bộ tiêu chí mặc định)', () => {
  const anchors = new Set(['criteria/rules.md#R-OVERLAY']);
  assert.deepEqual(validateRuleIds([{ id: 'c1', kind: 'flow' }], anchors), []);
});

test('validateRuleIds: rule_id không nằm trong anchors => lỗi nêu id và rule_id', () => {
  const anchors = new Set(['criteria/rules.md#R-OVERLAY']);
  const errors = validateRuleIds([{ id: 'c7', kind: 'flow', rule_id: 'criteria/rules.md#R-BIA-RA' }], anchors);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /c7/);
  assert.match(errors[0]!, /R-BIA-RA/);
});

test('validateRuleIds: rule_id trỏ components.md chỉ hợp lệ trên kind=component', () => {
  const anchors = new Set(['criteria/components.md#button']);
  assert.deepEqual(
    validateRuleIds([{ id: 'c1', kind: 'component', rule_id: 'criteria/components.md#button' }], anchors),
    [],
  );
  const errors = validateRuleIds(
    [{ id: 'c2', kind: 'ux-writing', rule_id: 'criteria/components.md#button' }],
    anchors,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /c2/);
  assert.match(errors[0]!, /DANH MỤC|danh mục/);
});

test('removePageOutputs xoá cả notes.json lẫn MỌI file tạm .s<NN>.changes.json / .s<NN>.notes.json của trang, không đụng trang khác, gọi hai lần không lỗi', async () => {
  const conf = join(cwd, 'docs', 'confluence');
  await mkdir(conf, { recursive: true });
  await writeFile(join(conf, 'a.md'), 'Trang A.\n');
  await writeFile(join(conf, 'b.md'), 'Trang B.\n');
  await cloneDocsForReview(cwd);
  const dir = join(cwd, 'review', 'docs', 'confluence');
  await mkdir(dir, { recursive: true });
  for (const name of [
    'a.changes.json',
    'a.notes.json',
    'a.s00.changes.json',
    'a.s00.notes.json',
    'a.s01.changes.json',
    'a.s12.notes.json',
    'b.changes.json',
    'b.notes.json',
    'b.s00.changes.json',
    'b.s00.notes.json',
  ]) {
    await writeFile(join(dir, name), '[]\n');
  }

  await removePageOutputs(cwd, 'docs/confluence/a.md');

  for (const gone of [
    'a.md',
    'a.changes.json',
    'a.notes.json',
    'a.s00.changes.json',
    'a.s00.notes.json',
    'a.s01.changes.json',
    'a.s12.notes.json',
  ]) {
    await assert.rejects(() => stat(join(dir, gone)), `${gone} phải bị xoá`);
  }
  // Trang b nguyên vẹn — kể cả file tạm theo section của nó.
  for (const kept of ['b.md', 'b.changes.json', 'b.notes.json', 'b.s00.changes.json', 'b.s00.notes.json']) {
    await stat(join(dir, kept));
  }

  await removePageOutputs(cwd, 'docs/confluence/a.md');
});

test('mergeChangeReports: đếm note vào index.json (summary.notes + pages[].notes) và in mục nhận xét trong summary.md, GIỮ NGUYÊN mọi trường sẵn có', () => {
  const results: DocPageResult[] = [
    {
      slug: 'a',
      page: 'Trang A',
      docPath: 'docs/a.md',
      reviewPath: 'review/docs/a.md',
      status: 'succeeded',
      changes: [{ id: 'c1', kind: 'ux-writing', severity: 'minor', quote: 'q1', reason: 'r1' }],
      notes: [
        {
          id: 'n1',
          kind: 'component',
          severity: 'major',
          rule_id: 'criteria/components.md#modal',
          anchor: 'Hiện hộp thoại xác nhận',
          finding: 'Dùng Modal cho tác vụ dài, sai R-OVERLAY.',
          suggestion: 'Chuyển sang Drawer hoặc một màn riêng.',
        },
        {
          id: 'n2',
          kind: 'gap',
          severity: 'blocker',
          anchor: '2.1 Sơ đồ luồng',
          finding: 'Heading tồn tại nhưng không có nội dung.',
          suggestion: 'Bổ sung sơ đồ luồng cho mục này.',
        },
      ],
    },
    {
      slug: 'b',
      page: 'Trang B',
      docPath: 'docs/b.md',
      reviewPath: 'review/docs/b.md',
      status: 'succeeded',
      changes: [],
      notes: [],
    },
  ];
  const { index, summaryMd } = mergeChangeReports(results);
  const idx = index as any;
  // Trường mới…
  assert.equal(idx.summary.notes, 2);
  assert.equal(idx.pages.find((p: any) => p.slug === 'a').notes, 2);
  assert.equal(idx.pages.find((p: any) => p.slug === 'b').notes, 0);
  // …và mọi trường sẵn có vẫn còn.
  assert.equal(idx.schema_version, '1.0');
  assert.equal(idx.kind, 'docs-spec-review-index');
  assert.equal(idx.summary.pages, 2);
  assert.equal(idx.summary.changed_pages, 1);
  assert.equal(idx.summary.changes, 1);
  assert.equal(idx.summary.blockers, 0);
  assert.equal(idx.summary.majors, 0);
  assert.equal(idx.summary.minors, 1);
  const pa = idx.pages.find((p: any) => p.slug === 'a');
  assert.equal(pa.page, 'Trang A');
  assert.equal(pa.doc_path, 'docs/a.md');
  assert.equal(pa.review_path, 'review/docs/a.md');
  assert.equal(pa.changes, 1);
  assert.equal(pa.status, 'succeeded');

  // summary.md: dòng tổng, cột bảng, và mục nhận xét đủ chi tiết.
  assert.match(summaryMd, /2 nhận xét/);
  assert.match(summaryMd, /\| Nhận xét \|/);
  assert.match(summaryMd, /## Nhận xét \(không sửa trực tiếp\)/);
  assert.match(summaryMd, /Dùng Modal cho tác vụ dài, sai R-OVERLAY\./);
  assert.match(summaryMd, /Chuyển sang Drawer hoặc một màn riêng\./);
  assert.match(summaryMd, /criteria\/components\.md#modal/);
  assert.match(summaryMd, /Heading tồn tại nhưng không có nội dung\./);
});

// ---------------------------------------------------------------------------
// anchor + doc_refs (định vị change/note vào bản đã sửa) và bộ rule_id mặc
// định. Cả hai nhóm sinh ra từ output thật: change XOÁ THUẦN không có toạ độ
// nào trong bản đã sửa nên UI không hiện được chỗ xoá, và `reason` viện dẫn
// chỗ khác trong tài liệu bằng lời ("như luồng F-009 mô tả") nên người đọc
// phải tự đi tìm.
// ---------------------------------------------------------------------------

test('parseChangesFile: nhận change có `anchor` chuỗi + `doc_refs` mảng ≤3 chuỗi', () => {
  const raw = JSON.stringify([
    {
      id: 'c1',
      kind: 'ux-writing',
      severity: 'minor',
      rule_id: 'default#ux-writing-thuat-ngu',
      before: 'b1',
      quote: 'q1',
      anchor: 'câu liền trước chỗ xoá',
      doc_refs: ['đoạn định nghĩa thuật ngữ', 'F-009 Người dùng xác nhận', 'ô Mục đích'],
      reason: 'r1',
    },
  ]);
  const result = parseChangesFile(raw);
  assert.ok('changes' in result, 'expected a changes result, not errors');
  if ('changes' in result) {
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0]!.anchor, 'câu liền trước chỗ xoá');
    assert.deepEqual(result.changes[0]!.doc_refs, [
      'đoạn định nghĩa thuật ngữ',
      'F-009 Người dùng xác nhận',
      'ô Mục đích',
    ]);
  }
});

test('parseChangesFile: `anchor` không phải chuỗi => lỗi nêu tên trường', () => {
  const raw = JSON.stringify([
    { id: 'c1', kind: 'gap', severity: 'minor', before: 'b', anchor: 42, reason: 'r' },
  ]);
  const result = parseChangesFile(raw);
  assert.ok('errors' in result);
  if ('errors' in result) assert.match(result.errors.join(' '), /anchor/);
});

test('parseChangesFile: `doc_refs` không phải mảng chuỗi => lỗi (cả ca không-phải-mảng và ca phần tử rỗng)', () => {
  const notArray = parseChangesFile(
    JSON.stringify([{ id: 'c1', kind: 'gap', severity: 'minor', quote: 'q', doc_refs: 'một chuỗi', reason: 'r' }]),
  );
  assert.ok('errors' in notArray);
  if ('errors' in notArray) assert.match(notArray.errors.join(' '), /doc_refs/);

  const badElem = parseChangesFile(
    JSON.stringify([{ id: 'c1', kind: 'gap', severity: 'minor', quote: 'q', doc_refs: ['ok', '   '], reason: 'r' }]),
  );
  assert.ok('errors' in badElem);
  if ('errors' in badElem) assert.match(badElem.errors.join(' '), /doc_refs\[1\]/);

  const nonString = parseChangesFile(
    JSON.stringify([{ id: 'c1', kind: 'gap', severity: 'minor', quote: 'q', doc_refs: ['ok', 7], reason: 'r' }]),
  );
  assert.ok('errors' in nonString);
  if ('errors' in nonString) assert.match(nonString.errors.join(' '), /doc_refs\[1\]/);
});

test('parseChangesFile: `doc_refs` quá 3 phần tử => lỗi "tối đa 3 tham chiếu"', () => {
  const raw = JSON.stringify([
    { id: 'c1', kind: 'gap', severity: 'minor', quote: 'q', doc_refs: ['a', 'b', 'c', 'd'], reason: 'r' },
  ]);
  const result = parseChangesFile(raw);
  assert.ok('errors' in result);
  if ('errors' in result) assert.match(result.errors.join(' '), /'doc_refs' tối đa 3 tham chiếu/);
});

test('parseNotesFile: `doc_refs` cùng luật — mảng ≤3 chuỗi thì đạt, 4 phần tử / phần tử không phải chuỗi thì lỗi', () => {
  const ok = parseNotesFile(
    JSON.stringify([
      {
        id: 'n1',
        kind: 'flow',
        severity: 'major',
        anchor: 'Người dùng nhấn Xác nhận',
        doc_refs: ['F-009 Người dùng xác nhận'],
        finding: 'f',
        suggestion: 's',
      },
    ]),
  );
  assert.ok('notes' in ok, 'expected notes result, not errors');
  if ('notes' in ok) assert.deepEqual(ok.notes[0]!.doc_refs, ['F-009 Người dùng xác nhận']);

  const tooMany = parseNotesFile(
    JSON.stringify([
      {
        id: 'n1',
        kind: 'flow',
        severity: 'major',
        anchor: 'a b',
        doc_refs: ['a', 'b', 'c', 'd'],
        finding: 'f',
        suggestion: 's',
      },
    ]),
  );
  assert.ok('errors' in tooMany);
  if ('errors' in tooMany) assert.match(tooMany.errors.join(' '), /'doc_refs' tối đa 3 tham chiếu/);

  const badElem = parseNotesFile(
    JSON.stringify([
      { id: 'n1', kind: 'flow', severity: 'major', anchor: 'a b', doc_refs: [null], finding: 'f', suggestion: 's' },
    ]),
  );
  assert.ok('errors' in badElem);
  if ('errors' in badElem) assert.match(badElem.errors.join(' '), /doc_refs\[0\]/);
});

test('validateChanges: xoá thuần THIẾU `anchor` => lỗi (không có toạ độ nào trong bản đã sửa để UI hiện chỗ xoá)', () => {
  const original = 'Dòng một.\nDòng cần xoá vì dư thừa.\nDòng ba.\n';
  const revised = 'Dòng một.\nDòng ba.\n';
  const errors = validateChanges(original, revised, [
    {
      id: 'c1',
      kind: 'gap',
      severity: 'minor',
      before: 'Dòng cần xoá vì dư thừa.',
      reason: 'Nội dung dư thừa, không còn hợp lệ.',
    },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /c1/);
  assert.match(errors[0]!, /xoá thuần nhưng thiếu 'anchor'/);
});

test('validateChanges: xoá thuần CÓ `anchor` tồn tại trong bản đã sửa => đạt (dòng xoá vẫn do `before` phủ như cũ)', () => {
  const original = 'Dòng một.\nDòng cần xoá vì dư thừa.\nDòng ba.\n';
  const revised = 'Dòng một.\nDòng ba.\n';
  const errors = validateChanges(original, revised, [
    {
      id: 'c1',
      kind: 'gap',
      severity: 'minor',
      before: 'Dòng cần xoá vì dư thừa.',
      anchor: 'Dòng một.',
      reason: 'Nội dung dư thừa, không còn hợp lệ.',
    },
  ]);
  assert.deepEqual(errors, []);
});

test('validateChanges: `anchor` không tìm thấy trong bản đã sửa => lỗi (kể cả trên change sửa/thay bình thường)', () => {
  const original = 'Người dùng nhập OTP.\n';
  const revised = 'Người dùng nhập mã OTP gồm 6 chữ số.\n';
  const errors = validateChanges(original, revised, [
    {
      id: 'c1',
      kind: 'ux-writing',
      severity: 'minor',
      before: 'Người dùng nhập OTP.',
      quote: 'Người dùng nhập mã OTP gồm 6 chữ số.',
      anchor: 'câu neo hoàn toàn không tồn tại',
      reason: 'Không nêu định dạng OTP.',
    },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /c1/);
  assert.match(errors[0]!, /anchor không tìm thấy trong bản đã sửa/);
  assert.match(errors[0]!, /câu neo hoàn toàn không tồn tại/);
});

test('validateChanges: phần tử `doc_refs` không có trong bản đã sửa => lỗi nêu id và nguyên văn đoạn', () => {
  const original = 'Dòng một.\nNgười dùng nhập OTP.\n';
  const revised = 'Dòng một.\nNgười dùng nhập mã OTP gồm 6 chữ số.\n';
  const errors = validateChanges(original, revised, [
    {
      id: 'c3',
      kind: 'ux-writing',
      severity: 'minor',
      before: 'Người dùng nhập OTP.',
      quote: 'Người dùng nhập mã OTP gồm 6 chữ số.',
      doc_refs: ['Dòng một.', 'đoạn viện dẫn không hề có trong tài liệu'],
      reason: 'Không nêu định dạng OTP.',
    },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /c3/);
  assert.match(errors[0]!, /doc_ref không tìm thấy trong bản đã sửa/);
  assert.match(errors[0]!, /đoạn viện dẫn không hề có trong tài liệu/);
});

test('validateChanges: `doc_refs` hợp lệ => đạt, NHƯNG nó KHÔNG phủ được dòng thêm/xoá (neo định vị, không phải khai báo sửa)', () => {
  // Đạt: mọi doc_ref đều có thật trong bản đã sửa.
  const original = 'Đoạn định nghĩa thuật ngữ ví điện tử.\nNgười dùng nhập OTP.\n';
  const revised = 'Đoạn định nghĩa thuật ngữ ví điện tử.\nNgười dùng nhập mã OTP gồm 6 chữ số.\n';
  assert.deepEqual(
    validateChanges(original, revised, [
      {
        id: 'c1',
        kind: 'ux-writing',
        severity: 'minor',
        before: 'Người dùng nhập OTP.',
        quote: 'Người dùng nhập mã OTP gồm 6 chữ số.',
        doc_refs: ['Đoạn định nghĩa thuật ngữ ví điện tử.'],
        reason: 'Không nêu định dạng OTP nên người đọc phải đoán.',
      },
    ]),
    [],
  );

  // KHÔNG phủ: một dòng MỚI trong bản đã sửa trùng đúng nguyên văn một
  // doc_ref, nhưng không nằm trong `quote` nào => vẫn phải bị báo là sửa
  // không khai báo. Nếu doc_refs được tính vào phép phủ thì agent chỉ cần
  // trích câu lân cận là mọi sửa đổi không khai báo quanh đó lọt hết.
  const errors = validateChanges('Dòng một.\n', 'Dòng một.\nDòng thêm không khai báo.\n', [
    {
      id: 'c1',
      kind: 'gap',
      severity: 'minor',
      quote: 'Dòng một.',
      doc_refs: ['Dòng thêm không khai báo.'],
      reason: 'Neo tham chiếu, không phải khai báo sửa.',
    },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /không có change\.quote nào khai báo/);
  assert.match(errors[0]!, /Dòng thêm không khai báo/);

  // Cùng lý do ở chiều XOÁ: `anchor` trùng nguyên văn dòng bị xoá cũng không
  // được phủ thay cho `before`.
  const deleted = validateChanges('Dòng một.\nDòng bị xoá lặng lẽ.\n', 'Dòng một.\n', [
    {
      id: 'c1',
      kind: 'gap',
      severity: 'minor',
      quote: 'Dòng một.',
      anchor: 'Dòng một.',
      reason: 'Neo định vị, không phải khai báo xoá.',
    },
  ]);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0]!, /không có change\.before nào khai báo/);
  assert.match(deleted[0]!, /Dòng bị xoá lặng lẽ/);
});

test('validateNotes: phần tử `doc_refs` không có trong bản GỐC => lỗi; có thật => đạt', () => {
  const original = 'Luồng F-009 Người dùng xác nhận giao dịch.\nNgười dùng nhấn nút OK.\n';
  const ok: DocNote[] = [
    {
      id: 'n1',
      kind: 'flow',
      severity: 'major',
      anchor: 'Người dùng nhấn nút OK.',
      doc_refs: ['Luồng F-009 Người dùng xác nhận giao dịch.'],
      finding: 'f',
      suggestion: 's',
    },
  ];
  assert.deepEqual(validateNotes(original, ok), []);

  const errors = validateNotes(original, [
    {
      id: 'n2',
      kind: 'flow',
      severity: 'major',
      anchor: 'Người dùng nhấn nút OK.',
      doc_refs: ['luồng F-999 không hề tồn tại trong tài liệu'],
      finding: 'f',
      suggestion: 's',
    },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /n2/);
  assert.match(errors[0]!, /doc_ref không tìm thấy trong bản gốc/);
  assert.match(errors[0]!, /luồng F-999 không hề tồn tại trong tài liệu/);
});

test('validateRuleIds: rule_id `default#…` được kiểm CẢ KHI anchors rỗng — id có thật thì đạt, id bịa thì lỗi', () => {
  const empty = new Set<string>();
  const withAnchors = new Set(['criteria/rules.md#R-OVERLAY']);

  // Bộ mặc định nằm trong SKILL.md, không nằm trong criteria/ => không phụ
  // thuộc việc dự án có upload criteria hay không.
  assert.deepEqual(validateRuleIds([{ id: 'c1', kind: 'flow', rule_id: 'default#flow' }], empty), []);
  assert.deepEqual(validateRuleIds([{ id: 'c1', kind: 'flow', rule_id: 'default#flow' }], withAnchors), []);

  for (const anchors of [empty, withAnchors]) {
    const errors = validateRuleIds([{ id: 'c9', kind: 'flow', rule_id: 'default#khong-ton-tai' }], anchors);
    assert.equal(errors.length, 1, 'default# bịa phải bị bắt bất kể có criteria/ hay không');
    assert.match(errors[0]!, /c9/);
    assert.match(errors[0]!, /rule_id mặc định không tồn tại/);
    assert.match(errors[0]!, /default#khong-ton-tai/);
    // Thông báo liệt kê bộ hợp lệ để agent tự sửa được.
    assert.match(errors[0]!, /default#ux-writing-chu-ngu/);
  }
});

test('validateRuleIds: cả 7 id trong DEFAULT_RULE_IDS đều hợp lệ (khớp 1-1 với bộ tiêu chí mặc định trong SKILL.md)', () => {
  assert.equal(DEFAULT_RULE_IDS.size, 7);
  const entries = [...DEFAULT_RULE_IDS].map((rule_id, i) => ({
    id: `c${i}`,
    kind: 'flow' as const,
    rule_id,
  }));
  assert.deepEqual(validateRuleIds(entries, new Set<string>()), []);
  assert.deepEqual(validateRuleIds(entries, new Set(['criteria/rules.md#R-OVERLAY'])), []);
});

test('validateRuleIds: hành vi cũ GIỮ NGUYÊN — rule_id dạng criteria/* với anchors rỗng vẫn được bỏ qua', () => {
  assert.deepEqual(
    validateRuleIds(
      [
        { id: 'c1', kind: 'flow', rule_id: 'criteria/rules.md#KHONG-TON-TAI' },
        // components.md trên kind khác cũng không bị bắt khi thiếu criteria/.
        { id: 'c2', kind: 'ux-writing', rule_id: 'criteria/components.md#button' },
        { id: 'c3', kind: 'gap' },
      ],
      new Set<string>(),
    ),
    [],
  );
});

// ── Lát cắt theo section: cắt rồi ghép phải ra ĐÚNG trang ban đầu ────────────
// Đây là bất biến giữ cho việc chạy song song an toàn. Nếu các section do
// splitSections sinh ra không phủ kín hoặc chồng lấn, phép ghép sẽ làm MẤT hoặc
// NHÂN ĐÔI nội dung tài liệu của người dùng — và triệu chứng sẽ hiện ra ở tận
// validateChanges dưới dạng "dòng bị xoá không khai báo", rất khó lần ngược về
// nguyên nhân thật. Nên nó được khoá ở đây, ngay tại chỗ.

const PAGE_MD = [
  '---',
  'title: URD Quản lý nhân viên',
  '---',
  '',
  'Mở đầu không có heading.',
  '',
  '# 1. Tổng quan',
  '',
  'Nội dung tổng quan.',
  '',
  '## 1.1 Phạm vi',
  '',
  '| Cột | Giá trị |',
  '| --- | --- |',
  '| Mã | F-001 |',
  '',
  '## 1.2 Sơ đồ luồng',
  '',
  '# 2. Giao diện',
  '',
  '![Màn hình](attachments/scr-001.png)',
  '',
].join('\n');

test('sliceSections + rebuildPageFromSlices dựng lại NGUYÊN VĂN trang ban đầu', () => {
  const sections = splitSections(PAGE_MD);
  const slices = sliceSections(PAGE_MD, sections);
  assert.equal(slices.length, sections.length);
  assert.equal(rebuildPageFromSlices(slices, detectEol(PAGE_MD)), PAGE_MD);
});

test('sliceSections: các lát phủ kín và không chồng lấn (mỗi dòng thuộc đúng một lát)', () => {
  const sections = splitSections(PAGE_MD);
  const slices = sliceSections(PAGE_MD, sections);
  const totalLines = slices.reduce((n, s) => n + s.split('\n').length, 0);
  assert.equal(totalLines, PAGE_MD.split('\n').length);
  // Heading mở đầu của từng lát phải khớp heading section khai báo.
  sections.forEach((sec, i) => {
    if (!sec.heading) return;
    assert.equal(slices[i]!.split('\n')[0], sec.heading);
  });
});

test('sliceSections giữ nguyên kiểu xuống dòng CRLF (không âm thầm đổi cả file)', () => {
  const crlf = PAGE_MD.replace(/\n/g, '\r\n');
  const sections = splitSections(crlf);
  const rebuilt = rebuildPageFromSlices(sliceSections(crlf, sections), detectEol(crlf));
  assert.equal(rebuilt, crlf);
  assert.equal(detectEol(crlf), '\r\n');
});

test('sliceSections: một lát đã SỬA chỉ ảnh hưởng phần của nó khi ghép', () => {
  const sections = splitSections(PAGE_MD);
  const slices = sliceSections(PAGE_MD, sections);
  const target = slices.findIndex((s) => s.includes('Nội dung tổng quan.'));
  assert.notEqual(target, -1);
  slices[target] = slices[target]!.replace('Nội dung tổng quan.', 'Nội dung tổng quan đã viết lại.');
  const rebuilt = rebuildPageFromSlices(slices, '\n');
  assert.ok(rebuilt.includes('Nội dung tổng quan đã viết lại.'));
  // Mọi phần khác còn nguyên.
  assert.ok(rebuilt.includes('| Mã | F-001 |'));
  assert.ok(rebuilt.includes('![Màn hình](attachments/scr-001.png)'));
  assert.ok(rebuilt.startsWith('---\ntitle: URD Quản lý nhân viên'));
});

test('sectionSlicePath đệm 0 hai chữ số, cùng khuôn sectionOutputPath', () => {
  assert.equal(sectionSlicePath('review/docs/confluence/a.md', 3), 'review/docs/confluence/a.s03.slice.md');
  assert.equal(sectionSlicePath('review/docs/a.md', 12), 'review/docs/a.s12.slice.md');
});

test('removePageOutputs dọn luôn file lát cắt .s<NN>.slice.md', async () => {
  const dir = join(cwd, 'review', 'docs', 'confluence');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'x.md'), '# x\n', 'utf8');
  await writeFile(join(dir, 'x.s00.slice.md'), '# x\n', 'utf8');
  await writeFile(join(dir, 'x.s01.slice.md'), 'body\n', 'utf8');
  await writeFile(join(dir, 'x.s00.changes.json'), '[]', 'utf8');

  await removePageOutputs(cwd, 'docs/confluence/x.md');

  for (const name of ['x.md', 'x.s00.slice.md', 'x.s01.slice.md', 'x.s00.changes.json']) {
    await assert.rejects(() => stat(join(dir, name)), `${name} phải bị xoá`);
  }
});

test('listDocPages and cloneDocsForReview prefer docs-feature and preserve its root', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'od-docs-feature-'));
  await mkdir(join(cwd, 'docs-feature'), { recursive: true });
  await writeFile(join(cwd, 'docs-feature', 'feature.md'), '# Feature');
  await mkdir(join(cwd, 'docs'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'legacy.md'), '# Legacy');
  const pages = await listDocPages(cwd);
  assert.deepEqual(pages.map((p) => p.mdPath), ['docs-feature/feature.md']);
  assert.deepEqual(await cloneDocsForReview(cwd), ['review/docs-feature/feature.md']);
  assert.equal(await readFile(join(cwd, 'review/docs-feature/feature.md'), 'utf8'), '# Feature');
  await rm(cwd, { recursive: true, force: true });
});

test('pageOutlinePath sits next to the slices: <clone>.outline.md', () => {
  assert.equal(pageOutlinePath('review/docs/confluence/a.md'), 'review/docs/confluence/a.outline.md');
  assert.equal(pageOutlinePath('review/docs-feature/App/x/y.MD'), 'review/docs-feature/App/x/y.outline.md');
});

test('renderPageOutline lists every section with its line range and flags, names the slice pattern, and never copies body text', () => {
  const md = [
    '---',
    'title: Trang A',
    '---',
    'Mở đầu nói về CIF và KH.',
    '# 1. Tổng quan',
    'Nội dung tổng quan dòng 6.',
    '## 2. Sơ đồ luồng',
    '## 3. Màn hình',
    'Có ảnh ![m](attachments/a.png) ở đây.',
    'Thêm dòng nữa.',
  ].join('\n');
  const sections = splitSections(md, { minLines: 1 });
  const out = renderPageOutline({
    page: 'Trang A',
    mdPath: 'docs/confluence/a.md',
    reviewRel: 'review/docs/confluence/a.md',
    totalLines: md.split('\n').length,
    sections,
  });
  assert.match(out, /^# Mục lục trang: Trang A/m);
  assert.match(out, /`docs\/confluence\/a\.md` — 10 dòng, \d+ section/);
  assert.match(out, /review\/docs\/confluence\/a\.s<NN>\.slice\.md/);
  // One line per section, in index order, with 1-based inclusive ranges.
  for (const sec of sections) {
    const nn = String(sec.index).padStart(2, '0');
    const re = new RegExp(`^- s${nn}  dòng ${sec.startLine}–${sec.endLine}  `, 'm');
    assert.match(out, re, `section ${nn} listed`);
  }
  // Empty heading is flagged, image count is flagged.
  const empty = sections.find((s) => s.bodyLines === 0);
  const withImg = sections.find((s) => s.imageRefs.length > 0);
  assert.ok(empty && withImg, 'fixture has an empty section and an image section');
  assert.match(out, /RỖNG — chỉ có tiêu đề/);
  assert.match(out, /\[.*1 ảnh.*\]/);
  // Structure only: no body sentence leaks into the outline.
  assert.doesNotMatch(out, /Nội dung tổng quan/);
  assert.doesNotMatch(out, /Thêm dòng nữa/);
  // The reading rule the kickoff relies on is spelled out in the file itself.
  assert.match(out, /KHÔNG đọc cả trang/);
});

// ── NFC/NBSP + note neo trượt (đo thật trên PRD "Mua SIM du lịch" 2026-08-18) ──
// Tài liệu Confluence nạp về là bản TRỘN NFC/NFD, có  ; agent viết NFC và
// khoảng trắng thường → 2 note trượt anchor → cả trang bị fail-shut, 13 section
// đã chạy bị xoá. Từ nay: so khớp sau NFC; note neo trượt là CẢNH BÁO, giữ note.
test('fuzzyIncludes: bản gốc NFD + NBSP, needle NFC + khoảng trắng thường => vẫn khớp', async () => {
  const { fuzzyIncludes } = await import('../src/docs-review.js');
  const nfd = 'Nhóm 1: Điểm Đến & Phân Loại'.normalize('NFD');
  const original = `| BR-01 | ${nfd} | Digilife (2)  đợi API NCC |\n`;
  assert.ok(fuzzyIncludes(original, 'Nhóm 1: Điểm Đến & Phân Loại'));
  assert.ok(fuzzyIncludes(original, 'Digilife (2)  đợi API NCC'));
  assert.ok(!fuzzyIncludes(original, 'Digilife (3) đợi API NCC'));
});

test('partitionNotesByAnchor: anchor trượt → giữ note + anchor_unresolved + cảnh báo; doc_ref trượt bị bỏ; thiếu anchor mới là lỗi', async () => {
  const { partitionNotesByAnchor } = await import('../src/docs-review.js');
  const original = 'Dòng một có Điểm Đến.\nDòng hai.\n';
  const base = { kind: 'gap' as const, severity: 'minor' as const, finding: 'f', suggestion: 's' };
  const r = partitionNotesByAnchor(original, [
    { id: 'n1', anchor: 'Dòng một có Điểm Đến.'.normalize('NFD'), ...base },
    { id: 'n2', anchor: 'Không có trong bản gốc', doc_refs: ['Dòng hai.', 'cũng không có'], ...base },
    { id: 'n3', anchor: '   ', ...base },
  ]);
  assert.deepEqual(r.notes.map((n) => n.id), ['n1', 'n2']);
  assert.equal(r.notes[0]!.anchor_unresolved, undefined);
  assert.equal(r.notes[1]!.anchor_unresolved, true);
  assert.deepEqual(r.notes[1]!.doc_refs, ['Dòng hai.']);
  assert.equal(r.warnings.length, 2, r.warnings.join('\n'));
  assert.ok(r.warnings[0]!.includes('n2') && r.warnings[0]!.includes('anchor'));
  assert.ok(r.warnings[1]!.includes('doc_ref'));
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0]!.includes('n3'));
});

test('mergeChangeReports: trang đạt có warnings → mục "Cảnh báo (trang vẫn đạt)" + note neo trượt được đánh dấu', async () => {
  const { mergeChangeReports } = await import('../src/docs-review.js');
  const { summaryMd, index } = mergeChangeReports([
    {
      slug: 'p', page: 'Trang A', docPath: 'docs/a.md', reviewPath: 'review/a.md', changes: [],
      notes: [{ id: 'n2', kind: 'gap', severity: 'minor', anchor: 'X', finding: 'f', suggestion: 's', anchor_unresolved: true }],
      status: 'succeeded', warnings: ['Note "n2" có anchor không tìm thấy trong bản gốc — giữ lại nhưng không bôi được vào tài liệu: "X"'],
    },
  ]);
  assert.ok(summaryMd.includes('## Cảnh báo (trang vẫn đạt)'));
  assert.ok(summaryMd.includes('| Trang A | Đã sửa |'));
  assert.ok(summaryMd.includes('không tìm thấy trong bản gốc — không bôi được'));
  assert.deepEqual((index as { pages: Array<{ warnings?: string[] }> }).pages[0]!.warnings?.length, 1);
});

// ---------------------------------------------------------------------------
// WP2 nền: kind `flow-diagram` (change do daemon tự ghi, origin 'system') +
// rule_id trỏ file kết quả nội bộ (`flows/…`, `comp/…`) thay vì `criteria/`.
// Xem systemChangesPath, DocChange.origin, và nhánh (d) của validateRuleIds.
// ---------------------------------------------------------------------------
describe('WP2 nền — kind flow-diagram, origin, rule_id nội bộ', () => {
  test('parseChangesFile: chấp nhận kind "flow-diagram" và giữ nguyên trường `origin` khi có', () => {
    const raw = JSON.stringify([
      {
        id: 'c1',
        kind: 'flow-diagram',
        severity: 'minor',
        quote: 'q1',
        reason: 'sơ đồ vừa được daemon vẽ lại',
        rule_id: 'flows/F-009.json',
        origin: 'system',
      },
    ]);
    const result = parseChangesFile(raw);
    assert.ok('changes' in result, `expected changes, got ${JSON.stringify(result)}`);
    if (!('changes' in result)) return;
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0]!.kind, 'flow-diagram');
    assert.equal(result.changes[0]!.origin, 'system');
  });

  test('parseChangesFile: `origin` vắng mặt vẫn hợp lệ (coi như agent, không tự gán)', () => {
    const raw = JSON.stringify([
      { id: 'c1', kind: 'ux-writing', severity: 'minor', quote: 'q1', reason: 'r1' },
    ]);
    const result = parseChangesFile(raw);
    assert.ok('changes' in result, `expected changes, got ${JSON.stringify(result)}`);
    if (!('changes' in result)) return;
    assert.equal(result.changes[0]!.origin, undefined);
  });

  test('parseNotesFile: cũng chấp nhận kind "flow-diagram" (lọc kind dùng chung DOC_CHANGE_KINDS)', () => {
    const raw = JSON.stringify([
      { id: 'n1', kind: 'flow-diagram', severity: 'minor', anchor: 'A', finding: 'f', suggestion: 's' },
    ]);
    const result = parseNotesFile(raw);
    assert.ok('notes' in result, `expected notes, got ${JSON.stringify(result)}`);
    if (!('notes' in result)) return;
    assert.equal(result.notes[0]!.kind, 'flow-diagram');
  });

  test('validateRuleIds: rule_id "flows/…" hợp lệ cho kind flow hoặc flow-diagram, sai kind thì lỗi', () => {
    assert.deepEqual(
      validateRuleIds([{ id: 'c1', kind: 'flow', rule_id: 'flows/F-009.json' }], new Set<string>()),
      [],
    );
    assert.deepEqual(
      validateRuleIds([{ id: 'c2', kind: 'flow-diagram', rule_id: 'flows/F-009.json' }], new Set<string>()),
      [],
    );
    const errors = validateRuleIds(
      [{ id: 'c3', kind: 'ux-writing', rule_id: 'flows/F-009.json' }],
      new Set<string>(),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /c3/);
    assert.match(errors[0]!, /flow/);
  });

  test('validateRuleIds: rule_id "comp/…" hợp lệ CHỈ cho kind component, sai kind thì lỗi', () => {
    assert.deepEqual(
      validateRuleIds([{ id: 'c1', kind: 'component', rule_id: 'comp/dang-nhap.screen.json' }], new Set<string>()),
      [],
    );
    const errors = validateRuleIds(
      [{ id: 'c2', kind: 'flow', rule_id: 'comp/dang-nhap.screen.json' }],
      new Set<string>(),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /c2/);
    assert.match(errors[0]!, /comp\//);
  });

  test('validateRuleIds: "flows/…"/"comp/…" KHÔNG bị đối chiếu với criteria/ dù anchors không rỗng', () => {
    const anchors = new Set(['criteria/rules.md#R-OVERLAY']);
    assert.deepEqual(
      validateRuleIds(
        [
          { id: 'c1', kind: 'flow', rule_id: 'flows/F-009.json' },
          { id: 'c2', kind: 'component', rule_id: 'comp/dang-nhap.screen.json' },
        ],
        anchors,
      ),
      [],
    );
  });

  test('validateRuleIds: internalRefs truyền vào => rule_id phải nằm trong set (file có thật)', () => {
    const internalRefs = new Set(['flows/F-009.json', 'comp/dang-nhap.screen.json']);
    assert.deepEqual(
      validateRuleIds(
        [{ id: 'c1', kind: 'flow', rule_id: 'flows/F-009.json' }],
        new Set<string>(),
        internalRefs,
      ),
      [],
    );
    const errors = validateRuleIds(
      [{ id: 'c2', kind: 'flow', rule_id: 'flows/KHONG-TON-TAI.json' }],
      new Set<string>(),
      internalRefs,
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /c2/);
    assert.match(errors[0]!, /KHONG-TON-TAI/);
  });

  test('validateRuleIds: internalRefs KHÔNG truyền => bỏ qua kiểm tra tồn tại', () => {
    assert.deepEqual(
      validateRuleIds([{ id: 'c1', kind: 'flow', rule_id: 'flows/khong-co-that.json' }], new Set<string>()),
      [],
    );
  });

  test('mergeChangeReports: đếm diagrams_updated (flow-diagram + origin system) và composition_tables (component, rule_id comp/…, không có before)', () => {
    const results: DocPageResult[] = [
      {
        slug: 'a',
        page: 'Trang A',
        docPath: 'docs/a.md',
        reviewPath: 'review/docs/a.md',
        status: 'succeeded',
        changes: [
          {
            id: 'd1',
            kind: 'flow-diagram',
            severity: 'minor',
            quote: 'sơ đồ mới',
            reason: 'daemon vẽ lại theo flows/F-009.json',
            rule_id: 'flows/F-009.json',
            origin: 'system',
          },
          // Change flow-diagram nhưng KHÔNG phải origin system — không được tính.
          {
            id: 'd2',
            kind: 'flow-diagram',
            severity: 'minor',
            quote: 'sơ đồ khác',
            reason: 'agent tự vẽ',
            rule_id: 'flows/F-010.json',
          },
          {
            id: 't1',
            kind: 'component',
            severity: 'minor',
            quote: '| Component | Vai trò |\n| --- | --- |\n| Button | Xác nhận |',
            reason: 'chèn bảng thành phần cho màn Đăng nhập',
            rule_id: 'comp/dang-nhap.screen.json',
          },
          // Component có rule_id comp/… nhưng có `before` => coi là SỬA bảng cũ,
          // không phải chèn mới — không được tính vào composition_tables.
          {
            id: 't2',
            kind: 'component',
            severity: 'minor',
            before: '| Component cũ |',
            quote: '| Component mới |',
            reason: 'sửa bảng thành phần cũ',
            rule_id: 'comp/dang-nhap.screen.json',
          },
        ],
        notes: [],
      },
      {
        slug: 'b',
        page: 'Trang B',
        docPath: 'docs/b.md',
        reviewPath: 'review/docs/b.md',
        status: 'succeeded',
        changes: [],
        notes: [],
      },
    ];
    const { index, summaryMd } = mergeChangeReports(results);
    const idx = index as any;
    assert.equal(idx.summary.diagrams_updated, 1);
    assert.equal(idx.summary.composition_tables, 1);
    assert.equal(idx.pages.find((p: any) => p.slug === 'a').diagrams_updated, 1);
    assert.equal(idx.pages.find((p: any) => p.slug === 'a').composition_tables, 1);
    assert.equal(idx.pages.find((p: any) => p.slug === 'b').diagrams_updated, 0);
    assert.equal(idx.pages.find((p: any) => p.slug === 'b').composition_tables, 0);
    // Mọi trường sẵn có vẫn còn — GIỮ NGUYÊN, không phá test cũ.
    assert.equal(idx.summary.changes, 4);
    assert.match(summaryMd, /Sơ đồ đã thay: 1 · Bảng thành phần đã chèn: 1/);
  });

  test('removePageOutputs: xoá cả file `.sys.changes.json` của trang', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'docs-review-sys-'));
    try {
      const conf = join(cwd, 'docs', 'confluence');
      await mkdir(conf, { recursive: true });
      await writeFile(join(conf, 'a.md'), 'Trang A.\n');
      await writeFile(join(conf, 'b.md'), 'Trang B.\n');
      await cloneDocsForReview(cwd);
      const dir = join(cwd, 'review', 'docs', 'confluence');
      const reviewRelA = 'review/docs/confluence/a.md';
      const reviewRelB = 'review/docs/confluence/b.md';
      await writeFile(join(cwd, systemChangesPath(reviewRelA)), '[]\n');
      await writeFile(join(cwd, systemChangesPath(reviewRelB)), '[]\n');
      assert.equal(systemChangesPath(reviewRelA), 'review/docs/confluence/a.sys.changes.json');

      await removePageOutputs(cwd, 'docs/confluence/a.md');

      await assert.rejects(() => stat(join(cwd, systemChangesPath(reviewRelA))));
      // Trang b không bị đụng.
      await stat(join(cwd, systemChangesPath(reviewRelB)));
      await stat(join(dir, 'b.md'));

      // Gọi lại lần hai không lỗi (idempotent).
      await removePageOutputs(cwd, 'docs/confluence/a.md');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('WP8a — validateChanges opts.locateIn, mergeChangeReports sectionsTotal/sectionsFailed', () => {
  test('validateChanges: anchor chỉ có trong locateIn (không có trong revised) → không lỗi khi truyền opts.locateIn; không truyền => lỗi như cũ', () => {
    const original = 'Section gốc.\n';
    const revised = 'Section gốc đã sửa chữ.\n';
    const locateIn = 'Toàn trang: phần khác có câu "Điểm neo ở section khác."\n' + revised;
    const changes: DocChange[] = [
      {
        id: 'c1',
        kind: 'ux-writing',
        severity: 'minor',
        before: 'Section gốc.',
        quote: 'Section gốc đã sửa chữ.',
        anchor: 'Điểm neo ở section khác.',
        reason: 'sửa chữ, viện dẫn đoạn khác của trang',
      },
    ];

    const errorsWithoutOpts = validateChanges(original, revised, changes);
    assert.ok(errorsWithoutOpts.some((e) => e.includes('anchor')), JSON.stringify(errorsWithoutOpts));

    const errorsWithLocateIn = validateChanges(original, revised, changes, { locateIn });
    assert.deepEqual(errorsWithLocateIn, []);
  });

  test('mergeChangeReports: page có sectionsTotal 12/sectionsFailed 2 → index có sections_total/sections_failed, summary có mục mới + "(10/12 section)"; page không có sectionsTotal → index y như cũ', () => {
    const results: DocPageResult[] = [
      {
        slug: 'a',
        page: 'Trang A',
        docPath: 'docs/a.md',
        reviewPath: 'review/docs/a.md',
        status: 'succeeded',
        changes: [],
        notes: [],
        sectionsTotal: 12,
        sectionsFailed: [
          {
            index: 3,
            heading: '6.1 Màn trang chủ',
            errors: ['Dòng đã đổi/thêm nhưng không có change.quote nào khai báo: "x"'],
          },
          { index: 7, heading: '', errors: ['Rác output-của-tool: "Wall time: 0.4 seconds"'] },
        ],
      },
      {
        slug: 'b',
        page: 'Trang B',
        docPath: 'docs/b.md',
        reviewPath: 'review/docs/b.md',
        status: 'succeeded',
        changes: [],
        notes: [],
      },
    ];
    const { index, summaryMd } = mergeChangeReports(results);
    const idx = index as any;
    const pageA = idx.pages.find((p: any) => p.slug === 'a');
    const pageB = idx.pages.find((p: any) => p.slug === 'b');

    assert.equal(pageA.sections_total, 12);
    assert.equal(pageA.sections_failed, 2);
    assert.ok(!('sections_total' in pageB), 'trang không có sectionsTotal thì index KHÔNG có trường sections_total');
    assert.ok(!('sections_failed' in pageB));

    assert.match(summaryMd, /## Section không đạt \(đã giữ nguyên nội dung gốc đã enrich\)/);
    assert.match(summaryMd, /Trang A.*s03 "6\.1 Màn trang chủ"/);
    assert.match(summaryMd, /Trang A.*s07 "Mở đầu"/);
    assert.match(summaryMd, /Đã sửa \(10\/12 section\)/);
  });
});
