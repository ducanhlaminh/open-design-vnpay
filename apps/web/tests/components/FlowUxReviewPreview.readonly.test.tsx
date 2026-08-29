// @vitest-environment jsdom
//
// wp-docs-review-report-quick-result (Executor W1): FlowUxReviewPreview trong
// dự án ảo `drsnap.*` (báo cáo xác nhận) chỉ xem — không "Chỉnh sửa"
// (POST screen-flow), không radio "Dùng bản để chạy tiếp" (PUT selection) mà
// chỉ dòng "Bản đang dùng: …"; Tải .drawio / Toàn màn hình / panel finding giữ.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const FILES: Record<string, string | null> = {};

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => FILES[name] ?? null,
}));
vi.mock('../../src/components/DrawioViewer', () => ({
  DrawioViewer: (props: { page?: number }) => <div data-testid="drawio-stub" data-page={props.page ?? 0} />,
}));
vi.mock('../../src/components/DrawioEditor', () => ({
  DrawioEditor: () => <div data-testid="drawio-editor-stub" />,
}));
vi.mock('../../src/components/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => <pre data-testid="mermaid-stub">{code}</pre>,
}));
vi.mock('../../src/components/docs-review/StageCommentPanel', () => ({
  StageCommentPanel: (props: { stageId: string }) => <aside data-testid="stage-comment-panel" data-stage-id={props.stageId} />,
}));

const { FlowUxReviewPreview } = await import('../../src/components/FlowUxReviewPreview');

afterEach(() => {
  cleanup();
  for (const k of Object.keys(FILES)) delete FILES[k];
  vi.unstubAllGlobals();
  localStorage.clear();
});

const SNAP_ID = 'drsnap.abc123.p1';
const file = (name: string) => ({ name, size: 1, mtime: 1, kind: 'code' as const, mime: 'application/json' });

const IMPROVED_XML =
  '<mxfile>' +
  '<diagram id="screen-flow" name="Nguyên bản"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="s1" value="Nhập OTP" vertex="1" parent="1"/></root></mxGraphModel></diagram>' +
  '<diagram id="screen-flow-proposed" name="Cải thiện"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<object id="od-n1" label="Báo lỗi timeout" od-change="added" od-finding="UX-01"><mxCell vertex="1" parent="1"/></object>' +
  '</root></mxGraphModel></diagram>' +
  '</mxfile>';
const REVIEW = {
  flowId: 'SCREEN-FLOW',
  verdict: 'needs-improvement',
  summary: 'Thiếu nhánh timeout.',
  findings: [{ id: 'UX-01', severity: 'major', title: 'Timeout mù', reason: 'Cần báo lỗi khi hết giờ.', cells: { asIs: ['s1'], proposed: ['od-n1'] }, change: 'added' }],
};

function seed(selection?: { variant: 'original' | 'improved' }) {
  FILES['docs-review/flows/SCREEN-FLOW/ux-review.json'] = JSON.stringify(REVIEW);
  FILES['docs-review/flows/SCREEN-FLOW/proposed.drawio'] = IMPROVED_XML;
  FILES['docs-review/flows/index.json'] = JSON.stringify([
    { id: 'SCREEN-FLOW', title: 'Luồng màn hình — OTP', kind: 'drawio', hasProposal: true, ...(selection ? { selection, variant: selection.variant } : {}) },
  ]);
}

describe('FlowUxReviewPreview — chỉ xem trong dự án ảo drsnap.*', () => {
  it('drsnap.* → không "Chỉnh sửa", không radiogroup "Dùng bản để chạy tiếp", có "Bản đang dùng: Cải thiện"; Tải/Toàn màn hình/finding giữ; không fetch ghi', async () => {
    seed({ variant: 'improved' });
    const fetchMock = vi.fn(async () => { throw new Error('không được gọi fetch trong chế độ chỉ xem'); });
    vi.stubGlobal('fetch', fetchMock);
    render(<FlowUxReviewPreview projectId={SNAP_ID} file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));

    expect(screen.queryByRole('button', { name: 'Chỉnh sửa' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Dùng bản để chạy tiếp' })).toBeNull();
    expect(screen.queryByText('Dùng bản để chạy tiếp')).toBeNull();
    expect(screen.queryByTestId('variant-select')).toBeNull();
    expect(screen.getByTestId('variant-select-readonly').textContent).toContain('Bản đang dùng: Cải thiện');
    expect(screen.queryByRole('radio')).toBeNull();

    // Phần đọc giữ nguyên.
    expect(screen.getByRole('link', { name: 'Tải .drawio' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Toàn màn hình' })).toBeTruthy();
    expect(screen.getByText('Timeout mù')).toBeTruthy();
    expect(screen.getByTestId('stage-comment-panel').getAttribute('data-stage-id')).toBe('dr-flow-improve');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drsnap.* không selection trong index → "Bản đang dùng: Nguyên bản"', async () => {
    seed();
    vi.stubGlobal('fetch', vi.fn());
    render(<FlowUxReviewPreview projectId={SNAP_ID} file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getByTestId('variant-select-readonly')).toBeTruthy());
    expect(screen.getByTestId('variant-select-readonly').textContent).toContain('Bản đang dùng: Nguyên bản');
  });

  it('đối chứng: projectId thường vẫn có "Chỉnh sửa" + radiogroup "Dùng bản để chạy tiếp"', async () => {
    seed({ variant: 'improved' });
    vi.stubGlobal('fetch', vi.fn());
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    expect(screen.getByRole('button', { name: 'Chỉnh sửa' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Dùng bản để chạy tiếp' })).toBeTruthy();
    expect(screen.queryByTestId('variant-select-readonly')).toBeNull();
  });
});
