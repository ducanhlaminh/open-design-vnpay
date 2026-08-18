// @vitest-environment jsdom
//
// Khung nhìn Đánh giá luồng UX (`flows/<FLOW-ID>/…`): route đúng file, panel
// phát hiện hiện đủ và sắp theo mức độ, bấm finding → cell được highlight trên
// sơ đồ (và ngược lại), chuyển "Hiện trạng" ↔ "Đề xuất" đổi trang draw.io.
// Viewer draw.io thật cần script ngoài nên được stub — điều cần kiểm là hợp
// đồng props (xml/page/highlightCells/onCellClick), không phải mxGraph.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const FILES: Record<string, string | null> = {};
let lastViewerProps: { xml: string; page?: number; highlightCells?: readonly string[]; onCellClick?: (id: string | null) => void } | null = null;

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => FILES[name] ?? null,
}));
vi.mock('../../src/components/DrawioViewer', () => ({
  DrawioViewer: (props: { xml: string; page?: number; highlightCells?: readonly string[]; onCellClick?: (id: string | null) => void }) => {
    lastViewerProps = props;
    return (
      <div data-testid="drawio-stub" data-page={props.page ?? 0} data-highlight={(props.highlightCells ?? []).join(',')}>
        <button type="button" data-testid="click-cell-timeout" onClick={() => props.onCellClick?.('timeout')}>
          cell
        </button>
      </div>
    );
  },
}));
vi.mock('../../src/components/MermaidDiagram', () => ({
  MermaidDiagram: ({ code, svg, initialFit }: { code: string; svg?: string; initialFit?: string }) => (
    <pre data-testid="mermaid-stub" data-fit={initialFit ?? ''}>
      {svg ?? code}
    </pre>
  ),
}));

const { FlowUxReviewPreview, isFlowUxFile, flowUxLocationOf, parseUxReview, drawioPageCount } = await import('../../src/components/FlowUxReviewPreview');

afterEach(() => {
  cleanup();
  for (const k of Object.keys(FILES)) delete FILES[k];
  lastViewerProps = null;
});

const file = (name: string) => ({ name, size: 1, mtime: 1, kind: 'code' as const, mime: 'application/json' });

describe('isFlowUxFile / flowUxLocationOf', () => {
  it('nhận mọi artefact dưới flows/<id>/, bỏ qua flowchart.json và index.json ở gốc', () => {
    for (const n of ['docs-review/flows/FLOW-a/ux-review.json', 'flows/FLOW-a/proposed.drawio', 'flows/FLOW-a/as-is.mmd', 'flows/FLOW-a/patch.json']) {
      expect(isFlowUxFile(file(n))).toBe(true);
    }
    // flowchart.json cũng vào khung này (có fallback về canvas cũ), index.json thì không.
    expect(isFlowUxFile(file('docs-review/flows/FLOW-a.flowchart.json'))).toBe(true);
    expect(isFlowUxFile(file('docs-review/flows/index.json'))).toBe(false);
    expect(flowUxLocationOf('docs-review/flows/FLOW-a/ux-review.json')).toEqual({ dir: 'docs-review/flows/FLOW-a/', flowsDir: 'docs-review/flows/', flowId: 'FLOW-a' });
    expect(flowUxLocationOf('docs-review/flows/FLOW-a.flowchart.json')).toEqual({ dir: 'docs-review/flows/FLOW-a/', flowsDir: 'docs-review/flows/', flowId: 'FLOW-a' });
  });
});

describe('parseUxReview', () => {
  it('khoan dung: finding thiếu title/reason bị bỏ, severity lạ → minor, verdict suy từ findings', () => {
    const r = parseUxReview(JSON.stringify({ findings: [{ title: 'A', reason: 'a', severity: 'blocker' }, { severity: 'x', reason: 'b' }, {}] }), 'FLOW-a');
    expect(r?.findings.map((f) => [f.id, f.severity])).toEqual([['UX-01', 'blocker'], ['UX-02', 'minor']]);
    expect(r?.verdict).toBe('poor');
    expect(parseUxReview('không phải json', 'x')).toBeNull();
    expect(drawioPageCount('<mxfile><diagram/><diagram/></mxfile>')).toBe(2);
  });
});

