// @vitest-environment jsdom
//
// WP app-pool-paste-link — dán LINK hoặc PAGE ID Confluence vào ô tìm "Tài liệu
// dự án" (RunAllModal focus='source', nguồn app-pool). Trước đây ô tìm chỉ lọc
// cây kho cục bộ theo tên nên dán link ra "Không có trang nào khớp <link>".
//   • ref → GET /api/pipelines/confluence/resolve?ref= (KHÔNG search theo tên).
//   • Có trong kho → cây chỉ còn trang đó (kèm tổ tiên) + tự tick.
//   • Chưa có → dòng «title» chưa có… + "Import + tick" → POST import-confluence
//     → GET pool lại → path vừa nhập được tick.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { AppPoolPage } from '@open-design/contracts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

vi.mock('../../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/registry')>();
  return { ...actual, fetchDesignSystems: async () => [] };
});

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { RunAllModal } = await import('../../../src/components/pipelines/PipelineModals');
const { AppPoolTree } = await import('../../../src/components/pipelines/AppPoolTree');

const page = (pageId: string, path: string, title: string): AppPoolPage => ({
  pageId,
  path,
  title,
  branch: path.split('/')[0]!,
  contentHash: 'h',
  fetchedAt: 0,
});

const POOL_PAGES: AppPoolPage[] = [
  page('111', 'VNPAY-Phan-mem-ke-toan/III.-Tai-lieu-URD-san-pham/URD-01.md', 'URD-01'),
  page('112', 'VNPAY-Phan-mem-ke-toan/III.-Tai-lieu-PRD-san-pham/PRD-01.md', 'PRD-01'),
  page('113', 'ID-Safe/Tong-quan.md', 'Tong-quan'),
];

const LINK_111 = 'https://wiki.x/pages/111/Abc';
const LINK_222 = 'https://wiki.x/pages/222/Xyz';
const IMPORTED_222 = page('222', 'a/b.md', 'Tiêu đề 222');

let fetchMock: ReturnType<typeof vi.fn>;
/** Pool hiện tại mà GET /pool trả — import làm nó dài thêm. */
let poolPages: AppPoolPage[];
const calledUrls = () => fetchMock.mock.calls.map((call) => String(call[0]));
const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

beforeEach(() => {
  poolPages = [...POOL_PAGES];
  fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/confluence/resolve?ref=')) {
      const ref = decodeURIComponent(u.split('ref=')[1] ?? '');
      if (ref === LINK_111 || ref === '111') return json(200, { page: { id: '111', title: 'URD-01', url: LINK_111 } });
      if (ref === LINK_222 || ref === '222') return json(200, { page: { id: '222', title: 'Tiêu đề 222', url: LINK_222 } });
      return json(400, { error: 'Không nhận ra link/page id Confluence.' });
    }
    if (u.endsWith('/import-confluence') && init?.method === 'POST') {
      poolPages = [...poolPages, IMPORTED_222];
      return json(200, { imported: 1, updated: 0, pages: [IMPORTED_222] });
    }
    if (u.includes('/pool')) return json(200, { pages: poolPages });
    return json(200, {});
  });
  vi.stubGlobal('fetch', fetchMock);
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
  await waitFor(() => expect(dialog.querySelector('input[type="search"]')).not.toBeNull());
  const search = dialog.querySelector('input[type="search"]') as HTMLInputElement;
  const tree = () => dialog.querySelector('[class*="poolTree"]') as HTMLElement;
  return { ...view, dialog, search, tree };
}

