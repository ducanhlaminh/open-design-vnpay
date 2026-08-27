// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@open-design/contracts';

import { EditAppModal, normalizeFigmaLinks } from '../../../src/components/pipelines/EditAppModal';
import { NewAppModal } from '../../../src/components/pipelines/NewAppModal';
import { AppDesignSystemPanel } from '../../../src/components/pipelines/AppDesignSystemPanel';

const systems = [
  { id: 'figma-ds', title: 'Figma DS', category: 'Product', summary: 'Review source', status: 'published' },
] satisfies DesignSystemSummary[];

vi.mock('../../../src/providers/registry', () => ({
  fetchDesignSystems: async () => systems,
}));

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => cleanup());

// WP dr-mockup (2026-08-27): khối nguồn component / DS / Figma DS nằm trong
// <details> "Nâng cao — Design System (tuỳ chọn)" MẶC ĐỊNH ĐÓNG — test mở nó
// ra trước khi bấm radio/picker (jsdom không ẩn con của details đóng, nhưng
// thao tác qua summary mới đúng đường người dùng đi).
function openAdvanced() {
  const details = screen.getByTestId('app-ds-advanced') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  fireEvent.click(details.querySelector('summary')!);
  if (!details.open) details.open = true;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/pipelines/apps') return new Response(JSON.stringify({ apps: [] }), { status: 200 });
    if (url === '/api/figma-design-systems') return new Response(JSON.stringify({ sources: [{
      id: 'shared-figma', name: 'VNPAY Components', kind: 'figma-links', links: ['https://www.figma.com/design/ABC'], status: 'ready',
      catalog: { generatedAt: '2026-08-17T00:00:00Z', digest: 'sha256:x', fileCount: 1, componentCount: 12, files: [] },
      lastError: null, hasShowcase: false, hasReactBundle: false, createdAt: '2026-08-17T00:00:00Z', updatedAt: '2026-08-17T00:00:00Z',
    }] }), { status: 200 });
    if (url === '/api/figma-design-systems/shared-figma') return new Response(JSON.stringify({
      source: {
        id: 'shared-figma', name: 'VNPAY Components', kind: 'figma-links', links: ['https://www.figma.com/design/ABC'], status: 'ready',
        refreshProgress: null,
        catalog: { generatedAt: '2026-08-17T00:00:00Z', digest: 'sha256:x', fileCount: 1, componentCount: 12, files: [] },
        lastError: null, hasShowcase: false, hasReactBundle: false, createdAt: '2026-08-17T00:00:00Z', updatedAt: '2026-08-17T00:00:00Z',
      },
      componentsMarkdown: '# Danh mục component từ Figma\n\n### `#button` Primary button from Figma\n',
    }), { status: 200 });
    if (url === '/api/figma-config' && (!init?.method || init.method === 'GET')) return new Response(JSON.stringify({ hasToken: true }), { status: 200 });
    if (url === '/api/figma-config/test') return new Response(JSON.stringify({ ok: true, handle: 'tester' }), { status: 200 });
    if (url === '/api/figma-config/verify-links') {
      const links = JSON.parse(String(init?.body)).links as Array<{ fileKey: string; url: string }>;
      return new Response(JSON.stringify({ hasToken: true, links: links.map((link) => ({ ...link, ok: true, name: link.fileKey, componentCount: 1 })) }), { status: 200 });
    }
    if (url === '/api/figma-desktop/status') return new Response(JSON.stringify({ available: false, canSwitch: false, platform: 'test' }), { status: 200 });
    if (url.includes('/pool')) return new Response(JSON.stringify({ pages: [] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
});

// WP21b — panel App khi gắn qua nguồn Figma dùng chung RÚT GỌN: markdown
// dump (criteria/components.md render thô) đã dọn khỏi panel này, chuyển
// hẳn sang trang detail `/design-systems/figma/:sourceId`
// (FigmaDsSourceDetail — component browser có cấu trúc, xem
// figma-ds-source-detail.test.tsx). Panel ở đây chỉ còn coverage + nút link
// điều hướng.
describe('AppDesignSystemPanel · shared Figma catalogue', () => {
  it('hiện tên nguồn + số component, KHÔNG còn render markdown thô', async () => {
    render(<AppDesignSystemPanel appId="retail" figmaDesignSystemSourceId="shared-figma" />);
    expect(await screen.findByRole('heading', { name: 'VNPAY Components' })).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Nội dung criteria/components.md' })).toBeNull();
    expect(screen.getByTestId('figma-design-system-open-detail')).toBeTruthy();
  });
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

  it('chọn nguồn Figma đã nạp và chỉ lưu source id', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={{ id: 'retail', name: 'Retail' }} onClose={() => {}} onSaved={() => {}} />);
    openAdvanced();
    fireEvent.click(screen.getByRole('radio', { name: /^Design system từ link Figma/i }));
    fireEvent.change(await screen.findByLabelText('Design system Figma'), { target: { value: 'shared-figma' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pipelines/apps/') && call[1]?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find((item) => String(item[0]).includes('/api/pipelines/apps/') && item[1]?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ figmaDesignSystemSourceId: 'shared-figma' });
  });

  it('chọn nguồn Figma thì ẩn picker Design System và PATCH designSystemId null', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={{ id: 'retail', name: 'Retail', designSystemId: 'old-ds' }} onClose={() => {}} onSaved={() => {}} />);
    await act(async () => {});
    openAdvanced();
    expect(screen.getByText('Design System (Figma)')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Design system từ link Figma/i }));
    expect(screen.queryByText('Design System (Figma)')).toBeNull();
    fireEvent.change(await screen.findByLabelText('Design system Figma'), { target: { value: 'shared-figma' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Design System đã nạp/i }));
    expect(screen.getByText('Design System (Figma)')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Design system từ link Figma/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pipelines/apps/') && call[1]?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pipelines/apps/') && c[1]?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      designSystemId: null,
      figmaDesignSystemSourceId: 'shared-figma',
    });
  });

  async function chooseDs(app: { id: string; name: string; designSystemId?: string | null }) {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={app} onClose={() => {}} onSaved={() => {}} />);
    await act(async () => {});
    openAdvanced();
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
    openAdvanced();
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

  // WP dr-mockup: nút Lưu KHÔNG phụ thuộc DS — chọn loại Figma mà chưa chọn
  // nguồn (trước đây khoá nút) thì đổi tên vẫn lưu được, PATCH chỉ có name.
  it('chọn loại Figma nhưng chưa chọn nguồn: đổi tên vẫn Lưu được, không gửi nguồn', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<EditAppModal app={{ id: 'retail', name: 'Retail' }} onClose={() => {}} onSaved={() => {}} />);
    await act(async () => {});
    openAdvanced();
    fireEvent.click(screen.getByRole('radio', { name: /^Design system từ link Figma/i }));
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Retail VN' } });
    expect((screen.getByRole('button', { name: 'Lưu thay đổi' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pipelines/apps/') && call[1]?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/pipelines/apps/') && c[1]?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: 'Retail VN' });
  });
});

