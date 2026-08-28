// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocsReviewFeedbackArtifactV2, DocsReviewReportDetailResponse } from '@open-design/contracts';
import { DocsReviewReportDetailView, formatBytes, metricRows, outputKindOf } from '../../../src/components/feedback/DocsReviewReportDetail';

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
  it('classifies outputs by extension and formats sizes', () => {
    expect(outputKindOf('docs/a.md')).toBe('markdown');
    expect(outputKindOf('mockups/S1.HTML')).toBe('html');
    expect(outputKindOf('flows/f.svg')).toBe('image');
    expect(outputKindOf('flows/f.drawio')).toBe('other');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(0)).toBe('0 B');
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
});

describe('DocsReviewReportDetailView', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '# Tiêu đề\n\nNội dung.' })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders header, history, stage tabs, markdown output, then the mockup iframe + comments on tab switch', async () => {
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
    // Bước 1: 2 file md → có thanh chọn file, file đầu render markdown qua fetch route output.
    expect(screen.getByRole('button', { name: 'docs/b.md' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('article.markdown-rendered')?.innerHTML).toContain('Tiêu đề'));
    expect(fetch).toHaveBeenCalledWith('/api/pipelines/docs-review/reports/p-v2/c-new/output?path=docs%2Fa.md');
    expect(screen.getByText('Trang tài liệu')).toBeTruthy();
    expect(screen.getByText('Chưa có bình luận ở bước này.')).toBeTruthy();

    fireEvent.click(tabs[1]);
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('/api/pipelines/docs-review/reports/p-v2/c-new/output?path=mockups%2Fs1.html');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(screen.getByText('Đổi màu nút')).toBeTruthy();
    expect(screen.getByText('Màn chuyển tiền')).toBeTruthy();
    expect(screen.getByText('1 file không đính kèm (quá 5 MB)')).toBeTruthy();
    const download = screen.getByText('Tải') as HTMLAnchorElement;
    expect(download.getAttribute('href')).toBe('/api/pipelines/docs-review/reports/p-v2/c-new/output?path=mockups%2Fs1.html&download=1');
    expect(download.hasAttribute('download')).toBe(true);
  });
});
