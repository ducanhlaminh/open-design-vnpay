// @vitest-environment jsdom
//
// Khung nhìn Đánh giá luồng UX (`flows/<FLOW-ID>/…`): route đúng file, panel
// phát hiện hiện đủ và sắp theo mức độ, bấm finding → cell được highlight trên
// sơ đồ (và ngược lại), chuyển "Hiện trạng" ↔ "Đề xuất" đổi trang draw.io.
// Viewer draw.io thật cần script ngoài nên được stub — điều cần kiểm là hợp
// đồng props (xml/page/highlightCells/onCellClick), không phải mxGraph.
//
// wp17a.yaml: mặc định giờ là bố cục "Cạnh nhau" (2 khung Hiện trạng/Đề xuất
// cùng lúc) khi có bản đề xuất — stub DrawioViewer trước đây chỉ giữ MỘT
// `lastViewerProps` (một instance), sai với 2 khung cùng render; đổi sang một
// mảng gom props MỌI instance (`viewerCalls`), tra theo `page` để phân biệt
// khung trái/phải.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import styles from '../../src/components/FlowUxReviewPreview.module.css';

const FILES: Record<string, string | null> = {};
type StubViewerProps = { xml: string; page?: number; highlightCells?: readonly string[]; onCellClick?: (id: string | null) => void };
// Mảng gom props của MỌI instance DrawioViewer đã render (kể cả re-render) —
// chế độ "Cạnh nhau" dựng 2 <DrawioViewer> cùng lúc (page 0 và 1) nên một biến
// "lastViewerProps" duy nhất không phân biệt được khung nào là khung nào; tra
// theo `page` (đếm ngược để lấy bản mới nhất) mới đúng cho cả 2 khung.
let viewerCalls: StubViewerProps[] = [];
function lastPropsForPage(page: number): StubViewerProps | undefined {
  for (let i = viewerCalls.length - 1; i >= 0; i--) {
    if ((viewerCalls[i]!.page ?? 0) === page) return viewerCalls[i];
  }
  return undefined;
}

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => FILES[name] ?? null,
}));
vi.mock('../../src/components/DrawioViewer', () => ({
  DrawioViewer: (props: StubViewerProps) => {
    viewerCalls.push(props);
    const page = props.page ?? 0;
    return (
      <div data-testid="drawio-stub" data-page={page} data-highlight={(props.highlightCells ?? []).join(',')}>
        <button type="button" data-testid={`click-cell-timeout-p${page}`} onClick={() => props.onCellClick?.('timeout')}>
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
  viewerCalls = [];
  localStorage.clear();
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

function renderSideDefault() {
  FILES['docs-review/flows/FLOW-a/ux-review.json'] = JSON.stringify(REVIEW);
  FILES['docs-review/flows/FLOW-a/proposed.drawio'] = PROPOSED;
  FILES['docs-review/flows/index.json'] = JSON.stringify([{ id: 'FLOW-a', title: 'Mua SIM', kind: 'drawio', source: 'docs-feature/x.md', hasProposal: true, patchSkipped: [{ op: { op: 'mark', cell: 'nope' }, reason: 'cell "nope" not found' }] }]);
  return render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/FLOW-a/ux-review.json')} />);
}

describe('FlowUxReviewPreview (draw.io, bố cục Cạnh nhau — wp17a mặc định khi có đề xuất)', () => {
  it('có đề xuất → mặc định 2 khung page 0 (Hiện trạng) và 1 (Đề xuất) cạnh nhau, có header rõ ràng', async () => {
    renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    const pages = screen.getAllByTestId('drawio-stub').map((el) => el.getAttribute('data-page')).sort();
    expect(pages).toEqual(['0', '1']);
    expect(screen.getByRole('heading', { level: 3, name: 'Hiện trạng' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Đề xuất' })).toBeTruthy();
    // Không còn tab Hiện trạng/Đề xuất (đó là hành vi của chế độ Từng bản).
    expect(screen.queryByRole('tab', { name: 'Hiện trạng' })).toBeNull();
    // Legend đề xuất nằm ở khung phải khi ở bố cục cạnh nhau (không lẫn với
    // chip "Thêm mới" trên card finding UX-01 ở panel bên phải trang).
    expect(within(screen.getByTestId('side-pane-right')).getByText('Thêm mới')).toBeTruthy();
  });

  it('bấm finding → khung trái nhận highlight cells.asIs, khung phải nhận cells.proposed (không fallback chéo)', async () => {
    renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    fireEvent.click(screen.getByTestId('finding-UX-01'));
    await waitFor(() => expect(lastPropsForPage(0)?.highlightCells?.join(',')).toBe('timeout'));
    expect(lastPropsForPage(1)?.highlightCells?.join(',')).toBe('timeout,od-n1');
    // UX-02 chỉ có cells.asIs — khung phải phải rỗng, không fallback sang asIs.
    fireEvent.click(screen.getByTestId('finding-UX-02'));
    await waitFor(() => expect(lastPropsForPage(0)?.highlightCells?.join(',')).toBe('s1'));
    expect(lastPropsForPage(1)?.highlightCells ?? []).toEqual([]);
  });

  it('bấm cell ở khung phải → finding tương ứng active', async () => {
    renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    expect(screen.getByTestId('finding-UX-01').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('click-cell-timeout-p1'));
    await waitFor(() => expect(screen.getByTestId('finding-UX-01').getAttribute('aria-pressed')).toBe('true'));
  });

  it('toggle "Từng bản" → về 1 khung có tab như cũ, sắp panel theo mức độ, bấm finding/cell đồng bộ đúng trang', async () => {
    renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Từng bản' }));
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(1));
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
    fireEvent.click(screen.getByTestId('click-cell-timeout-p0'));
    await waitFor(() => expect(screen.getByTestId('finding-UX-01').getAttribute('aria-pressed')).toBe('true'));
    expect(lastPropsForPage(0)?.xml).toBe(PROPOSED);
  });

  it('không có bản đề xuất → không có toggle bố cục, chỉ tab Hiện trạng, không legend; luồng tốt → hộp xanh', async () => {
    FILES['flows/FLOW-b/ux-review.json'] = JSON.stringify({ verdict: 'good', summary: 'ok', findings: [] });
    FILES['flows/FLOW-b/as-is.drawio'] = '<mxfile><diagram id="p" name="x"><mxGraphModel/></diagram></mxfile>';
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-b/as-is.drawio')} />);
    await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
    expect(screen.queryByRole('tab', { name: 'Đề xuất' })).toBeNull();
    expect(screen.queryByText('Thêm mới')).toBeNull();
    // wp17a: không có đề xuất thì không có nút chuyển bố cục Cạnh nhau/Từng bản.
    expect(screen.queryByRole('button', { name: 'Cạnh nhau' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Từng bản' })).toBeNull();
    expect(screen.getAllByTestId('drawio-stub').length).toBe(1);
    expect(screen.getByText(/Không có phát hiện nào/)).toBeTruthy();
    expect(screen.getByTestId('verdict').textContent).toBe('Luồng tốt');
  });
});

describe('FlowUxReviewPreview — panel "Phát hiện UX" ẩn/hiện (wp17a mục 3)', () => {
  it('nút ẩn panel → panel biến mất, tab dọc bám mép phải hiện tổng số finding, bấm tab → panel lại hiện', async () => {
    renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    expect(screen.getByText('Phát hiện UX')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Ẩn chú giải'));
    await waitFor(() => expect(screen.queryByText('Phát hiện UX')).toBeNull());
    const tab = screen.getByLabelText('Hiện chú giải');
    expect(tab.textContent).toBe('2'); // REVIEW có 2 finding.
    fireEvent.click(tab);
    await waitFor(() => expect(screen.getByText('Phát hiện UX')).toBeTruthy());
  });
});

describe('FlowUxReviewPreview — toàn màn hình qua portal, viewer trễ 1 frame, khoá cuộn body (wp18.yaml, fix bug 0.8.78)', () => {
  // Bug 0.8.78: class `fullscreen` (position:fixed) gắn TẠI CHỖ lên root —
  // tổ tiên có transform/backdrop-filter (pipelines.css) trở thành containing
  // block của position:fixed ⇒ overlay lệch/tràn thay vì phủ kín viewport.
  // Test này ĐỎ trước khi sửa (root vẫn còn nhận class overlay + không có gì
  // gắn thẳng vào document.body) — sau khi sửa (createPortal lên
  // document.body, viewer mount trễ 1 frame qua fsReady, khoá cuộn body) mới
  // xanh. Bằng chứng red→green: xem report.
  it('overlay là con trực tiếp của document.body (KHÔNG còn ở root tại chỗ); viewer mount sau rAF; Esc thoát khôi phục cuộn', async () => {
    const { container } = renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains(styles.fullscreen ?? '__never__')).toBe(false);
    expect(document.body.style.overflow).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Toàn màn hình' }));

    // Root tại chỗ KHÔNG còn nhận class overlay — nó chỉ còn placeholder gọn
    // để layout khung bao quanh (workspace/modal) không sập.
    expect(root.classList.contains(styles.fullscreen ?? '__never__')).toBe(false);
    expect(root.textContent).toContain('Đang xem toàn màn hình');

    // Overlay thật là phần tử RIÊNG, con TRỰC TIẾP của document.body (portal)
    // — không lồng trong root/container của lần render này.
    const overlay = document.body.querySelector('[data-testid="fs-overlay"]') as HTMLElement | null;
    expect(overlay).toBeTruthy();
    expect(overlay!.parentElement).toBe(document.body);
    expect(overlay!.classList.contains(styles.fullscreen ?? '__never__')).toBe(true);
    expect(container.contains(overlay)).toBe(false);

    // Cuộn trang phía sau bị khoá trong lúc overlay mở.
    expect(document.body.style.overflow).toBe('hidden');

    // Ngay sau khi bật, GraphViewer CHƯA mount (đang chờ rAF layout ổn định)
    // — overlay chỉ có placeholder "Đang tải…", tránh đo kích thước sớm gây
    // auto-fit sai (bug 0.8.78: sơ đồ bé tí + khoảng trắng khổng lồ).
    expect(within(overlay!).queryAllByTestId('drawio-stub').length).toBe(0);
    expect(within(overlay!).getAllByText('Đang tải…').length).toBeGreaterThan(0);

    // Sau khi rAF flush (jsdom thật — không mock, xem ghi chú đầu file test),
    // viewer xuất hiện trong overlay, đủ 2 khung page 0/1 như bố cục cạnh nhau.
    await waitFor(() => expect(within(overlay!).getAllByTestId('drawio-stub').length).toBe(2));
    const pages = within(overlay!)
      .getAllByTestId('drawio-stub')
      .map((el) => el.getAttribute('data-page'))
      .sort();
    expect(pages).toEqual(['0', '1']);
    // Không render trùng 2 bộ viewer: root tại chỗ (placeholder) không có viewer nào.
    expect(within(root).queryAllByTestId('drawio-stub').length).toBe(0);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.body.querySelector('[data-testid="fs-overlay"]')).toBeNull());
    // Viewer quay lại render tại chỗ (root), không còn trong overlay.
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    expect(document.body.style.overflow).toBe('');
  });
});

describe('FlowUxReviewPreview (Mermaid)', () => {
  it('render proposed.mmd mặc định (bố cục cạnh nhau), toggle Từng bản → chuyển Hiện trạng / Ảnh gốc', async () => {
    FILES['flows/FLOW-m/ux-review.json'] = JSON.stringify({ verdict: 'needs-improvement', summary: 's', findings: [{ id: 'UX-01', severity: 'major', title: 't', reason: 'r' }] });
    FILES['flows/FLOW-m/as-is.mmd'] = 'flowchart TD\n A-->B';
    FILES['flows/FLOW-m/proposed.mmd'] = 'flowchart TD\n A-->B\n B-->OD_1\n class OD_1 od-added';
    FILES['flows/FLOW-m/as-is.svg'] = '<svg xmlns="http://www.w3.org/2000/svg"><text>goc</text></svg>';
    FILES['flows/index.json'] = JSON.stringify([{ id: 'FLOW-m', title: 'Luồng người dùng', kind: 'mermaid' }]);
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-m/as-is.mmd')} />);
    await waitFor(() => expect(screen.getAllByTestId('mermaid-stub').length).toBe(2));
    // Mặc định cạnh nhau: khung trái as-is, khung phải proposed (chứa OD_1).
    const stubs = screen.getAllByTestId('mermaid-stub');
    expect(stubs.some((s) => s.textContent?.includes('OD_1'))).toBe(true);
    expect(stubs.some((s) => !s.textContent?.includes('OD_1'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Từng bản' }));
    await waitFor(() => expect(screen.getAllByTestId('mermaid-stub').length).toBe(1));
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
