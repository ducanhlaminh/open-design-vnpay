// @vitest-environment jsdom
//
// WP dr-review-screen-flow (2026-08-27) — Executor B (web):
//   B1 ScreenFlowPanelViewer: sơ đồ Luồng màn hình BẢN ĐÃ CHỌN (selection.json;
//      404 → original → as-is.drawio page 0; improved → proposed.drawio page 1),
//      badge bản, nút Phóng to (overlay portal + Esc), fail-soft khi thiếu file.
//   B2 DocRedlinePreview: change/note kind flow (hoặc gap/edge-case có rule_id
//      `flows/SCREEN-FLOW…#…`) → right panel hiện viewer + tô cell theo ref
//      (ux-review#UX-xx / screens.json#KEY / flowchart.json#from→to).
//   B3 Xuất PDF: sheet in có mục "Luồng màn hình — bản …" với SVG clone từ
//      viewer in offscreen; không có SCREEN-FLOW → không có mục.
//
// DrawioViewer thật cần window.GraphViewer (script vendor ~4MB) — stub đọc
// lại props (xml/page/highlightCells) và tự nhét một <svg> để đường in có
// gì mà clone (cùng kỹ thuật doc-redline-drawio.test.tsx).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

type LoggedProps = { xml: string; page?: number; highlightCells?: readonly unknown[] };
const drawioPropsLog: LoggedProps[] = [];
vi.mock('../../src/components/DrawioViewer', () => ({
  DrawioViewer: (props: LoggedProps) => {
    drawioPropsLog.push({ xml: props.xml, page: props.page, highlightCells: props.highlightCells });
    return (
      <div data-testid="drawio-viewer" data-page={props.page} data-cells={JSON.stringify(props.highlightCells ?? null)}>
        <svg data-testid="drawio-svg" viewBox="0 0 10 10" />
      </div>
    );
  },
}));
vi.mock('../../src/components/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => <div data-testid="mermaid-diagram">{code}</div>,
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  drawioPropsLog.length = 0;
});

beforeAll(() => {
  Element.prototype.scrollIntoView = function noop() {};
  window.print = vi.fn();
});

const PREFIX = 'docs-review';
const AS_IS_XML = [
  '<mxfile><diagram name="Luồng" id="d0"><mxGraphModel><root>',
  '<mxCell id="0"/><mxCell id="1" parent="0"/>',
  '<mxCell id="od-a" value="Đăng nhập" vertex="1" parent="1"/>',
  '<mxCell id="od-b" value="Kết quả" vertex="1" parent="1"/>',
  '<mxCell id="od-e1" edge="1" source="od-a" target="od-b" parent="1"/>',
  '</root></mxGraphModel></diagram></mxfile>',
].join('');
const PROPOSED_XML = [
  '<mxfile>',
  '<diagram name="Hiện trạng" id="p0"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>',
  '<mxCell id="od-a" vertex="1" parent="1"/><mxCell id="od-b" vertex="1" parent="1"/>',
  '<mxCell id="od-e1" edge="1" source="od-a" target="od-b" parent="1"/>',
  '</root></mxGraphModel></diagram>',
  '<diagram name="Đề xuất" id="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>',
  '<mxCell id="od-a" vertex="1" parent="1"/><mxCell id="od-n1" vertex="1" parent="1"/><mxCell id="od-b" vertex="1" parent="1"/>',
  '<mxCell id="od-e2" edge="1" source="od-a" target="od-n1" parent="1"/>',
  '<mxCell id="od-e3" edge="1" source="od-n1" target="od-b" parent="1"/>',
  '</root></mxGraphModel></diagram>',
  '</mxfile>',
].join('');

const UX_REVIEW = JSON.stringify({
  flowId: 'SCREEN-FLOW',
  verdict: 'needs-improvement',
  summary: '',
  findings: [
    {
      id: 'UX-01',
      severity: 'major',
      title: 'Thiếu bước xác nhận',
      reason: 'Sau OTP không có màn xác nhận.',
      cells: { asIs: ['od-a'], proposed: ['od-n1'] },
      change: 'added',
    },
  ],
});
const SCREENS = JSON.stringify({
  screens: [{ key: 'urd__S1', code: 'S1', name: 'Đăng nhập', anchorText: 'Màn đăng nhập hiện form.', cell: 'od-a' }],
});
const SCREENS_IMPROVED = JSON.stringify({
  schema_version: 1,
  screens: [{ key: 'urd__X1', name: 'Xác nhận', cell: 'od-n1', provenance: 'proposed' }],
});