const REVIEW = {
  flowId: 'FLOW-a',
  verdict: 'needs-improvement',
  summary: 'Thiếu phản hồi khi timeout.',
  findings: [
    { id: 'UX-02', severity: 'minor', title: 'Nhãn chưa rõ', reason: 'r2', cells: { asIs: ['s1'] }, change: 'modified' },
    { id: 'UX-01', severity: 'major', heuristic: 'Nielsen#1', title: 'Timeout mù', reason: 'r1', recommendation: 'Thêm bước', evidence: ['doc.md#4.2c'], cells: { asIs: ['timeout'], proposed: ['timeout', 'od-n1'] }, change: 'added' },
  ],
};
const PROPOSED = '<mxfile><diagram id="p1" name="Hiện trạng"><mxGraphModel/></diagram><diagram id="p1-proposed" name="Đề xuất"><mxGraphModel/></diagram></mxfile>';

describe('FlowUxReviewPreview (draw.io)', () => {
  it('render sơ đồ đề xuất mặc định, panel sắp theo mức độ, bấm finding → highlight cell của trang đang xem; bấm cell → chọn finding', async () => {
    FILES['docs-review/flows/FLOW-a/ux-review.json'] = JSON.stringify(REVIEW);
    FILES['docs-review/flows/FLOW-a/proposed.drawio'] = PROPOSED;
    FILES['docs-review/flows/index.json'] = JSON.stringify([{ id: 'FLOW-a', title: 'Mua SIM', kind: 'drawio', source: 'docs-feature/x.md', hasProposal: true, patchSkipped: [{ op: { op: 'mark', cell: 'nope' }, reason: 'cell "nope" not found' }] }]);
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/FLOW-a/ux-review.json')} />);
    await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
    expect(screen.getByText('Mua SIM')).toBeTruthy();
    expect(screen.getByTestId('verdict').textContent).toBe('Cần cải thiện');
    expect(screen.getByText('Thiếu phản hồi khi timeout.')).toBeTruthy();
    // Mặc định mở "Đề xuất" (trang 1) khi có bản đề xuất.
    expect(screen.getByTestId('drawio-stub').getAttribute('data-page')).toBe('1');
    // Sắp theo mức độ: major (UX-01) trước minor (UX-02).
    const cards = screen.getAllByRole('button', { pressed: false }).filter((b) => b.getAttribute('data-testid')?.startsWith('finding-'));
    expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual(['finding-UX-01', 'finding-UX-02']);
    // Cảnh báo op bị bỏ qua.
    expect(screen.getByText(/1 thao tác đề xuất không áp được/)).toBeTruthy();
    // Bấm UX-01 → highlight cell của trang Đề xuất.
    fireEvent.click(screen.getByTestId('finding-UX-01'));
    await waitFor(() => expect(screen.getByTestId('drawio-stub').getAttribute('data-highlight')).toBe('timeout,od-n1'));
    // Chuyển sang Hiện trạng → trang 0, highlight chỉ cell as-is.
    fireEvent.click(screen.getByRole('tab', { name: 'Hiện trạng' }));
    await waitFor(() => expect(screen.getByTestId('drawio-stub').getAttribute('data-page')).toBe('0'));
    expect(screen.getByTestId('drawio-stub').getAttribute('data-highlight')).toBe('timeout');
    // Bấm cell trên sơ đồ → finding tương ứng được chọn (UX-01 đang chọn; chọn UX-02 qua cell s1 không có nút stub, thử bỏ chọn rồi bấm cell timeout).
    fireEvent.click(screen.getByTestId('finding-UX-01')); // bỏ chọn
    await waitFor(() => expect(screen.getByTestId('drawio-stub').getAttribute('data-highlight')).toBe(''));
    fireEvent.click(screen.getByTestId('click-cell-timeout'));
    await waitFor(() => expect(screen.getByTestId('finding-UX-01').getAttribute('aria-pressed')).toBe('true'));
    expect(lastViewerProps?.xml).toBe(PROPOSED);
  });

  it('không có bản đề xuất → chỉ tab Hiện trạng, không legend; luồng tốt → hộp xanh', async () => {
    FILES['flows/FLOW-b/ux-review.json'] = JSON.stringify({ verdict: 'good', summary: 'ok', findings: [] });
    FILES['flows/FLOW-b/as-is.drawio'] = '<mxfile><diagram id="p" name="x"><mxGraphModel/></diagram></mxfile>';
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-b/as-is.drawio')} />);
    await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
    expect(screen.queryByRole('tab', { name: 'Đề xuất' })).toBeNull();
    expect(screen.queryByText('Thêm mới')).toBeNull();
    expect(screen.getByText(/Không có phát hiện nào/)).toBeTruthy();
    expect(screen.getByTestId('verdict').textContent).toBe('Luồng tốt');
  });
});

