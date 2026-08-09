// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@open-design/contracts';

import { EditAppModal } from '../../../src/components/pipelines/EditAppModal';
import { NewAppModal } from '../../../src/components/pipelines/NewAppModal';

const systems = [
  { id: 'figma-ds', title: 'Figma DS', category: 'Product', summary: 'Review source', status: 'published' },
] satisfies DesignSystemSummary[];

vi.mock('../../../src/providers/registry', () => ({
  fetchDesignSystems: async () => systems,
}));

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => cleanup());
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/pipelines/apps') return new Response(JSON.stringify({ apps: [] }), { status: 200 });
    if (url.includes('/pool')) return new Response(JSON.stringify({ pages: [] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
});

describe('EditAppModal · Design System', () => {
  async function chooseDs(app: { id: string; name: string; designSystemId?: string | null }) {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={app} onClose={() => {}} onSaved={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    fireEvent.click(screen.getByTestId('project-ds-picker-option-figma-ds'));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pipelines/apps/') && call[1]?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pipelines/apps/') && c[1]?.method === 'PATCH');
    return JSON.parse(String(call?.[1]?.body));
  }

  it('chỉ đổi DS thì PATCH DS, không gửi name', async () => {
    await expect(chooseDs({ id: 'retail', name: 'Retail' })).resolves.toEqual({ designSystemId: 'figma-ds' });
  });

  it('chỉ đổi tên thì PATCH name, không gửi designSystemId', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={{ id: 'retail', name: 'Retail', designSystemId: 'old-ds' }} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText('Tên App'), { target: { value: 'Retail VN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pipelines/apps/') && call[1]?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pipelines/apps/') && c[1]?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: 'Retail VN' });
  });

  it('chọn Không dùng thì PATCH designSystemId null', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={{ id: 'retail', name: 'Retail', designSystemId: 'old-ds' }} onClose={() => {}} onSaved={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    fireEvent.click(screen.getByRole('option', { name: /No design system/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pipelines/apps/') && call[1]?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pipelines/apps/') && c[1]?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ designSystemId: null });
  });

  it('không đổi gì thì disabled Lưu', async () => {
    render(<EditAppModal app={{ id: 'retail', name: 'Retail', designSystemId: 'figma-ds' }} onClose={() => {}} onSaved={() => {}} />);
    expect((screen.getByRole('button', { name: 'Lưu' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('NewAppModal · Design System', () => {
  it('không chọn DS thì POST không có designSystemId', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<NewAppModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Tên App'), { target: { value: 'Retail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === '/api/pipelines/apps' && call[1]?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/pipelines/apps' && c[1]?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty('designSystemId');
  });
});
