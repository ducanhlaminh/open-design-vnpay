// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineProject } from '@open-design/contracts';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  reload: vi.fn(async () => undefined),
}));

vi.mock('../../../src/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/router')>()),
  navigate: mocks.navigate,
  useRoute: () => ({ kind: 'home', view: 'pipelines' as const }),
}));

const features: PipelineProject[] = [
  { id: 'checkout', name: 'Thanh toán', done: 0, total: 3, running: 0, app: { id: 'retail', name: 'Retail' } },
  { id: 'orders', name: 'Đơn hàng', done: 0, total: 3, running: 0, app: { id: 'retail', name: 'Retail' } },
];

vi.mock('../../../src/components/pipelines/usePipelineNav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/pipelines/usePipelineNav')>()),
  usePipelineNav: () => ({
    apps: [{
      id: 'retail',
      name: 'Retail',
      unassigned: false,
      features,
      doneFeatures: 0,
      runningFeatures: 0,
    }],
    projects: features,
    loading: false,
    loaded: true,
    error: null,
    reload: mocks.reload,
    appById: () => null,
    featureOf: () => null,
  }),
}));

const { PipelinesRoute } = await import('../../../src/components/pipelines/PipelinesRoute');

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.reload.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PipelinesRoute · xóa Dự án khỏi máy', () => {
  it('xác nhận đúng phạm vi, reload danh sách và quay về màn Dự án', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/me') {
        return new Response(JSON.stringify({ syncReady: true, syncIssue: null }), { status: 200 });
      }
      if (url === '/api/workflows') {
        return new Response(JSON.stringify({ workflows: [] }), { status: 200 });
      }
      if (url === '/api/project-sync/status') {
        return new Response(JSON.stringify({ data: { results: [
          { scope: { kind: 'app', projectId: 'retail' }, state: 'unchanged', mappingValid: true, origin: { originId: 'retail-cloud', name: 'Retail', kind: 'app', visibility: 'visible', inKgs: true, inMedia: true }, features: [], summary: { created: 0, unchanged: 1, changed: 0, deleted: 0 }, entries: [] },
        ] } }), { status: 200 });
      }
      if (url === '/api/pipelines/apps/retail' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true, deletedFeatures: 2, localOnly: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PipelinesRoute />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/project-sync/status')).toBe(true));
    fireEvent.click(screen.getByLabelText('Thao tác với Retail'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Xóa khỏi máy' }));

    expect(screen.queryByText('Xóa dự án "Retail" khỏi máy?')).not.toBeNull();
    expect(screen.queryByText(/2 tính năng và toàn bộ dữ liệu của dự án trên máy này sẽ bị xóa/)).not.toBeNull();
    expect(screen.queryByText(/Bạn có thể lấy lại dự án sau/)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Xóa khỏi máy' }));

    await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith('/api/pipelines/apps/retail', { method: 'DELETE' });
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: 'home', view: 'pipelines' });
    expect(await screen.findByText('Đã xóa dự án "Retail" khỏi máy. Bản trong kho chung vẫn được giữ.')).not.toBeNull();
  });
});
