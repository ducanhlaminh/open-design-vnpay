// @vitest-environment jsdom
//
// wp4.yaml — sửa tay mở rộng: (1) "Sửa bảng" theo hàng cho thẻ Bảng thành
// phần, (2) "Thêm sau mục…" (chọn heading thay vì bôi đen), (3) select "Loại"
// trong composer sửa tay.
//
// Fixture tách khỏi doc-redline-preview.wp3.test.tsx/.ops.test.tsx/.feedback
// test.tsx (mỗi file khoá một tập id/anchor riêng — cùng lý do các file đó đã
// tách nhau). Dùng lại khuôn dynamic-mock (`vi.doMock` + `import()` mỗi test)
// của wp3.test.tsx vì file này có NHIỀU fixture tài liệu khác nhau, và khuôn
// `fetch` mock + `latestSidecarWrite` của doc-redline-feedback.test.tsx để đọc
// đúng payload đã LƯU (không chỉ DOM sau khi sửa).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = function noop() {};
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true } as Response);
  vi.stubGlobal('fetch', fetchMock);
});

/** Ghi cuối cùng cho `*.md` hoặc `*.changes.json` — cùng khuôn
 *  `latestSidecarWrite` của doc-redline-feedback.test.tsx (đọc thẳng payload
 *  đã POST lên `/api/projects/:id/files`, không suy luận qua DOM). */
function latestWrite(suffix: '.md' | '.changes.json'): { name: string; content: string } {
  const call = [...fetchMock.mock.calls].reverse().find((args) => {
    const init = args[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
    return typeof body.name === 'string' && body.name.endsWith(suffix);
  });
  if (!call) throw new Error(`không tìm thấy lệnh ghi ${suffix}`);
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as { name: string; content: string };
}
function latestSidecar(): { annotations: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> } {
  return JSON.parse(latestWrite('.changes.json').content);
}

function selectText(container: HTMLElement, text: string) {
  const article = container.querySelector('article');
  if (!article) throw new Error('missing article');
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.textContent !== text) node = walker.nextNode();
  if (!node) throw new Error(`missing text node: ${text}`);
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

// ── Fixture 1: Bảng thành phần (mục 1 — "Sửa bảng" theo hàng) ───────────────
const TABLE_QUOTE = [
  '**Cấu thành màn hình (Design System) — Đăng nhập**',
  '',
  '| # | Thành phần | Component DS | Biến thể | Vai trò / dùng để | Mô tả component | Điều hướng tới | Ghi chú |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 1 | Ô nhập số điện thoại | Input | text | Nhập số điện thoại | Ô nhập một dòng | — | — |',
  '| 2 | Nút Đăng nhập | Button | primary | Xác nhận đăng nhập | Nút chính | Trang chủ | — |',
  '| 3 | Biểu tượng OTP | — (DS không có) | — | Minh hoạ bước OTP | Icon tự vẽ | — | Chưa có trong DS |',
  '',
  '*Nguồn: comp/login.screen.json (rà soát UX)*',
].join('\n');
const TABLE_EDITED = ['# Đăng nhập', '', TABLE_QUOTE, ''].join('\n');
const TABLE_CHANGES = JSON.stringify([
  {
    id: 'ct1',
    kind: 'component',
    severity: 'minor',
    rule_id: 'comp/login.screen.json',
    quote: TABLE_QUOTE,
    reason: 'Bổ sung bảng thành phần cho màn Đăng nhập theo rà soát UX.',
  },
]);
function mockTableProject() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return TABLE_CHANGES;
      if (name.endsWith('.notes.json')) return null;
      return TABLE_EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}
const TABLE_FILE = {
  name: 'docs-review/review/docs/confluence/login.md',
  kind: 'text',
  size: TABLE_EDITED.length,
  mtime: 1,
} as never;

async function renderTable() {
  vi.resetModules();
  mockTableProject();
  const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
  const { container } = render(<Comp projectId="p1" file={TABLE_FILE} />);
  await waitFor(() => {
    expect(container.querySelector('[data-change-item="ct1"]')).not.toBeNull();
  });
  return container;
}
function tableCard(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-change-item="ct1"]') as HTMLElement;
}
function clickButton(root: HTMLElement, label: string) {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === label);
  if (!btn) throw new Error(`không tìm thấy nút "${label}"`);
  fireEvent.click(btn);
}

