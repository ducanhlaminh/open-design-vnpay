// @vitest-environment jsdom
//
// Test DUY NHẤT mount DocRedlinePreview thật dưới React. Nó tồn tại vì đợt
// redline có ba lần "logic đo thì đúng mà giao diện không bôi gì": các phép đo
// thuần (regex khớp chuỗi) không thấy được vòng đời React, ref gắn muộn, hay
// DOM bị dựng lại sau khi đã bôi. Chỉ có mount thật mới bắt được.
//
// Test cũng khoá luôn việc component KHÔNG được import từ './FileViewer':
// FileViewer đã import component này để route file redline, nên chiều ngược
// lại là import vòng. Ở đây không mock FileViewer — nếu ai đó nối lại vòng đó,
// module 8000 dòng sẽ bị kéo vào và test đổ ngay lúc import.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

const ORIGINAL = [
  '# Quản lý khách hàng',
  '',
  '| Nút | Mô tả |',
  '| --- | --- |',
  '| Xuất Excel | Chi tiết: Luồng thay thế 16 (Xuất Excel). |',
  '',
  '- SCR-009 — Nhập Excel',
  '- SCR-010 — Xuất excel',
  '',
  'Người dùng nhập OTP.',
  '',
].join('\n');

const REASON_C1 = 'Mã màn hình sai và trùng với popup khác.';
const REASON_C2 = 'AF-16 là luồng Nhập Excel sai định dạng, không phải Xuất Excel.';
const REASON_C3 = 'Nêu rõ định dạng OTP để người đọc không phải đoán.';
const REASON_C4 = 'Chỗ sửa này trích một câu không còn tồn tại trong bản đã sửa.';

const CHANGES = JSON.stringify([
  {
    id: 'c1',
    kind: 'gap',
    severity: 'major',
    before: '- SCR-009 — Nhập Excel\n- SCR-010 — Xuất excel',
    quote: '- SCR-012 — Nhập Excel\n- SCR-013 — Xuất Excel',
    reason: REASON_C1,
  },
  {
    id: 'c2',
    kind: 'flow',
    severity: 'major',
    before: 'Luồng thay thế 16 (Xuất Excel). |',
    quote: 'Luồng thay thế AF-18 (Xuất Excel). |',
    reason: REASON_C2,
  },
  {
    id: 'c3',
    kind: 'ux-writing',
    severity: 'minor',
    before: 'Người dùng nhập OTP.',
    quote: 'Người dùng nhập mã OTP gồm 6 chữ số.',
    reason: REASON_C3,
  },
  // Chỗ sửa KHÔNG NEO ĐƯỢC: `before` là câu chắc chắn không có trong tài
  // liệu (đã enrich nhưng KHÔNG BAO GIỜ bị sửa), nên injectHighlights không
  // tạo <mark> nào cho nó.
  {
    id: 'c4',
    kind: 'edge-case',
    severity: 'blocker',
    before: 'Một câu cũ nào đó tuyệt đối không xuất hiện ở bất kỳ đâu trong tài liệu.',
    quote: 'Câu đề xuất thay thế.',
    reason: REASON_C4,
  },
]);

// Tài liệu hiển thị LUÔN là bản GỐC đã enrich — component không bao giờ ghi
// lại `file.name`, nên chỉ có MỘT phiên bản để phục vụ, không còn khái niệm
// "bản đã sửa" phân biệt theo đường dẫn như trước.
vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => {
    if (name.endsWith('.changes.json')) return CHANGES;
    return ORIGINAL;
  },
  projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
}));

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { DocRedlinePreview, extractRuleSection } = await import('../../src/components/DocRedlinePreview');

const FILE = {
  name: 'docs-review/review/docs/confluence/urd.md',
  kind: 'text',
  size: ORIGINAL.length,
  mtime: 1,
} as never;

// jsdom không cài `scrollIntoView` (nó là hành vi trình duyệt, không phải DOM
// API jsdom mô phỏng). Component gọi nó khi cuộn vùng bôi / mục danh sách vào
// tầm nhìn, nên thiếu nó thì mọi click đều ném lỗi vì lý do KHÔNG liên quan tới
// bug đang đo. Đây là SPY chứ không phải hàm rỗng: hướng "click mục trong danh
// sách → cuộn tài liệu" chỉ quan sát được qua chính lời gọi này, và phải kiểm
// cả `this` (cuộn nhầm sang mark của change khác vẫn thoả nếu chỉ đếm số lần).
interface ScrollCall {
  el: Element;
  opts: ScrollIntoViewOptions | boolean | undefined;
}
const scrollCalls: ScrollCall[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = function scrollIntoViewSpy(
    this: Element,
    opts?: ScrollIntoViewOptions | boolean,
  ) {
    scrollCalls.push({ el: this, opts });
  };
});
beforeEach(() => {
  scrollCalls.length = 0;
});

