// @vitest-environment jsdom
//
// Sơ đồ khối `flows/<FLOW-ID>.flowchart.json` (bước dr-flow của docs-review).
// Ba câu hỏi: file hợp lệ có vẽ đủ bốn loại khối + hộp chú thích không, nhánh
// ra từ điểm quyết định có hiện nhãn không, và file hỏng có báo lỗi gọn thay vì
// làm sập khung nhìn không.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import {
  FlowchartCanvas,
  isFlowchartFile,
  layoutFlowchart,
  parseFlowchartDoc,
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

  it('file hỏng → báo lỗi gọn, không sập khung nhìn', async () => {
    FILES['review/flows/hong.flowchart.json'] = '{ "nodes": [ hỏng';
    const { container } = render(
      <FlowchartPreview projectId="p1" file={file('review/flows/hong.flowchart.json')} />,
    );

    await waitFor(() => expect(container.textContent).toContain('Không đọc được sơ đồ'));
    expect(container.querySelector('.react-flow')).toBeNull();
  });
});