// ── Fixture 1b (vá B1, review attempt2): quote đã có sẵn một ô escape `\|`
// (mô phỏng bảng do daemon sinh, `escapeCell` trong docs-review-enrich.ts
// cũng ghi `\|` khi một ô chứa `|`) — round-trip qua form KHÔNG được xé ô đó
// thành hai/chín cột. ────────────────────────────────────────────────────
const TABLE_QUOTE_ESCAPED = [
  '**Cấu thành màn hình (Design System) — Đăng nhập**',
  '',
  '| # | Thành phần | Component DS | Biến thể | Vai trò / dùng để | Mô tả component | Điều hướng tới | Ghi chú |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 1 | Ô nhập số điện thoại | Input | text | Nhập số điện thoại | Ô nhập một dòng | — | — |',
  '| 2 | Nút Đăng nhập | Button | primary | Xác nhận đăng nhập | Nút chính | Trang chủ | Chặn khi role = admin \\| viewer |',
  '| 3 | Biểu tượng OTP | — (DS không có) | — | Minh hoạ bước OTP | Icon tự vẽ | — | Chưa có trong DS |',
  '',
  '*Nguồn: comp/login.screen.json (rà soát UX)*',
].join('\n');
const TABLE_EDITED_ESCAPED = ['# Đăng nhập', '', TABLE_QUOTE_ESCAPED, ''].join('\n');
const TABLE_CHANGES_ESCAPED = JSON.stringify([
  {
    id: 'ct1',
    kind: 'component',
    severity: 'minor',
    rule_id: 'comp/login.screen.json',
    quote: TABLE_QUOTE_ESCAPED,
    reason: 'Bổ sung bảng thành phần cho màn Đăng nhập theo rà soát UX.',
  },
]);
function mockTableProjectEscaped() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return TABLE_CHANGES_ESCAPED;
      if (name.endsWith('.notes.json')) return null;
      return TABLE_EDITED_ESCAPED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}
async function renderTableEscaped() {
  vi.resetModules();
  mockTableProjectEscaped();
  const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
  const { container } = render(<Comp projectId="p1" file={TABLE_FILE} />);
  await waitFor(() => {
    expect(container.querySelector('[data-change-item="ct1"]')).not.toBeNull();
  });
  return container;
}