/** Chờ mark của MỌI change neo được xuất hiện rồi trả về mark đầu tiên của
 *  từng change. Trả `HTMLElement` chứ không trả selector vì test click thật
 *  vào phần tử. */
async function renderAndWaitForMarks(): Promise<{
  container: HTMLElement;
  markOf: (changeId: string) => HTMLElement;
}> {
  const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
  await waitFor(() => {
    const ids = new Set(
      Array.from(container.querySelectorAll<HTMLElement>('mark[data-change-id]')).map(
        (mark) => mark.dataset.changeId,
      ),
    );
    expect(ids).toEqual(new Set(['c1', 'c2', 'c3']));
  });
  return {
    container,
    markOf: (changeId: string) => {
      const mark = container.querySelector<HTMLElement>(`mark[data-change-id="${changeId}"]`);
      if (!mark) throw new Error(`không tìm thấy mark của ${changeId}`);
      return mark;
    },
  };
}

describe('DocRedlinePreview', () => {
  it('bôi highlight mọi chỗ sửa neo được và nối chúng bằng data-change-id', async () => {
    const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);

    await waitFor(() => {
      expect(container.querySelectorAll('mark[data-change-id]').length).toBeGreaterThan(0);
    });

    const ids = new Set(
      Array.from(container.querySelectorAll<HTMLElement>('mark[data-change-id]')).map(
        (mark) => mark.dataset.changeId,
      ),
    );
    // Ba chỗ sửa có quote khớp bản đã sửa đều phải neo được — nếu tụt xuống,
    // cách cắt đoạn trong quoteSegments đã hỏng với một dạng cú pháp markdown
    // nào đó. `c4` cố ý không neo được (xem fixture).
    expect(ids).toEqual(new Set(['c1', 'c2', 'c3']));
  });

  it('chỉ còn MỘT cột tài liệu, và mọi mark nằm trong đó', async () => {
    const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => {
      expect(container.querySelectorAll('mark[data-change-id]').length).toBeGreaterThan(0);
    });

    // Cột bản gốc đã bỏ: chỉ còn đúng một .docCol.
    const cols = container.querySelectorAll('[class*="docCol"]');
    expect(cols.length).toBe(1);
    const col = cols[0]!;
    const idsInCol = new Set(
      Array.from(col.querySelectorAll<HTMLElement>('mark[data-change-id]')).map(
        (mark) => mark.dataset.changeId,
      ),
    );
    expect(idsInCol).toEqual(new Set(['c1', 'c2', 'c3']));
    // Không còn mark nào ngoài cột tài liệu (ví dụ sót lại một cột thứ hai
      // được render ở chỗ khác trong cây).
    expect(container.querySelectorAll('mark[data-change-id]').length).toBe(
      col.querySelectorAll('mark[data-change-id]').length,
    );
  });

  // wp-redline-no-rail.yaml: rail đã bỏ, "Trước/Sau" ở đầu cột tài liệu vẫn
  // đi qua CÙNG cơ chế cuộn/nháy (selectFromList) — chỉ khác điểm vào.
  it('bấm "Sau" cuộn tài liệu tới vùng bôi của chỗ sửa kế tiếp', async () => {
    const { container } = await renderAndWaitForMarks();

    fireEvent.click(container.querySelector('button[aria-label="Thay đổi sau"]')!);

    await waitFor(() => {
      expect(scrollCalls.length).toBeGreaterThan(0);
    });
    const hit = scrollCalls.find((call) => call.el.tagName.toLowerCase() === 'mark');
    expect(hit, 'phải cuộn tới một <mark>').toBeTruthy();
    // `behavior: 'auto'`, KHÔNG 'smooth' — xem docblock trong component.
    expect((hit!.opts as ScrollIntoViewOptions).behavior).toBe('auto');
  });

  // Chỗ sửa không neo được (c4) không có mark nào trong tài liệu — không có
  // gì để bấm — nhưng KHÔNG bị nuốt im lặng: nó vẫn tồn tại trong
  // `changes.json`, chỉ đơn giản là không tham gia vòng điều hướng
  // (`getAnchoredNavigationItems` lọc theo `anchored`, xem redline-navigation.ts).
  it('chỗ sửa không neo được không có mark, không chen vào vòng điều hướng', async () => {
    const { container } = await renderAndWaitForMarks();
    expect(container.querySelector('mark[data-change-id="c4"]')).toBeNull();
    // 3 chỗ sửa neo được (c1..c3) — tổng điều hướng phải khớp, không đếm dư c4.
    expect(container.textContent).toContain('/ 3');
  });

  // Bấm vùng bôi mở modal chi tiết đúng change đó và làm nổi mark của nó.
  it('click vùng bôi mở modal chi tiết đúng change và nháy sáng mark tương ứng', async () => {
    const { container, markOf } = await renderAndWaitForMarks();

    fireEvent.click(markOf('c2'));
    await waitFor(() => {
      expect(markOf('c2').className).toMatch(/Active/i);
    });
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(REASON_C2);
    expect(markOf('c1').className).not.toMatch(/Active/i);

    fireEvent.click(container.querySelector('[class*="modalClose"]')!);
    await waitFor(() => {
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    // Chuỗi click phải lặp được vô hạn, không phải chỉ đúng lần đầu.
    fireEvent.click(markOf('c3'));
    await waitFor(() => {
      expect(container.querySelector('[role="dialog"]')?.textContent).toContain(REASON_C3);
    });
    expect(markOf('c2').className).not.toMatch(/Active/i);
  });

  // Bấm lại chính vùng bôi đang chọn không được đóng modal — mark phải giữ
  // trạng thái nổi, modal vẫn mở với đúng nội dung.
  it('click lại chính vùng bôi đang chọn vẫn giữ modal mở với đúng nội dung', async () => {
    const { container, markOf } = await renderAndWaitForMarks();

    fireEvent.click(markOf('c2'));
    await waitFor(() => {
      expect(markOf('c2').className).toMatch(/Active/i);
    });

    fireEvent.click(markOf('c2'));
    expect(markOf('c2').className).toMatch(/Active/i);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(REASON_C2);
  });
});

