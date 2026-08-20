// @vitest-environment jsdom
//
// WP22b — NewAppModal chuyển từ import đồng bộ (importConfluenceInBatches,
// vòng lặp client-side chờ RESOLVE) sang start-job nền: 202 → đóng modal
// NGAY, không còn chờ; start lỗi (409/400/502) → App vẫn tồn tại, modal hiện
// lỗi như hành vi import-lỗi cũ (không coi là lỗi tạo App). Theo dõi tiến độ
// chuyển sang AppImportBanner (app-import-banner.test.tsx) — modal không còn
// tự hiện %.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/providers/registry', () => ({
  fetchDesignSystems: async () => [],
}));

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

// NewAppModal chỉ cần `ConfluenceTreePicker` để tick trang — thay UI tìm
// kiếm Confluence thật (search input + kết quả async) bằng một nút bấm
// tick cố định, để test này không phụ thuộc luồng tìm kiếm (đã có test
// riêng ở confluence-import-abort.test.ts và ConfluenceTreeImport nội bộ).
vi.mock('../../../src/components/pipelines/ConfluenceTreeImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/components/pipelines/ConfluenceTreeImport')>();
  return {
    ...actual,
    ConfluenceTreePicker: (props: { onTickedChange: (next: Set<string>) => void }) => (
      <button type="button" data-testid="tick-fixture-page" onClick={() => props.onTickedChange(new Set(['page-1']))}>
        Tick trang cố định
      </button>
    ),
  };
});

const { NewAppModal } = await import('../../../src/components/pipelines/NewAppModal');

afterEach(() => cleanup());

function stubFetch(overrides: Record<string, (init?: RequestInit) => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url}`;
      if (overrides[key]) return overrides[key](init);
      if (overrides[url]) return overrides[url](init);
      if (url === '/api/pipelines/apps' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ apps: [] }), { status: 200 });
      }
      if (url === '/api/figma-design-systems') {
        return new Response(JSON.stringify({ sources: [] }), { status: 200 });
      }
      if (url.includes('/app-import-jobs/active')) {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      if (url.includes('/pool')) {
        return new Response(JSON.stringify({ pages: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
}

async function nameApp(name: string) {
  fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: name } });
}

describe('NewAppModal — start-job import (WP22b)', () => {
  it('start 202: đóng modal ngay, onCreated được gọi, KHÔNG có request import-confluence đồng bộ (chỉ /start)', async () => {
    stubFetch({
      'POST /api/pipelines/apps': () => new Response(JSON.stringify({ id: 'retail' }), { status: 200 }),
      'POST /api/pipelines/apps/retail/import-confluence/start': () =>
        new Response(
          JSON.stringify({
            job: { id: 'job-1', appId: 'retail', status: 'running', done: 0, total: 1, imported: 0, updated: 0, startedAt: Date.now() },
          }),
          { status: 202 },
        ),
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewAppModal onClose={onClose} onCreated={onCreated} />);
    await nameApp('Retail');
    fireEvent.click(screen.getByTestId('tick-fixture-page'));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('retail'));
    expect(onClose).toHaveBeenCalled();

    const fetchMock = vi.mocked(fetch);
    const importCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/import-confluence'));
    // Đúng một request — start-job — KHÔNG có request đồng bộ
    // (`/import-confluence` trơn, không có hậu tố `/start`) như vòng lặp cũ.
    expect(importCalls).toHaveLength(1);
    expect(String(importCalls[0]?.[0])).toContain('/import-confluence/start');
  });

  it('không tick trang nào: tạo App xong đóng luôn, không gọi start (hành vi cũ)', async () => {
    stubFetch({
      'POST /api/pipelines/apps': () => new Response(JSON.stringify({ id: 'retail' }), { status: 200 }),
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewAppModal onClose={onClose} onCreated={onCreated} />);
    await nameApp('Retail');
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('retail'));
    expect(onClose).toHaveBeenCalled();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/import-confluence'))).toBe(false);
  });

  it('start 409: App đã tồn tại, modal hiện lỗi (KHÔNG coi là lỗi tạo App)', async () => {
    stubFetch({
      'POST /api/pipelines/apps': () => new Response(JSON.stringify({ id: 'retail' }), { status: 200 }),
      'POST /api/pipelines/apps/retail/import-confluence/start': () =>
        new Response(JSON.stringify({ error: 'Đang có import khác chạy.' }), { status: 409 }),
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewAppModal onClose={onClose} onCreated={onCreated} />);
    await nameApp('Retail');
    fireEvent.click(screen.getByTestId('tick-fixture-page'));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));

    await screen.findByText(/App .Retail. đã tạo\./);
    expect(await screen.findByText(/Đang có import khác chạy\./)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