describe('DocRedlinePreview — wp4.yaml mục 1: "Sửa bảng" theo hàng', () => {
  it('sửa ô "Vai trò / dùng để" của một hàng → quote mới có trong text đã lưu, change chuyển status "edited"', async () => {
    const container = await renderTable();
    const card = tableCard(container);

    clickButton(card, 'Sửa bảng');
    const roleInput = card.querySelector<HTMLInputElement>(
      'input[aria-label="Vai trò / dùng để — Ô nhập số điện thoại"]',
    );
    expect(roleInput, 'phải có ô nhập "Vai trò / dùng để" của hàng 1').toBeTruthy();
    fireEvent.change(roleInput!, { target: { value: 'Nhập SĐT để đăng nhập vào hệ thống' } });
    clickButton(card, 'Lưu');

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const savedMd = latestWrite('.md');
    expect(savedMd.content).toContain('Nhập SĐT để đăng nhập vào hệ thống');
    expect(savedMd.content).not.toContain('| Nhập số điện thoại |');
    const sidecar = latestSidecar();
    const annotation = sidecar.annotations.find((a) => a.id === 'ct1');
    expect(annotation).toMatchObject({ status: 'edited' });
    expect(String(annotation?.quote)).toContain('Nhập SĐT để đăng nhập vào hệ thống');
    // Header/tiêu đề/caption giữ nguyên — chỉ ô đã sửa mới đổi.
    expect(String(annotation?.quote)).toContain('**Cấu thành màn hình (Design System) — Đăng nhập**');
    expect(String(annotation?.quote)).toContain('*Nguồn: comp/login.screen.json (rà soát UX)*');
  });

  it('sửa ô "Ghi chú" → quote mới có trong text đã lưu', async () => {
    const container = await renderTable();
    const card = tableCard(container);

    clickButton(card, 'Sửa bảng');
    const noteInput = card.querySelector<HTMLInputElement>('input[aria-label="Ghi chú — Nút Đăng nhập"]');
    expect(noteInput, 'phải có ô nhập "Ghi chú" của hàng 2').toBeTruthy();
    fireEvent.change(noteInput!, { target: { value: 'Vô hiệu hoá khi form chưa hợp lệ' } });
    clickButton(card, 'Lưu');

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const sidecar = latestSidecar();
    const annotation = sidecar.annotations.find((a) => a.id === 'ct1');
    expect(String(annotation?.quote)).toContain('Vô hiệu hoá khi form chưa hợp lệ');
  });

  it('"Gỡ hàng" → hàng biến mất khỏi text đã lưu, hai hàng còn lại vẫn nguyên', async () => {
    const container = await renderTable();
    const card = tableCard(container);

    clickButton(card, 'Sửa bảng');
    const rowToRemove = card.querySelector('[data-table-edit-row="2"]') as HTMLElement;
    expect(rowToRemove, 'phải có hàng thứ 3 (Biểu tượng OTP)').toBeTruthy();
    expect(rowToRemove.textContent).toContain('Biểu tượng OTP');
    clickButton(rowToRemove, 'Gỡ hàng');
    clickButton(card, 'Lưu');

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const sidecar = latestSidecar();
    const annotation = sidecar.annotations.find((a) => a.id === 'ct1');
    const quote = String(annotation?.quote);
    expect(quote).not.toContain('Biểu tượng OTP');
    expect(quote).toContain('Ô nhập số điện thoại');
    expect(quote).toContain('Nút Đăng nhập');
    const savedMd = latestWrite('.md');
    expect(savedMd.content).not.toContain('Biểu tượng OTP');
  });

  it('escape dấu "|" khi dựng lại quote — không phá cú pháp bảng', async () => {
    const container = await renderTable();
    const card = tableCard(container);

    clickButton(card, 'Sửa bảng');
    const noteInput = card.querySelector<HTMLInputElement>('input[aria-label="Ghi chú — Nút Đăng nhập"]');
    fireEvent.change(noteInput!, { target: { value: 'Chặn khi role = admin | viewer' } });
    clickButton(card, 'Lưu');

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const sidecar = latestSidecar();
    const annotation = sidecar.annotations.find((a) => a.id === 'ct1');
    const quote = String(annotation?.quote);
    expect(quote).toContain('admin \\| viewer');
    // Escape không làm dư/thiếu cột: vẫn đúng 5 dòng bảng (header + gạch
    // ngăn + 3 hàng dữ liệu).
    const tableLines = quote.split('\n').filter((l) => l.trim().startsWith('|'));
    expect(tableLines.length).toBe(5);
  });

  // Vá B1 (review attempt2): quote SẴN CÓ một ô escape `\|` (bảng do daemon
  // sinh cũng escape kiểu này) — mở form phải đọc đúng 8 cột (không xé ô
  // Ghi chú thành hai vì gặp `\|`), và Lưu không sửa gì phải cho ra quote
  // BYTE-EQUAL quote cũ (round-trip ổn định, không lệch cột dần qua mỗi lần
  // mở/lưu).
  it('quote có ô escape "\\|" sẵn → mở form đúng 8 cột, hiện "|" thật; Lưu không sửa gì → quote byte-equal quote cũ; đếm N/M/K đúng', async () => {
    const container = await renderTableEscaped();
    const card = tableCard(container);

    // Đếm N/M/K trên mặt thẻ vẫn đúng dù có ô chứa "\|" ở một hàng khác.
    expect(card.textContent).toContain('3 thành phần');
    expect(card.textContent).toContain('2 map DS');
    expect(card.textContent).toContain('1 DS không có');

    clickButton(card, 'Sửa bảng');
    const noteInput = card.querySelector<HTMLInputElement>('input[aria-label="Ghi chú — Nút Đăng nhập"]');
    expect(noteInput, 'phải có đúng MỘT ô Ghi chú của hàng 2, không bị "\\|" xé đôi').toBeTruthy();
    expect(noteInput!.value).toBe('Chặn khi role = admin | viewer');
    // Cột kế cận không bị lệch vì cột trước nó bị tách sai.
    const roleInputRow2 = card.querySelector<HTMLInputElement>('input[aria-label="Vai trò / dùng để — Nút Đăng nhập"]');
    expect(roleInputRow2!.value).toBe('Xác nhận đăng nhập');

    clickButton(card, 'Lưu'); // không sửa ô nào — chỉ kiểm round-trip
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const saved = String(latestSidecar().annotations.find((a) => a.id === 'ct1')?.quote);
    expect(saved).toBe(TABLE_QUOTE_ESCAPED);
  });

  // Vá B1 (review attempt2): người dùng tự gõ "|" vào một ô (không phải ô đã
  // escape sẵn) → lưu → mở lại form vẫn đúng 8 cột (đọc lại được quote vừa
  // lưu) → lưu lần 2 không sửa gì thêm phải cho quote GIỐNG HỆT lần 1 (không
  // phình thêm cột/dòng qua mỗi vòng sửa-lưu-mở-lại).
  it('sửa 1 ô chứa "|" → lưu → mở lại form vẫn đúng 8 cột → lưu lại lần 2 không đổi thêm gì (round-trip ổn định)', async () => {
    const container = await renderTable();
    const card = tableCard(container);

    clickButton(card, 'Sửa bảng');
    const noteInput = card.querySelector<HTMLInputElement>('input[aria-label="Ghi chú — Nút Đăng nhập"]');
    fireEvent.change(noteInput!, { target: { value: 'Chặn khi role = admin | viewer' } });
    clickButton(card, 'Lưu');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const firstQuote = String(latestSidecar().annotations.find((a) => a.id === 'ct1')?.quote);

    clickButton(card, 'Sửa bảng'); // mở lại — đọc quote VỪA lưu (đã escape)
    const reopenedNoteInput = card.querySelector<HTMLInputElement>('input[aria-label="Ghi chú — Nút Đăng nhập"]');
    expect(reopenedNoteInput, 'mở lại vẫn phải có đúng MỘT ô Ghi chú của hàng 2').toBeTruthy();
    expect(reopenedNoteInput!.value).toBe('Chặn khi role = admin | viewer');
    const roleInputRow2 = card.querySelector<HTMLInputElement>('input[aria-label="Vai trò / dùng để — Nút Đăng nhập"]');
    expect(roleInputRow2!.value).toBe('Xác nhận đăng nhập');

    clickButton(card, 'Lưu'); // lưu lần 2, không sửa gì thêm
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    const secondQuote = String(latestSidecar().annotations.find((a) => a.id === 'ct1')?.quote);
    expect(secondQuote).toBe(firstQuote); // không lệch thêm cột qua vòng lặp thứ hai
    const tableLines = secondQuote.split('\n').filter((l) => l.trim().startsWith('|'));
    expect(tableLines.length).toBe(5);
  });

  it('"Hủy" → không đổi gì, không gọi lưu', async () => {
    const container = await renderTable();
    const card = tableCard(container);

    clickButton(card, 'Sửa bảng');
    const roleInput = card.querySelector<HTMLInputElement>(
      'input[aria-label="Vai trò / dùng để — Ô nhập số điện thoại"]',
    );
    fireEvent.change(roleInput!, { target: { value: 'Một giá trị sẽ bị bỏ' } });
    clickButton(card, 'Hủy');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(card.querySelector('[class*="tableEditForm"]')).toBeNull();
    expect(card.textContent).toContain('3 thành phần');
  });

  // Vá N2 (phải vá, review attempt2): trước đây `handleSaveTable` đóng form
  // TRƯỚC khi gọi lưu — POST lỗi thì mất trắng nháp đang sửa. Giờ chỉ đóng
  // form SAU khi lưu thành công; lưu hỏng phải giữ nguyên form + nháp và hiện
  // lỗi ngay trong form.
  it('POST lưu thất bại → form Sửa bảng vẫn mở với nháp, hiện thông báo lỗi', async () => {
    const container = await renderTable();
    const card = tableCard(container);

    clickButton(card, 'Sửa bảng');
    const roleInput = card.querySelector<HTMLInputElement>(
      'input[aria-label="Vai trò / dùng để — Ô nhập số điện thoại"]',
    );
    fireEvent.change(roleInput!, { target: { value: 'Giá trị chưa lưu được' } });
    // POST lưu file thất bại từ đây trở đi.
    fetchMock.mockResolvedValue({ ok: false } as Response);
    clickButton(card, 'Lưu');

    await waitFor(() => expect(card.textContent).toContain('Không ghi được file'));
    // Form vẫn mở — nháp còn nguyên, không bị đóng/mất khi lưu hỏng.
    expect(card.querySelector('[class*="tableEditForm"]')).not.toBeNull();
    const stillOpenInput = card.querySelector<HTMLInputElement>(
      'input[aria-label="Vai trò / dùng để — Ô nhập số điện thoại"]',
    );
    expect(stillOpenInput?.value).toBe('Giá trị chưa lưu được');
  });
});

