// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@open-design/contracts';

import { EditAppModal, normalizeFigmaLinks } from '../../../src/components/pipelines/EditAppModal';
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
  it('chuẩn hóa, giữ node-id và bỏ link trùng trước khi lưu', () => {
    const parsed = normalizeFigmaLinks([
      'https://www.figma.com/design/ABC/Login?node-id=1-2&utm_source=x',
      'https://figma.com/file/ABC/Copy?node-id=1-2',
      'https://www.figma.com/design/XYZ/Home',
    ].join('\n'));
    expect(parsed.error).toBeNull();
    expect(parsed.links).toEqual([
      { url: 'https://www.figma.com/design/ABC?node-id=1-2', fileKey: 'ABC', nodeId: '1:2' },
      { url: 'https://www.figma.com/design/XYZ', fileKey: 'XYZ' },
    ]);
  });

  it('báo lỗi thân thiện khi nhập quá 5 link', () => {
    expect(normalizeFigmaLinks(Array.from({ length: 6 }, (_, index) => `https://figma.com/design/F${index}`).join('\n')).error)
      .toBe('Chỉ nhập tối đa 5 link Figma mỗi lần.');
  });

  it('không làm sập form khi file key có percent-encoding hỏng', () => {
    expect(normalizeFigmaLinks('https://figma.com/design/%E0%A4%A/Broken').error)
      .toContain('Mã file không hợp lệ');
  });

  it('lưu nguồn link Figma đã chuẩn hóa mà không bắt readiness phải thành công', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={{ id: 'retail', name: 'Retail' }} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /^Link Figma/i }));
    fireEvent.change(screen.getByLabelText('Link file Figma'), { target: { value: 'https://figma.com/design/ABC/Login?node-id=3-4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pipelines/apps/') && call[1]?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find((item) => String(item[0]).includes('/api/pipelines/apps/') && item[1]?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      docsReviewComponentSource: {
        mode: 'figma-links',
        links: [{ url: 'https://www.figma.com/design/ABC?node-id=3-4', fileKey: 'ABC', nodeId: '3:4' }],
      },
    });
  });

  it('chọn Link Figma thì ẨN picker Design System và PATCH designSystemId null cho App đang gắn DS; chọn lại DS thì picker hiện lại', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={{ id: 'retail', name: 'Retail', designSystemId: 'old-ds' }} onClose={() => {}} onSaved={() => {}} />);
    await act(async () => {});
    expect(screen.getByText('Design System (Figma)')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Link Figma/i }));
    expect(screen.queryByText('Design System (Figma)')).toBeNull();
    expect(screen.getByLabelText('Link file Figma')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Design System đã nạp/i }));
    expect(screen.getByText('Design System (Figma)')).toBeTruthy();
    expect(screen.queryByLabelText('Link file Figma')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /^Link Figma/i }));
    fireEvent.change(screen.getByLabelText('Link file Figma'), { target: { value: 'https://figma.com/design/ABC/Login' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pipelines/apps/') && call[1]?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pipelines/apps/') && c[1]?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      designSystemId: null,
      docsReviewComponentSource: { mode: 'figma-links', links: [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }] },
    });
  });

  async function chooseDs(app: { id: string; name: string; designSystemId?: string | null }) {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={app} onClose={() => {}} onSaved={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('project-ds-picker-option-figma-ds'));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
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
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Retail VN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pipelines/apps/') && call[1]?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pipelines/apps/') && c[1]?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: 'Retail VN' });
  });

  it('chọn Không dùng thì PATCH designSystemId null', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={{ id: 'retail', name: 'Retail', designSystemId: 'old-ds' }} onClose={() => {}} onSaved={() => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('radio', { name: /No design system/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pipelines/apps/') && call[1]?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pipelines/apps/') && c[1]?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ designSystemId: null });
  });

  it('không đổi gì thì disabled Lưu', async () => {
    render(<EditAppModal app={{ id: 'retail', name: 'Retail', designSystemId: 'figma-ds' }} onClose={() => {}} onSaved={() => {}} />);
    expect((screen.getByRole('button', { name: 'Lưu thay đổi' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('NewAppModal · Design System', () => {
  it('không chọn DS thì POST không có designSystemId', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<NewAppModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Retail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === '/api/pipelines/apps' && call[1]?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/pipelines/apps' && c[1]?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty('designSystemId');
  });

  it('cho nhập link Figma ngay khi tạo và POST nguồn đã chuẩn hóa', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<NewAppModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Retail' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Link Figma/i }));
    fireEvent.change(screen.getByLabelText('Link file Figma'), {
      target: { value: 'https://figma.com/file/ABC/Login?node-id=12-34' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === '/api/pipelines/apps' && call[1]?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find((item) => item[0] === '/api/pipelines/apps' && item[1]?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      appId: 'retail',
      name: 'Retail',
      docsReviewComponentSource: {
        mode: 'figma-links',
        links: [{ url: 'https://www.figma.com/design/ABC?node-id=12-34', fileKey: 'ABC', nodeId: '12:34' }],
      },
    });
  });

  it('không cho tạo khi đã chọn nguồn Figma nhưng chưa dán link', () => {
    render(<NewAppModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Retail' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Link Figma/i }));
    expect(screen.getByText('Dán ít nhất 1 link Figma.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Tạo' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