const EDITED = [
  '# Tài liệu',
  '',
  'Người dùng nhập OTP.',
  '',
  'Màn đăng nhập hiện form.',
  '',
  'Sau khi xác nhận hệ thống chuyển sang màn kết quả.',
  '',
  'Nếu lỗi thì quay về trang chủ.',
  '',
  'Màn xác nhận chưa được mô tả.',
  '',
].join('\n');

const CHANGES = JSON.stringify([
  {
    id: 'c-ux',
    kind: 'flow',
    severity: 'major',
    rule_id: 'flows/SCREEN-FLOW/ux-review.json#UX-01',
    before: 'Người dùng nhập OTP.',
    quote: 'Người dùng nhập OTP rồi xác nhận.',
    reason: 'Bản cải thiện thêm màn xác nhận (UX-01).',
  },
  {
    id: 'c-edge',
    kind: 'flow',
    severity: 'minor',
    rule_id: 'flows/SCREEN-FLOW.flowchart.json#od-a→od-b',
    before: 'Sau khi xác nhận hệ thống chuyển sang màn kết quả.',
    quote: 'Sau khi đăng nhập hệ thống chuyển sang màn kết quả.',
    reason: 'Câu điều hướng lệch cạnh Đăng nhập → Kết quả.',
  },
  {
    id: 'c-edge-miss',
    kind: 'flow',
    severity: 'minor',
    rule_id: 'flows/SCREEN-FLOW.flowchart.json#od-b→od-zz',
    before: 'Nếu lỗi thì quay về trang chủ.',
    quote: 'Nếu lỗi thì quay về màn Kết quả.',
    reason: 'Cạnh không tồn tại trong luồng.',
  },
]);
const NOTES = JSON.stringify([
  {
    id: 'n-gap',
    kind: 'gap',
    severity: 'major',
    rule_id: 'flows/SCREEN-FLOW/screens.json#urd__S1',
    anchor: 'Màn đăng nhập hiện form.',
    finding: 'Luồng màn hình có màn «Đăng nhập» nhưng tài liệu chưa có mục mô tả',
    suggestion: 'Bổ sung mục mô tả màn.',
  },
  {
    id: 'n-gap-x',
    kind: 'gap',
    severity: 'major',
    rule_id: 'flows/SCREEN-FLOW/screens.improved.json#urd__X1',
    anchor: 'Màn xác nhận chưa được mô tả.',
    finding: 'Tài liệu chưa mô tả màn do bản cải thiện đề xuất (UX-01)',
    suggestion: 'Bổ sung mục mô tả màn Xác nhận.',
  },
]);

const FILE = {
  name: `${PREFIX}/review/docs/confluence/urd.md`,
  kind: 'text',
  size: EDITED.length,
  mtime: 1,
} as never;

function mockProject(opts: { selection?: 'original' | 'improved' | 'missing'; noFlow?: boolean } = {}) {
  const fetchCalls: string[] = [];
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      fetchCalls.push(name);
      if (name.endsWith('.changes.json')) return CHANGES;
      if (name.endsWith('.notes.json')) return NOTES;
      if (name.endsWith('/SCREEN-FLOW/selection.json')) {
        if (!opts.selection || opts.selection === 'missing') return null;
        return JSON.stringify({ variant: opts.selection, source: 'user', at: '2026-08-27T00:00:00Z' });
      }
      if (name.endsWith('/SCREEN-FLOW/as-is.drawio')) return opts.noFlow ? null : AS_IS_XML;
      if (name.endsWith('/SCREEN-FLOW/proposed.drawio')) return opts.noFlow ? null : PROPOSED_XML;
      if (name.endsWith('/SCREEN-FLOW/ux-review.json')) return UX_REVIEW;
      if (name.endsWith('/SCREEN-FLOW/screens.json')) return SCREENS;
      if (name.endsWith('/SCREEN-FLOW/screens.improved.json')) return SCREENS_IMPROVED;
      if (name.endsWith('.md')) return EDITED;
      return null;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
  return fetchCalls;
}

async function mount(opts?: Parameters<typeof mockProject>[0]) {
  vi.resetModules();
  const fetchCalls = mockProject(opts);
  const mod = await import('../../src/components/DocRedlinePreview');
  const utils = render(<mod.DocRedlinePreview projectId="p1" file={FILE} />);
  return { ...utils, fetchCalls, mod };
}

async function openChange(container: HTMLElement, baseElement: HTMLElement, id: string) {
  await waitFor(() => {
    expect(container.querySelector(`mark[data-change-id="${id}"]`)).not.toBeNull();
  });
  fireEvent.click(container.querySelector(`mark[data-change-id="${id}"]`)!);
  return waitFor(() => {
    const el = baseElement.querySelector<HTMLElement>('aside[role="dialog"]');
    expect(el).not.toBeNull();
    return el!;
  });
}