describe('FlowUxReviewPreview (Mermaid)', () => {
  it('render proposed.mmd mặc định, chuyển Hiện trạng / Ảnh gốc', async () => {
    FILES['flows/FLOW-m/ux-review.json'] = JSON.stringify({ verdict: 'needs-improvement', summary: 's', findings: [{ id: 'UX-01', severity: 'major', title: 't', reason: 'r' }] });
    FILES['flows/FLOW-m/as-is.mmd'] = 'flowchart TD\n A-->B';
    FILES['flows/FLOW-m/proposed.mmd'] = 'flowchart TD\n A-->B\n B-->OD_1\n class OD_1 od-added';
    FILES['flows/FLOW-m/as-is.svg'] = '<svg xmlns="http://www.w3.org/2000/svg"><text>goc</text></svg>';
    FILES['flows/index.json'] = JSON.stringify([{ id: 'FLOW-m', title: 'Luồng người dùng', kind: 'mermaid' }]);
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-m/as-is.mmd')} />);
    await waitFor(() => expect(screen.getByTestId('mermaid-stub')).toBeTruthy());
    expect(screen.getByTestId('mermaid-stub').textContent).toContain('OD_1');
    fireEvent.click(screen.getByRole('tab', { name: 'Hiện trạng' }));
    await waitFor(() => expect(screen.getByTestId('mermaid-stub').textContent).not.toContain('OD_1'));
    fireEvent.click(screen.getByRole('tab', { name: 'Ảnh gốc' }));
    await waitFor(() => expect(screen.getByTestId('mermaid-stub').textContent).toContain('goc'));
    // Sơ đồ nguồn vừa chiều rộng, đọc từ trên xuống — không co thành ảnh tí hon.
    expect(screen.getByTestId('mermaid-stub').getAttribute('data-fit')).toBe('width');
  });

  it('flowchart.json của lần chạy cũ (không có thư mục flows/<id>/) → render fallback; luồng dựng từ chữ → fallback nằm trong khung sơ đồ cạnh panel', async () => {
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-old.flowchart.json')} fallback={<div data-testid="legacy">canvas cũ</div>} />);
    await waitFor(() => expect(screen.getByTestId('legacy')).toBeTruthy());
    cleanup();
    FILES['flows/FLOW-t/ux-review.json'] = JSON.stringify({ verdict: 'good', summary: 'ok', findings: [] });
    FILES['flows/index.json'] = JSON.stringify([{ id: 'FLOW-t', title: 'Từ chữ', kind: 'text' }]);
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-t.flowchart.json')} fallback={<div data-testid="legacy">canvas cũ</div>} />);
    await waitFor(() => expect(screen.getByTestId('legacy')).toBeTruthy());
    expect(screen.getByTestId('verdict').textContent).toBe('Luồng tốt');
  });

  it('không có gì để hiện → thông báo chạy bước', async () => {
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-z/ux-review.json')} />);
    await waitFor(() => expect(screen.getByText(/Chưa có dữ liệu đánh giá/)).toBeTruthy());
  });
});
