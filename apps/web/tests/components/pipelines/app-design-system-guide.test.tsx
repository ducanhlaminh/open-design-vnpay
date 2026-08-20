// @vitest-environment jsdom
//
// WP19b: nút "Sinh mô tả (N thiếu)" của AppFigmaCatalogPanel — chỉ phần hành
// vi mới (N hiện đúng, disabled khi N=0/đang chạy, bấm gọi đúng POST). Phần
// panel Figma catalogue hiện có (refresh, markdown chính) đã có
// app-design-system.test.tsx riêng — file này không lặp lại.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppFigmaCatalogResponse, AppFigmaGuideJob, FigmaDesignSystemGuideJob, GetFigmaDesignSystemSourceResponse } from '@open-design/contracts';

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

// WP20: App gắn DS qua NGUỒN FIGMA DÙNG CHUNG (figmaDesignSystemSourceId) —
// cùng nút, khác lưu ở nguồn (sourceId) thay vì App (appId). Panel hiện có
// (Danh mục component đọc từ nguồn) đã có app-design-system.test.tsx riêng —
// file này chỉ phủ phần hành vi mới của WP20 (coverage + nút), mirror hệt bộ
// test AppFigmaCatalogPanel ở trên.
describe('SharedFigmaCatalogPanel · nút "Sinh mô tả (N thiếu)" (nguồn dùng chung)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const baseDetail: GetFigmaDesignSystemSourceResponse = {
    source: {
      id: 'src-1',
      name: 'EIB - MB',
      kind: 'figma-links',
      links: ['https://www.figma.com/design/ABC'],
      status: 'ready',
      refreshProgress: null,
      catalog: {
        generatedAt: '2026-08-19T00:00:00Z',
        digest: 'sha256:abc',
        fileCount: 1,
        componentCount: 3,
        files: [{ fileKey: 'ABC', name: 'Kit', url: 'https://www.figma.com/design/ABC', componentCount: 3 }],
      },
      lastError: null,
      hasShowcase: false,
      hasReactBundle: false,
      createdAt: '2026-08-19T00:00:00Z',
      updatedAt: '2026-08-19T00:00:00Z',
    },
    componentsMarkdown: '# Danh mục component từ Figma\n\n### `#figma-a` Button\n',
    coverage: { total: 3, described: 1, fromGuide: 0, missing: 2 },
  };

  function detailWithMissing(missing: number, described = 3 - missing) {
    return { ...baseDetail, coverage: { total: 3, described, fromGuide: 0, missing } };
  }

  // Thứ tự khai báo QUAN TRỌNG: '/generate-guide/' (GET poll job, có jobId
  // sau) phải khớp TRƯỚC '/generate-guide' (POST khởi job) vì URL POST là
  // tiền tố nguyên văn của URL GET job — mockFetchSequence duyệt theo thứ tự
  // khai báo, khớp cái nào trước dùng cái đó.
  function mockSourceFetchSequence(handlers: {
    getJob?: (init?: RequestInit) => Response;
    postGenerate?: (init?: RequestInit) => Response;
    getDetail: (init?: RequestInit) => Response;
  }) {
    mockFetchSequence({
      ...(handlers.getJob ? { '/generate-guide/': handlers.getJob } : {}),
      ...(handlers.postGenerate ? { '/generate-guide': handlers.postGenerate } : {}),
      '/api/figma-design-systems/': handlers.getDetail,
    });
  }

  it('ẩn hoàn toàn khi detail chưa có coverage (chưa có catalog)', async () => {
    mockSourceFetchSequence({
      getDetail: () => new Response(JSON.stringify({ ...baseDetail, coverage: undefined }), { status: 200 }),
    });
    render(<AppDesignSystemPanel appId="ss1" figmaDesignSystemSourceId="src-1" />);
    await screen.findByText('Danh mục component');
    expect(screen.queryByTestId('figma-design-system-guide-generate')).toBeNull();
  });

  it('disabled khi N=0 (mọi component đã có mô tả)', async () => {
    mockSourceFetchSequence({
      getDetail: () => new Response(JSON.stringify(detailWithMissing(0)), { status: 200 }),
    });
    render(<AppDesignSystemPanel appId="ss1" figmaDesignSystemSourceId="src-1" />);
    const button = await screen.findByTestId('figma-design-system-guide-generate');
    expect(button.textContent).toContain('Sinh mô tả (0 thiếu)');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('bấm khi N>0 gọi đúng POST /api/figma-design-systems/:id/generate-guide và disabled trong lúc job chạy', async () => {
    const job: FigmaDesignSystemGuideJob = {
      id: 'job-src-1', status: 'running', message: 'Đang xử lý…', generated: 0, rejected: 0, remaining: 0,
      error: null, createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z',
    };
    mockSourceFetchSequence({
      postGenerate: (init) => {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ jobId: job.id, job }), { status: 202 });
      },
      getDetail: () => new Response(JSON.stringify(detailWithMissing(2)), { status: 200 }),
    });
    render(<AppDesignSystemPanel appId="ss1" figmaDesignSystemSourceId="src-1" />);
    const button = await screen.findByTestId('figma-design-system-guide-generate');
    expect(button.textContent).toContain('Sinh mô tả (2 thiếu)');
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect((screen.getByTestId('figma-design-system-guide-generate') as HTMLButtonElement).disabled).toBe(true));
    const fetchMock = vi.mocked(fetch);
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/generate-guide') && !String(c[0]).includes(`/${job.id}`));
    expect(call?.[0]).toBe('/api/figma-design-systems/src-1/generate-guide');
    expect(call?.[1]?.method).toBe('POST');
  });

  it('lỗi POST hiện message (daemon trả error dạng {code, message})', async () => {
    mockSourceFetchSequence({
      postGenerate: () => new Response(JSON.stringify({ error: { code: 'CATALOG_REQUIRED', message: 'Nguồn chưa có danh mục component.' } }), { status: 409 }),
      getDetail: () => new Response(JSON.stringify(detailWithMissing(1)), { status: 200 }),
    });
    render(<AppDesignSystemPanel appId="ss1" figmaDesignSystemSourceId="src-1" />);
    const button = await screen.findByTestId('figma-design-system-guide-generate');
    fireEvent.click(button);
    await screen.findByText('Nguồn chưa có danh mục component.');
  });
});