async function openNote(container: HTMLElement, baseElement: HTMLElement, id: string) {
  const notesTab = await waitFor(() => {
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Nhận xét'));
    expect(btn).toBeTruthy();
    return btn as HTMLButtonElement;
  });
  fireEvent.click(notesTab);
  await waitFor(() => {
    expect(container.querySelector(`mark[data-change-id="note:${id}"]`)).not.toBeNull();
  });
  fireEvent.click(container.querySelector(`mark[data-change-id="note:${id}"]`)!);
  return waitFor(() => {
    const el = baseElement.querySelector<HTMLElement>('aside[role="dialog"]');
    expect(el).not.toBeNull();
    return el!;
  });
}

/** Viewer TRONG panel (không phải viewer in offscreen) + cells đã tô. */
function panelViewer(dialog: HTMLElement): { el: HTMLElement; cells: unknown } {
  const el = dialog.querySelector<HTMLElement>('[data-testid="panel-screen-flow"] [data-testid="drawio-viewer"]');
  expect(el, 'panel phải có DrawioViewer của Luồng màn hình').not.toBeNull();
  return { el: el!, cells: JSON.parse(el!.dataset.cells ?? 'null') };
}

describe('parseScreenFlowRef / splitEdgeKey / parseScreenCells (thuần)', () => {
  it('tách ba dạng rule_id theo hợp đồng mảnh #; dạng lạ → null', async () => {
    vi.resetModules();
    mockProject();
    const { parseScreenFlowRef, splitEdgeKey, parseScreenCells } = await import('../../src/components/DocRedlinePreview');
    expect(parseScreenFlowRef('flows/SCREEN-FLOW/ux-review.json#UX-01')).toEqual({ file: 'ux-review', id: 'UX-01' });
    expect(parseScreenFlowRef('flows/SCREEN-FLOW/screens.json#urd__S1')).toEqual({ file: 'screens', id: 'urd__S1' });
    expect(parseScreenFlowRef('flows/SCREEN-FLOW/screens.improved.json#urd__X1')).toEqual({ file: 'screens', id: 'urd__X1' });
    expect(parseScreenFlowRef('flows/SCREEN-FLOW.flowchart.json#od-a→od-b')).toEqual({ file: 'flowchart', id: 'od-a→od-b' });
    expect(parseScreenFlowRef('default#flow')).toBeNull();
    expect(parseScreenFlowRef('flows/SCREEN-FLOW/ux-review.json')).toBeNull();
    expect(parseScreenFlowRef('flows/FLOW-x/ux-review.json#UX-01')).toBeNull();
    expect(parseScreenFlowRef(undefined)).toBeNull();
    expect(splitEdgeKey('od-6-4-1→od-n1')).toEqual({ from: 'od-6-4-1', to: 'od-n1' });
    expect(splitEdgeKey('a -> b')).toEqual({ from: 'a', to: 'b' });
    expect(splitEdgeKey('solo')).toBeNull();
    expect(parseScreenCells(SCREENS)).toEqual({ urd__S1: 'od-a' });
    expect(parseScreenCells('{"cells":["x"]}')).toBeNull();
    expect(parseScreenCells('not json')).toBeNull();
  });

  it('findEdgeCellId tìm cạnh theo source/target trên đúng trang; không thấy → null', async () => {
    vi.resetModules();
    mockProject();
    const { findEdgeCellId, parseScreenFlowSelection } = await import('../../src/components/ScreenFlowPanelViewer');
    expect(findEdgeCellId(AS_IS_XML, 0, 'od-a', 'od-b')).toBe('od-e1');
    expect(findEdgeCellId(PROPOSED_XML, 1, 'od-a', 'od-n1')).toBe('od-e2');
    expect(findEdgeCellId(PROPOSED_XML, 0, 'od-a', 'od-n1')).toBeNull();
    expect(findEdgeCellId(AS_IS_XML, 0, 'od-b', 'od-zz')).toBeNull();
    expect(parseScreenFlowSelection(null)).toBe('original');
    expect(parseScreenFlowSelection('{"variant":"improved"}')).toBe('improved');
    expect(parseScreenFlowSelection('garbage')).toBe('original');
  });
});

