// @vitest-environment jsdom
//
// WP21b — trang detail nguồn Figma (`FigmaDsSourceDetail`): component browser
// có cấu trúc (thay markdown) + nút "Sinh mô tả (N thiếu)" + panel tiến độ
// per-component. Contract API ở .tmp/pipeline/wp21-contract.md (WP21a dựng
// song song) — mock fetch theo ĐÚNG path/shape nguyên văn contract đó.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GetFigmaDesignSystemSourceResponse } from '@open-design/contracts';

import { FigmaDsSourceDetail } from '../../src/components/FigmaDsSourceDetail';
import type {
  FigmaDesignSystemComponentItem,
  FigmaDesignSystemGuideJobV2,
  FigmaGuideActiveJob,
} from '../../src/providers/figma-design-systems';

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => cleanup());

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
  componentsMarkdown: '# Danh mục component từ Figma\n',
  coverage: { total: 3, described: 1, fromGuide: 0, missing: 2 },
};

const baseComponents: FigmaDesignSystemComponentItem[] = [
  {
    anchor: 'figma-aaaaaaaaaa',
    name: 'Button/Primary',
    nodeId: '1:1',
    fileKey: 'ABC',
    fileName: 'Kit',
    page: 'Buttons',
    description: 'Mô tả gốc từ Figma.',
    descriptionSource: 'figma',
    properties: [{ name: 'size', type: 'variant', values: ['sm', 'md'] }],
  },
  {
    anchor: 'figma-bbbbbbbbbb',
    name: 'Button/Secondary',
    nodeId: '1:2',
    fileKey: 'ABC',
    fileName: 'Kit',
    page: 'Buttons',
    description: 'Mô tả do AI sinh.',
    descriptionSource: 'ai',
    properties: [],
  },
  {
    anchor: 'figma-cccccccccc',
    name: 'Input/Text',
    nodeId: '1:3',
    fileKey: 'ABC',
    fileName: 'Kit',
    page: 'Inputs',
    descriptionSource: 'none',
    properties: [],
  },
];

function mockFetchSequence(handlers: Record<string, (init?: RequestInit) => Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler(init);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
}

