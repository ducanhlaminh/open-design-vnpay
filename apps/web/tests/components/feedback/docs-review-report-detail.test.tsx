// @vitest-environment jsdom
// Trang chi tiết báo cáo docs-review: thân tab = Quick result thật (rail +
// FileViewer) trên dự án ảo `drsnap.<confirmationId>.<projectId>` — fetch mock
// theo URL đúng các route daemon phục vụ cho id ảo (files / raw / comments).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocsReviewFeedbackArtifactV2, DocsReviewReportDetailResponse, PipelineView, ProjectFile } from '@open-design/contracts';
import { DocsReviewReportDetailView, formatBytes, metricRows, stageBadgeText, stagePipelineView } from '../../../src/components/feedback/DocsReviewReportDetail';

afterEach(cleanup);

const report: DocsReviewFeedbackArtifactV2 = {
  schemaVersion: 2,
  confirmationId: 'c-new',
  projectId: 'p-v2',
  workflowId: 'docs-review',
  installationId: 'inst-b',
  user: 'binh',
  channel: 'packaged',
  confirmedAt: Date.UTC(2026, 7, 28, 3, 0, 0),
  app: { id: 'app-1', name: 'Ví VNPAY' },
  feature: { id: 'p-v2', name: 'Chuyển tiền' },
  screenPlatform: 'mobile',
  stages: [
    {
      stageId: 'dr-docs', name: 'Tài liệu', status: 'succeeded',
      outputs: [
        { path: 'docs/a.md', size: 2048, mediaPath: 'docs-review-feedback/inst-b/c-new/outputs/docs/a.md' },
        { path: 'docs/b.md', size: 10, mediaPath: 'docs-review-feedback/inst-b/c-new/outputs/docs/b.md' },
      ],
      comments: [],
      metrics: { kind: 'dr-docs', pages: 2 },
    },
    {
      stageId: 'dr-mockup', name: 'Mockup', status: 'succeeded',
      outputs: [{ path: 'mockups/s1.html', size: 20, mediaPath: 'docs-review-feedback/inst-b/c-new/outputs/mockups/s1.html' }],
      skipped: [{ path: 'mockups/big.png', reason: 'size' }],
      comments: [{ id: 'cm1', stageId: 'dr-mockup', text: 'Đổi màu nút', by: 'binh', at: Date.UTC(2026, 7, 27), target: { kind: 'screen', key: 'SCREEN-1', label: 'Màn chuyển tiền' } }],
      metrics: { kind: 'dr-mockup', screens: 1, variant: null },
    },
  ],
  summary: { agentProposals: 7, humanEdits: 3, comments: 1, aiOutcome: { proposals: 7, accepted: 4, edited: 2, dismissed: 1 } },
  agent: { add: 5, edited: 1, delete: 1, total: 7, accepted: 4, editedByUser: 2, dismissed: 1 },
  userChanges: { add: 1, edited: 0, delete: 0, total: 1 },
  pages: [],
};

const data: DocsReviewReportDetailResponse = {
  report,
  history: [
    { confirmationId: 'c-new', confirmedAt: report.confirmedAt, user: 'binh', legacy: false },
    { confirmationId: 'c-prev', confirmedAt: report.confirmedAt - 1000, user: 'dung', legacy: false },
    { confirmationId: 'c-old', confirmedAt: report.confirmedAt - 2000, user: 'an', legacy: true },
  ],
};

