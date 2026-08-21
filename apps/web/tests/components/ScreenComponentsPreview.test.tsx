// @vitest-environment jsdom
//
// Khung nhìn "Màn hình → Component" (dr-comp 2.0): route đúng file, rail màn
// theo thứ tự luồng (index.json, dự phòng _inputs.json, màn hỏng đánh dấu),
// panel element hiện component DS / biến thể / tin cậy / nguồn / lý do + link
// Figma từ .figma-catalog, bấm màn khác thì tải doc + wireframe của màn đó,
// wireframe được chèn cầu nối postMessage và chạy trong iframe sandbox
// allow-scripts (không same-origin).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const FILES: Record<string, string | null> = {};

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => FILES[name] ?? null,
}));

const {
  ScreenComponentsPreview,
  isScreenComponentsFile,
  screenComponentsLocationOf,
  parseScreenDoc,
  parseScreenIndex,
  parseScreenInputsRail,
  parseFigmaRefs,
  figmaNodeUrl,
  withWireframeBridge,
  WF_MSG,
} = await import('../../src/components/ScreenComponentsPreview');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const k of Object.keys(FILES)) delete FILES[k];
});

// WP25b (.tmp/pipeline/wp25-plan.md, Spec WP25b) — mock global fetch cho 3
// route "Dựng trong Figma" (providers/figma-build-jobs.ts). Route không khai
// handler → phản hồi mặc định vô hại (active rỗng / 500) — chỉ test nào cần
// mới truyền handler cho route đó.
function mockFigmaBuildFetch(opts: {
  active?: () => Response;
  previewGet?: () => Response;
  previewPut?: (body: unknown) => Response;
  start?: (body: unknown) => Response;
} = {}) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/figma-build-jobs/active')) {
      return (opts.active ?? (() => new Response(JSON.stringify({ jobs: [] }), { status: 200 })))();
    }
    if (url.includes('/docs-review/figma-build/start')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return (opts.start ?? (() => new Response(JSON.stringify({}), { status: 500 })))(body);
    }
    if (url.includes('/docs-review/figma-preview')) {
      if (init?.method === 'PUT') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return (opts.previewPut ?? (() => new Response(JSON.stringify({}), { status: 500 })))(body);
      }
      return (opts.previewGet ?? (() => new Response(JSON.stringify({ config: null }), { status: 200 })))();
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const file = (name: string) => ({ name, size: 1, mtime: 1, kind: 'code' as const, mime: 'application/json' });
const K1 = 'PRD-Mua-SIM__SCR-001';
const K2 = 'PRD-Mua-SIM__SCR-002';
const K3 = 'PRD-Mua-SIM__SCR-003';

describe('isScreenComponentsFile / screenComponentsLocationOf', () => {
  it('nhận comp/<KEY>.screen.json và comp/index.json; bỏ qua legacy .components.json, _inputs, wireframes', () => {
    expect(isScreenComponentsFile(file(`docs-review/comp/${K1}.screen.json`))).toBe(true);
    expect(isScreenComponentsFile(file('docs-review/comp/index.json'))).toBe(true);
    expect(isScreenComponentsFile(file('docs-review/comp/page.components.json'))).toBe(false);
    expect(isScreenComponentsFile(file('docs-review/comp/_inputs.json'))).toBe(false);
    expect(isScreenComponentsFile(file(`docs-review/wireframes/${K1}.html`))).toBe(false);
    expect(isScreenComponentsFile(file('ui/screens/a/screen.json'))).toBe(false);
    expect(screenComponentsLocationOf(`docs-review/comp/${K1}.screen.json`)).toEqual({ root: 'docs-review/', key: K1 });
    expect(screenComponentsLocationOf('comp/index.json')).toEqual({ root: '', key: null });
  });
});

