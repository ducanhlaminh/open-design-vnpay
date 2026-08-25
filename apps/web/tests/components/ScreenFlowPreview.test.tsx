// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const FILES: Record<string, string | null> = {};
let viewerProps: { xml: string; highlightCells?: readonly string[]; onCellClick?: (id: string | null) => void; options?: Record<string, unknown> } | null = null;

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: async (_projectId: string, name: string) => FILES[name] ?? null,
}));
vi.mock('../../src/components/DrawioViewer', () => ({
  DrawioViewer: (props: typeof viewerProps extends infer T ? NonNullable<T> : never) => {
    viewerProps = props;
    return <div data-testid="drawio-viewer">drawio</div>;
  },
}));

const { ScreenFlowPreview, parseScreenFlowIndex, parseScreenFlowModel, screenCellMapFromXml } = await import('../../src/components/ScreenFlowPreview');

const K1 = 'SIM__6.1.1';
const K2 = 'SIM__6.2.1';
const K3 = 'SIM__6.4.4';

afterEach(() => {
  cleanup();
  viewerProps = null;
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
    FILES['docs-review/comp/screen-flows/FLOW-A.screen-flow.json'] = JSON.stringify({ flowId: 'FLOW-A', screens: [{ key: K1 }], unlinkedScreens: [], warnings: [] });
    FILES['docs-review/comp/screen-flows/FLOW-B.screen-flow.json'] = JSON.stringify({ flowId: 'FLOW-B', screens: [{ key: K2 }, { key: K3 }], unlinkedScreens: [K3], warnings: ['Thiếu cạnh cho màn voucher'] });
    FILES['docs-review/comp/screen-flows/FLOW-A.drawio'] = `<mxfile><diagram><mxGraphModel><root><mxCell id="a1" od-screen-key="${K1}" vertex="1"/></root></mxGraphModel></diagram></mxfile>`;
    FILES['docs-review/comp/screen-flows/FLOW-B.drawio'] = `<mxfile><diagram><mxGraphModel><root><mxCell id="b1" od-screen-key="${K2}" vertex="1"/><mxCell id="b2" od-screen-key="${K3}" vertex="1"/></root></mxGraphModel></diagram></mxfile>`;
  }

  it('chọn flow chứa current, hiện nguồn/warning, highlight và click node mở screen', async () => {
    seed();
    const onOpenScreen = vi.fn();
    render(<ScreenFlowPreview projectId="p1" root="docs-review/" currentScreenKey={K2} onOpenScreen={onOpenScreen} />);
    await waitFor(() => expect(screen.getByTestId('drawio-viewer')).toBeTruthy());
    expect((screen.getByLabelText('Chọn luồng màn hình') as HTMLSelectElement).value).toBe('FLOW-B');
    expect(screen.getByText('Tái sử dụng từ tài liệu')).toBeTruthy();
    expect(screen.getByText(/1 màn chưa xác định điều hướng/)).toBeTruthy();
    expect(screen.getByText(/flows\/FLOW-B\/as-is.drawio/)).toBeTruthy();
    expect(viewerProps?.highlightCells).toEqual(['b1']);
    viewerProps?.onCellClick?.('b2');
    expect(onOpenScreen).toHaveBeenCalledWith(K3);
    viewerProps?.onCellClick?.('edge-1');
    viewerProps?.onCellClick?.(null);
    expect(onOpenScreen).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Đề xuất')).toBeNull();
    expect(viewerProps?.options).toEqual({ toolbar: 'zoom' });
  });

  it('đổi nhiều flow tải drawio tương ứng', async () => {
    seed();
    render(<ScreenFlowPreview projectId="p1" root="docs-review/" currentScreenKey={K1} onOpenScreen={() => {}} />);
    await waitFor(() => expect(viewerProps?.xml).toContain('id="a1"'));
    fireEvent.change(screen.getByLabelText('Chọn luồng màn hình'), { target: { value: 'FLOW-B' } });
    await waitFor(() => expect(viewerProps?.xml).toContain('id="b1"'));
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