function mockSourceFetchSequence(handlers: {
  getJob?: (init?: RequestInit) => Response;
  postGenerate?: (init?: RequestInit) => Response;
  refresh?: (init?: RequestInit) => Response;
  /** GET /api/figma-guide-jobs/active — contract mục 5. Không khai báo →
   *  fallback `{ok:true}` (jobs undefined → mảng rỗng), tức "không có job
   *  active nào" — khớp hành vi mặc định của mọi test không quan tâm re-attach. */
  active?: (init?: RequestInit) => Response;
  getDetail: (init?: RequestInit) => Response;
  getComponents: (init?: RequestInit) => Response;
}) {
  mockFetchSequence({
    // Thứ tự khai báo QUAN TRỌNG (mock đơn giản, khớp theo substring theo thứ
    // tự declare): '/generate-guide/' (GET poll, có jobId) phải khớp TRƯỚC
    // '/generate-guide' (POST khởi job, là tiền tố nguyên văn của URL GET).
    // '/refresh' phải khai TRƯỚC '/api/figma-design-systems/' (tiền tố nguyên
    // văn của URL refresh). '/figma-guide-jobs/active' không đụng tiền tố nào
    // khác nên thứ tự không quan trọng với nó.
    ...(handlers.active ? { '/figma-guide-jobs/active': handlers.active } : {}),
    ...(handlers.getJob ? { '/generate-guide/': handlers.getJob } : {}),
    ...(handlers.postGenerate ? { '/generate-guide': handlers.postGenerate } : {}),
    ...(handlers.refresh ? { '/refresh': handlers.refresh } : {}),
    '/components': handlers.getComponents,
    '/api/figma-design-systems/': handlers.getDetail,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('FigmaDsSourceDetail · component browser', () => {
  it('(a) render list từ components JSON, badge đúng 3 nguồn', async () => {
    mockSourceFetchSequence({
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);

    await screen.findByText('Button/Primary');
    expect(screen.getByText('Button/Secondary')).toBeTruthy();
    expect(screen.getByText('Input/Text')).toBeTruthy();

    const rowPrimary = screen.getByTestId('figma-ds-detail-component-figma-aaaaaaaaaa');
    expect(within(rowPrimary).getByText('Figma')).toBeTruthy();
    const rowSecondary = screen.getByTestId('figma-ds-detail-component-figma-bbbbbbbbbb');
    expect(within(rowSecondary).getByText('AI')).toBeTruthy();
    const rowMissing = screen.getByTestId('figma-ds-detail-component-figma-cccccccccc');
    expect(within(rowMissing).getByText('Thiếu')).toBeTruthy();
  });

  it('(b) filter "Thiếu mô tả" lọc đúng', async () => {
    mockSourceFetchSequence({
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    fireEvent.click(screen.getByTestId('figma-ds-detail-missing-only'));

    expect(screen.queryByText('Button/Primary')).toBeNull();
    expect(screen.queryByText('Button/Secondary')).toBeNull();
    expect(screen.getByText('Input/Text')).toBeTruthy();
  });

  it('(c) bấm Sinh → POST đúng path, panel tiến độ hiện các nhóm đếm từ items', async () => {
    const runningJob: FigmaDesignSystemGuideJobV2 = {
      id: 'job-1', status: 'running', message: 'Đang xử lý…', generated: 0, rejected: 0, remaining: 2,
      error: null, createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z',
      items: [
        { anchor: 'figma-bbbbbbbbbb', name: 'Button/Secondary', page: 'Buttons', status: 'succeeded' },
        { anchor: 'figma-cccccccccc', name: 'Input/Text', page: 'Inputs', status: 'failed', reason: 'Không sinh được mô tả hợp lệ.' },
      ],
      remainingAfterCap: 5,
    };
    mockSourceFetchSequence({
      postGenerate: (init) => {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ jobId: runningJob.id, job: runningJob }), { status: 202 });
      },
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    const button = await screen.findByTestId('figma-ds-detail-generate');
    expect(button.textContent).toContain('Sinh mô tả (2 thiếu)');

    fireEvent.click(button);

    const fetchMock = vi.mocked(fetch);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/generate-guide') && !String(c[0]).includes('job-1'));
      expect(call?.[0]).toBe('/api/figma-design-systems/src-1/generate-guide');
      expect(call?.[1]?.method).toBe('POST');
    });

    const progress = await screen.findByTestId('figma-ds-detail-progress');
    // 4 đếm tổng.
    expect(within(progress).getByText(/Thành công/)).toBeTruthy();
    expect(within(progress).getByText(/Lỗi/)).toBeTruthy();
    expect(within(progress).getByText(/còn 5 comp chờ lượt sau/)).toBeTruthy();
    // Danh sách nhóm THEO PAGE — mỗi page một khối "<page> — x/y · trạng thái".
    const items = within(progress).getByTestId('figma-ds-detail-progress-items');
    expect(within(items).getByText(/Buttons — 1\/1 · xong/)).toBeTruthy();
    expect(within(items).getByText(/Inputs — 1\/1 · có lỗi/)).toBeTruthy();
    // Nhóm có lỗi tự mở — thấy reason không cần bấm xổ thêm.
    expect(within(items).getByText('Không sinh được mô tả hợp lệ.')).toBeTruthy();
  });

  it('(d) job không items → fallback 3 con số', async () => {
    const runningJob: FigmaDesignSystemGuideJobV2 = {
      id: 'job-2', status: 'running', message: 'Đang xử lý…', generated: 1, rejected: 0, remaining: 1,
      error: null, createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z',
    };
    mockSourceFetchSequence({
      postGenerate: () => new Response(JSON.stringify({ jobId: runningJob.id, job: runningJob }), { status: 202 }),
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    const button = await screen.findByTestId('figma-ds-detail-generate');
    fireEvent.click(button);

    const progress = await screen.findByTestId('figma-ds-detail-progress');
    // Fallback 3 con số cũ — không vỡ khi job (daemon cũ) không có `items`.
    expect(within(progress).getByText(/1/)).toBeTruthy();
    expect(screen.queryByTestId('figma-ds-detail-progress-items')).toBeNull();
  });

  it('(e) lastGuideRun hiển thị', async () => {
    const detailWithRun = {
      ...baseDetail,
      lastGuideRun: {
        finishedAt: '2026-08-19T10:00:00Z',
        generated: 4,
        failed: 1,
        failures: [{ anchor: 'figma-cccccccccc', name: 'Input/Text', reason: 'Lỗi validate.' }],
      },
    };
    mockSourceFetchSequence({
      getDetail: () => new Response(JSON.stringify(detailWithRun), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);

    await screen.findByText(/Lượt sinh gần nhất/);
    expect(screen.getByText(/4 ✓/)).toBeTruthy();
    expect(screen.getByText(/1 ✗/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Lượt sinh gần nhất/));
    expect(await screen.findByText('Lỗi validate.')).toBeTruthy();
  });

  // WP21-fix điểm 4 (review WP21a): refresh() lỗi trước đây bị nuốt im lặng
  // khi `detail` đã có dữ liệu (banner cũ chỉ render lúc `detail === null`).
  it('(f) refresh() lỗi vẫn hiện banner dù detail đang có dữ liệu cũ', async () => {
    mockSourceFetchSequence({
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
      refresh: () => new Response(JSON.stringify({ error: { message: 'Lỗi máy chủ khi làm mới.' } }), { status: 500 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    fireEvent.click(screen.getByText('Làm mới'));

    expect(await screen.findByText('Lỗi máy chủ khi làm mới.')).toBeTruthy();
    // detail vẫn còn hiện dữ liệu cũ — banner không thay thế trang.
    expect(screen.getByText('Button/Primary')).toBeTruthy();
  });

  // WP21-fix điểm 5 (review WP21a): nhóm "không page" trước đây dùng key
  // hiển thị 'Khác' để nhóm trong Map — đụng nếu Figma có page thật tên
  // "Khác" (gộp chung nhóm). Phải tách được 2 nhóm riêng biệt.
  it('(g) nhóm page thật tên "Khác" và item không có page là 2 nhóm riêng biệt', async () => {
    const runningJob: FigmaDesignSystemGuideJobV2 = {
      id: 'job-3', status: 'running', message: 'Đang xử lý…', generated: 0, rejected: 0, remaining: 2,
      error: null, createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z',
      items: [
        { anchor: 'figma-x1', name: 'X1', page: 'Khác', status: 'succeeded' },
        { anchor: 'figma-x2', name: 'X2', status: 'succeeded' }, // không có page
      ],
      remainingAfterCap: 0,
    };
    mockSourceFetchSequence({
      postGenerate: () => new Response(JSON.stringify({ jobId: runningJob.id, job: runningJob }), { status: 202 }),
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    const button = await screen.findByTestId('figma-ds-detail-generate');
    fireEvent.click(button);

    const items = await screen.findByTestId('figma-ds-detail-progress-items');
    // 2 khối riêng biệt, cả hai hiện nhãn "Khác — 1/1 · xong" — không gộp lại.
    const khacHeadings = within(items).getAllByText(/Khác — 1\/1 · xong/);
    expect(khacHeadings).toHaveLength(2);
  });

  // WP23b (a) — re-attach: vào trang lúc job đang chạy (registry active
  // GET /api/figma-guide-jobs/active) là thấy nguyên panel tiến độ, KHÔNG
  // cần bấm nút "Sinh mô tả" lại.
  it('(h) re-attach — active trả job running → panel tiến độ tự hiện không cần bấm nút', async () => {
    const activeJob: FigmaGuideActiveJob = {
      jobId: 'job-active-1', sourceId: 'src-1', status: 'running', done: 1, total: 2, startedAt: 1_000,
    };
    const fullJob: FigmaDesignSystemGuideJobV2 = {
      id: 'job-active-1', status: 'running', message: 'Đang xử lý…', generated: 0, rejected: 0, remaining: 1,
      error: null, createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z',
      items: [
        { anchor: 'figma-bbbbbbbbbb', name: 'Button/Secondary', page: 'Buttons', status: 'succeeded' },
        { anchor: 'figma-cccccccccc', name: 'Input/Text', page: 'Inputs', status: 'running' },
      ],
    };
    mockSourceFetchSequence({
      active: () => new Response(JSON.stringify({ jobs: [activeJob] }), { status: 200 }),
      getJob: () => new Response(JSON.stringify({ job: fullJob }), { status: 200 }),
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);

    // KHÔNG bấm nút "Sinh mô tả (N thiếu)" — panel tiến độ vẫn tự hiện.
    const progress = await screen.findByTestId('figma-ds-detail-progress');
    expect(within(progress).getByText(/Buttons — 1\/1 · xong/)).toBeTruthy();
    expect(within(progress).getByText(/Inputs — 0\/1 · đang sinh/)).toBeTruthy();
  });

  // WP23b (b) — 5 ô đếm (thêm "Bỏ qua") + item skipped có badge riêng + reason.
  it('(i) item skipped → đếm riêng "Bỏ qua" + badge + reason hiện khi nhóm mở', async () => {
    const runningJob: FigmaDesignSystemGuideJobV2 = {
      id: 'job-skip-1', status: 'succeeded', message: 'Xong', generated: 1, rejected: 0, remaining: 0,
      error: null, createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z',
      skipped: 1,
      items: [
        { anchor: 'figma-bbbbbbbbbb', name: 'Button/Secondary', page: 'Buttons', status: 'succeeded' },
        {
          anchor: 'figma-cccccccccc', name: 'Rectangle 12', page: 'Inputs', status: 'skipped',
          reason: 'Tên không đủ nghĩa — cần đặt lại tên trong Figma',
        },
      ],
    };
    mockSourceFetchSequence({
      postGenerate: () => new Response(JSON.stringify({ jobId: runningJob.id, job: runningJob }), { status: 202 }),
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    const button = await screen.findByTestId('figma-ds-detail-generate');
    fireEvent.click(button);

    const progress = await screen.findByTestId('figma-ds-detail-progress');
    // Ô đếm "Bỏ qua" trong 5 ô tổng.
    expect(within(progress).getByText('Bỏ qua')).toBeTruthy();
    // Nhóm "Inputs" chỉ có 1 item skipped — done/total = 1/1 tính cả skipped.
    const items = await screen.findByTestId('figma-ds-detail-progress-items');
    expect(within(items).getByText(/Inputs — 1\/1/)).toBeTruthy();
    fireEvent.click(within(items).getByText(/Inputs — 1\/1/));
    expect(within(items).getByText('Bỏ qua')).toBeTruthy();
    expect(within(items).getByText('Tên không đủ nghĩa — cần đặt lại tên trong Figma')).toBeTruthy();
  });

  // WP23b (c) — khối "Cần đặt lại tên trong Figma (N)" tính thẳng từ
  // components API, hiện cả khi KHÔNG có job nào chạy; filter "Tên rác" lọc
  // đúng danh sách.
  it('(j) khối "Cần đặt lại tên trong Figma (N)" hiện khi có needsRename, không cần job; filter Tên rác lọc đúng', async () => {
    const componentsWithJunk: FigmaDesignSystemComponentItem[] = [
      ...baseComponents,
      {
        anchor: 'figma-junk1', name: 'Rectangle 12', nodeId: '1:9', fileKey: 'ABC', fileName: 'Kit',
        page: 'Buttons', descriptionSource: 'none', properties: [], needsRename: true, kind: 'normal',
      },
    ];
    mockSourceFetchSequence({
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: componentsWithJunk }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    // Không có job nào chạy — khối vẫn hiện đúng N=1.
    const block = screen.getByTestId('figma-ds-detail-needs-rename');
    expect(within(block).getByText('Cần đặt lại tên trong Figma (1)')).toBeTruthy();
    fireEvent.click(within(block).getByText('Cần đặt lại tên trong Figma (1)'));
    expect(within(block).getByText('Rectangle 12')).toBeTruthy();
    // Đóng khối lại trước khi kiểm tra danh sách browser — tránh 2 nơi cùng
    // hiện chữ "Rectangle 12" (khối xổ + hàng trong browser) làm query mơ hồ.
    fireEvent.click(within(block).getByText('Cần đặt lại tên trong Figma (1)'));
    expect(within(block).queryByText('Rectangle 12')).toBeNull();

    // Filter "Tên rác (1)" chỉ còn item needsRename — assert theo testid hàng
    // (không theo text) để không lẫn với text bên trong khối.
    fireEvent.click(screen.getByTestId('figma-ds-detail-needs-rename-only'));
    expect(screen.queryByTestId('figma-ds-detail-component-figma-aaaaaaaaaa')).toBeNull();
    expect(screen.queryByTestId('figma-ds-detail-component-figma-cccccccccc')).toBeNull();
    expect(screen.getByTestId('figma-ds-detail-component-figma-junk1')).toBeTruthy();
  });

  it('(k) không có needsRename nào → không render khối/chip', async () => {
    mockSourceFetchSequence({
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    expect(screen.queryByTestId('figma-ds-detail-needs-rename')).toBeNull();
    expect(screen.queryByTestId('figma-ds-detail-needs-rename-only')).toBeNull();
  });

  // WP23b (d) — thumbnail: src đúng route component-image, loading="lazy".
  it('(l) mỗi hàng browser có ảnh thumbnail src đúng route component-image', async () => {
    mockSourceFetchSequence({
      getDetail: () => new Response(JSON.stringify(baseDetail), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    const row = screen.getByTestId('figma-ds-detail-component-figma-aaaaaaaaaa');
    const img = within(row).getByAltText('Button/Primary') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/figma-design-systems/src-1/component-image/figma-aaaaaaaaaa');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  // WP23b (e) — dòng phụ header khi detail.imageCache có.
  it('(m) header hiện "Ảnh comp: cached/total" khi detail.imageCache có, kèm "đang tải…" lúc running', async () => {
    mockSourceFetchSequence({
      getDetail: () => new Response(JSON.stringify({
        ...baseDetail,
        imageCache: { total: 3, cached: 1, running: true },
      }), { status: 200 }),
      getComponents: () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
    });
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);

    expect(await screen.findByText(/Ảnh comp: 1\/3/)).toBeTruthy();
    expect(screen.getByText(/đang tải…/)).toBeTruthy();
  });
});

describe('FigmaDsSourceDetail · tab Tokens (WP-ds-tokens UI)', () => {
  // '/tokens' phải khai TRƯỚC '/api/figma-design-systems/' (tiền tố nguyên văn
  // của URL tokens) — cùng lý do thứ tự đã ghi ở mockSourceFetchSequence.
  function mockWithTokens(tokens: (init?: RequestInit) => Response) {
    mockFetchSequence({
      '/tokens': tokens,
      '/components': () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
      '/api/figma-design-systems/': () => new Response(JSON.stringify(baseDetail), { status: 200 }),
    });
  }

  it('(t1) chuyển tab Tokens → fetch + render markdown, có ngày sinh', async () => {
    mockWithTokens(() => new Response(
      JSON.stringify({ markdown: '## Màu\n\n| Giá trị | Lượt dùng |\n| --- | --- |\n| `#0052ff` | 3 |\n', generatedAt: '2026-08-22T03:00:00Z' }),
      { status: 200 },
    ));
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    fireEvent.click(screen.getByTestId('figma-ds-detail-tab-tokens'));
    const panel = await screen.findByTestId('figma-ds-detail-tokens');
    await within(panel).findByText('Màu');
    expect(within(panel).getByText('#0052ff')).toBeTruthy();
    expect(within(panel).getByText(/Sinh lúc/)).toBeTruthy();
    // Tab Tokens ẩn toolbar/list component (một view một lúc).
    expect(screen.queryByText('Button/Primary')).toBeNull();
  });

  it('(t2) 404 TOKENS_NOT_GENERATED → empty-state hướng dẫn Làm mới + Tải lại, không phải lỗi', async () => {
    mockWithTokens(() => new Response(JSON.stringify({ code: 'TOKENS_NOT_GENERATED' }), { status: 404 }));
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    fireEvent.click(screen.getByTestId('figma-ds-detail-tab-tokens'));
    const panel = await screen.findByTestId('figma-ds-detail-tokens');
    await within(panel).findByText(/chưa có tokens/i);
    expect(within(panel).queryByRole('alert')).toBeNull();
    // "Tải lại" gọi lại API — lần hai trả markdown thì render được.
    expect(within(panel).getByRole('button', { name: 'Tải lại' })).toBeTruthy();
  });

  it('(t3) quay lại tab Thành phần → list render lại, không fetch tokens thừa', async () => {
    const tokensSpy = vi.fn(() => new Response(
      JSON.stringify({ markdown: '## Chữ\n', generatedAt: '2026-08-22T03:00:00Z' }),
      { status: 200 },
    ));
    mockWithTokens(tokensSpy);
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    fireEvent.click(screen.getByTestId('figma-ds-detail-tab-tokens'));
    await screen.findByText('Chữ');
    fireEvent.click(screen.getByTestId('figma-ds-detail-tab-components'));
    await screen.findByText('Button/Primary');
    fireEvent.click(screen.getByTestId('figma-ds-detail-tab-tokens'));
    await screen.findByText('Chữ');
    // Lazy + cache trong state: chỉ 1 lần fetch dù chuyển tab qua lại.
    expect(tokensSpy).toHaveBeenCalledTimes(1);
  });
});

describe('FigmaDsSourceDetail · tab Slots (WP-slots UI)', () => {
  // Cùng lý do thứ tự với mockWithTokens: '/slots' (và '/tokens') phải khai
  // TRƯỚC '/api/figma-design-systems/'.
  function mockWithSlots(slots: (init?: RequestInit) => Response) {
    mockFetchSequence({
      '/slots': slots,
      '/tokens': () => new Response(JSON.stringify({ code: 'TOKENS_NOT_GENERATED' }), { status: 404 }),
      '/components': () => new Response(JSON.stringify({ components: baseComponents }), { status: 200 }),
      '/api/figma-design-systems/': () => new Response(JSON.stringify(baseDetail), { status: 200 }),
    });
  }

  it('(s1) chuyển tab Slots → fetch + render markdown, ẩn list component', async () => {
    mockWithSlots(() => new Response(
      JSON.stringify({ markdown: '### Card Default\n\n| Path | Hidden |\n| --- | --- |\n| `.card-action` | không |\n', generatedAt: '2026-08-22T05:00:00Z' }),
      { status: 200 },
    ));
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    fireEvent.click(screen.getByTestId('figma-ds-detail-tab-slots'));
    const panel = await screen.findByTestId('figma-ds-detail-slots');
    await within(panel).findByText('Card Default');
    expect(within(panel).getByText('.card-action')).toBeTruthy();
    expect(within(panel).getByText(/Sinh lúc/)).toBeTruthy();
    expect(screen.queryByText('Button/Primary')).toBeNull();
  });

  it('(s2) 404 SLOTS_NOT_GENERATED → empty-state hướng dẫn, không phải lỗi', async () => {
    mockWithSlots(() => new Response(JSON.stringify({ code: 'SLOTS_NOT_GENERATED' }), { status: 404 }));
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    fireEvent.click(screen.getByTestId('figma-ds-detail-tab-slots'));
    const panel = await screen.findByTestId('figma-ds-detail-slots');
    await within(panel).findByText(/chưa có hồ sơ slot/i);
    expect(within(panel).queryByRole('alert')).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Tải lại' })).toBeTruthy();
  });

  it('(s3) chuyển tab qua lại → mỗi tab cache riêng, mỗi API chỉ fetch 1 lần', async () => {
    const slotsSpy = vi.fn(() => new Response(
      JSON.stringify({ markdown: '### Tabbar\n', generatedAt: '2026-08-22T05:00:00Z' }),
      { status: 200 },
    ));
    mockWithSlots(slotsSpy);
    render(<FigmaDsSourceDetail sourceId="src-1" onBack={() => {}} />);
    await screen.findByText('Button/Primary');

    fireEvent.click(screen.getByTestId('figma-ds-detail-tab-slots'));
    await screen.findByText('Tabbar');
    fireEvent.click(screen.getByTestId('figma-ds-detail-tab-components'));
    await screen.findByText('Button/Primary');
    fireEvent.click(screen.getByTestId('figma-ds-detail-tab-slots'));
    await screen.findByText('Tabbar');
    expect(slotsSpy).toHaveBeenCalledTimes(1);
  });
});