describe('parsers', () => {
  it('parseScreenDoc khoan dung: element thiếu id/label bị bỏ, nav trỏ id lạ bị bỏ, confidence lạ → medium', () => {
    const d = parseScreenDoc(
      JSON.stringify({
        key: K1,
        name: 'Chọn quốc gia',
        platform: 'web',
        elements: [
          { id: 'a', label: 'A', role: 'app-bar', ds: { component: 'Top App Bar', anchor: 'top-app-bar' }, confidence: 'x', provenance: 'flow' },
          { id: 'b', role: 'r' },
          { id: 'c', label: 'C', role: 'r', ds: null, why: 'DS không có' },
        ],
        nav: [{ el: 'a', to: K2 }, { el: 'zzz', to: K2 }],
        notes: ['n1', 3],
      }),
      'fallback',
    );
    expect(d?.key).toBe(K1);
    expect(d?.platform).toBe('web');
    expect(d?.elements.map((e) => e.id)).toEqual(['a', 'c']);
    expect(d?.elements[0]?.confidence).toBe('medium');
    expect(d?.elements[1]?.ds).toBeNull();
    expect(d?.nav).toEqual([{ el: 'a', to: K2 }]);
    expect(d?.notes).toEqual(['n1']);
    expect(parseScreenDoc('{"foo":1}', 'k')).toBeNull();
    expect(parseScreenDoc('nope', 'k')).toBeNull();
  });
  it('parseScreenIndex: bản 2.0 có screens[].key; bản 1.x (không screens) → null; failed[] giữ lỗi', () => {
    const idx = parseScreenIndex(JSON.stringify({ schema_version: '2.0', screens: [{ key: K2, name: 'B', order: 1, elements: 3, mapped: 2, navOut: [] }, { key: K1, name: 'A', order: 0 }], failed: [{ key: K3, name: 'C', errors: ['e1'] }] }));
    expect(idx?.screens.map((s) => s.key)).toEqual([K2, K1]);
    expect(idx?.failed).toEqual([{ key: K3, name: 'C', errors: ['e1'] }]);
    expect(parseScreenIndex(JSON.stringify({ schema_version: '1.0', pages: [] }))).toBeNull();
    expect(parseScreenInputsRail(JSON.stringify({ screens: [{ key: K1, name: 'A', order: 0 }] }))).toEqual([{ key: K1, name: 'A', order: 0 }]);
  });
  it('parseFigmaRefs: tên → fileKey/nodeId, link Figma đổi ":" thành "-"', () => {
    const refs = parseFigmaRefs(JSON.stringify({ files: [{ fileKey: 'ABC', components: [{ name: 'Button', nodeId: '12:34', page: 'Controls' }] }] }));
    expect(refs.get('Button')).toEqual({ fileKey: 'ABC', nodeId: '12:34', page: 'Controls' });
    expect(figmaNodeUrl(refs.get('Button')!)).toBe('https://www.figma.com/design/ABC?node-id=12-34');
    expect(parseFigmaRefs(null).size).toBe(0);
  });
  it('withWireframeBridge chèn style + script trước </body>, không đụng phần agent viết', () => {
    const html = '<!doctype html><html><head><style>.wf-component{}</style></head><body data-screen="x"><div data-el="a">A</div></body></html>';
    const out = withWireframeBridge(html);
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<div data-el="a">A</div>');
    expect(out.indexOf('<script>')).toBeGreaterThan(out.indexOf('data-el="a"'));
    expect(out).toContain(WF_MSG.highlight);
    expect(out.trim().endsWith('</body></html>')).toBe(true);
  });
  // WP24b (.tmp/pipeline/wp24b.yaml): screen.json 2.1 thêm elements[].content và
  // layoutSource — parse khoan dung, thiếu/sai kiểu/giá trị lạ thì bỏ qua êm.
  it('parseScreenDoc đọc content{}/layoutSource (2.1) khoan dung: sai kiểu bị bỏ qua êm, doc 2.0 cũ vẫn undefined', () => {
    const withContent = parseScreenDoc(
      JSON.stringify({
        key: K1,
        name: 'Chọn quốc gia',
        platform: 'mobile',
        layoutSource: 'doc-image',
        elements: [
          { id: 'a', label: 'A', role: 'r', confidence: 'high', provenance: 'text', content: { text: 'Hà Nội', secondary: 'Miền Bắc', value: '+84', badge: 'Mặc định', items: ['Quận 1', 'Quận 2'] } },
        ],
      }),
      'fallback',
    );
    expect(withContent?.layoutSource).toBe('doc-image');
    expect(withContent?.elements[0]?.content).toEqual({ text: 'Hà Nội', secondary: 'Miền Bắc', value: '+84', badge: 'Mặc định', items: ['Quận 1', 'Quận 2'] });

    const legacy = parseScreenDoc(JSON.stringify({ key: K1, name: 'A', platform: 'mobile', elements: [{ id: 'a', label: 'A', role: 'r', confidence: 'high', provenance: 'text' }] }), 'fallback');
    expect(legacy?.layoutSource).toBeUndefined();
    expect(legacy?.elements[0]?.content).toBeUndefined();

    const badTypes = parseScreenDoc(
      JSON.stringify({
        key: K1,
        name: 'A',
        platform: 'mobile',
        layoutSource: 'từ-sao-hoả',
        elements: [{ id: 'a', label: 'A', role: 'r', confidence: 'high', provenance: 'text', content: { text: 42, items: 'không phải mảng', badge: 'OK' } }],
      }),
      'fallback',
    );
    expect(badTypes?.layoutSource).toBeUndefined();
    expect(badTypes?.elements[0]?.content).toEqual({ badge: 'OK' });
  });
});

