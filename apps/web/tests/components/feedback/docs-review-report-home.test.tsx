// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { DocsReviewReportsResponse } from '@open-design/contracts';
import { DocsReviewReportHomeView, outcomeShares, outputUrl } from '../../../src/components/feedback/DocsReviewReportHome';

afterEach(cleanup);

const fixture: DocsReviewReportsResponse = {
  storeReachable: true,
  summary: {
    apps: 1,
    features: 3,
    confirmations: 5,
    agentProposals: 17,
    humanEdits: 9,
    comments: 1,
    aiOutcome: { proposals: 20, accepted: 10, edited: 5, dismissed: 5 },
  },
  byApp: [
    { appId: 'app-1', appName: 'Ví VNPAY', features: 2, confirmations: 4, aiOutcome: { proposals: 12, accepted: 6, edited: 3, dismissed: 3 } },
    { appId: null, appName: 'Chưa gắn App', features: 1, confirmations: 1, aiOutcome: { proposals: 5, accepted: 2, edited: 1, dismissed: 2 } },
  ],
  completed: [
    {
      projectId: 'p-v2', feature: { id: 'p-v2', name: 'Chuyển tiền' }, app: { id: 'app-1', name: 'Ví VNPAY' }, screenPlatform: 'both',
      confirmedAt: Date.UTC(2026, 7, 28, 3, 0, 0), user: 'binh', confirmationId: 'c-new', installationId: 'inst-b',
      summary: { agentProposals: 7, humanEdits: 3, comments: 1, aiOutcome: { proposals: 7, accepted: 4, edited: 2, dismissed: 1 } }, legacy: false,
    },
    {
      projectId: 'p-legacy', feature: { id: 'p-legacy', name: 'Đăng nhập' }, app: null, screenPlatform: null,
      confirmedAt: Date.UTC(2026, 7, 20, 3, 0, 0), user: 'an', confirmationId: 'c-old', installationId: 'inst-a',
      summary: { agentProposals: 5, humanEdits: 3, comments: 0, aiOutcome: { proposals: 5, accepted: 2, edited: 1, dismissed: 2 } }, legacy: true,
    },
  ],
  skippedFiles: [{ projectId: 'p-legacy', path: 'docs-review-feedback/inst-a/broken.json', reason: 'không parse được' }],
};

describe('outcomeShares', () => {
  it('computes percentages over proposals, falling back to the sum', () => {
    expect(outcomeShares({ proposals: 20, accepted: 10, edited: 5, dismissed: 5 })).toEqual({ accepted: 50, edited: 25, dismissed: 25, total: 20 });
    expect(outcomeShares({ proposals: 0, accepted: 1, edited: 1, dismissed: 2 })).toEqual({ accepted: 25, edited: 25, dismissed: 50, total: 4 });
    expect(outcomeShares({ proposals: 0, accepted: 0, edited: 0, dismissed: 0 })).toEqual({ accepted: 0, edited: 0, dismissed: 0, total: 0 });
  });
  it('outputUrl encodes path and toggles download', () => {
    expect(outputUrl('p 1', 'c/2', 'mockups/s1.html')).toBe('/api/pipelines/docs-review/reports/p%201/c%2F2/output?path=mockups%2Fs1.html');
    expect(outputUrl('p', 'c', 'a.md', { download: true })).toBe('/api/pipelines/docs-review/reports/p/c/output?path=a.md&download=1');
  });
});

describe('DocsReviewReportHomeView', () => {
  it('renders KPIs, the outcome meter, and both tables from a fixture', () => {
    render(<DocsReviewReportHomeView data={fixture} loading={false} error={null} onRefresh={vi.fn()} />);
    const kpi = (label: string) => document.querySelector(`[data-kpi="${label}"]`)?.textContent;
    expect(kpi('App')).toBe('1');
    expect(kpi('Tính năng')).toBe('3');
    expect(kpi('Lượt xác nhận')).toBe('5');
    expect(kpi('Agent đề xuất')).toBe('17');
    expect(kpi('Người sửa')).toBe('9');
    expect(kpi('Bình luận')).toBe('1');
    expect(screen.getByRole('img', { name: /Giữ 10, Sửa 5, Bỏ 5 trên 20/ })).toBeTruthy();
    expect(screen.getByText(/\(50%\)/)).toBeTruthy();

    const byApp = document.querySelector('[data-table="by-app"]') as HTMLElement;
    expect(within(byApp).getAllByRole('row')).toHaveLength(3);
    expect(within(byApp).getByText('Ví VNPAY')).toBeTruthy();
    expect(within(byApp).getByText('Chưa gắn App')).toBeTruthy();

    const completed = document.querySelector('[data-table="completed"]') as HTMLElement;
    const rows = within(completed).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement];
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-legacy')).toBe('no');
    expect(within(rows[0]).getByText('Cả hai')).toBeTruthy();
    const link = within(rows[0]).getByText('Chi tiết') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/feedback/docs-review/p-v2/c-new');
    expect(rows[1].getAttribute('data-legacy')).toBe('yes');
    expect(rows[1].getAttribute('title')).toBe('Bản cũ (v1), không có chi tiết');
    expect(within(rows[1]).queryByText('Chi tiết')).toBeNull();
    expect(within(rows[1]).getByText('—')).toBeTruthy();
    expect(screen.getByText('1 file bỏ qua (không đọc được).')).toBeTruthy();
  });

  it('shows the store warning and wires the refresh button', () => {
    const onRefresh = vi.fn();
    render(<DocsReviewReportHomeView data={{ ...fixture, storeReachable: false, byApp: [], completed: [], skippedFiles: [] }} loading={false} error={null} onRefresh={onRefresh} />);
    expect(screen.getByText(/Chưa kết nối media store/)).toBeTruthy();
    expect(screen.getByText('Chưa có bản xác nhận docs-review nào.')).toBeTruthy();
    screen.getByText('Làm mới').click();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders the error state without data', () => {
    render(<DocsReviewReportHomeView data={null} loading={false} error="HTTP 502" onRefresh={vi.fn()} />);
    expect(screen.getByText('Không tải được báo cáo: HTTP 502')).toBeTruthy();
  });
});
