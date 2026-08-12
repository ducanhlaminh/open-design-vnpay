// @vitest-environment jsdom
//
// ConfluenceTreePicker — panel chọn trang Confluence (App mới / Sửa App /
// "Import thêm" trong modal Nguồn tài liệu).
//
// Thứ đắt nhất ở đây là DANH SÁCH TRANG ĐÃ TICK. Trước đây tick xong thì
// dropdown đóng lại và trên màn không còn dấu vết gì ngoài một dòng đếm: không
// soát lại được đã tick những trang nào, cũng không bỏ tick được trang nào mà
// không phải đi tìm lại nó trong kết quả tìm kiếm. Và vì `hits` chỉ chứa kết
// quả của truy vấn HIỆN TẠI, tên trang phải đến từ một cache tích luỹ — đọc
// thẳng `hits` thì trang tick dưới từ khoá trước rơi về id thô ngay khi người
// dùng gõ từ khoá mới.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      if (String(url).includes('/confluence/pages')) {
        return {
          ok: true,
          json: async () => ({
            pages: [
              { id: 'p-18', title: '18. Kế toán thuê tài sản', hasChildren: false, ancestors: [] },
              { id: 'p-2', title: '2. URD cho website kế toán', hasChildren: true, ancestors: [] },
            ],
          }),
        } as Response;
      }
      if (String(url).includes('/confluence/descendants')) {
        // `treePath` = TIÊU ĐỀ các tổ tiên DƯỚI trang gốc (gốc không nằm trong
        // đó — `buildConfluenceDescTree` bắt đầu đi từ chính nó). Dùng pageId ở
        // đây thì mọi node trung gian không khớp tiêu đề nào và bị prune sạch.
        return {
          ok: true,
          json: async () => ({
            pages: [
              { pageId: 'p-2-1', title: 'II. URD Danh mục', treePath: [] },
              {
                pageId: 'p-2-1-1',
                title: '2.10. URD - Số dư ban đầu',
                treePath: ['II. URD Danh mục'],
              },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }),
  );
});

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { ConfluenceTreePicker, rankConfluenceHits } = await import(
  '../../../src/components/pipelines/ConfluenceTreeImport'
);

/** Bọc picker trong state thật: `ticked` là controlled, nên test không dựng
 *  vòng dữ liệu thì bỏ tick sẽ không bao giờ phản ánh ra DOM. */
function Harness({ initial }: { initial?: string[] }) {
  const [ticked, setTicked] = useState<Set<string>>(new Set(initial ?? []));
  return <ConfluenceTreePicker ticked={ticked} onTickedChange={setTicked} />;
}

