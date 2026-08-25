// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { layoutScreenFlow, ScreenFlowCanvas, type ScreenFlowCanvasModel } from '../../src/components/ScreenFlowCanvas';

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
// React Flow (@xyflow) reads the pane transform via DOMMatrixReadOnly; jsdom lacks it.
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
}));
// React Flow measures node/pane size via offset*/getBBox; jsdom returns 0 so nodes never mount.
Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get() { return 800; } },
  offsetHeight: { configurable: true, get() { return 600; } },
});
if (typeof SVGElement !== 'undefined' && !(SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox) {
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}

afterEach(cleanup);

const model: ScreenFlowCanvasModel = {
  entryScreens: ['SIM__6.1.1'],
  screens: [
    { key: 'SIM__6.1.1', name: '6.1.1 Màn hình trang chủ', linked: true },
    { key: 'SIM__6.2.1', name: '6.2.1 Màn hình chọn Quốc gia & Khu vực', linked: true },
    { key: 'SIM__6.4.4', name: '6.4.4 Mã voucher', linked: false },
  ],
  edges: [
    { id: 'e1', from: 'SIM__6.1.1', to: 'SIM__6.2.1', kind: 'branch', condition: 'SIM du lịch Quốc tế', via: '| nguyên dòng bảng rất dài | <br> nội dung thừa' },
    { id: 'e2', from: 'SIM__6.2.1', to: 'SIM__6.1.1', kind: 'return', via: 'Quay lại' },
  ],
  unlinkedScreens: ['SIM__6.4.4'],
};

describe('ScreenFlowCanvas', () => {
  it('lays forward nodes in layers and routes returns outside the main flow', () => {
    const layout = layoutScreenFlow(model);
    const home = layout.nodes.find((node) => node.key === 'SIM__6.1.1')!;
    const country = layout.nodes.find((node) => node.key === 'SIM__6.2.1')!;
    expect(country.y).toBeGreaterThan(home.y);
    expect(layout.edges.find((edge) => edge.id === 'e2')?.back).toBe(true);
    expect(layout.unlinkedTop).not.toBeNull();
  });

  it('ranks parallel branches and their merge from semantic edges only', () => {
    const topology: ScreenFlowCanvasModel = {
      entryScreens: ['FLOW__HOME'],
      screens: [
        { key: 'FLOW__HOME', name: 'Trang chủ', linked: true },
        { key: 'FLOW__VN', name: 'Gói Việt Nam', linked: true },
        { key: 'FLOW__INTL', name: 'Gói Quốc tế', linked: true },
        { key: 'FLOW__DETAIL', name: 'Chi tiết', linked: true },
      ],
      edges: [
        { id: 'vn', from: 'FLOW__HOME', to: 'FLOW__VN', kind: 'branch' },
        { id: 'intl', from: 'FLOW__HOME', to: 'FLOW__INTL', kind: 'branch' },
        { id: 'vn-detail', from: 'FLOW__VN', to: 'FLOW__DETAIL', kind: 'primary' },
        { id: 'intl-detail', from: 'FLOW__INTL', to: 'FLOW__DETAIL', kind: 'primary' },
        { id: 'secondary', from: 'FLOW__HOME', to: 'FLOW__DETAIL', kind: 'secondary' },
        { id: 'return', from: 'FLOW__DETAIL', to: 'FLOW__HOME', kind: 'return' },
      ],
      unlinkedScreens: [],
    };
    const layout = layoutScreenFlow(topology);
    const positions = new Map(layout.nodes.map((node) => [node.key, node]));
    expect(positions.get('FLOW__VN')?.y).toBe(positions.get('FLOW__INTL')?.y);
    expect(positions.get('FLOW__DETAIL')!.y).toBeGreaterThan(positions.get('FLOW__VN')!.y);
    expect(layout.edges.find((edge) => edge.id === 'secondary')?.secondary).toBe(true);
    expect(layout.edges.find((edge) => edge.id === 'return')?.secondary).toBe(true);
  });

  it('renders React Flow, hides secondary navigation by default and opens a screen', () => {
    const onOpenScreen = vi.fn();
    render(<ScreenFlowCanvas model={model} currentScreenKey="SIM__6.1.1" onOpenScreen={onOpenScreen} />);
    expect(screen.getByRole('img', { name: 'Sơ đồ luồng màn hình' })).toBeTruthy();
    expect(screen.getByText('SIM du lịch Quốc tế')).toBeTruthy();
    expect(screen.queryByText('Quay lại')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hiện điều hướng phụ' }));
    expect(screen.getByText('Quay lại')).toBeTruthy();
    expect(screen.queryByText(/nguyên dòng bảng rất dài/)).toBeNull();
    const country = screen.getByRole('button', { name: /Mở màn hình 6\.2\.1/i });
    fireEvent.click(country);
    expect(onOpenScreen).toHaveBeenCalledWith('SIM__6.2.1');
  });

  it('locks dragging and exposes auto-layout and reset callbacks', () => {
    const onLayoutLockedChange = vi.fn();
    const onResetLayout = vi.fn();
    render(
      <ScreenFlowCanvas
        model={model}
        currentScreenKey={null}
        onOpenScreen={() => {}}
        layoutLocked
        onLayoutLockedChange={onLayoutLockedChange}
        onResetLayout={onResetLayout}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mở khóa vị trí node' }));
    expect(onLayoutLockedChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Đặt lại bố cục' }));
    expect(onResetLayout).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Tự sắp xếp' })).toBeTruthy();
  });
});