describe('DocRedlinePreview — right panel Luồng màn hình bản đã chọn (WP dr-review-screen-flow)', () => {
  it('(a)+(e) improved: change kind flow rule_id ux-review.json#UX-01 → panel có viewer proposed.drawio page 1, tô cells.proposed của UX-01 theo change added', async () => {
    const { container, baseElement, fetchCalls } = await mount({ selection: 'improved' });
    const dialog = await openChange(container, baseElement, 'c-ux');
    expect(dialog.textContent).toContain('flows/SCREEN-FLOW/ux-review.json#UX-01');

    await waitFor(() => {
      const { cells } = panelViewer(dialog);
      expect(cells).toEqual([{ id: 'od-n1', kind: 'added' }]);
    });
    const { el } = panelViewer(dialog);
    expect(el.dataset.page).toBe('1');
    expect(dialog.querySelector('[data-testid="screen-flow-variant"]')?.textContent).toContain('Cải thiện');
    expect(fetchCalls).toContain(`${PREFIX}/flows/SCREEN-FLOW/selection.json`);
    expect(fetchCalls).toContain(`${PREFIX}/flows/SCREEN-FLOW/proposed.drawio`);
    expect(fetchCalls).not.toContain(`${PREFIX}/flows/SCREEN-FLOW/as-is.drawio`);
    expect(fetchCalls).toContain(`${PREFIX}/flows/SCREEN-FLOW/ux-review.json`);
    // Phóng to nằm trong panel.
    expect(Array.from(dialog.querySelectorAll('button')).some((b) => b.textContent === 'Phóng to')).toBe(true);
  });

  it('(b)+(e) original (selection 404): note gap screens.json#KEY → viewer as-is.drawio page 0, tô cell của màn', async () => {
    const { container, baseElement, fetchCalls } = await mount({ selection: 'missing' });
    const dialog = await openNote(container, baseElement, 'n-gap');
    await waitFor(() => {
      const { cells } = panelViewer(dialog);
      expect(cells).toEqual(['od-a']);
    });
    const { el } = panelViewer(dialog);
    expect(el.dataset.page).toBe('0');
    expect(dialog.querySelector('[data-testid="screen-flow-variant"]')?.textContent).toContain('Nguyên bản');
    expect(fetchCalls).toContain(`${PREFIX}/flows/SCREEN-FLOW/as-is.drawio`);
    expect(fetchCalls).toContain(`${PREFIX}/flows/SCREEN-FLOW/screens.json`);
    // original → KHÔNG đọc screens.improved.json.
    expect(fetchCalls).not.toContain(`${PREFIX}/flows/SCREEN-FLOW/screens.improved.json`);
  });

  it('(b) improved: note gap screens.improved.json#KEY (màn đề xuất) → tô cell từ screens.improved.json', async () => {
    const { container, baseElement, fetchCalls } = await mount({ selection: 'improved' });
    const dialog = await openNote(container, baseElement, 'n-gap-x');
    await waitFor(() => {
      const { cells } = panelViewer(dialog);
      expect(cells).toEqual(['od-n1']);
    });
    expect(fetchCalls).toContain(`${PREFIX}/flows/SCREEN-FLOW/screens.improved.json`);
  });

  it('(c) flowchart.json#from→to → tô id CẠNH tìm trong XML; cạnh không có → tô hai node from/to', async () => {
    const { container, baseElement } = await mount({ selection: 'original' });
    const dialog = await openChange(container, baseElement, 'c-edge');
    await waitFor(() => {
      const { cells } = panelViewer(dialog);
      expect(cells).toEqual(['od-e1']);
    });

    // Chuyển sang change có cạnh không tồn tại → hai node.
    fireEvent.click(container.querySelector('mark[data-change-id="c-edge-miss"]')!);
    await waitFor(() => {
      const d = baseElement.querySelector<HTMLElement>('aside[role="dialog"]')!;
      expect(d.textContent).toContain('od-b→od-zz');
      const { cells } = panelViewer(d);
      expect(cells).toEqual(['od-b', 'od-zz']);
    });
  });

  it('(d) Phóng to mở overlay toàn màn hình (portal body, role dialog), Esc đóng', async () => {
    const { container, baseElement } = await mount({ selection: 'original' });
    const dialog = await openChange(container, baseElement, 'c-ux');
    const zoom = await waitFor(() => {
      const b = Array.from(dialog.querySelectorAll('button')).find((x) => x.textContent === 'Phóng to');
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });
    fireEvent.click(zoom);
    const overlay = await waitFor(() => {
      const el = baseElement.querySelector<HTMLElement>('[data-testid="screen-flow-fs-overlay"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.textContent).toContain('Nguyên bản');
    // Viewer trong overlay dựng sau 2 rAF.
    await waitFor(() => {
      expect(overlay.querySelector('[data-testid="drawio-viewer"]')).not.toBeNull();
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(baseElement.querySelector('[data-testid="screen-flow-fs-overlay"]')).toBeNull();
    });
    // Nút Đóng cũng đóng.
    fireEvent.click(zoom);
    const closeBtn = await waitFor(() => {
      const el = baseElement.querySelector<HTMLElement>('[data-testid="screen-flow-fs-overlay"]');
      const b = el && Array.from(el.querySelectorAll('button')).find((x) => x.textContent === 'Đóng');
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });
    fireEvent.click(closeBtn);
    await waitFor(() => {
      expect(baseElement.querySelector('[data-testid="screen-flow-fs-overlay"]')).toBeNull();
    });
  });

  it('(f) Xuất PDF: sheet in có mục "Luồng màn hình — bản Cải thiện" với SVG clone; viewer in offscreen nằm ngoài panel', async () => {
    const { container, baseElement } = await mount({ selection: 'improved' });
    // Viewer in offscreen mount ngay khi biết có SCREEN-FLOW (không cần mở panel).
    const host = await waitFor(() => {
      const el = baseElement.querySelector<HTMLElement>('[data-testid="screen-flow-print-host"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(host.querySelector('svg')).not.toBeNull();
    expect(container.contains(host)).toBe(false);

    const section = baseElement.querySelector<HTMLElement>('[data-od-print-sheet] section[data-print-screen-flow]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain('Luồng màn hình — bản Cải thiện');
    expect(section!.querySelector('svg')).toBeNull();

    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Xuất PDF')!);
    await waitFor(() => {
      expect(window.print).toHaveBeenCalled();
    });
    expect(section!.hidden).toBe(false);
    const svg = section!.querySelector<SVGElement>('[data-print-screen-flow-frame] svg');
    expect(svg).not.toBeNull();
    expect(svg!.style.width).toBe('100%');
    expect(svg!.style.transform).toBe('none');
    // Thứ tự: mục Luồng màn hình TRƯỚC phụ lục.
    const sections = Array.from(baseElement.querySelectorAll('[data-od-print-sheet] section'));
    const sfIdx = sections.indexOf(section!);
    const appendixIdx = sections.findIndex((s) => s.textContent?.startsWith('Phụ lục'));
    expect(sfIdx).toBeGreaterThan(-1);
    expect(appendixIdx).toBeGreaterThan(sfIdx);
  });

  it('(f) thiếu SCREEN-FLOW: không có mục in, không có viewer offscreen; panel change flow báo "Chưa có Luồng màn hình"', async () => {
    const { container, baseElement } = await mount({ selection: 'missing', noFlow: true });
    const dialog = await openChange(container, baseElement, 'c-ux');
    await waitFor(() => {
      expect(dialog.querySelector('[data-testid="screen-flow-missing"]')?.textContent).toContain('Chưa có Luồng màn hình');
    });
    expect(dialog.querySelector('[data-testid="drawio-viewer"]')).toBeNull();
    expect(baseElement.querySelector('[data-testid="screen-flow-print-host"]')).toBeNull();
    expect(baseElement.querySelector('[data-od-print-sheet] section[data-print-screen-flow]')).toBeNull();

    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Xuất PDF')!);
    await waitFor(() => {
      expect(window.print).toHaveBeenCalled();
    });
    expect(baseElement.querySelector('[data-od-print-sheet] section[data-print-screen-flow]')).toBeNull();
  });

  it('change kind ux-writing (rule_id default#…) KHÔNG hiện sơ đồ trong panel', async () => {
    vi.resetModules();
    const fetchCalls: string[] = [];
    vi.doMock('../../src/providers/registry', () => ({
      fetchProjectFileText: async (_projectId: string, name: string) => {
        fetchCalls.push(name);
        if (name.endsWith('.changes.json')) {
          return JSON.stringify([
            { id: 'c-w', kind: 'ux-writing', severity: 'minor', rule_id: 'default#ux-writing', before: 'Người dùng nhập OTP.', quote: 'Nhập OTP.', reason: 'Gọn.' },
          ]);
        }
        if (name.endsWith('.notes.json')) return null;
        if (name.endsWith('/SCREEN-FLOW/selection.json')) return null;
        if (name.endsWith('/SCREEN-FLOW/as-is.drawio')) return AS_IS_XML;
        if (name.endsWith('.md')) return EDITED;
        return null;
      },
      projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
    }));
    const mod = await import('../../src/components/DocRedlinePreview');
    const { container, baseElement } = render(<mod.DocRedlinePreview projectId="p1" file={FILE} />);
    const dialog = await openChange(container, baseElement, 'c-w');
    expect(dialog.textContent).toContain('default#ux-writing');
    expect(dialog.querySelector('[data-testid="panel-screen-flow"]')).toBeNull();
  });
});