describe('helpers', () => {
  it('formatBytes', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('stageBadgeText đếm thứ có nghĩa thay vì số file', () => {
    expect(stageBadgeText(report.stages[0]!)).toBe('2 trang · 0 bl');
    expect(stageBadgeText(report.stages[1]!)).toBe('1 màn · 1 bl');
  });

  it('metricRows renders every kind in Vietnamese', () => {
    expect(metricRows({ kind: 'dr-docs', pages: 3 })).toEqual([['Trang tài liệu', '3']]);
    expect(metricRows({ kind: 'dr-flow', flows: 2, screens: 9, platform: 'both', drawioEdited: true, overrides: { add: 1, rename: 2, remove: 0 } })).toContainEqual(['Chỉnh màn (thêm / đổi tên / bỏ)', '1 / 2 / 0']);
    expect(metricRows({ kind: 'dr-mockup', screens: 4, variant: 'improved' })).toEqual([['Màn hình', '4'], ['Biến thể', 'improved']]);
    const review = metricRows({
      kind: 'dr-review',
      agent: { add: 1, edited: 1, delete: 1, total: 3, accepted: 1, editedByUser: 1, dismissed: 1 },
      userChanges: { add: 0, edited: 0, delete: 0, total: 0 },
      notes: { total: 2, dismissed: 1, user: 1 },
      annotationComments: 4,
      pages: [],
      enrich: { diagrams: { total: 1, accepted: 1, dismissed: 0 } },
    });
    expect(review).toContainEqual(['Giữ / Sửa / Bỏ', '1 / 1 / 1']);
    expect(review).toContainEqual(['Bình luận trên annotation', '4']);
  });

  it('stagePipelineView: outputs từ registry khi có, không thì bảng fallback theo bước', () => {
    const stage = { stageId: 'dr-docs' as const, name: 'Tài liệu' };
    expect(stagePipelineView(stage, null).outputs).toEqual(['docs/', 'docs-feature/']);
    expect(stagePipelineView({ stageId: 'dr-flow' as const, name: 'Luồng' }, null).outputs).toEqual(['flows/', 'screens-discovered.json', 'screens-discovered.md', 'comp/_screens.json']);
    expect(stagePipelineView({ stageId: 'dr-flow-improve' as const, name: 'Cải thiện' }, null).outputs).toContain('flows/SCREEN-FLOW--app/ux-review.json');
    expect(stagePipelineView({ stageId: 'dr-review' as const, name: 'Review' }, null).outputs).toEqual(['review/']);
    const registry: PipelineView[] = [{ id: 'dr-docs', name: 'Tài liệu (nạp)', dependsOn: [], status: 'succeeded', active: true, outputs: ['docs-feature/'] }];
    const view = stagePipelineView(stage, registry);
    expect(view.outputs).toEqual(['docs-feature/']);
    expect(view.id).toBe('dr-docs');
    // Registry có bước nhưng thiếu outputs → vẫn fallback.
    expect(stagePipelineView(stage, [{ id: 'dr-docs', name: 'x', dependsOn: [], status: 'idle', active: true }]).outputs).toEqual(['docs/', 'docs-feature/']);
  });
});

// ── Render: fetch mock theo URL ───────────────────────────────────────────
const SNAP = 'drsnap.c-new.p-v2';
const FILES_URL = `/api/projects/${SNAP}/files`;
const RAW_A_URL = `/api/projects/${SNAP}/raw/docs-review/docs/a.md`;
const COMMENTS_URL = `/api/projects/${SNAP}/docs-review/comments/dr-docs`;

function snapFile(name: string): ProjectFile {
  return { name, path: name, type: 'file', size: 10, mtime: report.confirmedAt, kind: 'text', mime: 'text/markdown' };
}
const snapFiles = [snapFile('docs-review/docs/a.md'), snapFile('docs-review/docs/b.md')];

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function textRes(text: string) {
  return { ok: true, status: 200, text: async () => text, json: async () => { throw new Error('not json'); } };
}
function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as { url: string }).url;
}

let calls: string[];
function installFetch(opts: { registry?: unknown; registryStatus?: number } = {}) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = urlOf(input);
    calls.push(url);
    if (url.startsWith('/api/pipelines?')) return jsonRes(opts.registry ?? { error: 'project not found' }, opts.registryStatus ?? (opts.registry ? 200 : 404));
    if (url === FILES_URL) return jsonRes({ files: snapFiles });
    if (url === RAW_A_URL) return textRes('# Tiêu đề\n\nNội dung.');
    if (url === COMMENTS_URL) return jsonRes({ comments: [] });
    return jsonRes({ error: `not available for snapshot: ${url}` }, 404);
  }));
}

