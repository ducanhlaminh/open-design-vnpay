// @vitest-environment jsdom
//
// WP confluence-paste-link — dán LINK hoặc PAGE ID vào CÙNG ô tìm của cả hai
// picker Confluence (không textarea, không nút chuyển chế độ):
//   • `ConfluenceTreePicker` (App → Nhập tài liệu): ref → GET
//     /api/pipelines/confluence/resolve?ref= (KHÔNG gọi search) → hàng hit y
//     hệt kết quả tìm (tick + mũi tên theo hasChildren) + meta "Từ link đã dán".
//   • `ConfluencePagePicker` (modal Chạy bước Docs / Chạy full): ref → hit
//     trong cây → tick → "Thêm N trang" → `onPagesChange` nhận {id,title,url}.
// Daemon (executor A) chưa chắc đã có route lúc viết test này — mock fetch
// theo hợp đồng: 200 `{page}`, 400/404/502 `{error}`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { ConfluenceTreePicker, looksLikeConfluenceRef, splitConfluenceRefs } = await import(
  '../../../src/components/pipelines/ConfluenceTreeImport'
);
const { ConfluencePagePicker } = await import('../../../src/components/pipelines/PipelineModals');

const LINK_A = 'https://wiki.example.com/pages/123456/Abc';
const LINK_B = 'https://wiki.example.com/display/SPACE/Trang+B';

let fetchMock: ReturnType<typeof vi.fn>;
/** Mọi URL fetch đã gọi, để khẳng định "ref → resolve, KHÔNG search" và ngược lại. */
const calledUrls = () => fetchMock.mock.calls.map((call) => String(call[0]));

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

