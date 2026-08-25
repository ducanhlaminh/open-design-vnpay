// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const FILES: Record<string, string | null> = {};

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => FILES[name] ?? null,
}));

// ScreenFlowPreview mounts ScreenFlowCanvas (React Flow / @xyflow), which needs
// ResizeObserver + DOMMatrixReadOnly — absent in jsdom.
class ResizeObserverMock {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe(target: Element) {
    this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);
class DOMMatrixReadOnlyMock {
  m22 = 1;
  constructor(transform?: string) {
    const scale = typeof transform === 'string' ? transform.match(/scale\(([\d.]+)\)/)?.[1] : undefined;
    if (scale !== undefined) this.m22 = Number(scale);
  }
}
vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyMock);
vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
  x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
  toJSON: () => ({}),
}) as DOMRect);
Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get() { return 800; } },
  offsetHeight: { configurable: true, get() { return 600; } },
});
if (typeof SVGElement !== 'undefined' && !(SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox) {
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}

const { ScreenFlowPreview, parseScreenFlowIndex, parseScreenFlowModel, screenCellMapFromXml } = await import('../../src/components/ScreenFlowPreview');

const K1 = 'SIM__6.1.1';
const K2 = 'SIM__6.2.1';
const K3 = 'SIM__6.4.4';

afterEach(() => {
  cleanup();
  for (const key of Object.keys(FILES)) delete FILES[key];
});

describe('screen-flow parsers', () => {
  it('đọc index/model khoan dung và bỏ entry không có id/files', () => {
    const index = parseScreenFlowIndex(JSON.stringify({ schemaVersion: '1.0', flows: [{ id: 'FLOW-A', title: 'Mua SIM', sourceMode: 'reused', files: { model: 'screen-flows/FLOW-A.screen-flow.json', drawio: 'screen-flows/FLOW-A.drawio' }, unlinkedCount: 1 }, { title: 'bad' }] }));
    expect(index?.flows).toHaveLength(1);
    expect(index?.flows[0]?.id).toBe('FLOW-A');
    expect(parseScreenFlowIndex('{bad')).toBeNull();
    expect(parseScreenFlowModel(JSON.stringify({ flowId: 'FLOW-A', screens: [{ key: K1 }, { key: '' }], unlinkedScreens: [K3], warnings: ['w'] }))?.screens.map((s) => s.key)).toEqual([K1]);
  });

  it('map cell bằng metadata od-screen-key, không dựa vào label', () => {
    const xml = `<mxfile><diagram><mxGraphModel><root><mxCell id="n1" value="Tên bất kỳ" od-screen-key="${K1}" vertex="1"/><object id="n2" od-screen-key="${K2}"><mxCell vertex="1"/></object></root></mxGraphModel></diagram></mxfile>`;
    expect([...screenCellMapFromXml(xml).entries()]).toEqual([['n1', K1], ['n2', K2]]);
  });
});

describe('ScreenFlowPreview', () => {
  function seed() {
    FILES['docs-review/comp/screen-flows/index.json'] = JSON.stringify({
      schemaVersion: '1.0',
      flows: [
        { id: 'FLOW-A', title: 'Luồng A', sourceMode: 'generated', files: { model: 'screen-flows/FLOW-A.screen-flow.json', drawio: 'screen-flows/FLOW-A.drawio' }, unlinkedCount: 0 },
        { id: 'FLOW-B', title: 'Luồng B', sourceMode: 'reused', source: { path: 'flows/FLOW-B/as-is.drawio' }, files: { model: 'screen-flows/FLOW-B.screen-flow.json', drawio: 'screen-flows/FLOW-B.drawio' }, unlinkedCount: 1 },
      ],
    });
    FILES['docs-review/comp/screen-flows/FLOW-A.screen-flow.json'] = JSON.stringify({ flowId: 'FLOW-A', entryScreens: [K1], screens: [{ key: K1, name: '6.1.1 Trang chủ', linked: true }], edges: [], unlinkedScreens: [], warnings: [] });
    FILES['docs-review/comp/screen-flows/FLOW-B.screen-flow.json'] = JSON.stringify({ flowId: 'FLOW-B', entryScreens: [K2], screens: [{ key: K2, name: '6.2.1 Chọn quốc gia', linked: true }, { key: K3, name: '6.4.4 Mã voucher', linked: false }], edges: [], unlinkedScreens: [K3], warnings: ['Thiếu cạnh cho màn voucher'] });
    FILES['docs-review/comp/screen-flows/FLOW-A.drawio'] = `<mxfile><diagram><mxGraphModel><root><mxCell id="a1" od-screen-key="${K1}" vertex="1"/></root></mxGraphModel></diagram></mxfile>`;
    FILES['docs-review/comp/screen-flows/FLOW-B.drawio'] = `<mxfile><diagram><mxGraphModel><root><mxCell id="b1" od-screen-key="${K2}" vertex="1"/><mxCell id="b2" od-screen-key="${K3}" vertex="1"/></root></mxGraphModel></diagram></mxfile>`;
  }

  it('chọn flow chứa current, hiện nguồn/warning, highlight và click node SVG mở screen', async () => {
    seed();
    const onOpenScreen = vi.fn();
    render(<ScreenFlowPreview projectId="p1" root="docs-review/" currentScreenKey={K2} onOpenScreen={onOpenScreen} />);
    await waitFor(() => expect(screen.getByTestId('screen-flow-canvas')).toBeTruthy());
    expect((screen.getByLabelText('Chọn luồng màn hình') as HTMLSelectElement).value).toBe('FLOW-B');
    expect(screen.getByText('Tái sử dụng từ tài liệu')).toBeTruthy();
    expect(screen.getByText(/1 màn chưa xác định điều hướng/)).toBeTruthy();
    expect(screen.getByText(/flows\/FLOW-B\/as-is.drawio/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Mở màn hình 6\.2\.1 Chọn quốc gia/i }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Mở màn hình 6\.4\.4 Mã voucher/i }));
    expect(onOpenScreen).toHaveBeenCalledWith(K3);
    expect(onOpenScreen).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Đề xuất')).toBeNull();
  });

  it('đổi nhiều flow cập nhật canvas và file Draw.io tải xuống tương ứng', async () => {
    seed();
    render(<ScreenFlowPreview projectId="p1" root="docs-review/" currentScreenKey={K1} onOpenScreen={() => {}} />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Tải .drawio' }).getAttribute('download')).toBe('FLOW-A.drawio'));
    fireEvent.change(screen.getByLabelText('Chọn luồng màn hình'), { target: { value: 'FLOW-B' } });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Tải .drawio' }).getAttribute('download')).toBe('FLOW-B.drawio'));
    expect(screen.getByRole('button', { name: /Mở màn hình 6\.2\.1 Chọn quốc gia/i })).toBeTruthy();
  });

  it('đổi màn trên rail tự chuyển sang flow chứa màn và không lặp warning', async () => {
    seed();
    const index = JSON.parse(FILES['docs-review/comp/screen-flows/index.json']!);
    index.flows[1].warnings = ['Thiếu cạnh cho màn voucher'];
    FILES['docs-review/comp/screen-flows/index.json'] = JSON.stringify(index);
    const { rerender } = render(<ScreenFlowPreview projectId="p1" root="docs-review/" currentScreenKey={K3} onOpenScreen={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText('Chọn luồng màn hình') as HTMLSelectElement).value).toBe('FLOW-B'));
    expect(screen.getAllByText('Thiếu cạnh cho màn voucher')).toHaveLength(1);
    rerender(<ScreenFlowPreview projectId="p1" root="docs-review/" currentScreenKey={K1} onOpenScreen={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText('Chọn luồng màn hình') as HTMLSelectElement).value).toBe('FLOW-A'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Mở màn hình 6\.1\.1 Trang chủ/i })).toBeTruthy());
  });

  it('preview SVG không phụ thuộc file Draw.io; thiếu Draw.io chỉ mất nút tải', async () => {
    seed();
    FILES['docs-review/comp/screen-flows/FLOW-A.drawio'] = null;
    render(<ScreenFlowPreview projectId="p1" root="docs-review/" currentScreenKey={K1} onOpenScreen={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('screen-flow-canvas')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/preview SVG vẫn hoạt động/)).toBeTruthy());
    expect(screen.queryByRole('link', { name: 'Tải .drawio' })).toBeNull();
    expect(screen.getByRole('button', { name: /Mở màn hình 6\.1\.1 Trang chủ/i })).toBeTruthy();
  });

  it('thiếu hoặc hỏng artifact fail-soft và yêu cầu chạy lại riêng dr-comp', async () => {
    FILES['docs-review/comp/screen-flows/index.json'] = null;
    const { rerender } = render(<ScreenFlowPreview projectId="p1" root="docs-review/" currentScreenKey={K1} onOpenScreen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Chưa có luồng màn hình/)).toBeTruthy());
    expect(screen.getByText(/Màn hình → Component/)).toBeTruthy();
    FILES['docs-review/comp/screen-flows/index.json'] = '{bad';
    rerender(<ScreenFlowPreview projectId="p1" root="docs-review/" currentScreenKey={K1} onOpenScreen={() => {}} fileMtime={2} />);
    await waitFor(() => expect(screen.getByText(/Không đọc được dữ liệu luồng màn hình/)).toBeTruthy());
  });
});