const INDEX = {
  schema_version: '2.0',
  screens: [
    { key: K1, name: 'Chọn quốc gia', flowId: 'FLOW-a', order: 0, platform: 'mobile', elements: 3, mapped: 2, navOut: [K2] },
    { key: K2, name: 'Chọn gói cước', flowId: 'FLOW-a', order: 1, platform: 'mobile', elements: 1, mapped: 1, navOut: [] },
  ],
  failed: [{ key: K3, name: 'Thanh toán', errors: ['Wireframe không được chứa <script>.'] }],
};
const DOC1 = {
  key: K1,
  name: 'Chọn quốc gia',
  flowId: 'FLOW-a',
  platform: 'mobile',
  source: 'docs-feature/PRD-Mua-SIM.md',
  elements: [
    { id: 'appbar', label: 'Chọn quốc gia', role: 'app-bar', ds: { component: 'Top App Bar', anchor: 'top-app-bar', variant: 'Back=true' }, confidence: 'high', provenance: 'ds' },
    { id: 'list', label: 'Danh sách quốc gia', role: 'list-item', ds: { component: 'List Item', anchor: 'list-item' }, confidence: 'medium', provenance: 'table', docType: 'List', why: 'Chọn 1 mục nên dùng List Item' },
    { id: 'empty', label: 'Không có quốc gia', role: 'empty-state', ds: null, confidence: 'low', provenance: 'ds' },
  ],
  nav: [{ el: 'list', to: K2 }],
  notes: ['Tài liệu không nói loading.'],
  warnings: ['element "list": "list item" khớp tên "List Item".'],
};
const DOC2 = { key: K2, name: 'Chọn gói cước', flowId: 'FLOW-a', platform: 'mobile', source: 'docs-feature/PRD-Mua-SIM.md', elements: [{ id: 'cta', label: 'Tiếp tục', role: 'primary-cta', ds: { component: 'Button', anchor: 'button' }, confidence: 'high', provenance: 'flow' }], nav: [] };
const HTML1 = `<!doctype html><html><head><style>.wf-component{}</style></head><body data-screen="${K1}" data-layout="mobile"><main><div class="wf-component" data-el="appbar">Chọn quốc gia</div><div class="wf-component" data-el="list" data-nav="${K2}">Danh sách</div><div class="wf-component" data-el="empty">Trống</div></main></body></html>`;
const HTML2 = `<!doctype html><html><head><style></style></head><body data-screen="${K2}" data-layout="mobile"><button data-el="cta">Tiếp tục</button></body></html>`;

