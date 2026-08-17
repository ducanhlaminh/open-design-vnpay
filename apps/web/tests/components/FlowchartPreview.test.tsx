// @vitest-environment jsdom
//
// Sơ đồ khối `flows/<FLOW-ID>.flowchart.json` (bước dr-flow của docs-review).
// Ba câu hỏi: file hợp lệ có vẽ đủ bốn loại khối + hộp chú thích không, nhánh
// ra từ điểm quyết định có hiện nhãn không, và file hỏng có báo lỗi gọn thay vì
// làm sập khung nhìn không.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  FlowchartCanvas,
  isFlowchartFile,
  layoutFlowchart,
  parseFlowchartDoc,
  parseScreenNames,
  wireframeLayoutOf,
  workflowDirOf,
} from '../../src/components/FlowchartPreview';

const FILES: Record<string, string | null> = {};

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => FILES[name] ?? null,
}));

const { FlowchartPreview } = await import('../../src/components/FlowchartPreview');

afterEach(() => cleanup());

// React Flow đo khung vẽ bằng ResizeObserver và đo nhãn cạnh bằng getBBox —
// jsdom không cài cái nào. Thiếu ResizeObserver thì component ném ngay lúc
// mount; thiếu kích thước thật thì React Flow coi canvas là 0×0 và không dựng
// đường nối nào, nên phép kiểm "cạnh có nhãn" sẽ xanh giả.
beforeAll(() => {
  class StubResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(el: Element) {
      this.cb([{ target: el, contentRect: { width: 800, height: 600 } } as never], this as never);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 });
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 800 },
    offsetHeight: { configurable: true, get: () => 600 },
  });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 30, height: 12 }) as DOMRect;
});

const LOGIN = {
  id: 'FLOW-login',
  title: 'Đăng nhập',
  source: 'review/docs/dang-nhap.md',
  nodes: [
    { id: 'n1', type: 'start', label: 'Bắt đầu' },
    { id: 'n2', type: 'action', label: 'Nhập tên đăng nhập + mật khẩu' },
    { id: 'n3', type: 'decision', label: 'Thông tin hợp lệ?' },
    { id: 'n4', type: 'action', label: 'Báo lỗi sai thông tin' },
    { id: 'n5', type: 'end', label: 'Vào màn hình chính' },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
    { from: 'n3', to: 'n5', label: 'Có' },
    { from: 'n3', to: 'n4', label: 'Không' },
  ],
};

