// @vitest-environment jsdom
//
// WP-drreview-mmd-color-badge — preview DocRedlinePreview phải cho biết một
// sơ đồ mermaid là "Sơ đồ đề xuất" (kèm chú giải 3 màu thêm/sửa/bỏ) hay
// "Nguyên bản" (không có bản đề xuất nào thay nó) — trước WP này chỉ có
// toggle "◉ Đề xuất/○ Gốc" kín đáo, không rõ ràng gì đã đổi.
//
// mermaid không chạy trong jsdom — stub MermaidDiagram giống
// doc-redline-preview.wp3.test.tsx.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

vi.mock('../../src/components/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => <div data-testid="mermaid-diagram">{code}</div>,
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

beforeAll(() => {
  Element.prototype.scrollIntoView = function noop() {};
});

// ── Fixture: một sơ đồ CÓ change (flow-diagram) + một sơ đồ MỒ CÔI (không
// change nào sở hữu — cùng kỹ thuật B1 trong doc-redline-preview.wp3.test.tsx:
// dòng đầu "flowchart TD" khác nhau đủ để quoteSegments không lẫn hai host) ──
const OWNED_BODY = ['flowchart TD', '    A([Bắt đầu]) --> B[Chọn gói cước]'].join('\n');
const ORPHAN_BODY = ['flowchart LR', '    X([Khác]) --> Y[Không gắn change nào]'].join('\n');
const OWNED_QUOTE = ['```mermaid', OWNED_BODY, '```'].join('\n');
const ORPHAN_QUOTE = ['```mermaid', ORPHAN_BODY, '```'].join('\n');

const EDITED = ['# Luồng mua SIM', '', OWNED_QUOTE, '', ORPHAN_QUOTE, ''].join('\n');
const CHANGES = JSON.stringify([
  {
    id: 'fd1',
    kind: 'flow-diagram',
    origin: 'system',
    severity: 'major',
    rule_id: 'flows/f1/ux-review.json',
    quote: OWNED_QUOTE,
    reason: 'Bổ sung bước chọn gói cước.',
  },
]);

function mockProject() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return CHANGES;
      if (name.endsWith('.notes.json')) return null;
      return EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}

const FILE = {
  name: 'docs-review/review/docs/confluence/flow.md',
  kind: 'text',
  size: EDITED.length,
  mtime: 1,
} as never;

describe('DocRedlinePreview — badge/chú giải sơ đồ mermaid (WP-drreview-mmd-color-badge)', () => {
  it('sơ đồ có change (flow-diagram) → badge "Sơ đồ đề xuất" + chú giải 3 nhãn thêm/sửa/bỏ; sơ đồ mồ côi → badge "Nguyên bản", không toggle', async () => {
    vi.resetModules();
    mockProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={FILE} />);

    const hosts = await waitFor(() => {
      const found = Array.from(container.querySelectorAll<HTMLElement>('[class*="mermaidHost"]'));
      expect(found.length).toBe(2);
      return found;
    });

    const ownedHost = hosts.find((h) => h.dataset.changeId === 'fd1')!;
    expect(ownedHost, 'phải có host sở hữu bởi change fd1').toBeTruthy();
    const orphanHost = hosts.find((h) => !h.dataset.changeId)!;
    expect(orphanHost, 'phải có host mồ côi').toBeTruthy();

    // Host CÓ change: badge "Sơ đồ đề xuất" + chú giải 3 màu + vẫn giữ toggle.
    expect(ownedHost.textContent).toContain('Sơ đồ đề xuất');
    expect(ownedHost.textContent).toContain('thêm');
    expect(ownedHost.textContent).toContain('sửa');
    expect(ownedHost.textContent).toContain('bỏ');
    expect(ownedHost.textContent).toContain('◉ Đề xuất');
    expect(ownedHost.textContent).toContain('○ Gốc');
    expect(ownedHost.textContent).not.toContain('Nguyên bản');

    // Host mồ côi: chỉ badge "Nguyên bản", KHÔNG toggle, KHÔNG chú giải.
    expect(orphanHost.textContent).toContain('Nguyên bản');
    expect(orphanHost.textContent).not.toContain('Sơ đồ đề xuất');
    expect(orphanHost.textContent).not.toContain('◉ Đề xuất');
    expect(orphanHost.textContent).not.toContain('○ Gốc');
    expect(orphanHost.querySelector('[class*="diagramLegend"]')).toBeNull();
  });
});