// ── Fixture 2: tài liệu nhiều heading, KHÔNG có changes.json (mục 2 — "Thêm
// sau mục…") ─────────────────────────────────────────────────────────────
const HEADING_EDITED = [
  '# Tài liệu đăng ký',
  '',
  'Đoạn giới thiệu chung về luồng đăng ký.',
  '',
  '## Luồng đăng ký',
  '',
  'Đoạn mô tả luồng đăng ký hiện tại.',
  '',
  '## Câu hỏi thường gặp',
  '',
  'Đoạn FAQ.',
  '',
].join('\n');
function mockHeadingProject() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return null;
      if (name.endsWith('.notes.json')) return null;
      return HEADING_EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}
const HEADING_FILE = {
  name: 'docs-review/review/docs/confluence/register.md',
  kind: 'text',
  size: HEADING_EDITED.length,
  mtime: 1,
} as never;

describe('DocRedlinePreview — wp4.yaml mục 2: "Thêm sau mục…"', () => {
  it('chọn một heading từ danh sách → đoạn mới nằm NGAY SAU dòng heading đã chọn', async () => {
    vi.resetModules();
    mockHeadingProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container, getByRole } = render(<Comp projectId="p1" file={HEADING_FILE} />);
    await waitFor(() => {
      expect(container.querySelector('article')).not.toBeNull();
    });

    clickButton(container, 'Thêm sau mục…');
    const select = getByRole('combobox', { name: 'Chọn mục' }) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent ?? '');
    expect(options.some((t) => t.includes('Luồng đăng ký'))).toBe(true);
    const optionValue = Array.from(select.options).find((o) => o.textContent?.includes('## Luồng đăng ký'))?.value;
    expect(optionValue, 'phải tìm được option "## Luồng đăng ký"').toBeTruthy();
    fireEvent.change(select, { target: { value: optionValue } });
    clickButton(container, 'Thêm');

    // Composer "Thêm sau đoạn chọn" mở ra với anchor = dòng heading.
    expect(container.textContent).toContain('Thêm sau đoạn đã chọn');
    expect(container.textContent).toContain('Luồng đăng ký');
    fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), {
      target: { value: 'Bước 0: người dùng mở màn hình đăng ký.' },
    });
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const savedMd = latestWrite('.md');
    const headingIndex = savedMd.content.indexOf('## Luồng đăng ký');
    const insertedIndex = savedMd.content.indexOf('Bước 0: người dùng mở màn hình đăng ký.');
    const nextHeadingIndex = savedMd.content.indexOf('## Câu hỏi thường gặp');
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(insertedIndex).toBeGreaterThan(headingIndex);
    // Đoạn mới nằm NGAY SAU heading đã chọn — trước bất kỳ heading kế tiếp
    // nào, và đoạn mô tả cũ của MỤC ĐÓ vẫn còn (không bị thay thế).
    expect(insertedIndex).toBeLessThan(nextHeadingIndex);
    expect(savedMd.content).toContain('Đoạn mô tả luồng đăng ký hiện tại.');

    const sidecar = latestSidecar();
    const created = sidecar.annotations.at(-1);
    expect(created).toMatchObject({ origin: 'user', operation: 'add', anchor: '## Luồng đăng ký' });
  });

  it('nút "Thêm sau mục…" bị vô hiệu hoá khi tài liệu không có heading nào', async () => {
    vi.resetModules();
    vi.doMock('../../src/providers/registry', () => ({
      fetchProjectFileText: async (_projectId: string, name: string) => {
        if (name.endsWith('.changes.json')) return null;
        if (name.endsWith('.notes.json')) return null;
        return 'Chỉ có một dòng văn xuôi, không heading nào.\n';
      },
      projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
    }));
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={HEADING_FILE} />);
    await waitFor(() => {
      expect(container.querySelector('article')).not.toBeNull();
    });
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Thêm sau mục…');
    expect(btn, 'phải có nút "Thêm sau mục…"').toBeTruthy();
    expect(btn!.disabled).toBe(true);
  });

  // Vá N1 (phải vá, review attempt2): `# Đăng ký` là substring của `##
  // Đăng ký thành công` (ký tự "#" thứ hai của heading con + phần chữ trùng
  // nhau) — kiểm duy nhất kiểu cũ (indexOf substring) báo trùng giả và chặn
  // composer mở ra. Fixture có CẢ heading cha và heading con cùng tiền tố.
  it('heading cha ("# Đăng ký") và heading con cùng tiền tố ("## Đăng ký thành công") — chọn heading cha vẫn thêm được, không báo trùng giả', async () => {
    const HEADING_PREFIX_TEXT = [
      '# Đăng ký',
      '',
      'Đoạn giới thiệu chung về đăng ký.',
      '',
      '## Đăng ký thành công',
      '',
      'Đoạn mô tả sau khi đăng ký thành công.',
      '',
    ].join('\n');
    vi.resetModules();
    vi.doMock('../../src/providers/registry', () => ({
      fetchProjectFileText: async (_projectId: string, name: string) => {
        if (name.endsWith('.changes.json')) return null;
        if (name.endsWith('.notes.json')) return null;
        return HEADING_PREFIX_TEXT;
      },
      projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
    }));
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container, getByRole } = render(<Comp projectId="p1" file={HEADING_FILE} />);
    await waitFor(() => {
      expect(container.querySelector('article')).not.toBeNull();
    });

    clickButton(container, 'Thêm sau mục…');
    const select = getByRole('combobox', { name: 'Chọn mục' }) as HTMLSelectElement;
    const optionTexts = Array.from(select.options).map((o) => o.textContent ?? '');
    // Cả heading cha VÀ heading con cùng có mặt trong danh sách chọn.
    expect(optionTexts).toContain('# Đăng ký');
    expect(optionTexts).toContain('## Đăng ký thành công');
    const parentValue = Array.from(select.options).find((o) => o.textContent === '# Đăng ký')?.value;
    expect(parentValue, 'phải tìm được đúng option "# Đăng ký" (không lẫn với heading con)').toBeTruthy();
    fireEvent.change(select, { target: { value: parentValue } });
    clickButton(container, 'Thêm');

    // Trước vá: bị chặn bởi lỗi trùng giả, composer không mở ra được.
    expect(container.textContent).not.toContain('Đoạn đã chọn phải xuất hiện đúng một lần');
    expect(container.textContent).toContain('Thêm sau đoạn đã chọn');

    fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), {
      target: { value: 'Bước xác nhận: kiểm tra email đăng ký.' },
    });
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const savedMd = latestWrite('.md');
    const parentHeadingIndex = savedMd.content.indexOf('# Đăng ký');
    const childHeadingIndex = savedMd.content.indexOf('## Đăng ký thành công');
    const insertedIndex = savedMd.content.indexOf('Bước xác nhận: kiểm tra email đăng ký.');
    const introIndex = savedMd.content.indexOf('Đoạn giới thiệu chung về đăng ký.');
    expect(parentHeadingIndex).toBe(0);
    expect(insertedIndex).toBeGreaterThan(parentHeadingIndex);
    // Đoạn mới nằm NGAY SAU dòng heading CHA — trước cả đoạn giới thiệu cũ
    // của chính mục đó VÀ trước heading con (không lạc sang mục con).
    expect(insertedIndex).toBeLessThan(introIndex);
    expect(insertedIndex).toBeLessThan(childHeadingIndex);
    expect(savedMd.content).toContain('Đoạn mô tả sau khi đăng ký thành công.');

    const sidecar = latestSidecar();
    const created = sidecar.annotations.at(-1);
    expect(created).toMatchObject({ origin: 'user', operation: 'add', anchor: '# Đăng ký' });
  });
});

