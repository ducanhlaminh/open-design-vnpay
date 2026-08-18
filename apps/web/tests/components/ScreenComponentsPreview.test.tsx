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
  for (const k of Object.keys(FILES)) delete FILES[k];
});

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
});