describe('NewAppModal · Design System', () => {
  // WP dr-mockup: khối DS đóng mặc định, không đụng tới → Tạo vẫn bật, POST
  // không có designSystemId lẫn figmaDesignSystemSourceId.
  it('không mở khối Nâng cao / không chọn DS thì vẫn Tạo được, POST không có DS', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<NewAppModal onClose={() => {}} onCreated={() => {}} />);
    expect((screen.getByTestId('app-ds-advanced') as HTMLDetailsElement).open).toBe(false);
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Retail' } });
    expect((screen.getByRole('button', { name: 'Tạo' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === '/api/pipelines/apps' && call[1]?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/pipelines/apps' && c[1]?.method === 'POST');
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).not.toHaveProperty('designSystemId');
    expect(body).not.toHaveProperty('figmaDesignSystemSourceId');
  });

  it('chọn Design system Figma đã nạp khi tạo và POST source id', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<NewAppModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Retail' } });
    openAdvanced();
    fireEvent.click(screen.getByRole('radio', { name: /^Design system từ link Figma/i }));
    fireEvent.change(await screen.findByLabelText('Design system Figma'), { target: { value: 'shared-figma' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === '/api/pipelines/apps' && call[1]?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find((item) => item[0] === '/api/pipelines/apps' && item[1]?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      appId: 'retail',
      name: 'Retail',
      figmaDesignSystemSourceId: 'shared-figma',
    });
  });

  // WP dr-mockup: trước đây khoá nút Tạo; nay nút KHÔNG phụ thuộc DS — vẫn
  // tạo được, không gửi nguồn Figma nào, hint nói rõ App không gắn DS.
  it('chọn loại Figma nhưng chưa chọn nguồn: vẫn Tạo được, POST không có figmaDesignSystemSourceId', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<NewAppModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Retail' } });
    openAdvanced();
    fireEvent.click(screen.getByRole('radio', { name: /^Design system từ link Figma/i }));
    expect(await screen.findByText(/Chưa chọn nguồn → dự án tạo ra không gắn Design System/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Tạo' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Tạo' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === '/api/pipelines/apps' && call[1]?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/pipelines/apps' && c[1]?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty('figmaDesignSystemSourceId');
  });
});
