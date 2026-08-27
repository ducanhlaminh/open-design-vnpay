// @vitest-environment jsdom
//
// Tham chiếu (`doc_refs`) mở CỬA SỔ xem đoạn được viện dẫn, không cuộn cột
// chính. Fixture tách khỏi doc-redline-preview.test.tsx vì thêm `doc_refs` vào
// fixture bên đó sẽ đẻ thêm mark `ref:…` và làm hỏng phép so tập mark của nó —
// hai file, hai câu hỏi khác nhau.
//
// wp-doc-redline-nondestructive: rail đã bỏ hẳn — bấm vào MỘT vùng bôi
// thường (không phải `ref:…`) mở `AnnotationDetailPanel` của chính change/note
// đó (xem `openAnnotationDetail`); nút "Bằng chứng viện dẫn" NẰM TRONG modal
// đó (không còn khối "Chi tiết ▾" ở rail riêng). Bấm nút đó mới mở CỬA SỔ
// tham chiếu (`refModal`) — hai cửa sổ có thể mở đồng thời (mỗi cái một
// backdrop riêng), nên các test dưới đây tìm ĐÚNG dialog theo `aria-label`
// thay vì "dialog đầu tiên tìm thấy".
//
// Tài liệu hiển thị = bản GỐC (không có bản "đã sửa"): mark của c1 (phép SỬA)
// phải neo trên `before`, không phải `quote` — EDITED chứa đúng câu `before`.
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
  // wp-doc-redline-nondestructive: tài liệu hiển thị không bao giờ bị ghi lại
  // — câu ở đây phải là `before` của c1 (chữ GỐC, nơi mark bôi neo vào), không
  // phải `quote` (nội dung đề xuất, chỉ hiện trong modal).
  'Người dùng nhấn nút Xác nhận để hoàn tất giao dịch.',
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

/** Bấm mark c1 (mở modal chi tiết của chính nó) rồi bấm nút "Bằng chứng viện
 *  dẫn" bên trong modal đó — mở cửa sổ tham chiếu (`refModal`). Trả về CẢ hai
 *  dialog có thể đang mở (chi tiết c1 + tham chiếu) để test tìm đúng cái mình
 *  cần theo `aria-label` (KHÔNG giả định "dialog đầu tiên" là đúng cái). */
async function renderAndOpenRef() {
  const { container, baseElement } = render(<DocRedlinePreview projectId="p1" file={FILE} />);
  await waitFor(() => {
    expect(container.querySelector('mark[data-change-id="c1"]')).not.toBeNull();
  });
  scrollTargets.length = 0;
  fireEvent.click(container.querySelector('mark[data-change-id="c1"]')!);
  const detailDialog = await waitFor(() => {
    const el = baseElement.querySelector('[aria-label="Sửa nội dung"]');
    expect(el, 'phải mở modal chi tiết của c1').not.toBeNull();
    return el as HTMLElement;
  });
  const refBtn = Array.from(detailDialog.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Kế toán và Hành chính'),
  );
  expect(refBtn, 'phải có nút tham chiếu trong modal chi tiết').toBeTruthy();
  fireEvent.click(refBtn!);
  const refDialog = await waitFor(() => {
    const el = baseElement.querySelector('[aria-label="Đoạn được tham chiếu"]');
    expect(el, 'phải mở cửa sổ tham chiếu').not.toBeNull();
    return el as HTMLElement;
  });
  return { container, baseElement, detailDialog, refDialog };
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
    const { refDialog } = await renderAndOpenRef();

    // refModal có BẢN SAO tài liệu riêng — cột chính giữ nguyên vị trí cuộn.
    const markInDialog = refDialog.querySelector('mark[data-change-id="ref:c1:0"]');
    expect(markInDialog).not.toBeNull();
    // …và chính mark trong modal là thứ được cuộn tới, không phải mark của cột
    // chính (nếu sai, người đọc mở modal ra và thấy đầu tài liệu).
    expect(scrollTargets).toContain(markInDialog);
  });

  it('Escape đóng CẢ HAI modal (chi tiết lẫn tham chiếu)', async () => {
    const { baseElement } = await renderAndOpenRef();
    expect(baseElement.querySelector('[role="dialog"]')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(baseElement.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  it('nút "Đóng" của cửa sổ tham chiếu chỉ đóng cửa sổ đó, không đụng modal chi tiết bên dưới', async () => {
    const { baseElement, detailDialog, refDialog } = await renderAndOpenRef();
    const closeBtn = Array.from(refDialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Đóng',
    );
    expect(closeBtn, 'cửa sổ tham chiếu phải có nút Đóng').toBeTruthy();

    fireEvent.click(closeBtn!);

    await waitFor(() => {
      expect(baseElement.querySelector('[aria-label="Đoạn được tham chiếu"]')).toBeNull();
    });
    // Modal chi tiết của c1 (đã mở trước đó) vẫn còn nguyên — hai cửa sổ độc
    // lập, đóng cái này không kéo theo cái kia.
    expect(baseElement.contains(detailDialog)).toBe(true);
    expect(baseElement.querySelector('[aria-label="Sửa nội dung"]')).not.toBeNull();
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
      // Mark PHẢI còn: nó giữ cho vùng bôi bấm được/điều hướng được. Mất mark
      // thì đổi lại thành mất luôn điều hướng — cái giá không ai đồng ý trả.
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
    const { container, refDialog } = await renderAndOpenRef();
    fireEvent.click(boxFor(refDialog, 'Sửa'));

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
