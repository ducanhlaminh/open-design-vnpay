// @vitest-environment jsdom
//
// Tham chiếu (`doc_refs`) mở CỬA SỔ xem đoạn được viện dẫn, không cuộn cột
// chính. Fixture tách khỏi doc-redline-preview.test.tsx vì thêm `doc_refs` vào
// fixture bên đó sẽ đẻ thêm mark `ref:…` và làm hỏng phép so tập mark của nó —
// hai file, hai câu hỏi khác nhau.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

// Không có cleanup thì mỗi `render` để lại cây cũ trong document.body, nên
// `baseElement` (dùng để tìm modal + ô chọn ở tầng body) gom cả các test trước
// và phép đếm "phải có đúng 2 ô chọn" đọc ra 7.
afterEach(() => cleanup());

const EDITED = [
  '# Quản lý nhân viên',
  '',
  '## 1. Vai trò',
  '',
  'Kế toán và Hành chính – Nhân sự cùng dùng danh mục nhân viên.',
  '',
  '## 2. Luồng xuất Excel',
  '',
  'Kế toán nhấn nút Xác nhận để hoàn tất giao dịch.',
  '',
].join('\n');

// c1 sửa câu ở mục 2, và VIỆN DẪN câu định nghĩa vai trò ở mục 1 — đúng hình
// dạng thật: chỗ sửa ở một nơi, bằng chứng cho nó ở nơi khác.
const CHANGES = JSON.stringify([
  {
    id: 'c1',
    kind: 'ux-writing',
    severity: 'minor',
    rule_id: 'default#ux-writing-chu-ngu',
    before: 'Người dùng nhấn nút Xác nhận để hoàn tất giao dịch.',
    quote: 'Kế toán nhấn nút Xác nhận để hoàn tất giao dịch.',
    doc_refs: ['Kế toán và Hành chính – Nhân sự cùng dùng danh mục nhân viên.'],
    reason: 'Chủ ngữ chung chung trong khi tài liệu đã định danh vai trò cụ thể.',
  },
]);

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => {
    if (name.endsWith('.changes.json')) return CHANGES;
    if (name.endsWith('.notes.json')) return null;
    return EDITED;
  },
  projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
}));

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { DocRedlinePreview } = await import('../../src/components/DocRedlinePreview');

const FILE = {
  name: 'docs-review/review/docs/confluence/urd.md',
  kind: 'text',
  size: EDITED.length,
  mtime: 1,
} as never;

// Xem chú thích trong doc-redline-preview.test.tsx: jsdom không cài
// scrollIntoView. Đây là SPY vì "cuộn tới ĐÚNG đoạn được dẫn" chỉ quan sát được
// qua chính lời gọi này — đếm số lần thôi thì cuộn nhầm chỗ vẫn qua.
const scrollTargets: Element[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = function scrollIntoViewSpy(this: Element) {
    scrollTargets.push(this);
  };
});

// wp3b.yaml mục E: RefRow (nút tham chiếu) nay nằm trong vùng gập "Chi tiết"
// của khuôn thẻ 3-dòng (mục D) — phải mở nó ra trước khi tìm nút tham chiếu.
async function renderAndOpenRef() {
  const { container, baseElement } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
  await waitFor(() => {
    expect(container.querySelector('mark[data-change-id="ref:c1:0"]')).not.toBeNull();
  });
  scrollTargets.length = 0;
  const detailBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Chi tiết'));
  expect(detailBtn, 'phải có nút "Chi tiết"').toBeTruthy();
  fireEvent.click(detailBtn!);
  const refBtn = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Kế toán và Hành chính'),
  );
  expect(refBtn, 'phải có nút tham chiếu trong thẻ').toBeTruthy();
  fireEvent.click(refBtn!);
  return { container, baseElement };
}

