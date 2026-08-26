// @vitest-environment jsdom
//
// wp-doc-redline-nondestructive: tài liệu hiển thị = bản GỐC, không bao giờ bị
// ghi lại (`fetchProjectFileText` cho `file.name` luôn trả TEXT dưới đây
// nguyên vẹn). Mark của agent-1 (phép SỬA — có cả `before`/`quote`) neo trên
// `before`, không phải `quote` — TEXT phải chứa đúng câu `before`, và một câu
// KHÁC (không trùng agent-1) để các test "tạo annotation người dùng" bôi đen.
//
// Rail đã bỏ hẳn: mọi hành động (Bỏ/Hoàn tác một chỗ sửa) giờ nằm trong
// `AnnotationDetailModal` mở ra khi bấm mark, không còn trong thẻ
// `[data-change-item]`. Tính năng "sửa TRỰC TIẾP nội dung quote của một chỗ
// sửa agent đã có, giữ initialQuote làm baseline" (nút "Sửa"/ô "Nội dung sửa"
// trong thẻ) đã KHÔNG CÒN ĐƯỜNG NÀO tới nó trong kiến trúc mới — đó là một
// thao tác "sửa-tại-chỗ-trên-thẻ" của rail, và rail đã bỏ; sửa một câu agent
// đã đề xuất giờ chỉ có thể làm qua "Sửa đoạn chọn" (tạo MỘT annotation MỚI
// của người dùng, neo trên chữ gốc) — khác hẳn ngữ nghĩa "giữ baseline agent,
// đổi quote tại chỗ". Bài test tương ứng ("keeps the agent baseline…") vì vậy
// đã XOÁ thay vì viết lại một thứ không tồn tại.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const TEXT = ['# Tài liệu', '', 'Người dùng nhập mã xác thực.', '', 'Người dùng nhập OTP.', ''].join('\n');
const SIDECAR = JSON.stringify({
  schemaVersion: 2,
  annotations: [{
    id: 'agent-1',
    kind: 'ux-writing',
    severity: 'minor',
    origin: 'agent',
    operation: 'edited',
    before: 'Người dùng nhập mã xác thực.',
    quote: 'Người dùng nhập OTP.',
    initialBefore: 'Người dùng nhập mã xác thực.',
    initialQuote: 'Người dùng nhập OTP.',
    reason: 'Dùng thuật ngữ trong tài liệu.',
  }],
  events: [],
});

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => {
    if (name.endsWith('.changes.json')) return SIDECAR;
    if (name.endsWith('.notes.json')) return null;
    return TEXT;
  },
  projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { DocRedlinePreview, parseDocChangesFile } = await import('../../src/components/DocRedlinePreview');

const FILE = {
  name: 'docs-review/review/docs/urd.md',
  kind: 'text',
  size: TEXT.length,
  mtime: 1,
} as never;

const fetchMock = vi.fn();

beforeAll(() => {
  Element.prototype.scrollIntoView = function noop() {};
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ file: FILE }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => cleanup());

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