describe('ConfluenceTreePicker · panel chọn trang', () => {
  it('xếp fuzzy không dấu theo tiêu đề, breadcrumb và chấp nhận lỗi đảo ký tự', () => {
    const hits = [
      { id: '3', title: 'Thông báo nghỉ lễ', space: 'HR' },
      { id: '2', title: 'Báo cáo tài chính', ancestors: ['Khối nghiệp vụ', 'Kế toán'] },
      { id: '1', title: '2. URD cho website kế toán', space: 'VNPPMKT' },
    ];
    expect(rankConfluenceHits('ke taon', hits).map((hit) => hit.id)).toEqual(['1', '2', '3']);
    expect(rankConfluenceHits('tai chinh', hits).map((hit) => hit.id)[0]).toBe('2');
  });

  it('chưa tick gì thì nói rõ phải làm gì, không để một vùng trống', () => {
    const view = render(<Harness />);
    expect(view.container.textContent).toContain('Chưa tick trang nào');
    expect(view.container.textContent).toContain('Gõ tên trang vào ô trên để tìm');
  });

  it('trang đã tick hiện thành hàng riêng kèm nút bỏ tick', async () => {
    const view = render(<Harness initial={['page-1', 'page-2']} />);
    expect(view.container.textContent).toContain('2 trang đã chọn');
    const removes = view.container.querySelectorAll('button[aria-label^="Bỏ tick"]');
    expect(removes).toHaveLength(2);

    fireEvent.click(removes[0]!);
    await waitFor(() => expect(view.container.textContent).toContain('1 trang đã chọn'));
    expect(view.container.querySelectorAll('button[aria-label^="Bỏ tick"]')).toHaveLength(1);
  });

  it('ô tìm nằm TRONG panel, cùng khối với vùng danh sách', () => {
    const view = render(<Harness initial={['page-1']} />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    // Panel = cha của thanh công cụ. KHÔNG dùng `closest('[class*="picker"]')`:
    // tên class của CSS Module bị hash nên `pickerHead` cũng khớp mẫu đó, và
    // closest dừng ngay ở thanh công cụ thay vì lên tới panel.
    const head = view.container.querySelector('[class*="pickerHead"]')!;
    const panel = head.parentElement!;
    expect(panel.contains(input)).toBe(true);
    expect(head.querySelector('[class*="pickerCount"]')).not.toBeNull();
    expect(panel.querySelector('[class*="pickerBody"]')).not.toBeNull();
    expect(panel.querySelector('[class*="pickerFoot"]')).not.toBeNull();
  });

  it('kết quả tìm đổ vào CHÍNH vùng danh sách, không có dropdown nổi ngoài panel', async () => {
    const view = render(<Harness />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    const body = view.container.querySelector('[class*="pickerBody"]')!;
    expect(body.textContent).toContain('Gõ tên trang vào ô trên để tìm');

    fireEvent.change(input, { target: { value: 'Kế toán' } });
    await waitFor(
      () => expect(body.textContent).toContain('18. Kế toán thuê tài sản'),
      { timeout: 3000 },
    );
    expect(body.textContent).toContain('2. URD cho website kế toán');
    // Vùng rỗng nhường chỗ cho kết quả — một khung nhìn, hai chế độ.
    expect(body.textContent).not.toContain('Gõ tên trang vào ô trên để tìm');

    // Không còn portal: mọi thứ picker vẽ ra đều nằm trong cây của chính nó.
    // `render` gắn container vào document.body, nên baseElement chỉ được có
    // đúng container đó — thêm node anh em nghĩa là dropdown đã quay lại.
    expect(view.baseElement.children).toHaveLength(1);
    expect(view.baseElement.firstElementChild).toBe(view.container);
  });

  it('cây con MẶC ĐỊNH ĐÓNG; bấm hàng mở nó ra mà KHÔNG tick trang nào', async () => {
    const view = render(<Harness />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    const body = view.container.querySelector('[class*="pickerBody"]')!;

    fireEvent.change(input, { target: { value: 'Kế toán' } });
    await waitFor(() => expect(body.textContent).toContain('2. URD cho website kế toán'), {
      timeout: 3000,
    });
    // Cây con đã nạp sẵn (mũi tên biết trang này có con) nhưng chưa hiện ra.
    await waitFor(() =>
      expect(view.container.querySelector('[class*="chevron"]')).not.toBeNull(),
    );
    expect(body.textContent).not.toContain('II. URD Danh mục');

    const parentRow = within(body as HTMLElement)
      .getByText('2. URD cho website kế toán')
      .closest('[class*="hitRow"]')!;
    fireEvent.click(parentRow);

    await waitFor(() => expect(body.textContent).toContain('II. URD Danh mục'));
    // Mở cây con KHÔNG được đụng tới lựa chọn — đó là hai hành động khác nhau.
    expect(view.container.textContent).toContain('Chưa tick trang nào');

    fireEvent.click(parentRow);
    await waitFor(() => expect(body.textContent).not.toContain('II. URD Danh mục'));
  });

  it('tick chỉ đổi khi bấm ĐÚNG ô tick, và cú bấm đó không mở cây con', async () => {
    const view = render(<Harness />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    const body = view.container.querySelector('[class*="pickerBody"]')!;

    fireEvent.change(input, { target: { value: 'Kế toán' } });
    await waitFor(() => expect(body.textContent).toContain('2. URD cho website kế toán'), {
      timeout: 3000,
    });

    fireEvent.click(within(body as HTMLElement).getByRole('checkbox', { name: /^Chọn 2\. URD/ }));
    await waitFor(() => expect(view.container.textContent).toContain('3 trang đã chọn'));
    // …và cú bấm đó không mở cây con ra.
    expect(body.textContent).not.toContain('II. URD Danh mục');
  });

  it('mũi tên nằm SAU tiêu đề trong hàng (mép phải), và chỉ hàng có con mới có', async () => {
    const view = render(<Harness />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    const body = view.container.querySelector('[class*="pickerBody"]')!;

    fireEvent.change(input, { target: { value: 'Kế toán' } });
    await waitFor(() => expect(body.textContent).toContain('2. URD cho website kế toán'), {
      timeout: 3000,
    });
    await waitFor(() =>
      expect(view.container.querySelector('[class*="chevron"]')).not.toBeNull(),
    );

    const parentRow = within(body as HTMLElement)
      .getByText('2. URD cho website kế toán')
      .closest('[class*="hitRow"]')! as HTMLElement;
    const kids = [...parentRow.children];
    const chevronIdx = kids.findIndex((el) => el.className.includes('chevron'));
    const bodyIdx = kids.findIndex((el) => el.className.includes('optionBody'));
    expect(chevronIdx).toBeGreaterThan(bodyIdx);

    // Hàng lá (`hasChildren: false`) không có mũi tên nào.
    const leafRow = within(body as HTMLElement)
      .getByText('18. Kế toán thuê tài sản')
      .closest('[class*="hitRow"]')! as HTMLElement;
    expect(leafRow.querySelector('[class*="chevron"]')).toBeNull();
  });

  it('trang cha hiện trạng thái NỬA TICK khi cây con chỉ tick một phần', async () => {
    const view = render(<Harness />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    const body = view.container.querySelector('[class*="pickerBody"]')!;

    fireEvent.change(input, { target: { value: 'Kế toán' } });
    await waitFor(() => expect(body.textContent).toContain('2. URD cho website kế toán'), {
      timeout: 3000,
    });
    await waitFor(() => expect(view.container.querySelector('[class*="chevron"]')).not.toBeNull());
    const parentBox = () => within(body as HTMLElement).getByRole('checkbox', { name: /2\. URD cho website/ });
    fireEvent.click(parentBox());
    await waitFor(() => expect(parentBox().getAttribute('aria-checked')).toBe('true'));
    const parentRow = within(body as HTMLElement).getByText('2. URD cho website kế toán').closest('[class*="hitRow"]')!;
    fireEvent.click(parentRow);
    await waitFor(() => expect(body.textContent).toContain('II. URD Danh mục'));
    fireEvent.click(within(body as HTMLElement).getByRole('checkbox', { name: /II\. URD Danh mục/ }));
    await waitFor(() => expect(parentBox().getAttribute('aria-checked')).toBe('mixed'));
  });

  it('bấm "Xong" xoá ô tìm và trả vùng danh sách về các trang đã tick', async () => {
    const view = render(<Harness initial={['page-1']} />);
    const input = view.container.querySelector('input[role="combobox"]')!;
    const body = view.container.querySelector('[class*="pickerBody"]')!;

    fireEvent.change(input, { target: { value: 'Kế toán' } });
    await waitFor(() => expect(body.textContent).toContain('18. Kế toán thuê tài sản'), {
      timeout: 3000,
    });

    fireEvent.click(within(view.container).getByRole('button', { name: 'Xong' }));
    await waitFor(() => expect(body.textContent).toContain('Tài liệu đã chọn'));
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('nút quét tài liệu liên quan bị khoá khi chưa tick trang nào', () => {
    const view = render(<Harness />);
    const scan = within(view.container).getByRole('button', {
      name: /Quét tài liệu liên quan/,
    }) as HTMLButtonElement;
    expect(scan.disabled).toBe(true);

    cleanup();
    const withTick = render(<Harness initial={['page-1']} />);
    const scan2 = within(withTick.container).getByRole('button', {
      name: /Quét tài liệu liên quan/,
    }) as HTMLButtonElement;
    expect(scan2.disabled).toBe(false);
  });
});