describe('doc_refs → cửa sổ xem đoạn được tham chiếu', () => {
  it('đoạn được viện dẫn được bôi trong tài liệu với id ref:<owner>:<i>', async () => {
    const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="c1"]')).not.toBeNull();
    });
    // Vùng viện dẫn là mark RIÊNG, không trùng id với chỗ sửa — nếu trùng thì
    // click vào nó sẽ bị hiểu nhầm thành click vào chỗ sửa.
    expect(container.querySelector('mark[data-change-id="ref:c1:0"]')).not.toBeNull();
  });

  it('bấm nút tham chiếu mở modal chứa tài liệu và cuộn tới đúng đoạn đó', async () => {
    const { baseElement } = await renderAndOpenRef();

    const dialog = baseElement.querySelector('[role="dialog"]');
    expect(dialog, 'modal phải mở').not.toBeNull();
    // Modal có BẢN SAO tài liệu riêng — cột chính giữ nguyên vị trí cuộn.
    const markInDialog = dialog!.querySelector('mark[data-change-id="ref:c1:0"]');
    expect(markInDialog).not.toBeNull();
    // …và chính mark trong modal là thứ được cuộn tới, không phải mark của cột
    // chính (nếu sai, người đọc mở modal ra và thấy đầu tài liệu).
    expect(scrollTargets).toContain(markInDialog);
  });

  it('Escape đóng modal', async () => {
    const { baseElement } = await renderAndOpenRef();
    expect(baseElement.querySelector('[role="dialog"]')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(baseElement.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  it('nút Đóng đóng modal', async () => {
    const { baseElement } = await renderAndOpenRef();
    const closeBtn = Array.from(baseElement.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Đóng',
    );
    expect(closeBtn).toBeTruthy();

    fireEvent.click(closeBtn!);

    await waitFor(() => {
      expect(baseElement.querySelector('[role="dialog"]')).toBeNull();
    });
  });
});

describe('bộ lọc màu (chú thích kiêm ô chọn)', () => {
  function boxes(root: HTMLElement): HTMLInputElement[] {
    return Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  }
  /** Ô chọn theo nhãn chip ("Thêm" | "Sửa" | "Xoá" | "Cần bàn"). */
  function boxFor(root: HTMLElement, label: string): HTMLInputElement {
    const chip = Array.from(root.querySelectorAll('label')).find((l) => l.textContent?.includes(label));
    if (!chip) throw new Error(`không tìm thấy chip "${label}"`);
    const input = chip.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) throw new Error(`chip "${label}" không có ô chọn`);
    return input;
  }

  it('có ĐÚNG bốn ô chọn, một cho mỗi màu, mặc định bật hết', async () => {
    const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="c1"]')).not.toBeNull();
    });
    const all = boxes(container);
    expect(all.length).toBe(4);
    expect(all.every((b) => b.checked)).toBe(true);
  });

  it('tắt "Sửa" chỉ gỡ phần sơn — mark VẪN CÒN trong DOM', async () => {
    const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="c1"]')).not.toBeNull();
    });
    expect(container.querySelector('mark[data-change-id="c1"]')!.className).toMatch(/hl/i);

    fireEvent.click(boxFor(container, 'Sửa'));

    await waitFor(() => {
      const mark = container.querySelector('mark[data-change-id="c1"]');
      // Mark PHẢI còn: nó giữ cho thẻ bên phải neo được. Mất mark thì thẻ tụt
      // xuống nhóm "không tìm thấy trong tài liệu" — tắt màu mà làm hỏng điều
      // hướng là cái giá không ai đồng ý trả.
      expect(mark).not.toBeNull();
      expect(mark!.className).toMatch(/hlOff/i);
    });
  });

  it('tắt "Sửa" KHÔNG đụng tới màu của loại khác', async () => {
    const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="ref:c1:0"]')).not.toBeNull();
    });

    fireEvent.click(boxFor(container, 'Sửa'));

    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="c1"]')!.className).toMatch(/hlOff/i);
    });
    // Vùng viện dẫn nằm ngoài bộ lọc (nó là điều hướng, không phải một loại sửa
    // đổi) nên phải nguyên vẹn.
    expect(container.querySelector('mark[data-change-id="ref:c1:0"]')!.className).toMatch(/hlRef/i);
    // Ba ô còn lại vẫn bật.
    expect(boxFor(container, 'Thêm').checked).toBe(true);
    expect(boxFor(container, 'Xoá').checked).toBe(true);
    expect(boxFor(container, 'Cần bàn').checked).toBe(true);
  });

  it('bộ lọc có mặt trong CẢ cửa sổ tham chiếu và dùng chung một state', async () => {
    const { container, baseElement } = await renderAndOpenRef();
    // 4 ở thanh tóm tắt + 4 ở đầu cửa sổ.
    expect(boxes(baseElement as HTMLElement).length).toBe(8);

    const dialog = baseElement.querySelector('[role="dialog"]') as HTMLElement;
    fireEvent.click(boxFor(dialog, 'Sửa'));

    await waitFor(() => {
      // Ô "Sửa" ngoài thanh tóm tắt cũng tắt theo — chung state, không phải hai
      // bộ công tắc rời cho cùng một thứ.
      expect(boxFor(container, 'Sửa').checked).toBe(false);
      expect(container.querySelector('mark[data-change-id="c1"]')!.className).toMatch(/hlOff/i);
    });
  });
});

describe('bộ lọc màu nói cho người dùng biết nó bấm được', () => {
  it('có dòng hướng dẫn và tooltip nêu rõ hành động của từng chip', async () => {
    const { container } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="c1"]')).not.toBeNull();
    });

    // Không có dòng này thì bốn chip màu đọc như chú thích tĩnh — đúng phản hồi
    // đã nhận: "sao mà biết chỗ đấy là checkbox".
    expect(container.textContent).toContain('Bấm để ẩn/hiện');

    const chip = Array.from(container.querySelectorAll('label')).find((l) => l.textContent?.includes('Sửa'));
    expect(chip!.getAttribute('title')).toBe('Ẩn vùng bôi "Sửa"');

    fireEvent.click(chip!.querySelector('input')!);

    // Tooltip đổi theo trạng thái: đang tắt thì nó phải mời BẬT lại, chứ không
    // lặp lại câu cũ.
    await waitFor(() => {
      const after = Array.from(container.querySelectorAll('label')).find((l) => l.textContent?.includes('Sửa'));
      expect(after!.getAttribute('title')).toBe('Hiện vùng bôi "Sửa"');
    });
  });
});
