// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { ProjectSyncPreviewModal } = await import('../../../src/components/project-sync');

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const status = { scope: { kind: 'app', projectId: 'app-a' }, state: 'changed', mappingValid: true, origin: { originId: 'shared-a', name: 'Kho thanh toán', kind: 'app', visibility: 'visible', inKgs: true, inMedia: true }, app: { id: 'app-a', name: 'Thanh toán', kind: 'app', state: 'changed', mappingValid: true, totals: { created: 0, unchanged: 1, changed: 2, deleted: 0 } }, features: [{ id: 'feature-a', name: 'QR', kind: 'feature', state: 'changed', mappingValid: true, totals: { created: 0, unchanged: 1, changed: 2, deleted: 0 } }], summary: { created: 0, unchanged: 1, changed: 2, deleted: 0 }, entries: [] };
const plan = { planId: 'plan-a', createdAt: '2026-08-12T00:00:00Z', direction: 'pull', scope: { kind: 'app', projectId: 'app-a' }, origin: { mode: 'existing', originId: 'shared-a' }, app: status.app, features: status.features, entries: [{ path: 'features/feature-a/output/ui.html', kind: 'output', change: 'changed', local: { checksum: 'l', size: 1 }, origin: { checksum: 'r', size: 1 }, resolution: 'pull' }], summary: status.summary };

function mockApi(apply = { data: { planId: 'plan-a', applied: 1, skipped: 0, unchanged: 1, softHiddenOriginFeatureIds: [], stale: [] } }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/project-sync/status')) return new Response(JSON.stringify({ data: { results: [status] } }));
    if (url.startsWith('/api/project-sync/origins')) return new Response(JSON.stringify({ data: { origins: [status.origin] } }));
    if (url === '/api/project-sync/plan') return new Response(JSON.stringify({ data: plan }));
    return new Response(JSON.stringify(apply), { status: 'error' in apply ? 409 : 200 });
  }));
}

describe('ProjectSyncPreviewModal', () => {
  it('renders the complete App plan without feature deselection and submits pull choices', async () => {
    mockApi();
    const onApplied = vi.fn();
    render(<ProjectSyncPreviewModal scope={{ kind: 'app', projectId: 'app-a' }} subjectName="Thanh toán" onClose={() => {}} onApplied={onApplied} />);
    await waitFor(() => expect(screen.queryByText('Thanh toán')).not.toBeNull());
    expect(screen.queryByText('QR')).not.toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: /Thanh toán/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('Các tính năng')).not.toBeNull();
    expect(screen.queryByText('Kết quả')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Kết quả/ }));
    fireEvent.click(screen.getByLabelText('Tệp có xung đột giữa bản trên máy và kho chung: features/feature-a/output/ui.html', { exact: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Lấy dự án về máy' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('shows PLAN_EXPIRED recovery and returns focus to reload', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/project-sync/status') return new Response(JSON.stringify({ data: { results: [status] } }));
      if (url === '/api/project-sync/plan') return new Response(JSON.stringify({ data: plan }));
      if (url === '/api/project-sync/apply') return new Response(JSON.stringify({ error: { code: 'PLAN_EXPIRED' } }), { status: 409 });
      return new Response(JSON.stringify({ data: {} }));
    }));
    render(<ProjectSyncPreviewModal scope={{ kind: 'app', projectId: 'app-a' }} subjectName="Thanh toán" onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Lấy dự án về máy' })).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Lấy dự án về máy' }));
    await waitFor(() => expect(screen.queryByText('Kế hoạch đã hết hạn. Tải lại để nhận ảnh chụp mới trước khi áp dụng.')).not.toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tải lại xem trước' }));
  });
});