beforeEach(() => {
  fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/confluence/resolve?ref=')) {
      const ref = decodeURIComponent(u.split('ref=')[1] ?? '');
      if (ref === LINK_A || ref === '123456') {
        return json(200, {
          page: { id: '123456', title: 'Trang từ link A', url: LINK_A, space: 'SPACE', hasChildren: true, ancestors: ['Cha'] },
        });
      }
      if (ref === LINK_B) {
        return json(200, { page: { id: '789', title: 'Trang B', url: LINK_B, space: 'SPACE', hasChildren: false } });
      }
      if (ref === '404404') return json(404, { error: 'Không tìm thấy trang hoặc không có quyền.' });
      return json(400, { error: 'Không nhận ra link/page id Confluence.' });
    }
    if (u.includes('/confluence/pages?q=')) {
      return json(200, { pages: [{ id: 'p-18', title: '18. Kế toán thuê tài sản', hasChildren: false, ancestors: [] }] });
    }
    if (u.includes('/confluence/descendants?ref=')) {
      const ref = decodeURIComponent(u.split('ref=')[1] ?? '');
      if (ref === '123456') {
        return json(200, { pages: [{ pageId: '123456-1', title: 'Con của A', treePath: [] }] });
      }
      return json(200, { pages: [] });
    }
    return json(200, {});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('helper nhận dạng ref', () => {
  it('looksLikeConfluenceRef: link http(s) hoặc toàn chữ số (kể cả 1 chữ số); tên trang thì không', () => {
    expect(looksLikeConfluenceRef(LINK_A)).toBe(true);
    expect(looksLikeConfluenceRef('  HTTP://wiki/x/abc ')).toBe(true);
    expect(looksLikeConfluenceRef('123456')).toBe(true);
    expect(looksLikeConfluenceRef('7')).toBe(true);
    expect(looksLikeConfluenceRef('Kế toán')).toBe(false);
    expect(looksLikeConfluenceRef('12 trang')).toBe(false);
    expect(looksLikeConfluenceRef('')).toBe(false);
  });

  it('splitConfluenceRefs: tách theo khoảng trắng/xuống dòng, cả khi trình duyệt xoá xuống dòng làm hai link dính nhau', () => {
    expect(splitConfluenceRefs(`${LINK_A}\n${LINK_B}`)).toEqual([LINK_A, LINK_B]);
    expect(splitConfluenceRefs(`${LINK_A}  123456 \r\n 789`)).toEqual([LINK_A, '123456', '789']);
    expect(splitConfluenceRefs(`${LINK_A}${LINK_B}`)).toEqual([LINK_A, LINK_B]);
    expect(splitConfluenceRefs(`${LINK_A} ${LINK_A}`)).toEqual([LINK_A]);
  });
});

function TreeHarness() {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  return <ConfluenceTreePicker ticked={ticked} onTickedChange={setTicked} />;
}

describe('ConfluenceTreePicker · dán link/page id vào cùng ô tìm', () => {
  it('không có textarea/nút chuyển chế độ; placeholder nói rõ nhận cả link', () => {
    const view = render(<TreeHarness />);
    expect(view.container.querySelector('textarea')).toBeNull();
    const input = view.container.querySelector('input[role="combobox"]') as HTMLInputElement;
    expect(input.placeholder).toContain('dán link/page id');
  });

  it('dán link → gọi resolve (KHÔNG search) → hàng hit với title từ API, meta "Từ link đã dán", tick được, có mũi tên khi hasChildren', async () => {
    const view = render(<TreeHarness />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    const body = view.container.querySelector('[class*="pickerBody"]') as HTMLElement;

    fireEvent.change(input, { target: { value: LINK_A } });
    await waitFor(() => expect(body.textContent).toContain('Trang từ link A'));
    expect(body.textContent).toContain('Từ link đã dán');
    expect(body.textContent).toContain('SPACE');

    // Đúng endpoint, đúng ref; và tuyệt đối không có lượt search theo tên.
    expect(calledUrls().some((u) => u.includes(`/api/pipelines/confluence/resolve?ref=${encodeURIComponent(LINK_A)}`))).toBe(true);
    expect(calledUrls().some((u) => u.includes('/confluence/pages?q='))).toBe(false);

    // Mũi tên xem trang con (hasChildren: true) — mở ra thấy cây con từ descendants.
    const row = within(body).getByText('Trang từ link A').closest('[class*="hitRow"]') as HTMLElement;
    await waitFor(() => expect(row.querySelector('[class*="chevron"]')).not.toBeNull());
    fireEvent.click(row);
    await waitFor(() => expect(body.textContent).toContain('Con của A'));

    // Tick trang → cascade sang trang con đã nạp → 2 trang đã chọn.
    fireEvent.click(within(body).getByRole('checkbox', { name: 'Chọn Trang từ link A' }));
    await waitFor(() => expect(view.container.textContent).toContain('2 trang đã chọn'));

    // Xoá ô → trang nằm trong danh sách đã tick với đúng tên (không cần state riêng).
    fireEvent.click(within(view.container).getByRole('button', { name: 'Xong' }));
    await waitFor(() => expect(body.textContent).toContain('Tài liệu đã chọn'));
    expect(body.textContent).toContain('Trang từ link A');
    expect(body.textContent).toContain('Con của A');
  });

  it('dán 2 link cách xuống dòng → 2 hàng; trang lá (hasChildren:false) không có mũi tên', async () => {
    const view = render(<TreeHarness />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    const body = view.container.querySelector('[class*="pickerBody"]') as HTMLElement;

    fireEvent.change(input, { target: { value: `${LINK_A}\n${LINK_B}` } });
    await waitFor(() => {
      expect(body.textContent).toContain('Trang từ link A');
      expect(body.textContent).toContain('Trang B');
    });
    expect(body.querySelectorAll('[class*="hitRow"]')).toHaveLength(2);
    const leaf = within(body).getByText('Trang B').closest('[class*="hitRow"]') as HTMLElement;
    expect(leaf.querySelector('[class*="chevron"]')).toBeNull();
    expect(calledUrls().filter((u) => u.includes('/confluence/resolve?ref='))).toHaveLength(2);
  });

  it('resolve 400 → dòng lỗi kèm gợi ý dạng hỗ trợ; 404 → lỗi không kèm gợi ý', async () => {
    const view = render(<TreeHarness />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    const body = view.container.querySelector('[class*="pickerBody"]') as HTMLElement;

    fireEvent.change(input, { target: { value: 'https://wiki.example.com/khong-hieu' } });
    await waitFor(() => expect(body.textContent).toContain('Không tra được «https://wiki.example.com/khong-hieu»'));
    expect(body.textContent).toContain('Không nhận ra link/page id Confluence.');
    expect(body.textContent).toContain('Dạng hỗ trợ: …/pages/<id>');

    fireEvent.change(input, { target: { value: '404404' } });
    await waitFor(() => expect(body.textContent).toContain('Không tra được «404404»'));
    expect(body.textContent).toContain('Không tìm thấy trang hoặc không có quyền.');
    expect(body.textContent).not.toContain('Dạng hỗ trợ');
    // Vẫn ở chế độ "đang tìm": nút Xong hiện, không rơi về danh sách đã tick.
    expect(within(view.container).queryByRole('button', { name: 'Xong' })).not.toBeNull();
  });

  it('gõ chữ thường → vẫn search theo tên như cũ, không gọi resolve', async () => {
    const view = render(<TreeHarness />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    const body = view.container.querySelector('[class*="pickerBody"]') as HTMLElement;

    fireEvent.change(input, { target: { value: 'Kế toán' } });
    await waitFor(() => expect(body.textContent).toContain('18. Kế toán thuê tài sản'), { timeout: 3000 });
    expect(calledUrls().some((u) => u.includes('/confluence/pages?q='))).toBe(true);
    expect(calledUrls().some((u) => u.includes('/confluence/resolve?ref='))).toBe(false);
    expect(body.textContent).not.toContain('Từ link đã dán');
  });
});

describe('ConfluencePagePicker · dán link/page id vào cùng ô tìm', () => {
  it('không còn textarea / nút chuyển chế độ; placeholder nói rõ nhận cả link', () => {
    const view = render(<ConfluencePagePicker pages={[]} onPagesChange={() => undefined} />);
    expect(view.container.querySelector('textarea')).toBeNull();
    expect(view.container.textContent).not.toContain('Dán link / page id thay vì tìm');
    expect(view.container.textContent).not.toContain('Quay lại tìm theo tên');
    const input = view.container.querySelector('input.pl-input') as HTMLInputElement;
    expect(input.placeholder).toContain('dán link/page id');
  });

  it('dán id → resolve → hit trong cây → tick → Thêm → onPagesChange nhận {id,title,url}', async () => {
    const onPagesChange = vi.fn();
    const view = render(<ConfluencePagePicker pages={[]} onPagesChange={onPagesChange} />);
    const input = view.container.querySelector('input.pl-input')!;

    fireEvent.change(input, { target: { value: '123456' } });
    await waitFor(() => expect(view.container.textContent).toContain('Trang từ link A'));
    expect(calledUrls().some((u) => u.includes('/confluence/resolve?ref=123456'))).toBe(true);
    expect(calledUrls().some((u) => u.includes('/confluence/pages?q='))).toBe(false);
    expect(view.container.querySelector('[class*="tree"]')).not.toBeNull();

    // Tick = bấm hàng (cùng cơ chế với hit tìm) → nút Thêm N trang.
    fireEvent.click(within(view.container).getByText('Trang từ link A').closest('[class*="treeRow"]')!);
    const add = await within(view.container).findByRole('button', { name: /Thêm 1 trang vào danh sách/ });
    fireEvent.click(add);

    expect(onPagesChange).toHaveBeenCalledTimes(1);
    expect(onPagesChange.mock.calls[0]![0]).toEqual([{ id: '123456', title: 'Trang từ link A', url: LINK_A }]);
  });

  it('resolve 400 → dòng lỗi kèm gợi ý; gõ tên → search như cũ', async () => {
    const view = render(<ConfluencePagePicker pages={[]} onPagesChange={() => undefined} />);
    const input = view.container.querySelector('input.pl-input')!;

    fireEvent.change(input, { target: { value: 'https://wiki.example.com/khong-hieu' } });
    await waitFor(() => expect(view.container.textContent).toContain('Không tra được «https://wiki.example.com/khong-hieu»'));
    expect(view.container.textContent).toContain('Dạng hỗ trợ');

    fireEvent.change(input, { target: { value: 'Kế toán' } });
    await waitFor(() => expect(view.container.textContent).toContain('18. Kế toán thuê tài sản'), { timeout: 3000 });
    expect(view.container.textContent).not.toContain('Không tra được');
  });
});
