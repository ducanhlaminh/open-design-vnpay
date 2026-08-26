// @vitest-environment jsdom
//
// wp4.yaml — sửa tay mở rộng: (2) "Thêm sau mục…" (chọn heading thay vì bôi
// đen), (3) select "Loại" trong composer sửa tay.
//
// wp-doc-redline-nondestructive: mục 1 gốc của wp4.yaml ("Sửa bảng" theo hàng
// cho thẻ Bảng thành phần) đã BỎ HẲN — `handleSaveTable` ghi thẳng nội dung ô
// đã sửa vào chính `file.name` (.md), đúng loại đường ghi mà kiến trúc mới
// cấm tuyệt đối (tài liệu hiển thị KHÔNG BAO GIỜ bị sửa). Không có đường thay
// thế non-destructive nào được yêu cầu bởi spec cho tính năng này, nên toàn
// bộ 9 test của mục 1 bị xoá thay vì viết lại — xem not_done của báo cáo thực
// thi.
//
// Mục 2/3 KHÔNG đụng vào cơ chế ghi `.md` (chúng dùng `createUserAnnotation`,
// đã là non-destructive từ trước) — chỉ chỉnh lại assertion không còn đọc
// `savedMd`/vị trí chèn trong tài liệu (tài liệu không đổi), thay bằng xác
// nhận KHÔNG có lệnh ghi `.md` nào được gọi.
//
// Fixture tách khỏi doc-redline-preview.wp3.test.tsx/.ops.test.tsx/.feedback
// test.tsx (mỗi file khoá một tập id/anchor riêng — cùng lý do các file đó đã
// tách nhau). Dùng lại khuôn dynamic-mock (`vi.doMock` + `import()` mỗi test)
// của wp3.test.tsx, và khuôn `fetch` mock + `latestSidecarWrite` của
// doc-redline-feedback.test.tsx để đọc đúng payload đã LƯU (không chỉ DOM).
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
 *  đã POST lên `/api/projects/:id/files`, không suy luận qua DOM). Ném lỗi
 *  nếu không tìm thấy — dùng làm assertion "phải/không được có lệnh ghi này". */
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
/** wp-doc-redline-nondestructive: khẳng định KHÔNG có lệnh ghi nào nhắm vào
 *  `file.name` (đuôi `.md`) — bất biến cốt lõi của kiến trúc mới, xem docblock
 *  đầu DocRedlinePreview.tsx. */
function expectNoMdWrite() {
  expect(() => latestWrite('.md')).toThrow();
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

// ── Fixture 1: tài liệu nhiều heading, KHÔNG có changes.json (mục 2 — "Thêm
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
function clickButton(root: HTMLElement, label: string) {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === label);
  if (!btn) throw new Error(`không tìm thấy nút "${label}"`);
  fireEvent.click(btn);
}

describe('DocRedlinePreview — wp4.yaml mục 2: "Thêm sau mục…"', () => {
  it('chọn một heading từ danh sách → lưu change add neo trên heading đó, KHÔNG ghi lại tài liệu (.md)', async () => {
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
    // Bất biến cốt lõi: tài liệu (file.name, đuôi .md) không bao giờ bị ghi
    // lại — chỉ sidecar changes.json nhận change mới.
    expectNoMdWrite();
    const sidecar = latestSidecar();
    const created = sidecar.annotations.at(-1);
    expect(created).toMatchObject({ origin: 'user', operation: 'add', anchor: '## Luồng đăng ký' });
    expect(created?.quote).toContain('Bước 0: người dùng mở màn hình đăng ký.');

    // Sau khi lưu, mark bôi xanh (Thêm) xuất hiện, neo TRÊN chính dòng
    // heading còn nguyên trong tài liệu — không có đoạn văn mới nào bị chèn
    // vào article (tài liệu không đổi).
    await waitFor(() => {
      expect(container.querySelector(`mark[data-change-id="${created!.id as string}"]`)).not.toBeNull();
    });
    expect(container.textContent).not.toContain('Bước 0: người dùng mở màn hình đăng ký.');
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
    expectNoMdWrite();
    const sidecar = latestSidecar();
    const created = sidecar.annotations.at(-1);
    expect(created).toMatchObject({ origin: 'user', operation: 'add', anchor: '# Đăng ký' });
    expect(created?.quote).toContain('Bước xác nhận: kiểm tra email đăng ký.');
  });
});

// ── Fixture 2: tài liệu đơn giản, KHÔNG có changes.json (mục 3 — select
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
  it('"Sửa đoạn chọn": mặc định "Sửa chữ" (ux-writing); đổi loại → kind đúng trong payload lưu, KHÔNG ghi .md', async () => {
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
    expectNoMdWrite();
    const created = latestSidecar().annotations.at(-1);
    expect(created).toMatchObject({ origin: 'user', operation: 'edited', kind: 'flow', severity: 'minor' });
    // `before` (nguồn bôi) vẫn là chữ gốc chưa đổi — tài liệu không bị ghi.
    expect(created?.before).toBe('Người dùng nhập mã OTP.');
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
    expectNoMdWrite();
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