describe('DocsReviewReportDetailView', () => {
  beforeEach(() => installFetch());
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('header + lịch sử như cũ; thân tab = Quick result trên dự án ảo (rail 2 mục, markdown render, số liệu gập)', async () => {
    render(<DocsReviewReportDetailView projectId="p-v2" confirmationId="c-new" data={data} />);
    expect(screen.getByText('Ví VNPAY')).toBeTruthy();
    expect(screen.getByText('Chuyển tiền')).toBeTruthy();
    expect(screen.getByText('Mobile')).toBeTruthy();
    const history = screen.getByLabelText('Lịch sử xác nhận') as HTMLSelectElement;
    expect(history.value).toBe('c-new');
    expect(history.options).toHaveLength(3);
    expect(history.options[2]!.disabled).toBe(true);

    const tabs = screen.getAllByRole('tab', { name: /Tài liệu|Mockup/ }) as [HTMLElement, HTMLElement];
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    // Số liệu bước nằm trong <details> gập ngay dưới thanh tab.
    expect(screen.getByText('Số liệu bước')).toBeTruthy();
    expect(screen.getByText('Trang tài liệu')).toBeTruthy();

    // Registry 404 (dự án không có trên máy) → fallback outputs docs/ → 2 file → rail 2 mục.
    await waitFor(() => expect(screen.getByLabelText('Output files')).toBeTruthy());
    expect(calls).toContain('/api/pipelines?projectId=p-v2&workflowId=docs-review');
    expect(calls).toContain(FILES_URL);
    expect(screen.getByText('a.md')).toBeTruthy();
    expect(screen.getByText('b.md')).toBeTruthy();
    // File đầu mở bằng MarkdownViewer thật, đọc qua /raw của dự án ảo.
    await waitFor(() => expect(document.querySelector('article.markdown-rendered')?.innerHTML).toContain('Tiêu đề'));
    expect(calls).toContain(RAW_A_URL);
    // Trang docs-review/docs/* có cột bình luận cấp bước → đọc comments của dự án ảo.
    await waitFor(() => expect(calls).toContain(COMMENTS_URL));
    // Không còn viewer tự chế / khối "Tải file gốc".
    expect(screen.queryByText(/Tải file gốc/)).toBeNull();
    // Khung bố cục = route Quick result.
    const page = document.querySelector('section.pl-result-page');
    expect(page?.getAttribute('aria-label')).toBe('Quick result · Tài liệu');
    expect(page?.querySelector('.pl-result-page__body .pl-result-preview')).toBeTruthy();

    // Đổi tab → mount Quick result mới (fetch files lần 2) + số liệu bước mockup.
    const filesBefore = calls.filter((u) => u === FILES_URL).length;
    fireEvent.click(tabs[1]);
    expect(screen.getByText('Biến thể')).toBeTruthy();
    expect(screen.getByText('1 file không đính kèm (quá 5 MB)')).toBeTruthy();
    await waitFor(() => expect(calls.filter((u) => u === FILES_URL).length).toBe(filesBefore + 1));
  });

  it('chỉ đọc: không có ô "Bình luận mới" trong cột bình luận của trang', async () => {
    render(<DocsReviewReportDetailView projectId="p-v2" confirmationId="c-new" data={data} />);
    await waitFor(() => expect(document.querySelector('article.markdown-rendered')?.innerHTML).toContain('Tiêu đề'));
    await waitFor(() => expect(calls).toContain(COMMENTS_URL));
    // Chờ panel bình luận (StageCommentPanel, W1) render xong nhãn "chỉ xem" để
    // assertion không-có-composer không bị rỗng nghĩa vì panel chưa mount.
    await waitFor(() => expect(screen.getByTestId('stage-comment-readonly')).toBeTruthy());
    expect(screen.queryByLabelText('Bình luận mới cho bước')).toBeNull();
  });

  it('registry trả outputs thật → dùng nó thay vì fallback', async () => {
    installFetch({
      registry: { projectId: 'p-v2', workflowId: 'docs-review', runMode: 'full', pipelines: [{ id: 'dr-docs', name: 'Tài liệu (nạp)', dependsOn: [], status: 'succeeded', active: true, outputs: ['docs-feature/'] }] },
    });
    render(<DocsReviewReportDetailView projectId="p-v2" confirmationId="c-new" data={data} />);
    // outputs docs-feature/ không khớp docs/a.md, docs/b.md → không có tệp hiển thị.
    await waitFor(() => expect(screen.getByText(/chưa có tệp kết quả/)).toBeTruthy());
    expect(screen.queryByLabelText('Output files')).toBeNull();
  });
});
