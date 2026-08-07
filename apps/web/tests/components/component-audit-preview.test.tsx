// @vitest-environment jsdom
//
// Màn xem kết quả đối chiếu component (`docs-review/comp/*.components.json`,
// bước dr-comp). Năm câu hỏi: có dựng đủ màn/phần tử của file không, một phần
// tử ngoài danh mục có hiện đúng kết luận KÈM nhận xét không, bộ lọc có thật
// sự gỡ dòng ra khỏi bảng không, một màn hết sạch phần tử sau khi lọc có biến
// mất cả khối không, và file hỏng có báo gọn thay vì làm sập khung nhìn không.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const FILES: Record<string, string | null> = {};

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => FILES[name] ?? null,
}));

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { ComponentAuditPreview, isComponentAuditFile } = await import(
  '../../src/components/ComponentAuditPreview'
);

// Không có cleanup thì cây của test trước còn nguyên trong document.body và mọi
// phép đếm dòng/khối bên dưới cộng dồn qua các test.
afterEach(() => cleanup());

const PATH = 'docs-review/comp/2-1-1-urd-quan-ly-nhan-vien.components.json';

/** Hai màn: SCR-001 trộn 'ok' với 'not-in-catalog', SCR-002 CHỈ có 'ok' — màn
 *  thứ hai là thứ phải biến mất khi tắt bộ lọc "Đạt". */
const REPORT = {
  schema_version: '1.0',
  page: '2.1.1 URD Quản lý nhân viên',
  doc_path: 'docs/confluence/2.1.1-URD-Quan-ly-nhan-vien.md',
  screens: [
    {
      id: 'SCR-001',
      name: 'Danh sách Nhân viên',
      anchor: '###### Màn hình 1: SCR-001 — Danh sách Nhân viên',
      images: ['attachments/scr-001.png'],
      elements: [
        {
          label: 'Nút Thêm mới',
          doc_type: 'Button',
          component: 'Button',
          rule_id: 'criteria/components.md#button',
          verdict: 'ok',
        },
        {
          label: 'Menu thao tác dòng',
          doc_type: 'Icon menu',
          verdict: 'not-in-catalog',
          note: "Danh mục không có 'Icon menu'; gần nhất là Popover hoặc Quick Action.",
        },
        {
          label: 'Ô tìm kiếm',
          doc_type: 'Text field',
          component: 'Input Field',
          rule_id: 'criteria/components.md#input-field',
          verdict: 'ok',
        },
      ],
    },
    {
      id: 'SCR-002',
      name: 'Chi tiết Nhân viên',
      anchor: '###### Màn hình 2: SCR-002 — Chi tiết Nhân viên',
      images: [],
      elements: [
        {
          label: 'Tiêu đề màn',
          doc_type: 'Heading',
          component: 'Typography',
          rule_id: 'criteria/components.md#typography',
          verdict: 'ok',
        },
      ],
    },
  ],
};

const FILE = {
  name: PATH,
  kind: 'text',
  size: 512,
  mtime: 1,
} as never;

function seed(raw: string) {
  FILES[PATH] = raw;
}

/** Các khối màn hình đang hiện — `data-screen-id` là thứ duy nhất phân biệt
 *  chúng mà không phụ thuộc vào tên lớp bị CSS Module băm. */
function screenIds(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-screen-id]')).map(
    (el) => el.dataset.screenId ?? '',
  );
}

/** Dòng phần tử (không tính dòng note, vốn không mang `data-verdict`). */
function elementRows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('tr[data-verdict]'));
}

/** Ô chọn của một chip theo nhãn ("Đạt" | "Ngoài danh mục" | …). */
function boxFor(root: HTMLElement, label: string): HTMLInputElement {
  const chip = Array.from(root.querySelectorAll('label')).find((l) => l.textContent?.includes(label));
  if (!chip) throw new Error(`không tìm thấy chip "${label}"`);
  const input = chip.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error(`chip "${label}" không có ô chọn`);
  return input;
}

async function renderReport(raw: string = JSON.stringify(REPORT)) {
  seed(raw);
  const { container } = render(<ComponentAuditPreview projectId="p1" file={FILE} />);
  await waitFor(() => {
    expect(container.textContent).not.toContain('Đang tải…');
  });
  return container;
}

