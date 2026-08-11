// @vitest-environment jsdom
//
// Nhánh "Tài liệu App" của section Nguồn tài liệu (RunAllModal, focus='source').
//
// Thứ đắt nhất phải giữ ở đây là ô tìm KHÔNG mượn class toàn cục
// `.pl-proj-search`. Class đó là `flex: 0 1 260px`, dựng cho thanh công cụ NẰM
// NGANG ở màn Feature. Đặt vào `.pl-modal-field` (flex column) thì 260px rơi
// vào chiều CAO, và `border-radius: 999px` biến ô tìm thành một hình bầu dục
// cao nửa modal, đè lên cả cây tài liệu. Lỗi thuộc loại chỉ nhìn mới thấy nên
// nó phải được chốt bằng test, không phải bằng trí nhớ.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, within } from '@testing-library/react';
import type { AppPoolPage } from '@open-design/contracts';

afterEach(() => cleanup());

vi.mock('../../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/registry')>();
  return { ...actual, fetchDesignSystems: async () => [] };
});

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { RunAllModal } = await import('../../../src/components/pipelines/PipelineModals');

// Thư mục trong cây được AppPoolTree suy ra từ SEGMENT của `path`, nên fixture
// chỉ cần các trang lá — không có "page kiểu folder" nào trong contract.
const page = (path: string, title: string): AppPoolPage => ({
  pageId: path,
  path,
  title,
  branch: path.split('/')[0]!,
  contentHash: 'h',
  fetchedAt: 0,
});

const POOL_PAGES: AppPoolPage[] = [
  page('VNPAY-Phan-mem-ke-toan/III.-Tai-lieu-URD-san-pham/URD-01', 'URD-01'),
  page('VNPAY-Phan-mem-ke-toan/III.-Tai-lieu-PRD-san-pham/PRD-01', 'PRD-01'),
  page('ID-Safe/Tong-quan', 'Tong-quan'),
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      if (String(url).includes('/pool')) {
        return { ok: true, json: async () => ({ pages: POOL_PAGES }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }),
  );
});

async function renderSource() {
  const view = render(
    <RunAllModal
      workflowName="Docs → UI-Spec"
      appId="app-1"
      anySucceeded={false}
      focus="source"
      onClose={() => {}}
      onSaveConfig={async () => {}}
    />,
  );
  const dialog = within(view.baseElement).getByRole('dialog');
  // Pool được fetch trong effect — chờ cây hiện ra rồi mới đo.
  await waitFor(() => expect(dialog.querySelector('input[type="search"]')).not.toBeNull());
  return { ...view, dialog };
}

describe('RunAllModal · nguồn "Tài liệu App"', () => {
  it('nói rõ URD là đầu vào chính, PRD là bổ sung và nguồn này dùng chung cho các workflow', async () => {
    const { dialog } = await renderSource();
    expect(dialog.textContent).toContain('Tài liệu đầu vào cho 3 workflow');
    expect(dialog.textContent).toContain('URD');
    expect(dialog.textContent).toContain('PRD');
    expect(dialog.textContent).toContain('dùng chung khi chạy cả 3 workflow');
  });

  it('ô tìm KHÔNG dùng class toàn cục .pl-proj-search (flex-basis 260px = oval khổng lồ)', async () => {
    const { dialog } = await renderSource();
    const search = dialog.querySelector('input[type="search"]')!;
    expect(search.className).not.toContain('pl-proj-search');
    // Class của CSS Module được hash, nhưng tên gốc vẫn nằm trong chuỗi —
    // đủ để chốt rằng ô tìm đọc style RIÊNG của panel này.
    expect(search.className).toMatch(/poolSearchInput/);
  });

  it('cây tài liệu nằm trong panel riêng, không đổ thẳng ra nền modal', async () => {
    const { dialog } = await renderSource();
    const search = dialog.querySelector('input[type="search"]')!;
    const picker = search.closest('[class*="poolPicker"]');
    expect(picker).not.toBeNull();
    // Cùng một panel bọc cả ô tìm lẫn vùng cây — đó là thứ biến khối này từ
    // một danh sách phẳng thành một vùng có đầu có cuối.
    expect(picker!.querySelector('[class*="poolTree"]')).not.toBeNull();
  });

  it('panel "Import thêm từ Confluence" chỉ dựng khi mở', async () => {
    const { dialog } = await renderSource();
    expect(dialog.querySelector('[class*="poolImportPanel"]')).toBeNull();
  });
});
