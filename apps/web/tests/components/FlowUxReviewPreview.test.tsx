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
type HighlightSpec = string | { id: string; kind?: 'added' | 'modified' | 'removed' };
type StubViewerProps = { xml: string; page?: number; highlightCells?: readonly HighlightSpec[]; dimCellsExcept?: readonly string[]; onCellClick?: (id: string | null) => void };
// Bản ghi trong viewerCalls: `highlightCells` đã QUY VỀ id trần (test cũ so
// `.join(',')`), `highlightSpecs` giữ nguyên prop (WP dr-flow-edit-highlight:
// khung Cải thiện mặc định nhận `{ id, kind }`).
type StubViewerCall = Omit<StubViewerProps, 'highlightCells'> & { highlightCells?: string[]; highlightSpecs?: readonly HighlightSpec[] };
// Mảng gom props của MỌI instance DrawioViewer đã render (kể cả re-render) —
// chế độ "Cạnh nhau" dựng 2 <DrawioViewer> cùng lúc (page 0 và 1) nên một biến
// "lastViewerProps" duy nhất không phân biệt được khung nào là khung nào; tra
// theo `page` (đếm ngược để lấy bản mới nhất) mới đúng cho cả 2 khung.
let viewerCalls: StubViewerCall[] = [];
function lastPropsForPage(page: number): StubViewerCall | undefined {
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
    const ids = (props.highlightCells ?? []).map((h) => (typeof h === 'string' ? h : h.id));
    viewerCalls.push({ ...props, highlightCells: ids, highlightSpecs: props.highlightCells });
    const page = props.page ?? 0;
    return (
      <div data-testid="drawio-stub" data-page={page} data-highlight={ids.join(',')} data-dim={props.dimCellsExcept ? props.dimCellsExcept.join(',') : 'off'}>
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

const { FlowUxReviewPreview, isFlowUxFile, flowUxLocationOf, parseUxReview, drawioPageCount, drawioPageNames, evidenceLabel } = await import('../../src/components/FlowUxReviewPreview');

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
    // drawioPageNames: theo thứ tự trang, trang không name → '' (caller fallback).
    expect(drawioPageNames('<mxfile><diagram id="a" name="Hiện trạng"><mxGraphModel/></diagram><diagram name="Đề xuất" id="b"/><diagram id="c"/></mxfile>')).toEqual(['Hiện trạng', 'Đề xuất', '']);
    expect(drawioPageNames('không có diagram')).toEqual([]);
  });
});