describe('ComponentAuditPreview — dựng file kết quả', () => {
  it('hiện đủ số màn và số phần tử của trang', async () => {
    const container = await renderReport();

    expect(screenIds(container)).toEqual(['SCR-001', 'SCR-002']);
    expect(elementRows(container)).toHaveLength(4);
    // Thanh tóm tắt đếm trên TOÀN trang: 2 màn, 4 phần tử, 1 cần xem lại.
    expect(container.textContent).toContain('2 màn hình · 4 phần tử · 1 cần xem lại');
    // Tiêu đề khối là "SCR-001 · Danh sách Nhân viên" — mã và tên, không phải
    // một trong hai.
    const head = container.querySelector<HTMLElement>('[data-screen-id="SCR-001"] h3');
    expect(head?.textContent).toContain('SCR-001');
    expect(head?.textContent).toContain('Danh sách Nhân viên');
    // Phần tử không map được component nào hiện "—", không phải ô trống.
    const rowLabels = elementRows(container).map((r) => r.textContent ?? '');
    expect(rowLabels.some((t) => t.includes('Menu thao tác dòng') && t.includes('—'))).toBe(true);
  });

  it("phần tử 'not-in-catalog' hiện chip 'Ngoài danh mục' kèm nhận xét", async () => {
    const container = await renderReport();

    const row = elementRows(container).find((r) => r.textContent?.includes('Menu thao tác dòng'));
    expect(row, 'phải có dòng cho phần tử ngoài danh mục').toBeTruthy();
    expect(row!.dataset.verdict).toBe('not-in-catalog');
    expect(row!.textContent).toContain('Ngoài danh mục');
    // Note nằm ở DÒNG RIÊNG ngay dưới, không nhét vào ô kết luận.
    expect(row!.textContent).not.toContain('Danh mục không có');
    const noteRow = container.querySelector<HTMLElement>('[data-note-for="Menu thao tác dòng"]');
    expect(noteRow).not.toBeNull();
    expect(noteRow!.textContent).toContain(
      "Danh mục không có 'Icon menu'; gần nhất là Popover hoặc Quick Action.",
    );
  });
});

describe('ComponentAuditPreview — bộ lọc verdict', () => {
  it('mặc định bật hết, tắt "Đạt" thì các dòng ok biến mất còn dòng ngoài danh mục ở lại', async () => {
    const container = await renderReport();
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes).toHaveLength(5);
    expect(boxes.every((b) => b.checked)).toBe(true);
    // Dòng hướng dẫn là thứ duy nhất nói cho người dùng biết hàng chip bấm được.
    expect(container.textContent).toContain('Bấm để lọc:');

    fireEvent.click(boxFor(container, 'Đạt'));

    await waitFor(() => {
      const rows = elementRows(container);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dataset.verdict).toBe('not-in-catalog');
    });
    // Con số tổng KHÔNG chạy theo bộ lọc — nó nói về file, không về khung nhìn.
    expect(container.textContent).toContain('2 màn hình · 4 phần tử · 1 cần xem lại');
  });

  it('màn hết sạch phần tử sau khi lọc thì ẩn CẢ khối, không để lại tiêu đề rỗng', async () => {
    const container = await renderReport();
    expect(screenIds(container)).toEqual(['SCR-001', 'SCR-002']);

    fireEvent.click(boxFor(container, 'Đạt'));

    await waitFor(() => {
      // SCR-002 chỉ có phần tử 'ok' nên biến mất hoàn toàn; SCR-001 còn dòng
      // ngoài danh mục nên ở lại.
      expect(screenIds(container)).toEqual(['SCR-001']);
    });
    expect(container.textContent).not.toContain('Chi tiết Nhân viên');
  });
});

describe('isComponentAuditFile — điều kiện route', () => {
  /** `kindFor` bên daemon (apps/daemon/src/projects.ts) xếp MỌI `.json` vào
   *  bucket 'code', không phải 'text'. Nếu vị từ này đòi `kind === 'text'` thì
   *  nhánh route trong FileViewer không bao giờ chạy và người dùng vẫn rơi về
   *  khung nhìn JSON thô — đúng cái màn này sinh ra để thay. */
  it("nhận file .components.json mà daemon gắn kind 'code'", () => {
    expect(isComponentAuditFile({ ...(FILE as object), kind: 'code' } as never)).toBe(true);
    expect(isComponentAuditFile({ ...(FILE as object), kind: 'text' } as never)).toBe(true);
  });

  it('bỏ qua .json thường và file ngoài thư mục comp/', () => {
    expect(
      isComponentAuditFile({ ...(FILE as object), name: 'docs-review/comp/index.json' } as never),
    ).toBe(false);
    expect(
      isComponentAuditFile({ ...(FILE as object), name: 'docs-review/other/x.components.json' } as never),
    ).toBe(false);
  });
});

describe('ComponentAuditPreview — file không dùng được', () => {
  it('JSON hỏng thì báo không đọc được chứ không ném lỗi', async () => {
    const container = await renderReport('{ "screens": [ này không phải JSON');

    expect(container.textContent).toContain('Không đọc được kết quả đối chiếu');
    expect(container.querySelector('table')).toBeNull();
  });

  it('file không có màn nào thì nói rõ, không để khung trắng', async () => {
    const container = await renderReport(JSON.stringify({ ...REPORT, screens: [] }));

    expect(container.textContent).toContain('Không có màn hình nào trong trang này.');
  });
});