function latestSidecarWrite(): { schemaVersion: number; annotations: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> } {
  const call = [...fetchMock.mock.calls].reverse().find((args) => {
    const init = args[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
    return body.name?.endsWith('.changes.json');
  });
  if (!call) throw new Error('missing sidecar write');
  const request = JSON.parse(String((call[1] as RequestInit).body)) as { content: string };
  return JSON.parse(request.content);
}

/** wp-doc-redline-nondestructive: khẳng định KHÔNG có lệnh ghi nào nhắm vào
 *  `file.name` (đuôi `.md`) — tài liệu không bao giờ bị ghi lại. */
function expectNoMdWrite() {
  const call = fetchMock.mock.calls.find((args) => {
    const init = args[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
    return body.name?.endsWith('.md');
  });
  expect(call, 'không được có lệnh ghi .md nào').toBeUndefined();
}

describe('Docs Review annotations and confirmation', () => {
  it('reads both legacy arrays and the v2 event envelope', () => {
    const legacy = parseDocChangesFile(JSON.stringify([{
      id: 'legacy', before: 'cũ', quote: 'mới', reason: 'Sửa câu.', kind: 'gap', severity: 'minor',
    }]));
    expect(legacy?.changes[0]).toMatchObject({
      id: 'legacy', origin: 'agent', operation: 'edited', initialBefore: 'cũ', initialQuote: 'mới',
    });
    expect(parseDocChangesFile(SIDECAR)?.events).toEqual([]);
  });

  it('creates a user edit from selected document text and writes an append-only create event (no .md write)', async () => {
    const { container, getByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());

    selectText(container, 'Người dùng nhập OTP.');
    fireEvent.click(getByRole('button', { name: 'Sửa đoạn chọn' }));
    fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), {
      target: { value: 'Người dùng nhập OTP gồm 6 chữ số.' },
    });
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    // Non-destructive: saveAction chỉ ghi .changes.json — MỘT lệnh gọi fetch,
    // không còn lệnh ghi .md song song như kiến trúc cũ.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expectNoMdWrite();
    const saved = latestSidecarWrite();
    expect(saved.schemaVersion).toBe(2);
    expect(saved.annotations.at(-1)).toMatchObject({
      origin: 'user',
      operation: 'edited',
      before: 'Người dùng nhập OTP.',
      quote: 'Người dùng nhập OTP gồm 6 chữ số.',
    });
    expect(saved.events.at(-1)).toMatchObject({ actor: 'user', type: 'create' });
  });

  it.each([
    { button: 'Thêm sau đoạn chọn', operation: 'add', replacement: 'Hệ thống kiểm tra OTP.' },
    { button: 'Xoá đoạn chọn', operation: 'delete', replacement: null },
  ])('creates a user $operation annotation with a stable anchor (no .md write)', async ({ button, operation, replacement }) => {
    const { container, getByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());

    selectText(container, 'Người dùng nhập OTP.');
    fireEvent.click(getByRole('button', { name: button }));
    if (replacement) {
      fireEvent.change(getByRole('textbox', { name: 'Nội dung mới' }), { target: { value: replacement } });
    }
    fireEvent.click(getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expectNoMdWrite();
    const annotation = latestSidecarWrite().annotations.at(-1);
    expect(annotation).toMatchObject({ origin: 'user', operation });
    expect(annotation?.anchor ?? annotation?.before).toBeTruthy();
  });

  it('records dismiss and restore events via the detail modal, without touching the document (.md)', async () => {
    const { container, baseElement } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(container.querySelector('mark[data-change-id="agent-1"]')).not.toBeNull());
    fireEvent.click(container.querySelector('mark[data-change-id="agent-1"]')!);

    const dialog = await waitFor(() => {
      const el = baseElement.querySelector('[role="dialog"]');
      expect(el, 'phải mở modal chi tiết của agent-1').not.toBeNull();
      return el as HTMLElement;
    });
    const dismissBtn = () =>
      Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Bỏ' || b.textContent === 'Hoàn tác')!;
    // wp-redline-card-polish.yaml mục 3: nhãn "Bỏ chỗ sửa" rút gọn còn "Bỏ" —
    // hành vi/nội dung nút không đổi qua đợt bỏ rail, chỉ đổi CHỖ hiện (modal).
    expect(dismissBtn().textContent).toBe('Bỏ');
    fireEvent.click(dismissBtn());

    await waitFor(() => expect(latestSidecarWrite().events.at(-1)).toMatchObject({ type: 'dismiss', actor: 'user' }));
    expect(latestSidecarWrite().annotations[0]).toMatchObject({ status: 'dismissed' });
    await waitFor(() => expect(dismissBtn().textContent).toBe('Hoàn tác'));

    fireEvent.click(dismissBtn());
    await waitFor(() => expect(latestSidecarWrite().events.at(-1)).toMatchObject({ type: 'restore', actor: 'user' }));
    expect(latestSidecarWrite().annotations[0]).toMatchObject({ status: 'active' });
    expectNoMdWrite();
  });

  it('does not expose workflow completion inside an individual document preview', async () => {
    const { queryByRole } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => expect(queryByRole('button', { name: 'Sửa đoạn chọn' })).toBeTruthy());
    expect(queryByRole('button', { name: 'Xác nhận hoàn tất' })).toBeNull();
  });
});