describe('parseFlowchartDoc', () => {
  it('đọc đủ node/edge của một file đúng schema', () => {
    const doc = parseFlowchartDoc(JSON.stringify(LOGIN));
    expect(doc?.id).toBe('FLOW-login');
    expect(doc?.title).toBe('Đăng nhập');
    expect(doc?.source).toBe('review/docs/dang-nhap.md');
    expect(doc?.nodes.map((n) => n.type)).toEqual(['start', 'action', 'decision', 'action', 'end']);
    expect(doc?.edges).toHaveLength(4);
  });

  it('bỏ qua phần tử hỏng thay vì đánh hỏng cả sơ đồ', () => {
    const doc = parseFlowchartDoc(
      JSON.stringify({
        id: 'FLOW-x',
        nodes: [
          { id: 'a', type: 'start', label: 'Bắt đầu' },
          { type: 'action', label: 'Không có id' },
          { id: 'a', type: 'action', label: 'Trùng id' },
          { id: 'b', type: 'lạ', label: 'Loại lạ' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'không-tồn-tại' },
          { to: 'b' },
        ],
      }),
    );
    expect(doc?.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    // Loại không nằm trong 4 ký pháp quy về `action` — vẫn đọc được.
    expect(doc?.nodes[1]?.type).toBe('action');
    expect(doc?.edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('trả null với file không dùng được', () => {
    expect(parseFlowchartDoc('{ không phải json')).toBeNull();
    expect(parseFlowchartDoc('[]')).toBeNull();
    expect(parseFlowchartDoc(JSON.stringify({ id: 'FLOW-x', nodes: [] }))).toBeNull();
  });

  it('giữ `screen` (SCREEN-KEY) trên node, cắt khoảng trắng, bỏ khi rỗng', () => {
    const doc = parseFlowchartDoc(
      JSON.stringify({
        id: 'FLOW-x',
        nodes: [
          { id: 'a', type: 'start', label: 'Bắt đầu' },
          { id: 'b', type: 'action', label: 'Nhập', screen: ' urd-nv__SCR-001 ' },
          { id: 'c', type: 'action', label: 'Rỗng', screen: '   ' },
          { id: 'd', type: 'action', label: 'Sai kiểu', screen: 12 },
        ],
        edges: [],
      }),
    );
    expect(doc?.nodes.map((n) => n.screen)).toEqual([undefined, 'urd-nv__SCR-001', undefined, undefined]);
    // File cũ không có field → không có key `screen` (tương thích ngược).
    expect('screen' in (parseFlowchartDoc(JSON.stringify(LOGIN))!.nodes[0] as object)).toBe(false);
  });
});

describe('đường dẫn wireframe / tên màn / layout', () => {
  it('workflowDirOf = phần trước `flows/`; file lẻ → thư mục cha', () => {
    expect(workflowDirOf('docs-review-1/flows/FLOW-a.flowchart.json')).toBe('docs-review-1/');
    expect(workflowDirOf('flows/FLOW-a.flowchart.json')).toBe('');
    expect(workflowDirOf('x/myflows/FLOW-a.flowchart.json')).toBe('x/myflows/');
    expect(workflowDirOf('FLOW-a.flowchart.json')).toBe('');
  });

  it('parseScreenNames đọc `[].screens[].{key,name}` của flows/index.json, khoan dung với file hỏng', () => {
    const idx = JSON.stringify([
      { id: 'FLOW-a', screens: [{ key: 'urd__SCR-001', name: 'Danh sách' }, { key: 'urd__SCR-002' }] },
      { id: 'FLOW-b', screens: [{ key: 'urd__SCR-003', name: 'Chi tiết' }] },
      { id: 'FLOW-c' },
    ]);
    expect(parseScreenNames(idx)).toEqual({ 'urd__SCR-001': 'Danh sách', 'urd__SCR-003': 'Chi tiết' });
    expect(parseScreenNames(null)).toEqual({});
    expect(parseScreenNames('{ hỏng')).toEqual({});
  });

  it('wireframeLayoutOf đọc data-layout, mặc định web', () => {
    expect(wireframeLayoutOf('<body data-screen="k" data-layout="mobile">')).toBe('mobile');
    expect(wireframeLayoutOf('<body data-layout="web">')).toBe('web');
    expect(wireframeLayoutOf('<body>')).toBe('web');
  });
});

describe('layoutFlowchart', () => {
  it('xếp từ trên xuống theo tầng BFS tính từ node start', () => {
    const doc = parseFlowchartDoc(JSON.stringify(LOGIN))!;
    const pos = layoutFlowchart(doc);
    const y = (id: string) => pos.get(id)!.y;
    expect(y('n1')).toBeLessThan(y('n2'));
    expect(y('n2')).toBeLessThan(y('n3'));
    // n4 và n5 là hai nhánh của cùng một quyết định → cùng tầng (canh giữa
    // theo tâm dọc vì hai khối cao thấp khác nhau), khác cột.
    const midY = (id: string) => y(id) + (id === 'n5' ? 56 : 68) / 2;
    expect(midY('n4')).toBe(midY('n5'));
    expect(pos.get('n4')!.x).not.toBe(pos.get('n5')!.x);
  });
});

describe('FlowchartCanvas', () => {
  it('vẽ đủ bốn ký pháp khối và hộp chú thích', () => {
    const doc = parseFlowchartDoc(JSON.stringify(LOGIN))!;
    const { container } = render(<FlowchartCanvas doc={doc} />);

    // React Flow gắn `react-flow__node-<type>` theo `node.type`, nên đây chính
    // là phép kiểm "start vẽ bằng oval, decision vẽ bằng hình thoi…".
    for (const type of ['start', 'action', 'decision', 'end']) {
      expect(container.querySelectorAll(`.react-flow__node-${type}`).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Chú thích')).toBeTruthy();
    expect(screen.getByText('Oval — điểm bắt đầu/kết thúc')).toBeTruthy();
    expect(screen.getByText('Chữ nhật — bước thực hiện/hành động')).toBeTruthy();
    expect(screen.getByText('Hình thoi — điểm quyết định (rẽ nhánh Có/Không)')).toBeTruthy();
    expect(screen.getByText('Mũi tên — hướng đi giữa các bước')).toBeTruthy();
  });

  it('mỗi nhánh ra từ điểm quyết định hiện nhãn của nó, có mũi tên đầu cạnh', () => {
    const doc = parseFlowchartDoc(JSON.stringify(LOGIN))!;
    const { container } = render(<FlowchartCanvas doc={doc} />);

    const labels = Array.from(container.querySelectorAll('.react-flow__edge-text')).map(
      (el) => el.textContent,
    );
    expect(labels).toContain('Có');
    expect(labels).toContain('Không');
    expect(container.querySelectorAll('.react-flow__edge-path')).toHaveLength(4);
    expect(container.querySelector('marker.react-flow__arrowhead')).not.toBeNull();
  });
});

describe('FlowchartPreview', () => {
  const file = (name: string) => ({ name, kind: 'code', mime: 'application/json', size: 1, mtime: 1 }) as never;

  it('chỉ nhận file `*.flowchart.json` — `flows/index.json` không thuộc khung nhìn này', () => {
    expect(isFlowchartFile(file('review/flows/FLOW-login.flowchart.json'))).toBe(true);
    expect(isFlowchartFile(file('review/flows/index.json'))).toBe(false);
    expect(isFlowchartFile(file('review/flows/FLOW-login.flow.json'))).toBe(false);
  });

  it('hiện tiêu đề + nguồn của sơ đồ', async () => {
    FILES['review/flows/FLOW-login.flowchart.json'] = JSON.stringify(LOGIN);
    render(<FlowchartPreview projectId="p1" file={file('review/flows/FLOW-login.flowchart.json')} />);

    await waitFor(() => expect(screen.getByText('Đăng nhập')).toBeTruthy());
    expect(screen.getByText('review/docs/dang-nhap.md')).toBeTruthy();
  });

  // Khung nhìn KỊCH BẢN (lý do tồn tại: sơ đồ thật 23 node/7 rẽ nhánh vẽ
  // nguyên khối thì không đọc nổi — xem flow-usecases.ts).
  it('mặc định mở chế độ Kịch bản: mỗi đường đi là một thẻ, tên lấy từ điểm kết thúc', async () => {
    FILES['review/flows/FLOW-login.flowchart.json'] = JSON.stringify(LOGIN);
    render(<FlowchartPreview projectId="p1" file={file('review/flows/FLOW-login.flowchart.json')} />);

    await waitFor(() => expect(screen.getByRole('tab', { name: /^Kịch bản/ })).toBeTruthy());
    expect(screen.getByRole('tab', { name: /^Kịch bản/ }).getAttribute('aria-selected')).toBe('true');
    // Hai kịch bản: vào được màn chính (thành công) và báo lỗi (đường cụt).
    expect(screen.getByText('Vào màn hình chính')).toBeTruthy();
    expect(screen.getByText('Báo lỗi sai thông tin')).toBeTruthy();
    // Mô tả = ngã rẽ đã chọn, thứ phân biệt hai kịch bản.
    expect(screen.getByText(/Thông tin hợp lệ\? → Có/)).toBeTruthy();
    expect(screen.getByText(/Thông tin hợp lệ\? → Không/)).toBeTruthy();
    // Chưa vào chi tiết thì chưa vẽ sơ đồ (React Flow chỉ dựng ở chế độ Sơ đồ).
    expect(document.querySelector('.react-flow')).toBeNull();
  });

  it('bấm một thẻ → chi tiết carousel từng bước, khối rẽ nhánh mang lựa chọn; ← quay lại danh sách', async () => {
    FILES['review/flows/FLOW-login.flowchart.json'] = JSON.stringify(LOGIN);
    render(<FlowchartPreview projectId="p1" file={file('review/flows/FLOW-login.flowchart.json')} />);

    await waitFor(() => expect(screen.getByText('Vào màn hình chính')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText('Vào màn hình chính')); });

    // Rail cho biết toàn bộ các bước; slide chỉ phóng lớn đúng bước đang chọn.
    await waitFor(() => expect(screen.getByRole('tablist', { name: 'Chọn bước' })).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /2\s*Nhập tên đăng nhập/ })); });
    expect(screen.getByRole('heading', { name: 'Nhập tên đăng nhập + mật khẩu' })).toBeTruthy();
    expect(screen.getAllByText('Bắt đầu').length).toBeGreaterThanOrEqual(1);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /3\s*Thông tin hợp lệ/ })); });
    expect(screen.getAllByText('Rẽ nhánh').length).toBeGreaterThan(0);
    expect(screen.getByText(/Lựa chọn:\s*Có/)).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /← Kịch bản/ })); });
    await waitFor(() => expect(screen.getByText('Báo lỗi sai thông tin')).toBeTruthy());
    expect(screen.queryByText(/Lựa chọn:\s*Có/)).toBeNull();
  });

  it('chuyển sang "Sơ đồ đầy đủ" thì React Flow mới dựng — bản vẽ cũ không mất', async () => {
    FILES['review/flows/FLOW-login.flowchart.json'] = JSON.stringify(LOGIN);
    const { container } = render(
      <FlowchartPreview projectId="p1" file={file('review/flows/FLOW-login.flowchart.json')} />,
    );

    await waitFor(() => expect(screen.getByRole('tab', { name: /^Sơ đồ đầy đủ/ })).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Sơ đồ đầy đủ/ })); });
    await waitFor(() => expect(container.querySelector('.react-flow')).toBeTruthy());
  });

  it('kịch bản quay vòng hiện khối "Quay lại bước #K" thay vì đi vòng vô tận', async () => {
    // Thêm cạnh báo-lỗi → quay về bước nhập: đúng ca "quá lượt nhập" ngoài đời.
    const looping = { ...LOGIN, edges: [...LOGIN.edges, { from: 'n4', to: 'n2' }] };
    FILES['review/flows/FLOW-loop.flowchart.json'] = JSON.stringify(looping);
    render(<FlowchartPreview projectId="p1" file={file('review/flows/FLOW-loop.flowchart.json')} />);

    await waitFor(() => expect(screen.getByText('Báo lỗi sai thông tin')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText('Báo lỗi sai thông tin')); });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /4\s*Báo lỗi sai thông tin/ })); });
    await waitFor(() => expect(screen.getByText(/Quay lại bước #2/)).toBeTruthy());
  });

  it('file hỏng → báo lỗi gọn, không sập khung nhìn', async () => {
    FILES['review/flows/hong.flowchart.json'] = '{ "nodes": [ hỏng';
    const { container } = render(
      <FlowchartPreview projectId="p1" file={file('review/flows/hong.flowchart.json')} />,
    );

    await waitFor(() => expect(container.textContent).toContain('Không đọc được sơ đồ'));
    expect(container.querySelector('.react-flow')).toBeNull();
  });

  // ── Tab "Flow màn hình" (node = màn hình có thumbnail wireframe) ─────────
  const KEY = '2.1.1-URD-Quan-ly-nhan-vien__SCR-001';
  const KEY2 = '2.1.1-URD-Quan-ly-nhan-vien__SCR-002';
  const WITH_SCREENS = {
    ...LOGIN,
    nodes: [
      { id: 'n1', type: 'start', label: 'Trang chủ' },
      { id: 'n2', type: 'action', label: 'Nhập tên đăng nhập + mật khẩu', screen: KEY },
      { id: 'n3', type: 'decision', label: 'Thông tin hợp lệ?' },
      { id: 'n4', type: 'action', label: 'Báo lỗi sai thông tin', screen: KEY },
      { id: 'n6', type: 'action', label: 'Xem trang chính', screen: KEY2 },
      { id: 'n5', type: 'end', label: 'Vào màn hình chính' },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n6', label: 'Có' },
      { from: 'n6', to: 'n5' },
      { from: 'n3', to: 'n4', label: 'Không' },
      { from: 'n4', to: 'n2' },
    ],
  };
  const WIRE = `<!doctype html><html><body data-screen="${KEY}" data-layout="web"><div class="wf-component">Table</div></body></html>`;

  it('ba tab theo thứ tự Kịch bản · Flow màn hình · Sơ đồ đầy đủ; tab giữa đếm số màn', async () => {
    FILES['wf/flows/FLOW-login.flowchart.json'] = JSON.stringify(WITH_SCREENS);
    render(<FlowchartPreview projectId="p1" file={file('wf/flows/FLOW-login.flowchart.json')} />);

    await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(3));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      expect.stringMatching(/^Kịch bản/),
      expect.stringMatching(/^Flow màn hình· 2 màn$/),
      expect.stringMatching(/^Sơ đồ đầy đủ/),
    ]);
  });

  it('Flow màn hình: node màn mang TÊN từ flows/index.json + thumbnail wireframe đọc theo SCREEN-KEY; màn thiếu wireframe hiện chỉ dẫn', async () => {
    FILES['wf/flows/FLOW-login.flowchart.json'] = JSON.stringify(WITH_SCREENS);
    FILES['wf/flows/index.json'] = JSON.stringify([
      { id: 'FLOW-login', screens: [{ key: KEY, name: 'Màn đăng nhập' }, { key: KEY2, name: 'Trang chính' }] },
    ]);
    FILES[`wf/wireframes/${KEY}.html`] = WIRE;
    delete FILES[`wf/wireframes/${KEY2}.html`];
    const { container } = render(
      <FlowchartPreview projectId="p1" file={file('wf/flows/FLOW-login.flowchart.json')} />,
    );

    await waitFor(() => expect(screen.getByRole('tab', { name: /^Flow màn hình/ })).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Flow màn hình/ })); });

    // Hai node màn (n2+n4 gộp thành một vì cùng KEY), một hình thoi, một oval
    // kết thúc, một nav xám cho "Trang chủ" (không có screen).
    await waitFor(() => expect(container.querySelectorAll('.react-flow__node-screen')).toHaveLength(2));
    expect(container.querySelectorAll('.react-flow__node-decision')).toHaveLength(1);
    expect(container.querySelectorAll('.react-flow__node-end')).toHaveLength(1);
    expect(container.querySelectorAll('.react-flow__node-nav')).toHaveLength(1);
    // Tên màn, không phải key.
    expect(screen.getByText('Màn đăng nhập')).toBeTruthy();
    expect(screen.getByText('Trang chính')).toBeTruthy();
    expect(screen.queryByText(KEY)).toBeNull();
    // Thumbnail = iframe WireBlocks với đúng HTML wireframe của màn.
    await waitFor(() => expect(container.querySelector('iframe[title="Wireframe"]')).not.toBeNull());
    expect(container.querySelector('iframe[title="Wireframe"]')?.getAttribute('srcdoc')).toContain('wf-component');
    // Màn chưa có wireframe (dr-comp chạy sau) → chỉ dẫn, không lỗi.
    expect(screen.getByText('(chưa có wireframe — chạy bước Màn hình → Component)')).toBeTruthy();
    // Không có dòng chú thích "chưa gán màn" vì file này CÓ screen.
    expect(screen.queryByText(/Sơ đồ chưa gán màn hình/)).toBeNull();
    // Nhánh "Không" của điểm rẽ quay về màn — cạnh gốc được giữ sau khi gộp.
    const labels = Array.from(container.querySelectorAll('.react-flow__edgelabel-renderer div[title]')).map((el) => el.getAttribute('title'));
    expect(labels).toContain('Có');
    expect(labels).toContain('Không');
    expect(labels).toContain('Nhập tên đăng nhập + mật khẩu');
  });

  it('không có index.json → tên màn fallback = SCREEN-KEY', async () => {
    FILES['wf2/flows/FLOW-login.flowchart.json'] = JSON.stringify(WITH_SCREENS);
    delete FILES['wf2/flows/index.json'];
    render(<FlowchartPreview projectId="p1" file={file('wf2/flows/FLOW-login.flowchart.json')} />);

    await waitFor(() => expect(screen.getByRole('tab', { name: /^Flow màn hình/ })).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Flow màn hình/ })); });
    await waitFor(() => expect(screen.getByText(KEY)).toBeTruthy());
  });

  it('file cũ không có `screen`: tab vẫn hiện, node toàn nav/decision/end + dòng chú thích chạy lại bước', async () => {
    FILES['wf/flows/FLOW-old.flowchart.json'] = JSON.stringify(LOGIN);
    const { container } = render(
      <FlowchartPreview projectId="p1" file={file('wf/flows/FLOW-old.flowchart.json')} />,
    );

    await waitFor(() => expect(screen.getByRole('tab', { name: /^Flow màn hình/ })).toBeTruthy());
    expect(screen.getByRole('tab', { name: /^Flow màn hình/ }).textContent).toContain('0 màn');
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^Flow màn hình/ })); });

    await waitFor(() => expect(container.querySelector('.react-flow')).toBeTruthy());
    expect(screen.getByText(/Sơ đồ chưa gán màn hình — chạy lại bước Sơ đồ luồng màn hình bản mới/)).toBeTruthy();
    expect(container.querySelectorAll('.react-flow__node-screen')).toHaveLength(0);
    expect(container.querySelectorAll('.react-flow__node-nav')).toHaveLength(3);
    expect(container.querySelectorAll('.react-flow__node-decision')).toHaveLength(1);
    expect(container.querySelectorAll('.react-flow__node-end')).toHaveLength(1);
    // Đủ 4 cạnh gốc — không mất nhánh khi không có gì để gộp.
    await waitFor(() => expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(4));
  });

  it('Kịch bản: bước có màn + có wireframe thì thẻ bước mang thumbnail; bước không màn thì không', async () => {
    FILES['wf/flows/FLOW-login.flowchart.json'] = JSON.stringify(WITH_SCREENS);
    FILES[`wf/wireframes/${KEY}.html`] = WIRE;
    delete FILES[`wf/wireframes/${KEY2}.html`];
    const { container } = render(
      <FlowchartPreview projectId="p1" file={file('wf/flows/FLOW-login.flowchart.json')} />,
    );

    await waitFor(() => expect(screen.getByText('Vào màn hình chính')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText('Vào màn hình chính')); });
    await waitFor(() => expect(screen.getByRole('tablist', { name: 'Chọn bước' })).toBeTruthy());
    // Bước 2 (Nhập tên…, màn KEY có wireframe) → khung trình duyệt + iframe.
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /2\s*Nhập tên đăng nhập/ })); });
    await waitFor(() => expect(container.querySelector('iframe[title="Wireframe"]')).not.toBeNull());
    expect(screen.getByText('Website')).toBeTruthy();
    // Bước 1 (Trang chủ — không có screen) → không thumbnail.
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /1\s*Trang chủ/ })); });
    expect(container.querySelector('iframe[title="Wireframe"]')).toBeNull();
  });
});