function seed() {
  FILES['docs-review/comp/index.json'] = JSON.stringify(INDEX);
  FILES['docs-review/comp/_role-map.json'] = JSON.stringify({ platform: 'mobile', roles: [{ role: 'app-bar', component: 'Top App Bar', anchor: 'top-app-bar' }, { role: 'empty-state', component: null, fallback: 'Typography + Button' }] });
  FILES['docs-review/.figma-catalog/components.json'] = JSON.stringify({ files: [{ fileKey: 'FK', components: [{ name: 'List Item', nodeId: '1:2' }] }] });
  FILES[`docs-review/comp/${K1}.screen.json`] = JSON.stringify(DOC1);
  FILES[`docs-review/comp/${K2}.screen.json`] = JSON.stringify(DOC2);
  FILES[`docs-review/wireframes/${K1}.html`] = HTML1;
  FILES[`docs-review/wireframes/${K2}.html`] = HTML2;
}

describe('ScreenComponentsPreview', () => {
  it('rail theo thứ tự luồng + màn hỏng; panel element có DS/biến thể/tin cậy/nguồn/lý do/link Figma; iframe sandbox allow-scripts với cầu nối', async () => {
    seed();
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());

    // Rail: 2 màn thành công + 1 màn hỏng, đúng thứ tự.
    const rail = screen.getByLabelText('Màn hình của luồng');
    expect(rail.textContent).toContain('Chọn quốc gia');
    expect(rail.textContent).toContain('Chọn gói cước');
    expect(rail.textContent).toContain('Thanh toán');
    expect(rail.textContent).toContain('chạy hỏng');
    expect(rail.textContent).toContain('2/3 map DS');
    expect(screen.getByTestId(`rail-${K1}`).getAttribute('aria-current')).toBe('true');

    // Header + panel.
    expect(screen.getByTestId('mapped-count').textContent).toBe('2/3 element có component DS');
    const list = screen.getByTestId('element-list');
    expect(list.textContent).toContain('Top App Bar');
    expect(list.textContent).toContain('Back=true');
    expect(list.textContent).toContain('Tin cậy cao');
    expect(list.textContent).toContain('Bảng cấu trúc');
    expect(list.textContent).toContain('tài liệu khai: List');
    expect(list.textContent).toContain('Chọn 1 mục nên dùng List Item');
    expect(list.textContent).toContain('Không có component DS — Typography + Button');
    expect(list.textContent).toContain('→ Chọn gói cước');
    const figma = list.querySelector('a[href^="https://www.figma.com/design/FK?node-id=1-2"]');
    expect(figma).toBeTruthy();
    expect(screen.getByText('Tài liệu không nói loading.')).toBeTruthy();
    expect(screen.getByTestId('screen-warnings').textContent).toContain('khớp tên "List Item"');

    // Iframe: sandbox allow-scripts + srcDoc là wireframe đã chèn cầu nối.
    const frame = screen.getByTestId('wireframe-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain(`data-screen="${K1}"`);
    expect(frame.getAttribute('srcdoc')).toContain(WF_MSG.el);

    // Bấm element trong panel → active (aria-pressed).
    fireEvent.click(screen.getByTestId('el-list'));
    expect(screen.getByTestId('el-list').getAttribute('aria-pressed')).toBe('true');

    // Bấm màn khác trong rail → tải doc + wireframe của màn đó.
    fireEvent.click(screen.getByTestId(`rail-${K2}`));
    await waitFor(() => expect(screen.getByTestId('mapped-count').textContent).toBe('1/1 element có component DS'));
    expect(screen.getByTestId('element-list').textContent).toContain('Tiếp tục');
    expect((screen.getByTestId('wireframe-frame') as HTMLIFrameElement).getAttribute('srcdoc')).toContain(`data-screen="${K2}"`);

    // Màn hỏng: hiện lỗi thay cho wireframe.
    fireEvent.click(screen.getByTestId(`rail-${K3}`));
    await waitFor(() => expect(screen.getByTestId('screen-failed')).toBeTruthy());
    expect(screen.getByTestId('screen-failed').textContent).toContain('Wireframe không được chứa <script>.');
  });

  it('thông điệp postMessage từ iframe: chọn element / điều hướng sang màn đích', async () => {
    seed();
    render(<ScreenComponentsPreview projectId="p1" file={file('docs-review/comp/index.json')} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    const frame = screen.getByTestId('wireframe-frame') as HTMLIFrameElement;
    // jsdom không chạy script trong srcDoc — giả lập thông điệp từ contentWindow.
    window.dispatchEvent(new MessageEvent('message', { data: { type: WF_MSG.el, el: 'appbar' }, source: frame.contentWindow }));
    await waitFor(() => expect(screen.getByTestId('el-appbar').getAttribute('aria-pressed')).toBe('true'));
    window.dispatchEvent(new MessageEvent('message', { data: { type: WF_MSG.nav, to: K2 }, source: frame.contentWindow }));
    await waitFor(() => expect(screen.getByTestId(`rail-${K2}`).getAttribute('aria-current')).toBe('true'));
    // Thông điệp từ nguồn khác bị bỏ qua.
    window.dispatchEvent(new MessageEvent('message', { data: { type: WF_MSG.nav, to: K1 }, source: window }));
    expect(screen.getByTestId(`rail-${K2}`).getAttribute('aria-current')).toBe('true');
  });

  it('chưa có index.json (đang chạy dở) → rail từ _inputs.json; không có gì → nhắc chạy dr-flow', async () => {
    FILES['docs-review/comp/_inputs.json'] = JSON.stringify({ screens: [{ key: K1, name: 'Chọn quốc gia', order: 0 }, { key: K2, name: 'Chọn gói cước', order: 1 }] });
    FILES[`docs-review/comp/${K1}.screen.json`] = JSON.stringify(DOC1);
    FILES[`docs-review/wireframes/${K1}.html`] = HTML1;
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    expect(screen.getByLabelText('Màn hình của luồng').textContent).toContain('Chọn gói cước');
    cleanup();
    render(<ScreenComponentsPreview projectId="p1" file={file('other/comp/index.json')} />);
    await waitFor(() => expect(screen.getByText(/Chưa có màn hình nào/)).toBeTruthy());
  });

  // WP24b (.tmp/pipeline/wp24b.yaml): badge nguồn bố cục + dòng nội dung gộp trong panel.
  it('doc 2.1 layoutSource "doc-image": badge "theo ảnh tài liệu" + panel hiện dòng nội dung gộp', async () => {
    seed();
    const doc = { ...DOC1, layoutSource: 'doc-image' as const, elements: [{ ...DOC1.elements[0]!, content: { text: 'Việt Nam', secondary: '+84', value: 'VN', badge: 'Mặc định', items: ['Hà Nội', 'TP.HCM'] } }, DOC1.elements[1]!, DOC1.elements[2]!] };
    FILES[`docs-review/comp/${K1}.screen.json`] = JSON.stringify(doc);
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    expect(screen.getByText('Bố cục & nội dung: theo ảnh tài liệu')).toBeTruthy();
    expect(screen.getByTestId('el-appbar').textContent).toContain('Việt Nam · +84 · VN · Mặc định · Hà Nội | TP.HCM');
  });

  it('doc 2.1 layoutSource "agent": badge cảnh báo "agent tự dựng…"', async () => {
    seed();
    const doc = { ...DOC1, layoutSource: 'agent' as const };
    FILES[`docs-review/comp/${K1}.screen.json`] = JSON.stringify(doc);
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    expect(screen.getByText('Bố cục & nội dung: agent tự dựng (tài liệu không có mockup)')).toBeTruthy();
  });

  it('doc 2.0 cũ (không content/layoutSource): không có badge nguồn bố cục, panel như cũ, không crash', async () => {
    seed();
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    expect(screen.queryByText(/Bố cục & nội dung/)).toBeNull();
    expect(screen.getByTestId('el-appbar').textContent).toContain('Top App Bar');
  });

  it('content sai kiểu (text là số, items là string) → bỏ qua êm, không crash, panel vẫn hiện phần hợp lệ', async () => {
    seed();
    const doc = { ...DOC1, elements: [{ ...DOC1.elements[0]!, content: { text: 42, items: 'không phải mảng', badge: 'OK' } }, DOC1.elements[1]!, DOC1.elements[2]!] };
    FILES[`docs-review/comp/${K1}.screen.json`] = JSON.stringify(doc);
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    expect(screen.getByTestId('el-appbar').textContent).toContain('OK');
  });
});

// WP25b (.tmp/pipeline/wp25-plan.md, Spec WP25b) — "Dựng trong Figma" per màn:
// nút render, POST start body {screenKeys}, mã lỗi → thông điệp hành động
// được, frameUrl → link, cấu hình file preview GET/PUT.
describe('ScreenComponentsPreview · Dựng trong Figma (WP25b)', () => {
  it('nút "Dựng trong Figma" + "Dựng tất cả (N màn)" render khi có current; bấm nút hiện tại → POST {screenKeys:[current]}', async () => {
    seed();
    const runningJob = { id: 'job-1', projectId: 'p1', status: 'running', items: [{ screenKey: K1, status: 'running' }] };
    const fetchMock = mockFigmaBuildFetch({
      start: (body) => {
        expect(body).toEqual({ screenKeys: [K1] });
        return new Response(JSON.stringify({ job: runningJob }), { status: 202 });
      },
    });
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());

    const btn = screen.getByTestId('figma-build-current');
    expect(btn.textContent).toBe('Dựng trong Figma');
    expect(screen.getByTestId('figma-build-all').textContent).toBe('Dựng tất cả (3 màn)');

    fireEvent.click(btn);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/docs-review/figma-build/start'));
      expect(call?.[1]?.method).toBe('POST');
    });
    await waitFor(() => expect(screen.getByTestId('figma-build-progress').textContent).toBe('Đang dựng 0/1…'));
    expect((screen.getByTestId('figma-build-current') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('figma-build-all') as HTMLButtonElement).disabled).toBe(true);
  });

  it('"Dựng tất cả" gửi đúng danh sách toàn bộ screenKeys của rail', async () => {
    seed();
    const fetchMock = mockFigmaBuildFetch({
      start: (body) => {
        expect(body).toEqual({ screenKeys: [K1, K2, K3] });
        return new Response(JSON.stringify({ job: { id: 'job-2', projectId: 'p1', status: 'running', items: [] } }), { status: 202 });
      },
    });
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    fireEvent.click(screen.getByTestId('figma-build-all'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/docs-review/figma-build/start'));
      expect(call).toBeTruthy();
    });
  });

  it.each([
    ['FIGMA_PREVIEW_FILE_REQUIRED', 'Chưa cấu hình file Figma preview — dán link file preview bên dưới rồi thử lại.'],
    ['MCP_FIGMA_REQUIRED', 'Thêm Figma MCP trong Cài đặt → MCP rồi đăng nhập.'],
    ['MCP_FIGMA_CONNECT_REQUIRED', 'Server Figma MCP đã có sẵn — vào Cài đặt → MCP bấm Connect để đăng nhập rồi thử lại.'],
    ['CATALOG_REQUIRED', 'Chưa có component key — Làm mới DS Figma (Refresh ở Design system); App dùng Figma links thì chạy lại bước Màn hình → Component.'],
    ['AGENT_UNAVAILABLE', 'Không có agent khả dụng để dựng — thử lại sau.'],
  ])('lỗi start mã %s → thông điệp tiếng Việt hành động được', async (code, expected) => {
    seed();
    mockFigmaBuildFetch({ start: () => new Response(JSON.stringify({ error: { code, message: 'raw daemon message' } }), { status: 422 }) });
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    fireEvent.click(screen.getByTestId('figma-build-current'));
    await waitFor(() => expect(screen.getByTestId('figma-build-error').textContent).toBe(expected));
    if (code === 'FIGMA_PREVIEW_FILE_REQUIRED') {
      expect(screen.getByTestId('figma-config-panel')).toBeTruthy();
    }
  });

  it('409 (job khác của project đang chạy) → adopt job hiện có, không hiện lỗi', async () => {
    seed();
    const runningJob = { id: 'job-3', projectId: 'p1', status: 'running', items: [{ screenKey: K1, status: 'queued' }] };
    mockFigmaBuildFetch({ start: () => new Response(JSON.stringify({ job: runningJob }), { status: 409 }) });
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    fireEvent.click(screen.getByTestId('figma-build-current'));
    await waitFor(() => expect(screen.getByTestId('figma-build-progress')).toBeTruthy());
    expect(screen.queryByTestId('figma-build-error')).toBeNull();
  });

  it('item màn hiện tại succeeded + frameUrl → link "Mở frame Figma ↗"; item failed → chữ lỗi ngắn, nút vẫn bấm lại được', async () => {
    seed();
    const succeededJob = {
      id: 'job-4', projectId: 'p1', status: 'succeeded',
      items: [{ screenKey: K1, status: 'succeeded', frameUrl: 'https://www.figma.com/design/FK/?node-id=1-2' }],
    };
    mockFigmaBuildFetch({ start: () => new Response(JSON.stringify({ job: succeededJob }), { status: 202 }) });
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    fireEvent.click(screen.getByTestId('figma-build-current'));
    await waitFor(() => expect(screen.getByTestId('figma-frame-link')).toBeTruthy());
    expect(screen.getByTestId('figma-frame-link').getAttribute('href')).toBe('https://www.figma.com/design/FK/?node-id=1-2');
    expect((screen.getByTestId('figma-build-current') as HTMLButtonElement).disabled).toBe(false);
  });

  it('item màn hiện tại failed → hiện lỗi ngắn cạnh nút, nút không bị khoá', async () => {
    seed();
    const failedJob = {
      id: 'job-5', projectId: 'p1', status: 'failed',
      items: [{ screenKey: K1, status: 'failed', error: 'Không tìm thấy component key.' }],
    };
    mockFigmaBuildFetch({ start: () => new Response(JSON.stringify({ job: failedJob }), { status: 202 }) });
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    fireEvent.click(screen.getByTestId('figma-build-current'));
    await waitFor(() => expect(screen.getByTestId('figma-build-item-error').textContent).toBe('Không tìm thấy component key.'));
    expect((screen.getByTestId('figma-build-current') as HTMLButtonElement).disabled).toBe(false);
  });

  it('khối cấu hình file preview: hiện url hiện tại; nhập link mới + Lưu → PUT đúng route/body, cập nhật hiển thị', async () => {
    seed();
    const fetchMock = mockFigmaBuildFetch({
      previewGet: () => new Response(JSON.stringify({ config: { fileKey: 'FK', url: 'https://www.figma.com/design/FK' } }), { status: 200 }),
      previewPut: (body) => {
        expect(body).toEqual({ url: 'https://www.figma.com/design/NEW' });
        return new Response(JSON.stringify({ config: { fileKey: 'NEW', url: 'https://www.figma.com/design/NEW' } }), { status: 200 });
      },
    });
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());

    fireEvent.click(screen.getByTestId('figma-config-toggle'));
    await waitFor(() => expect(screen.getByTestId('figma-config-panel').textContent).toContain('https://www.figma.com/design/FK'));
    expect(screen.getByTestId('figma-config-panel').textContent).toContain('Tạo một file Figma trống làm nơi chứa preview rồi dán link vào đây.');

    fireEvent.change(screen.getByTestId('figma-config-input'), { target: { value: 'https://www.figma.com/design/NEW' } });
    fireEvent.click(screen.getByTestId('figma-config-save'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/docs-review/figma-preview') && c[1]?.method === 'PUT');
      expect(call).toBeTruthy();
    });
    await waitFor(() => expect(screen.getByTestId('figma-config-panel').textContent).toContain('https://www.figma.com/design/NEW'));
  });

  it('PUT lỗi validate → hiện message dưới ô nhập, không đóng khối cấu hình', async () => {
    seed();
    mockFigmaBuildFetch({ previewPut: () => new Response(JSON.stringify({ error: 'Link Figma không hợp lệ.' }), { status: 400 }) });
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K1}.screen.json`)} />);
    await waitFor(() => expect(screen.getByTestId('element-list')).toBeTruthy());
    fireEvent.click(screen.getByTestId('figma-config-toggle'));
    fireEvent.change(screen.getByTestId('figma-config-input'), { target: { value: 'bad-link' } });
    fireEvent.click(screen.getByTestId('figma-config-save'));
    await waitFor(() => expect(screen.getByTestId('figma-config-error').textContent).toBe('Link Figma không hợp lệ.'));
    expect(screen.getByTestId('figma-config-panel')).toBeTruthy();
  });
});