const REVIEW = {
  flowId: 'FLOW-a',
  verdict: 'needs-improvement',
  summary: 'Thiếu phản hồi khi timeout.',
  findings: [
    { id: 'UX-02', severity: 'minor', title: 'Nhãn chưa rõ', reason: 'r2', cells: { asIs: ['s1'] }, change: 'modified' },
    { id: 'UX-01', severity: 'major', heuristic: 'Nielsen#1', title: 'Timeout mù', reason: 'r1', recommendation: 'Thêm bước', evidence: ['docs-feature/timeout-flow.md#4.2 Xử lý timeout'], cells: { asIs: ['timeout'], proposed: ['timeout', 'od-n1'] }, change: 'added' },
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
    expect(screen.getByRole('heading', { level: 3, name: 'Nguyên bản' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Cải thiện' })).toBeTruthy();
    // Không còn tab Hiện trạng/Đề xuất (đó là hành vi của chế độ Từng bản).
    expect(screen.queryByRole('tab', { name: 'Nguyên bản' })).toBeNull();
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
    fireEvent.click(screen.getByRole('tab', { name: 'Nguyên bản' }));
    await waitFor(() => expect(screen.getByTestId('drawio-stub').getAttribute('data-page')).toBe('0'));
    expect(screen.getByTestId('drawio-stub').getAttribute('data-highlight')).toBe('timeout');
    // Bấm cell trên sơ đồ → finding tương ứng được chọn (UX-01 đang chọn; chọn UX-02 qua cell s1 không có nút stub, thử bỏ chọn rồi bấm cell timeout).
    // Bỏ chọn → về mặc định B3 (WP dr-flow-result-split): trang Nguyên bản
    // viền HỢP findings[].cells.asIs (s1 của UX-02 + timeout của UX-01) thay
    // vì rỗng như trước.
    fireEvent.click(screen.getByTestId('finding-UX-01')); // bỏ chọn
    await waitFor(() => expect(screen.getByTestId('drawio-stub').getAttribute('data-highlight')).toBe('s1,timeout'));
    fireEvent.click(screen.getByTestId('click-cell-timeout-p0'));
    await waitFor(() => expect(screen.getByTestId('finding-UX-01').getAttribute('aria-pressed')).toBe('true'));
    expect(lastPropsForPage(0)?.xml).toBe(PROPOSED);
  });

  it('không có bản đề xuất → không có toggle bố cục, chỉ tab Hiện trạng, không legend; luồng tốt → hộp xanh', async () => {
    FILES['flows/FLOW-b/ux-review.json'] = JSON.stringify({ verdict: 'good', summary: 'ok', findings: [] });
    FILES['flows/FLOW-b/as-is.drawio'] = '<mxfile><diagram id="p" name="x"><mxGraphModel/></diagram></mxfile>';
    // Mở từ ux-review.json (chế độ đối chiếu) — as-is.drawio nay là chế độ
    // "chỉ nguyên bản" không có panel (WP dr-flow-result-split B2).
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-b/ux-review.json')} />);
    await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
    expect(screen.queryByRole('tab', { name: 'Cải thiện' })).toBeNull();
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
    fireEvent.click(screen.getByRole('tab', { name: 'Nguyên bản' }));
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

// wp-flowux-panel-compact.yaml: card "Phát hiện UX" trước đây dump toàn bộ
// reason + recommendation + evidence (path docs-feature/... rất dài) ngay
// trên mặt thẻ, chiếm cả màn hình. Đưa về khuôn 3 dòng như DocRedlinePreview
// — mặt thẻ chỉ còn đầu thẻ + tiêu đề + 1 dòng tóm tắt, phần đầy đủ nằm sau
// "Chi tiết ▾". Các case dưới ĐỎ trước khi sửa component (card cũ là
// <button> render reason/heuristic/evidence/cells thẳng trên mặt thẻ, không
// có nút "Chi tiết").
describe('FlowUxReviewPreview — panel "Phát hiện UX" gọn 3 dòng + "Chi tiết ▾" (wp-flowux-panel-compact)', () => {
  it('(a) mặt thẻ không chứa reason đầy đủ / evidence / heuristic / cells khi chưa mở Chi tiết', async () => {
    renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    const card = screen.getByTestId('finding-UX-01');
    // Dòng tóm tắt ưu tiên recommendation khi có.
    expect(within(card).getByText('Thêm bước')).toBeTruthy();
    expect(within(card).queryByText('r1')).toBeNull();
    expect(within(card).queryByText('Nielsen#1')).toBeNull();
    expect(within(card).queryByText('timeout-flow #4.2 Xử lý timeout')).toBeNull();
    expect(within(card).queryByText('timeout')).toBeNull();
    expect(within(card).queryByText('od-n1')).toBeNull();

    const card2 = screen.getByTestId('finding-UX-02');
    // UX-02 không có recommendation → tóm tắt rơi về reason.
    expect(within(card2).getByText('r2')).toBeTruthy();
  });

  it('(b) bấm "Chi tiết ▾" → hiện reason đầy đủ + evidence (rút gọn label, title = gốc) + cells; bấm lại ẩn', async () => {
    renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    const card = screen.getByTestId('finding-UX-01');
    const toggle = within(card).getByText('Chi tiết ▾');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const toggleOpen = within(card).getByText('Chi tiết ▴');
    expect(toggleOpen.getAttribute('aria-expanded')).toBe('true');
    expect(within(card).getByText('Nielsen#1')).toBeTruthy();
    expect(within(card).getByText('r1')).toBeTruthy();
    const evLabel = within(card).getByText('timeout-flow #4.2 Xử lý timeout');
    expect(evLabel.closest('li')?.getAttribute('title')).toBe('docs-feature/timeout-flow.md#4.2 Xử lý timeout');
    expect(within(card).getByText('timeout')).toBeTruthy();
    expect(within(card).getByText('od-n1')).toBeTruthy();
    fireEvent.click(within(card).getByText('Chi tiết ▴'));
    expect(within(card).queryByText('r1')).toBeNull();
    expect(within(card).queryByText('timeout-flow #4.2 Xử lý timeout')).toBeNull();
  });

  it('(c) bấm "Chi tiết" không đổi trạng thái chọn của thẻ (aria-pressed giữ nguyên)', async () => {
    renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    const card = screen.getByTestId('finding-UX-01');
    expect(card.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(card).getByText('Chi tiết ▾'));
    expect(card.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(card).getByText('Chi tiết ▴'));
    expect(card.getAttribute('aria-pressed')).toBe('true');
  });

  it('(e) hành vi cũ giữ: bấm thẻ chọn/bỏ chọn, Enter kích hoạt được', async () => {
    renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    const card = screen.getByTestId('finding-UX-01');
    expect(card.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(card.getAttribute('aria-pressed')).toBe('true');
  });

  it('dòng tóm tắt cắt còn ≤ 90 ký tự tại ranh giới từ + "…", title = chuỗi gốc', async () => {
    const longReason = `${'A'.repeat(40)} ${'B'.repeat(40)} ${'C'.repeat(40)}`;
    FILES['flows/FLOW-c/ux-review.json'] = JSON.stringify({ verdict: 'needs-improvement', summary: 's', findings: [{ id: 'UX-01', severity: 'major', title: 't', reason: longReason }] });
    FILES['flows/FLOW-c/as-is.drawio'] = '<mxfile><diagram id="p" name="x"><mxGraphModel/></diagram></mxfile>';
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-c/ux-review.json')} />);
    await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
    const card = screen.getByTestId('finding-UX-01');
    const summary = card.querySelector(`.${styles.summaryLine}`) as HTMLElement | null;
    expect(summary).toBeTruthy();
    expect(summary!.textContent!.length).toBeLessThanOrEqual(91);
    expect(summary!.textContent!.endsWith('…')).toBe(true);
    expect(summary!.getAttribute('title')).toBe(longReason);
  });
});

describe('evidenceLabel (wp-flowux-panel-compact.yaml mục 4)', () => {
  it('rút gọn 3 dạng evidence', () => {
    expect(evidenceLabel('docs-feature/timeout-flow.md#4.2 Xử lý timeout')).toBe('timeout-flow #4.2 Xử lý timeout');
    expect(evidenceLabel('docs-feature/nested/dir/spec.md')).toBe('spec');
    expect(evidenceLabel('cell G_Int')).toBe('cell G_Int');
  });
});

describe('FlowUxReviewPreview — SCREEN-FLOW (dr-flow mới): xem tĩnh mặc định, "Chỉnh sửa" bật editor draw.io nhúng tự lưu, "Xong" về tĩnh', () => {
  it('mặc định viewer tĩnh + nút Chỉnh sửa; bấm → iframe embed thay viewer; init → load xml; autosave → POST sau debounce; Xong → viewer hiện bản đã sửa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const XML = '<mxfile><diagram id="screen-flow" name="Luồng"><mxGraphModel/></diagram></mxfile>';
    FILES['docs-review/flows/SCREEN-FLOW/ux-review.json'] = JSON.stringify({ verdict: 'good', summary: 'sinh từ tài liệu', findings: [] });
    FILES['docs-review/flows/SCREEN-FLOW/as-is.drawio'] = XML;
    FILES['docs-review/flows/index.json'] = JSON.stringify([{ id: 'SCREEN-FLOW', title: 'Luồng màn hình — Mua SIM', kind: 'drawio', source: 'docs-feature/x.md' }]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, warnings: ['node đè nhau: a ↔ b'], screens: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
      // Mặc định: viewer tĩnh (không iframe, không cần mạng embed) + nút Chỉnh sửa.
      await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
      expect(screen.queryByTestId('drawio-editor')).toBeNull();
      const editBtn = screen.getByRole('button', { name: 'Chỉnh sửa' });
      expect(editBtn.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(editBtn);
      const host = await waitFor(() => screen.getByTestId('drawio-editor'));
      const iframe = host.querySelector('iframe') as HTMLIFrameElement;
      expect(iframe.src).toMatch(/^https:\/\/embed\.diagrams\.net\/\?embed=1&proto=json/);
      expect(screen.queryByTestId('drawio-stub')).toBeNull();
      expect(screen.getByRole('button', { name: 'Xong' }).getAttribute('aria-pressed')).toBe('true');

      // Giả lập editor: init → ta gửi load với đúng xml đã nạp.
      const posted: string[] = [];
      const win = iframe.contentWindow as Window;
      win.postMessage = ((data: string) => {
        posted.push(data);
      }) as typeof win.postMessage;
      fireEvent(window, new MessageEvent('message', { data: JSON.stringify({ event: 'init' }), source: win }));
      expect(JSON.parse(posted[0]!)).toEqual({ action: 'load', xml: XML, autosave: 1 });

      // autosave → chưa gọi daemon ngay; sau debounce → POST đúng route + body.
      const EDITED = XML.replace('name="Luồng"', 'name="Luồng đã sửa"');
      fireEvent(window, new MessageEvent('message', { data: JSON.stringify({ event: 'autosave', xml: EDITED }), source: win }));
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1600);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/projects/p/docs-review/screen-flow');
      expect(JSON.parse(String(init.body))).toEqual({ xml: EDITED });
      // Chip có tiền tố trang (tên `<diagram name>` của bản ĐÃ lưu — EDITED đổi
      // tên trang) — WP dr-flow-edit-highlight.
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Đang sửa: Luồng đã sửa · Đã lưu ✓'));
      // Sơ đồ 1 trang → editor mở trang 0, không dòng nhắc Cải thiện.
      expect(iframe.src).toContain('&page=0');
      expect(screen.queryByTestId('edit-hint')).toBeNull();
      // Cảnh báo daemon trả về hiện ra; link Tải .drawio trỏ bản đã sửa (không nạp lại file).
      expect(screen.getByText(/node đè nhau/)).toBeTruthy();
      const link = screen.getByText('Tải .drawio') as HTMLAnchorElement;
      expect(decodeURIComponent(link.getAttribute('href')!.split(',')[1]!)).toBe(EDITED);
      expect(host.querySelector('iframe')).toBe(iframe); // iframe không bị remount sau lưu

      // Xong → về viewer tĩnh, viewer nhận đúng bản vừa sửa (không nạp lại file).
      fireEvent.click(screen.getByRole('button', { name: 'Xong' }));
      await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
      expect(screen.queryByTestId('drawio-editor')).toBeNull();
      expect(lastPropsForPage(0)?.xml).toBe(EDITED);
      expect(screen.getByRole('button', { name: 'Chỉnh sửa' })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('flow thường (không phải SCREEN-FLOW) không có nút Chỉnh sửa, không có editor', async () => {
    FILES['flows/FLOW-b/ux-review.json'] = JSON.stringify({ verdict: 'good', summary: 'ok', findings: [] });
    FILES['flows/FLOW-b/as-is.drawio'] = '<mxfile><diagram id="p" name="x"><mxGraphModel/></diagram></mxfile>';
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-b/as-is.drawio')} />);
    await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
    expect(screen.queryByTestId('drawio-editor')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Chỉnh sửa' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Danh sách màn' })).toBeNull();
  });
});

// WP dr-screens-merge (2026-08-27): dr-flow SCREEN-FLOW sinh luôn danh sách
// màn (`<gốc workflow>/screens-discovered.json`, contract dr-screens cũ). Tab
// "Danh sách màn" tải lười file đó và render ScreensDiscoveredPreview thay
// khung sơ đồ; toolbar phải (Chỉnh sửa/Tải/Toàn màn hình) ẩn khi ở tab này.
describe('FlowUxReviewPreview — SCREEN-FLOW tab "Danh sách màn" (WP dr-screens-merge)', () => {
  const XML = '<mxfile><diagram id="screen-flow" name="Luồng"><mxGraphModel/></diagram></mxfile>';
  function seedScreenFlow() {
    FILES['docs-review/flows/SCREEN-FLOW/ux-review.json'] = JSON.stringify({ verdict: 'good', summary: 'sinh từ tài liệu', findings: [] });
    FILES['docs-review/flows/SCREEN-FLOW/as-is.drawio'] = XML;
    FILES['docs-review/flows/index.json'] = JSON.stringify([{ id: 'SCREEN-FLOW', title: 'Luồng màn hình — Mua SIM', kind: 'drawio', source: 'docs-feature/x.md' }]);
  }

  it('có screens-discovered.json ở gốc workflow → bấm tab thấy tên màn, toolbar phải ẩn; về Hiện trạng → viewer + toolbar lại hiện', async () => {
    seedScreenFlow();
    let fetchedScreens = 0;
    const DOC = {
      schema_version: 1,
      generatedAt: '2026-08-27T00:00:00.000Z',
      pages: [
        {
          source: 'docs-feature/x.md',
          screens: [
            { code: '6.4.1', name: 'Nhập thông tin', anchorText: '#### 6.4.1 Nhập thông tin', blocks: [{ name: 'Mã voucher', anchorText: '#### 6.4.4. Mã voucher' }] },
            { code: '6.3.2', name: 'Chi tiết gói cước Việt Nam', anchorText: '#### 6.3.2. Chi tiết gói cước' },
          ],
        },
      ],
      excluded: [{ name: '6. Khung giao diện sơ bộ', reason: 'Heading nhóm chứa các màn con.' }],
    };
    // Đếm số lần tải qua Proxy (FILES là mock của fetchProjectFileText) để chắc
    // file chỉ tải khi bấm tab, không tải trước.
    const target = FILES;
    Object.defineProperty(target, 'docs-review/screens-discovered.json', {
      configurable: true,
      enumerable: true,
      get() {
        fetchedScreens += 1;
        return JSON.stringify(DOC);
      },
    });
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
    expect(fetchedScreens).toBe(0); // lười: chưa bấm chưa tải
    const tab = screen.getByRole('tab', { name: 'Danh sách màn' });
    expect(tab.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: 'Nguyên bản' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(tab);
    await waitFor(() => expect(screen.getByTestId('screens-discovered-preview')).toBeTruthy());
    expect(fetchedScreens).toBe(1);
    expect(screen.getByText('Nhập thông tin')).toBeTruthy();
    expect(screen.getByText('Chi tiết gói cước Việt Nam')).toBeTruthy();
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Nguyên bản' }).getAttribute('aria-selected')).toBe('false');
    // Khung sơ đồ + toolbar phải nhường chỗ.
    expect(screen.queryByTestId('drawio-stub')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Chỉnh sửa' })).toBeNull();
    expect(screen.queryByText('Tải .drawio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Toàn màn hình' })).toBeNull();

    // Về Hiện trạng: viewer + toolbar lại hiện; bấm lại tab không tải lại (cache theo file/mtime).
    fireEvent.click(screen.getByRole('tab', { name: 'Nguyên bản' }));
    await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
    expect(screen.queryByTestId('screens-discovered-preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Chỉnh sửa' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Toàn màn hình' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Danh sách màn' }));
    await waitFor(() => expect(screen.getByTestId('screens-discovered-preview')).toBeTruthy());
    expect(fetchedScreens).toBe(1);
    delete (target as Record<string, unknown>)['docs-review/screens-discovered.json'];
  });

  it('không có screens-discovered.json (404) → thông báo chạy lại bước Luồng màn hình', async () => {
    seedScreenFlow();
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Danh sách màn' }));
    await waitFor(() => expect(screen.getByText('Chưa có danh sách màn — chạy lại bước Luồng màn hình.')).toBeTruthy());
    expect(screen.queryByTestId('screens-discovered-preview')).toBeNull();
    expect(screen.queryByTestId('drawio-stub')).toBeNull();
  });

  it('đang Chỉnh sửa mà bấm Danh sách màn → editor đóng (không còn iframe), về Hiện trạng thấy viewer tĩnh', async () => {
    seedScreenFlow();
    FILES['docs-review/screens-discovered.json'] = JSON.stringify({ schema_version: 1, pages: [{ source: 'docs-feature/x.md', screens: [{ code: null, name: 'Trang chủ', anchorText: '## Trang chủ' }] }] });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, warnings: [] }) })));
    try {
      render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
      await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Chỉnh sửa' }));
      await waitFor(() => expect(screen.getByTestId('drawio-editor')).toBeTruthy());
      fireEvent.click(screen.getByRole('tab', { name: 'Danh sách màn' }));
      await waitFor(() => expect(screen.getByText('Trang chủ')).toBeTruthy());
      expect(screen.queryByTestId('drawio-editor')).toBeNull();
      fireEvent.click(screen.getByRole('tab', { name: 'Nguyên bản' }));
      await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
      expect(screen.queryByTestId('drawio-editor')).toBeNull();
      expect(screen.getByRole('button', { name: 'Chỉnh sửa' })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// WP dr-flow-improve (2026-08-27): bước "Cải thiện luồng" sinh proposed.drawio
// 2 trang cho SCREEN-FLOW. Web: nhãn Nguyên bản | Cải thiện + badge "đang
// dùng", khối chọn bản (PUT …/screen-flow/selection) + banner stale, panel
// "Theo phần tử" gom <object od-change od-finding> ở trang 1, editor mở được
// cả khi có bản Cải thiện (nạp mxfile 2 trang).
describe('FlowUxReviewPreview — SCREEN-FLOW có bản Cải thiện (WP dr-flow-improve)', () => {
  const IMPROVED_XML =
    '<mxfile>' +
    '<diagram id="screen-flow" name="Nguyên bản"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="s1" value="Nhập OTP" vertex="1" parent="1"/><mxCell id="s2" value="Kết quả" vertex="1" parent="1"/>' +
    '</root></mxGraphModel></diagram>' +
    '<diagram id="screen-flow-proposed" name="Cải thiện"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<object id="s1" label="Nhập OTP" od-change="modified" od-finding="UX-02"><mxCell value="" vertex="1" parent="1"/></object>' +
    '<mxCell id="s2" value="Kết quả" vertex="1" parent="1"/>' +
    '<object id="od-n1" label="Báo lỗi &lt;b&gt;timeout&lt;/b&gt;" od-change="added" od-finding="UX-01"><mxCell vertex="1" parent="1"/></object>' +
    '<object id="od-e1" label="hết giờ" od-change="added" od-finding="UX-01"><mxCell edge="1" parent="1" source="s1" target="od-n1"/></object>' +
    '<object id="s3" label="Bước thừa" od-change="removed"><mxCell vertex="1" parent="1"/></object>' +
    '<object id="od-legend-added" label="Thêm mới" od-change="added"><mxCell vertex="1" parent="1"/></object>' +
    '</root></mxGraphModel></diagram>' +
    '</mxfile>';
  const IMPROVE_REVIEW = {
    flowId: 'SCREEN-FLOW',
    verdict: 'needs-improvement',
    summary: 'Thiếu nhánh timeout.',
    findings: [
      { id: 'UX-01', severity: 'major', title: 'Timeout mù', reason: 'Tài liệu 4.2 yêu cầu báo lỗi khi hết giờ OTP.', evidence: ['docs-feature/otp.md#4.2 Hết giờ'], cells: { asIs: ['s1'], proposed: ['od-n1', 'od-e1'] }, change: 'added' },
      { id: 'UX-02', severity: 'minor', title: 'Nhãn chưa rõ', reason: 'Nhãn nên nêu rõ OTP.', cells: { asIs: ['s1'], proposed: ['s1'] }, change: 'modified' },
    ],
  };
  function seedImproved(selection?: { variant: 'original' | 'improved'; source?: string }) {
    FILES['docs-review/flows/SCREEN-FLOW/ux-review.json'] = JSON.stringify(IMPROVE_REVIEW);
    FILES['docs-review/flows/SCREEN-FLOW/proposed.drawio'] = IMPROVED_XML;
    FILES['docs-review/flows/SCREEN-FLOW/as-is.drawio'] = '<mxfile><diagram id="screen-flow" name="Nguyên bản"><mxGraphModel/></diagram></mxfile>';
    FILES['docs-review/flows/index.json'] = JSON.stringify([
      { id: 'SCREEN-FLOW', title: 'Luồng màn hình — OTP', kind: 'drawio', hasProposal: true, ...(selection ? { selection, variant: selection.variant } : {}) },
    ]);
  }

  it('parseProposedElements: gom object[od-change] trang 1 + cell được cells.proposed nhắc, bỏ od-legend-*, nhãn HTML → chữ thuần', async () => {
    const { parseProposedElements } = await import('../../src/components/FlowUxReviewPreview');
    const findings = [
      { id: 'UX-01', severity: 'major' as const, title: 't', reason: 'r', cells: { proposed: ['od-n1', 's2'] }, change: 'modified' as const },
    ];
    const r = parseProposedElements(IMPROVED_XML, findings);
    expect(r.unreadable).toBe(false);
    expect(r.elements.map((e) => [e.id, e.change, e.kind, e.findingId, e.label])).toEqual([
      ['s1', 'modified', 'node', 'UX-02', 'Nhập OTP'],
      ['od-n1', 'added', 'node', 'UX-01', 'Báo lỗi timeout'],
      ['od-e1', 'added', 'edge', 'UX-01', 'hết giờ'],
      ['s3', 'removed', 'node', null, 'Bước thừa'],
      // s2 không có wrapper nhưng được finding nhắc → loại theo finding.change.
      ['s2', 'modified', 'node', 'UX-01', 'Kết quả'],
    ]);
    // 1 trang → không có phần tử, không phải lỗi; trang 1 nén (không có DOM con) → unreadable.
    expect(parseProposedElements('<mxfile><diagram id="a"><mxGraphModel/></diagram></mxfile>', [])).toEqual({ elements: [], unreadable: false });
    expect(parseProposedElements('<mxfile><diagram id="a"><mxGraphModel/></diagram><diagram id="b">jZHBbsIw</diagram></mxfile>', []).unreadable).toBe(true);
  });

  it('nhãn Nguyên bản | Cải thiện; selection từ index.json → badge "đang dùng" đúng bản; radio đổi → PUT selection, đang lưu khoá radio, downstreamStale → banner', async () => {
    seedImproved({ variant: 'improved', source: 'run-all' });
    let resolvePut: ((v: unknown) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePut = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
      await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
      // Bố cục cạnh nhau: tiêu đề khung theo nhãn mới, nhãn cũ biến mất.
      expect(screen.getByRole('heading', { level: 3, name: 'Nguyên bản' })).toBeTruthy();
      expect(screen.getByRole('heading', { level: 3, name: 'Cải thiện' })).toBeTruthy();
      expect(screen.queryByText('Hiện trạng')).toBeNull();
      expect(screen.queryByText('Đề xuất')).toBeNull();
      // Badge theo index.selection = improved — ở CẢ tab lẫn tiêu đề khung phải
      // (SCREEN-FLOW hiện tablist cùng lúc với bố cục cạnh nhau).
      expect(screen.getAllByTestId('using-improved').length).toBe(2);
      expect(screen.queryByTestId('using-original')).toBeNull();
      // Tablist vẫn hiện với SCREEN-FLOW: tab Cải thiện mang badge.
      const improvedTab = screen.getByRole('tab', { name: /^Cải thiện/ });
      expect(within(improvedTab).getByText('đang dùng')).toBeTruthy();

      const group = screen.getByRole('radiogroup', { name: 'Dùng bản để chạy tiếp' });
      const radioOriginal = within(group).getByRole('radio', { name: 'Nguyên bản' }) as HTMLInputElement;
      const radioImproved = within(group).getByRole('radio', { name: 'Cải thiện' }) as HTMLInputElement;
      expect(radioImproved.checked).toBe(true);
      expect(radioOriginal.checked).toBe(false);

      fireEvent.click(radioOriginal);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/projects/p/docs-review/screen-flow/selection');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(String(init.body))).toEqual({ variant: 'original' });
      // Đang lưu: radio khoá, chưa có banner.
      await waitFor(() => expect(radioOriginal.disabled).toBe(true));
      expect(radioImproved.disabled).toBe(true);
      expect(screen.queryByText(/đang theo bản trước/)).toBeNull();

      resolvePut!({ ok: true, status: 200, json: async () => ({ ok: true, variant: 'original', screens: [], downstreamStale: true }) });
      await waitFor(() => expect(radioOriginal.disabled).toBe(false));
      expect(radioOriginal.checked).toBe(true);
      expect(screen.getByText('Các bước sau (Màn hình → Component…) đang theo bản trước — Chạy lại để cập nhật.')).toBeTruthy();
      // Badge chuyển sang Nguyên bản.
      expect(screen.getAllByTestId('using-original').length).toBe(2);
      expect(screen.queryByTestId('using-improved')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('PUT selection thất bại → radio trả về bản cũ + báo lỗi; không có selection trong index → mặc định Nguyên bản', async () => {
    seedImproved();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'daemon lỗi' }) })));
    try {
      render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
      await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
      expect(screen.getAllByTestId('using-original').length).toBe(2);
      const radioImproved = screen.getByRole('radio', { name: 'Cải thiện' }) as HTMLInputElement;
      expect(radioImproved.checked).toBe(false);
      fireEvent.click(radioImproved);
      await waitFor(() => expect(screen.getByText(/Không lưu được lựa chọn: daemon lỗi/)).toBeTruthy());
      expect((screen.getByRole('radio', { name: 'Nguyên bản' }) as HTMLInputElement).checked).toBe(true);
      expect(screen.getAllByTestId('using-original').length).toBe(2);
      expect(screen.queryByTestId('using-improved')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('flow thường có đề xuất (không phải SCREEN-FLOW) → không có khối chọn bản, không badge', async () => {
    renderSideDefault();
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByText('đang dùng')).toBeNull();
  });

  it('panel "Theo phần tử": nhóm Thêm mới / Sửa đổi / Đề nghị bỏ từ trang 1, kèm reason + evidence của finding; bấm dòng → finding active + highlight đúng cell ở khung Cải thiện', async () => {
    seedImproved({ variant: 'original', source: 'user' });
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    // Mặc định vẫn là danh sách finding.
    expect(screen.getByTestId('finding-UX-01')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Theo phần tử' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    const panel = await waitFor(() => screen.getByTestId('elements-panel'));
    expect(screen.queryByTestId('finding-UX-01')).toBeNull();
    // Nhóm + số lượng: Thêm mới 2 (od-n1, od-e1), Sửa đổi 1 (s1), Đề nghị bỏ 1 (s3); od-legend-* bị bỏ.
    const added = within(panel).getByRole('region', { name: 'Thêm mới' });
    expect(within(added).getAllByRole('button').map((b) => b.getAttribute('data-testid'))).toEqual(['element-od-n1', 'element-od-e1']);
    expect(within(screen.getByRole('region', { name: 'Sửa đổi' })).getByTestId('element-s1')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Đề nghị bỏ' })).getByTestId('element-s3')).toBeTruthy();
    expect(screen.queryByTestId('element-od-legend-added')).toBeNull();
    // Dòng: nhãn cell (HTML → chữ thuần), chip loại, reason + evidence của finding.
    const row = screen.getByTestId('element-od-n1');
    expect(within(row).getByText('Báo lỗi timeout')).toBeTruthy();
    expect(within(row).getByText('Node')).toBeTruthy();
    expect(within(row).getByText('Thêm mới')).toBeTruthy();
    expect(within(row).getByText('Tài liệu 4.2 yêu cầu báo lỗi khi hết giờ OTP.')).toBeTruthy();
    expect(within(row).getByText('otp #4.2 Hết giờ')).toBeTruthy();
    expect(within(screen.getByTestId('element-od-e1')).getByText('Cạnh')).toBeTruthy();
    // s3 không có finding → dòng nhắc.
    expect(within(screen.getByTestId('element-s3')).getByText('Không có finding giải thích cho phần tử này.')).toBeTruthy();

    // Bấm od-e1 → khung phải highlight ĐÚNG cell đó (không phải toàn bộ cells.proposed), khung trái theo cells.asIs của finding.
    fireEvent.click(screen.getByTestId('element-od-e1'));
    await waitFor(() => expect(lastPropsForPage(1)?.highlightCells?.join(',')).toBe('od-e1'));
    expect(lastPropsForPage(0)?.highlightCells?.join(',')).toBe('s1');
    expect(screen.getByTestId('element-od-e1').getAttribute('aria-pressed')).toBe('true');
    // Quay lại Phát hiện UX: finding UX-01 đang active; bấm card → highlight về theo finding.
    fireEvent.click(screen.getByRole('button', { name: 'Phát hiện UX' }));
    await waitFor(() => expect(screen.getByTestId('finding-UX-01').getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(screen.getByTestId('finding-UX-02'));
    await waitFor(() => expect(lastPropsForPage(1)?.highlightCells?.join(',')).toBe('s1'));
  });

  it('trang Cải thiện không có od-change nào → dòng "không thay đổi phần tử nào"', async () => {
    FILES['docs-review/flows/SCREEN-FLOW/ux-review.json'] = JSON.stringify({ verdict: 'good', summary: 'ok', findings: [] });
    FILES['docs-review/flows/SCREEN-FLOW/proposed.drawio'] = '<mxfile><diagram id="a"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram><diagram id="b"><mxGraphModel><root><mxCell id="0"/><mxCell id="s1" value="A" vertex="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
    FILES['docs-review/flows/index.json'] = JSON.stringify([{ id: 'SCREEN-FLOW', title: 'x', kind: 'drawio', hasProposal: true }]);
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Theo phần tử' }));
    await waitFor(() => expect(screen.getByText('Bản cải thiện không thay đổi phần tử nào.')).toBeTruthy());
  });

  it('có bản Cải thiện vẫn Chỉnh sửa được: editor nạp mxfile 2 trang, ép bố cục 1 khung; lưu POST route cũ; Xong → về 2 khung cạnh nhau với bản đã sửa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedImproved({ variant: 'improved', source: 'user' });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, warnings: ['Bản Nguyên bản đã sửa tay — đề xuất có thể lệch'], screens: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
      await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
      const editBtn = screen.getByRole('button', { name: 'Chỉnh sửa' });
      fireEvent.click(editBtn);
      const host = await waitFor(() => screen.getByTestId('drawio-editor'));
      // Editor thay cả 2 khung (bố cục ép về một khung khi đang sửa).
      expect(screen.queryAllByTestId('drawio-stub').length).toBe(0);
      const iframe = host.querySelector('iframe') as HTMLIFrameElement;
      const posted: string[] = [];
      const win = iframe.contentWindow as Window;
      win.postMessage = ((data: string) => {
        posted.push(data);
      }) as typeof win.postMessage;
      fireEvent(window, new MessageEvent('message', { data: JSON.stringify({ event: 'init' }), source: win }));
      expect(JSON.parse(posted[0]!)).toEqual({ action: 'load', xml: IMPROVED_XML, autosave: 1 });

      const EDITED = IMPROVED_XML.replace('label="Bước thừa"', 'label="Bước thừa (đã sửa)"');
      fireEvent(window, new MessageEvent('message', { data: JSON.stringify({ event: 'autosave', xml: EDITED }), source: win }));
      await vi.advanceTimersByTimeAsync(1600);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/projects/p/docs-review/screen-flow');
      expect(JSON.parse(String(init.body))).toEqual({ xml: EDITED });
      await waitFor(() => expect(screen.getByText(/Bản Nguyên bản đã sửa tay/)).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'Xong' }));
      await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
      expect(screen.queryByTestId('drawio-editor')).toBeNull();
      expect(lastPropsForPage(0)?.xml).toBe(EDITED);
      expect(lastPropsForPage(1)?.xml).toBe(EDITED);
      // Panel Theo phần tử đọc bản đã sửa.
      fireEvent.click(screen.getByRole('button', { name: 'Theo phần tử' }));
      await waitFor(() => expect(within(screen.getByTestId('element-s3')).getByText('Bước thừa (đã sửa)')).toBeTruthy());
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

// WP dr-flow-result-split (2026-08-27): Quick result dr-flow mở as-is.drawio →
// CHỈ nguyên bản (không tải proposed/ux-review dù có trên đĩa, không tab Cải
// thiện, không chọn bản, không panel); Quick result dr-flow-improve mở
// ux-review.json → mặc định highlight toàn bộ thay đổi + badge + "Chỉ xem
// thay đổi" (dimCellsExcept) — chọn finding thu hẹp, bỏ chọn về đủ.
describe('FlowUxReviewPreview — chế độ theo file mở + highlight thay đổi (WP dr-flow-result-split)', () => {
  const IMPROVED_XML =
    '<mxfile>' +
    '<diagram id="screen-flow" name="Nguyên bản"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="s1" value="Nhập OTP" vertex="1" parent="1"/><mxCell id="s2" value="Kết quả" vertex="1" parent="1"/>' +
    '</root></mxGraphModel></diagram>' +
    '<diagram id="screen-flow-proposed" name="Cải thiện"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<object id="s1" label="Nhập OTP" od-change="modified" od-finding="UX-02"><mxCell value="" vertex="1" parent="1"/></object>' +
    '<mxCell id="s2" value="Kết quả" vertex="1" parent="1"/>' +
    '<object id="od-n1" label="Báo lỗi timeout" od-change="added" od-finding="UX-01"><mxCell vertex="1" parent="1"/></object>' +
    '<object id="od-e1" label="hết giờ" od-change="added" od-finding="UX-01"><mxCell edge="1" parent="1" source="s1" target="od-n1"/></object>' +
    '<object id="s3" label="Bước thừa" od-change="removed"><mxCell vertex="1" parent="1"/></object>' +
    '<object id="od-legend-added" label="Thêm mới" od-change="added"><mxCell vertex="1" parent="1"/></object>' +
    '</root></mxGraphModel></diagram>' +
    '</mxfile>';
  const AS_IS_XML = '<mxfile><diagram id="screen-flow" name="Nguyên bản"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="s1" value="Nhập OTP" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>';
  const REVIEW2 = {
    flowId: 'SCREEN-FLOW',
    verdict: 'needs-improvement',
    summary: 'Thiếu nhánh timeout.',
    findings: [
      { id: 'UX-01', severity: 'major', title: 'Timeout mù', reason: 'r1', cells: { asIs: ['s1'], proposed: ['od-n1', 'od-e1'] }, change: 'added' },
      { id: 'UX-02', severity: 'minor', title: 'Nhãn chưa rõ', reason: 'r2', cells: { asIs: ['s2'], proposed: ['s1'] }, change: 'modified' },
    ],
  };
  const CHANGED = 's1,od-n1,od-e1,s3';
  /** Đếm số lần tải qua getter (FILES là mock của fetchProjectFileText). */
  function counted(name: string, value: string): () => number {
    let n = 0;
    Object.defineProperty(FILES, name, {
      configurable: true,
      enumerable: true,
      get() {
        n += 1;
        return value;
      },
    });
    return () => n;
  }
  function seed() {
    FILES['docs-review/flows/SCREEN-FLOW/as-is.drawio'] = AS_IS_XML;
    FILES['docs-review/flows/index.json'] = JSON.stringify([{ id: 'SCREEN-FLOW', title: 'Luồng màn hình — OTP', kind: 'drawio', hasProposal: true, selection: { variant: 'improved', source: 'user' } }]);
    return { review: counted('docs-review/flows/SCREEN-FLOW/ux-review.json', JSON.stringify(REVIEW2)), proposed: counted('docs-review/flows/SCREEN-FLOW/proposed.drawio', IMPROVED_XML) };
  }

  it('mở as-is.drawio (Quick result dr-flow) → chỉ nguyên bản: KHÔNG fetch proposed/ux-review dù có trên đĩa, không tab Cải thiện/radiogroup/panel; giữ Chỉnh sửa + Danh sách màn + Tải + Toàn màn hình', async () => {
    const n = seed();
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/as-is.drawio')} />);
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(1));
    expect(n.proposed()).toBe(0);
    expect(n.review()).toBe(0);
    const stub = screen.getByTestId('drawio-stub');
    expect(stub.getAttribute('data-page')).toBe('0');
    expect(lastPropsForPage(0)?.xml).toBe(AS_IS_XML);
    expect(stub.getAttribute('data-highlight')).toBe('');
    expect(stub.getAttribute('data-dim')).toBe('off');
    // Không có gì của bản Cải thiện.
    expect(screen.queryByRole('tab', { name: /^Cải thiện/ })).toBeNull();
    expect(screen.queryByRole('heading', { level: 3, name: 'Cải thiện' })).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByText('đang dùng')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Theo phần tử' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Chỉ xem thay đổi' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cạnh nhau' })).toBeNull();
    // Right panel Phát hiện UX không hiện, kể cả tab dọc "Hiện chú giải".
    expect(screen.queryByText('Phát hiện UX')).toBeNull();
    expect(screen.queryByLabelText('Lý do UX')).toBeNull();
    expect(screen.queryByLabelText('Hiện chú giải')).toBeNull();
    expect(screen.queryByTestId('verdict')).toBeNull();
    // Giữ: Chỉnh sửa, Tải .drawio (tên nguyên bản), Toàn màn hình, tab Danh sách màn.
    expect(screen.getByRole('button', { name: 'Chỉnh sửa' })).toBeTruthy();
    expect((screen.getByText('Tải .drawio') as HTMLAnchorElement).getAttribute('download')).toBe('SCREEN-FLOW.drawio');
    expect(screen.getByRole('button', { name: 'Toàn màn hình' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Danh sách màn' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Nguyên bản' }).getAttribute('aria-selected')).toBe('true');
    delete (FILES as Record<string, unknown>)['docs-review/flows/SCREEN-FLOW/ux-review.json'];
    delete (FILES as Record<string, unknown>)['docs-review/flows/SCREEN-FLOW/proposed.drawio'];
  });

  it('mở ux-review.json (Quick result dr-flow-improve) → mặc định khung Cải thiện viền toàn bộ thay đổi, khung Nguyên bản viền hợp cells.asIs; badge N thay đổi; chọn finding thu hẹp, bỏ chọn về đủ', async () => {
    const n = seed();
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    expect(n.proposed()).toBe(1);
    expect(n.review()).toBe(1);
    // Mặc định: chưa chọn finding → highlight = changed (bỏ od-legend-*) / hợp asIs.
    await waitFor(() => expect(lastPropsForPage(1)?.highlightCells?.join(',')).toBe(CHANGED));
    expect(lastPropsForPage(0)?.highlightCells?.join(',')).toBe('s1,s2');
    // Badge trên tab Cải thiện + tiêu đề khung phải: 4 thay đổi · 2 thêm · 1 sửa · 1 bỏ.
    const badgeText = '4 thay đổi · 2 thêm · 1 sửa · 1 bỏ';
    expect(screen.getByTestId('changes-badge-tab').textContent).toBe(badgeText);
    expect(screen.getByTestId('changes-badge-pane').textContent).toBe(badgeText);
    expect(within(screen.getByTestId('side-pane-right')).getByRole('heading', { level: 3, name: 'Cải thiện' })).toBeTruthy();
    // Panel Theo phần tử đếm cùng con số với badge.
    expect(screen.getByRole('button', { name: 'Theo phần tử' })).toBeTruthy();
    // Chọn finding → thu về viền riêng.
    fireEvent.click(screen.getByTestId('finding-UX-01'));
    await waitFor(() => expect(lastPropsForPage(1)?.highlightCells?.join(',')).toBe('od-n1,od-e1'));
    expect(lastPropsForPage(0)?.highlightCells?.join(',')).toBe('s1');
    // Bỏ chọn → về toàn bộ.
    fireEvent.click(screen.getByTestId('finding-UX-01'));
    await waitFor(() => expect(lastPropsForPage(1)?.highlightCells?.join(',')).toBe(CHANGED));
    expect(lastPropsForPage(0)?.highlightCells?.join(',')).toBe('s1,s2');
    // Chọn phần tử ở panel Theo phần tử → chỉ cell đó; về Phát hiện UX + bỏ chọn → về đủ.
    fireEvent.click(screen.getByRole('button', { name: 'Theo phần tử' }));
    fireEvent.click(await waitFor(() => screen.getByTestId('element-s3')));
    await waitFor(() => expect(lastPropsForPage(1)?.highlightCells?.join(',')).toBe('s3'));
    delete (FILES as Record<string, unknown>)['docs-review/flows/SCREEN-FLOW/ux-review.json'];
    delete (FILES as Record<string, unknown>)['docs-review/flows/SCREEN-FLOW/proposed.drawio'];
  });

  it('"Chỉ xem thay đổi" (aria-pressed) ở tiêu đề khung Cải thiện → khung phải nhận dimCellsExcept = changed, khung trái không; tắt → bỏ; Từng bản/trang Cải thiện cũng nhận', async () => {
    seed();
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    const right = screen.getByTestId('side-pane-right');
    const toggle = within(right).getByRole('button', { name: 'Chỉ xem thay đổi' });
    // WP dr-flow-edit-highlight: mặc định BẬT khi có bản Cải thiện có thay đổi.
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect(lastPropsForPage(1)?.dimCellsExcept?.join(',')).toBe(CHANGED));
    expect(lastPropsForPage(0)?.dimCellsExcept).toBeUndefined();
    // Highlight mặc định vẫn còn khi đang mờ.
    expect(lastPropsForPage(1)?.highlightCells?.join(',')).toBe(CHANGED);
    // Tắt → bỏ mờ; bật lại → mờ.
    fireEvent.click(toggle);
    await waitFor(() => expect(lastPropsForPage(1)?.dimCellsExcept).toBeUndefined());
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(lastPropsForPage(1)?.dimCellsExcept?.join(',')).toBe(CHANGED));
    fireEvent.click(toggle);
    await waitFor(() => expect(lastPropsForPage(1)?.dimCellsExcept).toBeUndefined());
    // Từng bản: trang Cải thiện (mặc định) — nút vẫn có, bật → viewer đơn nhận dim; trang Nguyên bản không.
    fireEvent.click(screen.getByRole('button', { name: 'Từng bản' }));
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(1));
    expect(screen.getByTestId('drawio-stub').getAttribute('data-page')).toBe('1');
    expect(screen.getByTestId('drawio-stub').getAttribute('data-highlight')).toBe(CHANGED);
    expect(screen.getByTestId('drawio-stub').getAttribute('data-dim')).toBe('off');
    fireEvent.click(screen.getByRole('button', { name: 'Chỉ xem thay đổi' }));
    await waitFor(() => expect(screen.getByTestId('drawio-stub').getAttribute('data-dim')).toBe(CHANGED));
    fireEvent.click(screen.getByRole('tab', { name: 'Nguyên bản' }));
    await waitFor(() => expect(screen.getByTestId('drawio-stub').getAttribute('data-page')).toBe('0'));
    expect(screen.getByTestId('drawio-stub').getAttribute('data-dim')).toBe('off');
    expect(screen.getByTestId('drawio-stub').getAttribute('data-highlight')).toBe('s1,s2');
    expect(screen.queryByRole('button', { name: 'Chỉ xem thay đổi' })).toBeNull();
    delete (FILES as Record<string, unknown>)['docs-review/flows/SCREEN-FLOW/ux-review.json'];
    delete (FILES as Record<string, unknown>)['docs-review/flows/SCREEN-FLOW/proposed.drawio'];
  });

  it('flow không có bản Cải thiện mở từ ux-review.json → không badge, không nút Chỉ xem thay đổi, highlight mặc định rỗng như cũ', async () => {
    FILES['flows/FLOW-b/ux-review.json'] = JSON.stringify({ verdict: 'needs-improvement', summary: 's', findings: [{ id: 'UX-01', severity: 'major', title: 't', reason: 'r', cells: { asIs: ['a'] } }] });
    FILES['flows/FLOW-b/as-is.drawio'] = '<mxfile><diagram id="p" name="x"><mxGraphModel/></diagram></mxfile>';
    render(<FlowUxReviewPreview projectId="p" file={file('flows/FLOW-b/ux-review.json')} />);
    await waitFor(() => expect(screen.getByTestId('drawio-stub')).toBeTruthy());
    expect(screen.getByTestId('drawio-stub').getAttribute('data-highlight')).toBe('');
    expect(screen.queryByTestId('changes-badge-tab')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Chỉ xem thay đổi' })).toBeNull();
    expect(screen.getByTestId('finding-UX-01')).toBeTruthy();
  });
});

// WP dr-flow-edit-highlight (2026-08-27): (1) editor mở ĐÚNG trang đang xem
// (`page` URL param), đổi tab trong lúc sửa → remount đúng trang + đẩy bản chờ
// lưu; (2) khung Cải thiện nhận highlight `{ id, kind }` theo loại thay đổi;
// "Chỉ xem thay đổi" mặc định bật (test ở describe trên).
describe('FlowUxReviewPreview — editor đúng trang + highlight theo loại (WP dr-flow-edit-highlight)', () => {
  const IMPROVED_XML =
    '<mxfile>' +
    '<diagram id="screen-flow" name="Nguyên bản"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="s1" value="Nhập OTP" vertex="1" parent="1"/><mxCell id="s2" value="Kết quả" vertex="1" parent="1"/>' +
    '</root></mxGraphModel></diagram>' +
    '<diagram id="screen-flow-proposed" name="Đề xuất"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<object id="s1" label="Nhập OTP" od-change="modified" od-finding="UX-02"><mxCell value="" vertex="1" parent="1"/></object>' +
    '<mxCell id="s2" value="Kết quả" vertex="1" parent="1"/>' +
    '<object id="od-n1" label="Báo lỗi timeout" od-change="added" od-finding="UX-01"><mxCell vertex="1" parent="1"/></object>' +
    '<object id="od-e1" label="hết giờ" od-change="added" od-finding="UX-01"><mxCell edge="1" parent="1" source="s1" target="od-n1"/></object>' +
    '<object id="s3" label="Bước thừa" od-change="removed"><mxCell vertex="1" parent="1"/></object>' +
    '<object id="od-legend-added" label="Thêm mới" od-change="added"><mxCell vertex="1" parent="1"/></object>' +
    '</root></mxGraphModel></diagram>' +
    '</mxfile>';
  const REVIEW3 = {
    flowId: 'SCREEN-FLOW',
    verdict: 'needs-improvement',
    summary: 'Thiếu nhánh timeout.',
    findings: [
      { id: 'UX-01', severity: 'major', title: 'Timeout mù', reason: 'r1', cells: { asIs: ['s1'], proposed: ['od-n1', 'od-e1'] }, change: 'added' },
      { id: 'UX-02', severity: 'minor', title: 'Nhãn chưa rõ', reason: 'r2', cells: { asIs: ['s2'], proposed: ['s1'] }, change: 'modified' },
    ],
  };
  function seed() {
    FILES['docs-review/flows/SCREEN-FLOW/ux-review.json'] = JSON.stringify(REVIEW3);
    FILES['docs-review/flows/SCREEN-FLOW/proposed.drawio'] = IMPROVED_XML;
    FILES['docs-review/flows/SCREEN-FLOW/as-is.drawio'] = '<mxfile><diagram id="screen-flow" name="Nguyên bản"><mxGraphModel/></diagram></mxfile>';
    FILES['docs-review/flows/index.json'] = JSON.stringify([{ id: 'SCREEN-FLOW', title: 'Luồng màn hình — OTP', kind: 'drawio', hasProposal: true, selection: { variant: 'improved', source: 'user' } }]);
  }
  const iframeOf = () => screen.getByTestId('drawio-editor').querySelector('iframe') as HTMLIFrameElement;

  it('viewer khung Cải thiện nhận highlightCells `{ id, kind }` cho toàn bộ thay đổi khi chưa chọn gì; chọn finding → id trần (viền accent)', async () => {
    seed();
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    await waitFor(() =>
      expect(lastPropsForPage(1)?.highlightSpecs).toEqual([
        { id: 's1', kind: 'modified' },
        { id: 'od-n1', kind: 'added' },
        { id: 'od-e1', kind: 'added' },
        { id: 's3', kind: 'removed' },
      ]),
    );
    // Khung Nguyên bản vẫn id trần (hợp cells.asIs).
    expect(lastPropsForPage(0)?.highlightSpecs).toEqual(['s1', 's2']);
    fireEvent.click(screen.getByTestId('finding-UX-01'));
    await waitFor(() => expect(lastPropsForPage(1)?.highlightSpecs).toEqual(['od-n1', 'od-e1']));
    // Bỏ chọn → về theo loại.
    fireEvent.click(screen.getByTestId('finding-UX-01'));
    await waitFor(() => expect(lastPropsForPage(1)?.highlightSpecs?.length).toBe(4));
    expect(lastPropsForPage(1)?.highlightSpecs?.[0]).toEqual({ id: 's1', kind: 'modified' });
  });

  it('ở tab Cải thiện bấm Chỉnh sửa → editor page=1 + chip "Đang sửa: Đề xuất" + dòng nhắc; đổi tab Nguyên bản đang sửa → remount page=0, bản chờ lưu được POST, editor mới nạp bản đã sửa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seed();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, warnings: [], screens: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
      await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
      fireEvent.click(screen.getByRole('button', { name: 'Chỉnh sửa' }));
      await waitFor(() => expect(screen.getByTestId('drawio-editor')).toBeTruthy());
      // Mặc định đang ở Cải thiện → trang 1 (URL param `page=1`, PoC embed).
      const iframe1 = iframeOf();
      expect(iframe1.src).toMatch(/^https:\/\/embed\.diagrams\.net\/\?embed=1&proto=json.*&page=1$/);
      expect(screen.getByTestId('drawio-editor').getAttribute('data-page')).toBe('1');
      expect(screen.getByRole('status').textContent).toBe('Đang sửa: Đề xuất · Đang mở editor…');
      expect(screen.getByTestId('edit-hint').textContent).toContain('proposed.edited.json');
      // init → load nguyên mxfile 2 trang (thứ tự trang giữ nguyên).
      const posted1: string[] = [];
      const win1 = iframe1.contentWindow as Window;
      win1.postMessage = ((d: string) => {
        posted1.push(d);
      }) as typeof win1.postMessage;
      fireEvent(window, new MessageEvent('message', { data: JSON.stringify({ event: 'init' }), source: win1 }));
      expect(JSON.parse(posted1[0]!)).toEqual({ action: 'load', xml: IMPROVED_XML, autosave: 1 });
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Đang sửa: Đề xuất · tự lưu'));
      // Sửa (autosave, chưa tới debounce) rồi đổi tab Nguyên bản → editor remount page=0,
      // unmount cũ đẩy bản chờ về daemon ngay.
      const EDITED = IMPROVED_XML.replace('label="Bước thừa"', 'label="Bước thừa (sửa tay)"');
      fireEvent(window, new MessageEvent('message', { data: JSON.stringify({ event: 'autosave', xml: EDITED }), source: win1 }));
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('tab', { name: 'Nguyên bản' }));
      await waitFor(() => expect(screen.getByTestId('drawio-editor').getAttribute('data-page')).toBe('0'));
      const iframe2 = iframeOf();
      expect(iframe2).not.toBe(iframe1);
      expect(iframe2.src).toContain('&page=0');
      expect(screen.getByRole('button', { name: 'Xong' }).getAttribute('aria-pressed')).toBe('true'); // vẫn đang sửa
      expect(screen.queryByTestId('edit-hint')).toBeNull();
      expect(screen.getByRole('status').textContent).toContain('Đang sửa: Nguyên bản');
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/projects/p/docs-review/screen-flow');
      expect(JSON.parse(String(init.body))).toEqual({ xml: EDITED });
      // Editor mới nạp bản đã sửa (editedXmlRef), không rơi về bản gốc.
      const posted2: string[] = [];
      const win2 = iframe2.contentWindow as Window;
      win2.postMessage = ((d: string) => {
        posted2.push(d);
      }) as typeof win2.postMessage;
      fireEvent(window, new MessageEvent('message', { data: JSON.stringify({ event: 'init' }), source: win2 }));
      expect(JSON.parse(posted2[0]!)).toEqual({ action: 'load', xml: EDITED, autosave: 1 });
      // Quay lại Cải thiện → page=1 lần nữa; Xong → 2 khung, bản đã sửa.
      fireEvent.click(screen.getByRole('tab', { name: /^Cải thiện/ }));
      await waitFor(() => expect(screen.getByTestId('drawio-editor').getAttribute('data-page')).toBe('1'));
      expect(fetchMock).toHaveBeenCalledTimes(1); // không còn bản chờ → không POST thêm
      fireEvent.click(screen.getByRole('button', { name: 'Xong' }));
      await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
      expect(lastPropsForPage(1)?.xml).toBe(EDITED);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('ở tab Nguyên bản (Từng bản) bấm Chỉnh sửa → editor page=0, không dòng nhắc', async () => {
    seed();
    render(<FlowUxReviewPreview projectId="p" file={file('docs-review/flows/SCREEN-FLOW/ux-review.json')} />);
    await waitFor(() => expect(screen.getAllByTestId('drawio-stub').length).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Từng bản' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Nguyên bản' }));
    await waitFor(() => expect(screen.getByTestId('drawio-stub').getAttribute('data-page')).toBe('0'));
    fireEvent.click(screen.getByRole('button', { name: 'Chỉnh sửa' }));
    await waitFor(() => expect(screen.getByTestId('drawio-editor')).toBeTruthy());
    expect(iframeOf().src).toContain('&page=0');
    expect(screen.getByRole('status').textContent).toBe('Đang sửa: Nguyên bản · Đang mở editor…');
    expect(screen.queryByTestId('edit-hint')).toBeNull();
  });
});