// extractRuleSection là phần thuần của popover rule. Nó phải khớp ĐÚNG quy ước
// anchor của daemon (collectCriteriaAnchors trong apps/daemon/src/docs-review.ts:
// token trong backtick trên dòng heading, bỏ dấu `#` đầu). Lệch quy ước nghĩa là
// daemon nhận một rule_id mà popover lại báo không tìm thấy — cùng một dữ liệu
// cho hai câu trả lời khác nhau, nên nó đáng có test riêng.
const CRITERIA = [
  '# Bộ tiêu chí',
  '',
  '## `R-OVERLAY` Khi nào dùng overlay',
  '',
  'Modal chỉ dùng cho xác nhận một bước, không có form.',
  '',
  '### `R-OVERLAY-DRAWER` Drawer',
  '',
  'Drawer cho tác vụ nhiều bước.',
  '',
  '## `R-TABLE` Bảng',
  '',
  'Ghim cột đầu khi bảng cuộn ngang.',
  '',
].join('\n');

describe('extractRuleSection', () => {
  it('cắt đúng phần của một rule, và ôm cả rule con nằm dưới nó', () => {
    const section = extractRuleSection(CRITERIA, 'R-OVERLAY');
    expect(section).toContain('Modal chỉ dùng cho xác nhận một bước');
    // rule con (heading sâu hơn) thuộc về cha…
    expect(section).toContain('Drawer cho tác vụ nhiều bước.');
    // …nhưng rule ngang hàng kế tiếp thì không.
    expect(section).not.toContain('Ghim cột đầu');
  });

  it('dừng đúng ở heading ngang hàng kế tiếp', () => {
    const section = extractRuleSection(CRITERIA, 'R-TABLE');
    expect(section).toContain('Ghim cột đầu');
    expect(section).not.toContain('Modal chỉ dùng');
  });

  it('trả null khi anchor không có trong file', () => {
    expect(extractRuleSection(CRITERIA, 'R-KHONG-TON-TAI')).toBeNull();
  });

  it('bỏ dấu # đầu token, đúng như daemon làm với components.md (`#button`)', () => {
    const md = ['### `#button` Button', '', 'Biến thể: primary, secondary.', ''].join('\n');
    expect(extractRuleSection(md, 'button')).toContain('Biến thể: primary, secondary.');
  });
});