// ── Fixture 3: tài liệu đơn giản, KHÔNG có changes.json (mục 3 — select
// "Loại" trong composer sửa tay) ─────────────────────────────────────────────
const SIMPLE_TEXT = ['# Quản lý khách hàng', '', 'Người dùng nhập mã OTP.', ''].join('\n');
function mockSimpleProject() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return null;
      if (name.endsWith('.notes.json')) return null;
      return SIMPLE_TEXT;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}
const SIMPLE_FILE = {
  name: 'docs-review/review/docs/confluence/customers.md',
  kind: 'text',
  size: SIMPLE_TEXT.length,
  mtime: 1,
} as never;

describe('DocRedlinePreview — wp4.yaml mục 3: select "Loại" trong composer sửa tay', () => {
  it('"Sửa đoạn chọn": mặc định "Sửa chữ" (ux-writing); đổi loại → kind đúng trong payload lưu', async () => {
    vi.resetModules();
    mockSimpleProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container, getByRole } = render(<Comp projectId="p1" file={SIMPLE_FILE} />);
    await waitFor(() => {
      expect(container.querySelector('article')).not.toBeNull();
    });

    selectText(container, 'Người dùng nhập mã OTP.');
    fireEvent.click(getByRole('button', { name: 'Sửa đoạn chọn' }));
    const kindSelect = getByRole('combobox', { name: 'Loại' }) as HTMLSelectElement;
    expect(kindSelect.value).toBe('ux-writing');

    fireEvent.change(kindSelect, { target: { value: 'flow' } });
    fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), {
      target: { value: 'Người dùng nhập mã OTP gồm 6 chữ số.' },
    });
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const created = latestSidecar().annotations.at(-1);
    expect(created).toMatchObject({ origin: 'user', operation: 'edited', kind: 'flow', severity: 'minor' });
  });

  it('"Thêm sau đoạn chọn": mặc định "Thiếu mô tả" (gap); đổi loại → kind đúng trong payload lưu', async () => {
    vi.resetModules();
    mockSimpleProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container, getByRole } = render(<Comp projectId="p1" file={SIMPLE_FILE} />);
    await waitFor(() => {
      expect(container.querySelector('article')).not.toBeNull();
    });

    selectText(container, 'Người dùng nhập mã OTP.');
    fireEvent.click(getByRole('button', { name: 'Thêm sau đoạn chọn' }));
    const kindSelect = getByRole('combobox', { name: 'Loại' }) as HTMLSelectElement;
    expect(kindSelect.value).toBe('gap');

    fireEvent.change(kindSelect, { target: { value: 'component' } });
    fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), {
      target: { value: 'Hệ thống kiểm tra mã OTP trước khi cho tiếp tục.' },
    });
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const created = latestSidecar().annotations.at(-1);
    expect(created).toMatchObject({ origin: 'user', operation: 'add', kind: 'component' });
  });

  it('"Xoá đoạn chọn": composer KHÔNG hiện select "Loại"', async () => {
    vi.resetModules();
    mockSimpleProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container, getByRole, queryByRole } = render(<Comp projectId="p1" file={SIMPLE_FILE} />);
    await waitFor(() => {
      expect(container.querySelector('article')).not.toBeNull();
    });

    selectText(container, 'Người dùng nhập mã OTP.');
    fireEvent.click(getByRole('button', { name: 'Xoá đoạn chọn' }));
    expect(queryByRole('combobox', { name: 'Loại' })).toBeNull();
  });
});
