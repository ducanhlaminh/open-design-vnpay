// @vitest-environment jsdom
//
// WP-drreview-drawio-preview mục D: DocRedlinePreview phải nhận diện marker
// `*flow-diagram-drawio — …*` (daemon chèn qua replaceDrawioInSlice, xem
// apps/daemon/src/docs-review-enrich.ts) và portal <DrawioViewer> + toggle
// "◉ Đề xuất/○ Gốc" + badge/chú giải (TÁI DÙNG markup mermaid của
// WP-drreview-mmd-color-badge, xem doc-redline-diagram-badge.test.tsx) vào
// đúng chỗ, thay vì để nguyên dòng marker chữ.
//
// DrawioViewer thật cần window.GraphViewer (script vendor ~4MB, không chạy
// trong jsdom) — stub để đọc lại props (xml/page) mỗi lượt render, cùng kỹ
// thuật doc-redline-preview.wp3.test.tsx stub MermaidDiagram.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const drawioPropsLog: Array<{ xml: string; page?: number }> = [];
vi.mock('../../src/components/DrawioViewer', () => ({
  DrawioViewer: (props: { xml: string; page?: number }) => {
    drawioPropsLog.push({ xml: props.xml, page: props.page });
    return (
      <div data-testid="drawio-viewer" data-page={props.page}>
        {props.xml.length}
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
});

const FLOW_ID = 'FLOW-doi-mat-khau';
const CHANGE_ID = `sys-flow-diagram-${FLOW_ID}`;
const EXPECTED_DRAWIO_PATH = `docs-review/flows/${FLOW_ID}/proposed.drawio`;
const MARKER = `*flow-diagram-drawio — sơ đồ ĐỀ XUẤT sau rà soát UX (nguồn gốc: 777-Doi-mat-khau.drawio; đề xuất: flows/${FLOW_ID}/proposed.drawio)*`;

const EDITED = ['# Luồng đổi mật khẩu', '', MARKER, ''].join('\n');
const CHANGES = JSON.stringify([
  {
    id: CHANGE_ID,
    kind: 'flow-diagram',
    origin: 'system',
    severity: 'major',
    rule_id: `flows/${FLOW_ID}/ux-review.json`,
    before: '<img src="attachments/777-Doi-mat-khau-p1.png" alt="flow-diagram" />',
    quote: MARKER,
    reason: 'Thiếu bước xác nhận mật khẩu mới.',
  },
]);

// 2 trang mxfile (Hiện trạng/Đề xuất, đúng khuôn finalizeFlowUx ghi) — page
// mặc định 'proposed' phải trỏ pageCount-1 = 1.
const DRAWIO_XML = '<mxfile><diagram name="Hiện trạng" id="p1"></diagram><diagram name="Đề xuất" id="p2"></diagram></mxfile>';

const FILE = {
  name: 'docs-review/review/docs/confluence/flow.md',
  kind: 'text',
  size: EDITED.length,
  mtime: 1,
} as never;

function mockProject(opts?: { drawioReject?: boolean }) {
  const fetchCalls: string[] = [];
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return CHANGES;
      if (name.endsWith('.notes.json')) return null;
      if (name.endsWith('.drawio')) {
        fetchCalls.push(name);
        if (opts?.drawioReject) throw new Error('boom');
        return DRAWIO_XML;
      }
      return EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
    __fetchCalls: fetchCalls,
  }));
  return fetchCalls;
}

describe('DocRedlinePreview — sơ đồ draw.io (WP-drreview-drawio-preview)', () => {
  it('marker flow-diagram-drawio → host xuất hiện, fetch đúng path docs-review/flows/<id>/proposed.drawio, toggle đổi prop page', async () => {
    vi.resetModules();
    const fetchCalls = mockProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={FILE} />);

    const viewer = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-testid="drawio-viewer"]');
      expect(el).toBeTruthy();
      return el!;
    });

    // fetch đúng path: <workflowPrefix>/flows/<flowId>/proposed.drawio (file.name
    // trước '/review/' = 'docs-review').
    expect(fetchCalls).toContain(EXPECTED_DRAWIO_PATH);
    expect(drawioPropsLog[drawioPropsLog.length - 1]!.xml).toBe(DRAWIO_XML);

    // Mặc định 'Đề xuất' → page cuối (pageCount − 1 = 1, 2 thẻ <diagram trong XML).
    expect(viewer.dataset.page).toBe('1');

    // Host là <mark data-change-id> — cùng khuôn mermaid, để "chọn card ↔
    // highlight" ăn theo miễn phí cơ chế mark sẵn có (marksFor).
    const host = viewer.closest('[data-change-id]') as HTMLElement | null;
    expect(host?.dataset.changeId).toBe(CHANGE_ID);
    expect(host!.textContent).toContain('Sơ đồ đề xuất');
    expect(host!.textContent).toContain('◉ Đề xuất');
    expect(host!.textContent).toContain('○ Gốc');

    // Toggle "○ Gốc" → page 0.
    const gocBtn = Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.includes('Gốc'))!;
    fireEvent.click(gocBtn);

    await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-testid="drawio-viewer"]');
      expect(el?.dataset.page).toBe('0');
    });
  });

  it('fetch lỗi (reject) → giữ dòng marker chữ + thông báo nhỏ, không crash', async () => {
    vi.resetModules();
    mockProject({ drawioReject: true });
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={FILE} />);

    await waitFor(() => {
      expect(container.textContent).toContain('Không tải được sơ đồ đề xuất');
    });
    expect(container.querySelector('[data-testid="drawio-viewer"]')).toBeNull();
    // Dòng marker chữ vẫn còn trong tài liệu (không xoá/thay khi fetch lỗi).
    expect(container.textContent).toContain('flow-diagram-drawio');
  });
});
