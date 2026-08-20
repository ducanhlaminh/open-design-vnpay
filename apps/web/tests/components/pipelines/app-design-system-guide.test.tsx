// @vitest-environment jsdom
//
// WP19b: nút "Sinh mô tả (N thiếu)" của AppFigmaCatalogPanel — chỉ phần hành
// vi mới (N hiện đúng, disabled khi N=0/đang chạy, bấm gọi đúng POST). Phần
// panel Figma catalogue hiện có (refresh, markdown chính) đã có
// app-design-system.test.tsx riêng — file này không lặp lại.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppFigmaCatalogResponse, AppFigmaGuideJob } from '@open-design/contracts';

import { AppDesignSystemPanel } from '../../../src/components/pipelines/AppDesignSystemPanel';

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => cleanup());

const baseCatalog: AppFigmaCatalogResponse = {
  links: [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }],
  hasToken: true,
  generatedAt: '2026-08-19T00:00:00Z',
  files: [{ fileKey: 'ABC', name: 'Kit', url: 'https://www.figma.com/design/ABC', componentCount: 3 }],
  componentCount: 3,
  markdown: '# Danh mục component từ Figma\n\n### `#figma-a` Button\n',
  coverage: { total: 3, described: 1, fromGuide: 0, missing: 2 },
};

function catalogWithMissing(missing: number, described = 3 - missing) {
  return { ...baseCatalog, coverage: { total: 3, described, fromGuide: 0, missing } };
}

function mockFetchSequence(handlers: Record<string, (init?: RequestInit) => Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler(init);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
}

describe('AppFigmaCatalogPanel · nút "Sinh mô tả (N thiếu)"', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hiện đúng N thiếu và ẩn hoàn toàn khi catalog chưa có coverage', async () => {
    mockFetchSequence({
      '/figma-catalog': () => new Response(JSON.stringify({ ...baseCatalog, coverage: undefined }), { status: 200 }),
    });
    render(<AppDesignSystemPanel appId="retail" componentSource={{ mode: 'figma-links', links: baseCatalog.links! }} />);
    await screen.findByText('Danh mục component');
    expect(screen.queryByTestId('figma-guide-generate')).toBeNull();
  });

  it('disabled khi N=0 (mọi component đã có mô tả)', async () => {
    mockFetchSequence({
      '/figma-catalog': () => new Response(JSON.stringify(catalogWithMissing(0)), { status: 200 }),
    });
    render(<AppDesignSystemPanel appId="retail" componentSource={{ mode: 'figma-links', links: baseCatalog.links! }} />);
    const button = await screen.findByTestId('figma-guide-generate');
    expect(button.textContent).toContain('Sinh mô tả (0 thiếu)');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('bấm khi N>0 gọi đúng POST /generate-guide và disabled trong lúc job đang chạy', async () => {
    const job: AppFigmaGuideJob = {
      id: 'job-1', status: 'running', message: 'Đang xử lý…', generated: 0, rejected: 0, remaining: 0,
      error: null, createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z',
    };
    mockFetchSequence({
      '/figma-catalog/generate-guide': (init) => {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ jobId: job.id, job }), { status: 202 });
      },
      '/figma-catalog': () => new Response(JSON.stringify(catalogWithMissing(2)), { status: 200 }),
    });
    render(<AppDesignSystemPanel appId="retail" componentSource={{ mode: 'figma-links', links: baseCatalog.links! }} />);
    const button = await screen.findByTestId('figma-guide-generate');
    expect(button.textContent).toContain('Sinh mô tả (2 thiếu)');
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect((screen.getByTestId('figma-guide-generate') as HTMLButtonElement).disabled).toBe(true));
    const fetchMock = vi.mocked(fetch);
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/figma-catalog/generate-guide'));
    expect(call?.[0]).toBe('/api/pipelines/apps/retail/figma-catalog/generate-guide');
    expect(call?.[1]?.method).toBe('POST');
  });

  it('lỗi POST hiện message', async () => {
    mockFetchSequence({
      '/figma-catalog/generate-guide': () => new Response(JSON.stringify({ error: 'Chưa cấu hình agent.' }), { status: 500 }),
      '/figma-catalog': () => new Response(JSON.stringify(catalogWithMissing(1)), { status: 200 }),
    });
    render(<AppDesignSystemPanel appId="retail" componentSource={{ mode: 'figma-links', links: baseCatalog.links! }} />);
    const button = await screen.findByTestId('figma-guide-generate');
    fireEvent.click(button);
    await screen.findByText('Chưa cấu hình agent.');
  });
});