describe('RunAllModal · "Tài liệu dự án" · dán link/page id Confluence', () => {
  it('placeholder nói rõ nhận cả link/page id', async () => {
    const { search } = await renderSource();
    expect(search.placeholder).toContain('dán link/page id');
  });

  it('dán link trang ĐÃ CÓ trong kho → resolve (không search), cây chỉ còn trang đó, tự tick 1 trang', async () => {
    const { dialog, search, tree } = await renderSource();
    // Mặc định cấp 1 mở, sâu hơn đóng → thấy folder PRD, chưa thấy lá.
    expect(tree().textContent).toContain('III.-Tai-lieu-PRD-san-pham');

    fireEvent.change(search, { target: { value: LINK_111 } });
    await waitFor(() => expect(dialog.textContent).toContain('1 trang đã tick'));

    expect(calledUrls().some((u) => u.includes(`/api/pipelines/confluence/resolve?ref=${encodeURIComponent(LINK_111)}`))).toBe(true);
    expect(calledUrls().some((u) => u.includes('/confluence/pages?q='))).toBe(false);

    // Cây: trang 111 + tổ tiên; các trang khác biến mất.
    expect(tree().textContent).toContain('URD-01');
    expect(tree().textContent).toContain('III.-Tai-lieu-URD-san-pham');
    expect(tree().textContent).not.toContain('III.-Tai-lieu-PRD-san-pham');
    expect(tree().textContent).not.toContain('Tong-quan');
    expect(within(tree()).getByRole('button', { name: 'Tick trang URD-01' }).getAttribute('aria-pressed')).toBe('true');
    expect(dialog.textContent).toContain('Từ link đã dán');
    expect(dialog.textContent).not.toContain('Không có trang nào khớp');
  });

  it('bỏ tick rồi thì KHÔNG tự tick lại cùng pageId', async () => {
    const { dialog, search, tree } = await renderSource();
    fireEvent.change(search, { target: { value: LINK_111 } });
    await waitFor(() => expect(dialog.textContent).toContain('1 trang đã tick'));
    fireEvent.click(within(tree()).getByRole('button', { name: 'Tick trang URD-01' }));
    await waitFor(() => expect(dialog.textContent).toContain('Chưa tick trang nào'));
    // Đổi input rồi quay lại cùng ref — vẫn giữ ý người dùng đã bỏ tick.
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.change(search, { target: { value: '111' } });
    await waitFor(() => expect(tree().textContent).toContain('URD-01'));
    expect(dialog.textContent).toContain('Chưa tick trang nào');
  });

  it('dán id CHƯA CÓ trong kho → dòng «title» chưa có + "Import + tick" → POST import → GET pool lại → path mới được tick', async () => {
    const { dialog, search, tree } = await renderSource();
    const poolCallsBefore = calledUrls().filter((u) => u.includes('/pool')).length;

    fireEvent.change(search, { target: { value: '222' } });
    await waitFor(() => expect(dialog.textContent).toContain('«Tiêu đề 222» chưa có trong tài liệu dự án'));
    expect(dialog.textContent).not.toContain('Không có trang nào khớp');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Import + tick' }));
    await waitFor(() => expect(dialog.textContent).toContain('1 trang đã tick'));

    const importCall = fetchMock.mock.calls.find(
      (call) => String(call[0]) === '/api/pipelines/apps/app-1/import-confluence' && (call[1] as RequestInit)?.method === 'POST',
    );
    expect(importCall).toBeDefined();
    expect(JSON.parse(String((importCall![1] as RequestInit).body)).refs).toEqual([LINK_222]);

    // Pool được tải lại nền → trang vừa nhập nằm trong cây, đã tick.
    await waitFor(() => expect(calledUrls().filter((u) => u.includes('/pool')).length).toBeGreaterThan(poolCallsBefore));
    await waitFor(() => expect(tree().textContent).toContain('Tiêu đề 222'));
    expect(within(tree()).getByRole('button', { name: 'Tick trang Tiêu đề 222' }).getAttribute('aria-pressed')).toBe('true');
    expect(dialog.textContent).toContain('1 trang đã tick');
    expect(dialog.textContent).not.toContain('chưa có trong tài liệu dự án');
  });

  it('resolve trả 400 → dòng lỗi kèm gợi ý dạng hỗ trợ, không có "Không có trang nào khớp"', async () => {
    const { dialog, search } = await renderSource();
    fireEvent.change(search, { target: { value: 'https://wiki.x/khong-hieu' } });
    await waitFor(() => expect(dialog.textContent).toContain('Không tra được «https://wiki.x/khong-hieu»'));
    expect(dialog.textContent).toContain('Không nhận ra link/page id Confluence.');
    expect(dialog.textContent).toContain('Dạng hỗ trợ:');
    expect(dialog.textContent).not.toContain('Không có trang nào khớp');
  });

  it('gõ chữ thường "URD" → lọc theo tên như cũ, KHÔNG gọi resolve', async () => {
    const { search, tree } = await renderSource();
    fireEvent.change(search, { target: { value: 'URD' } });
    await waitFor(() => expect(tree().textContent).not.toContain('PRD-01'));
    expect(tree().textContent).toContain('URD-01');
    expect(calledUrls().some((u) => u.includes('/confluence/resolve'))).toBe(false);
  });
});

describe('AppPoolTree · pageIdFilter', () => {
  it('giữ tổ tiên của trang khớp, bỏ mọi trang khác, bỏ qua query text', () => {
    const view = render(<AppPoolTree pages={POOL_PAGES} query="PRD" pageIdFilter={new Set(['111'])} />);
    expect(view.container.textContent).toContain('VNPAY-Phan-mem-ke-toan');
    expect(view.container.textContent).toContain('III.-Tai-lieu-URD-san-pham');
    expect(view.container.textContent).toContain('URD-01');
    expect(view.container.textContent).not.toContain('PRD-01');
    expect(view.container.textContent).not.toContain('Tong-quan');
    expect(view.container.textContent).not.toContain('Không có trang nào khớp');
  });

  it('tập rỗng → không render empty-state', () => {
    const view = render(<AppPoolTree pages={POOL_PAGES} query="https://wiki.x/pages/9" pageIdFilter={new Set()} />);
    expect(view.container.textContent).toBe('');
  });

  it('vắng prop → lọc theo query như cũ', () => {
    const view = render(<AppPoolTree pages={POOL_PAGES} query="zzz-khong-co" />);
    expect(view.container.textContent).toContain('Không có trang nào khớp');
  });
});
