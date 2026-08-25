// @vitest-environment jsdom
//
// WP3 (.tmp/pipeline/wp3.yaml): change `kind: 'flow-diagram'` (sơ đồ mermaid
// Gốc/Đề xuất), change `component` không `before` với `rule_id` bắt đầu
// `comp/` ("Bảng thành phần"), right panel ẩn/hiện, chip lọc mới.
//
// Fixture tách khỏi doc-redline-preview.test.tsx (khoá tập id neo được của
// luồng "sửa" cũ) — cùng lý do các file *.ops/*.refs/*.rule-chip tách riêng.
//
// mermaid không chạy trong jsdom — stub MermaidDiagram để kiểm code truyền
// vào (cùng cách file-viewer-markdown-mermaid.test.tsx làm với FileViewer).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

// N6 (wp3b.yaml): MermaidDiagram thật có nút zoom/pan/reset KHÔNG tự
// stopPropagation (component đó ngoài `touches`, không được sửa) — stub thêm
// một nút "Zoom in" giả để bài test N6 bên dưới bấm vào, không đụng gì tới
// những test khác (chúng chỉ đọc `textContent`/`data-testid`, không đếm số
// nút trong khối này).
vi.mock('../../src/components/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => (
    <div data-testid="mermaid-diagram">
      <button type="button" aria-label="Zoom in">+</button>
      <svg data-testid="mermaid-svg" viewBox="0 0 320 180"><text>{code}</text></svg>
    </div>
  ),
}));
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  // Mục 0c/0d (wp4.yaml) stub `fetch` cho từng test riêng lẻ — dọn ở đây để
  // các bài test khác trong file (không đụng fetch) không thấy stub sót lại.
  vi.unstubAllGlobals();
});

beforeAll(() => {
  Element.prototype.scrollIntoView = function noop() {};
});

// ── Fixture 1: sơ đồ mermaid ────────────────────────────────────────────────
const DIAGRAM_BEFORE = [
  '```mermaid',
  'flowchart TD',
  '    A([Bắt đầu]) --> B[Chọn Mua SIM]',
  '```',
  '*flow-diagram — sơ đồ gốc trước rà soát UX (2 bước)*',
].join('\n');
const DIAGRAM_QUOTE = [
  '```mermaid',
  'flowchart TD',
  '    A([Bắt đầu]) --> B[Chọn gói cước] --> C[Xác nhận]',
  '```',
  '*flow-diagram — sơ đồ ĐỀ XUẤT sau rà soát UX (3 bước)*',
].join('\n');
const DIAGRAM_REASON = 'Luồng thiếu bước chọn gói cước trước khi xác nhận.';
const DIAGRAM_RULE_ID = 'flows/f1/ux-review.json';

const DIAGRAM_EDITED = ['# Luồng mua SIM', '', DIAGRAM_QUOTE, ''].join('\n');
const DIAGRAM_CHANGES = JSON.stringify([
  {
    id: 'fd1',
    kind: 'flow-diagram',
    origin: 'system',
    severity: 'major',
    rule_id: DIAGRAM_RULE_ID,
    before: DIAGRAM_BEFORE,
    quote: DIAGRAM_QUOTE,
    reason: DIAGRAM_REASON,
  },
]);

function mockDiagramProject() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return DIAGRAM_CHANGES;
      if (name.endsWith('.notes.json')) return null;
      return DIAGRAM_EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}

const DIAGRAM_FILE = {
  name: 'docs-review/review/docs/confluence/flow.md',
  kind: 'text',
  size: DIAGRAM_EDITED.length,
  mtime: 1,
} as never;

// ── Fixture 2: bảng thành phần ──────────────────────────────────────────────
const TABLE_QUOTE = [
  '**Cấu thành màn hình (Design System) — Đăng nhập**',
  '',
  '| # | Thành phần | Component DS | Biến thể | Vai trò / dùng để | Mô tả component | Điều hướng tới | Ghi chú |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 1 | Ô nhập số điện thoại | Input | text | Nhập số điện thoại | Ô nhập một dòng | — | — |',
  '| 2 | Nút Đăng nhập | Button | primary | Xác nhận đăng nhập | Nút chính | Trang chủ | — |',
  '| 3 | Biểu tượng OTP | — (DS không có) | — | Minh hoạ bước OTP | Icon tự vẽ | — | Chưa có trong DS |',
  '',
  '*Nguồn: comp/login.screen.json (rà soát UX)*',
].join('\n');
const TABLE_REASON = 'Bổ sung bảng thành phần cho màn Đăng nhập theo rà soát UX.';
const TABLE_RULE_ID = 'comp/login.screen.json';

const TABLE_EDITED = ['# Đăng nhập', '', TABLE_QUOTE, ''].join('\n');
const TABLE_CHANGES = JSON.stringify([
  {
    id: 'ct1',
    kind: 'component',
    severity: 'minor',
    rule_id: TABLE_RULE_ID,
    quote: TABLE_QUOTE,
    reason: TABLE_REASON,
  },
]);

function mockTableProject() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return TABLE_CHANGES;
      if (name.endsWith('.notes.json')) return null;
      return TABLE_EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}

const TABLE_FILE = {
  name: 'docs-review/review/docs/confluence/login.md',
  kind: 'text',
  size: TABLE_EDITED.length,
  mtime: 1,
} as never;

describe('DocRedlinePreview — sơ đồ mermaid (kind flow-diagram)', () => {
  it('hiện bản Đề xuất mặc định; bấm ○ Gốc đổi qua before, bấm lại ◉ Đề xuất đổi về quote', async () => {
    vi.resetModules();
    mockDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    const diagram = async () => {
      const el = await waitFor(() => {
        const found = container.querySelector('[data-testid="mermaid-diagram"]');
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      return el;
    };

    const first = await diagram();
    expect(first.textContent).toContain('Chọn gói cước');

    const gocBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Gốc'));
    expect(gocBtn, 'phải có nút "○ Gốc"').toBeTruthy();
    fireEvent.click(gocBtn!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-diagram"]')?.textContent).toContain('Chọn Mua SIM');
    });

    const deXuatBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Đề xuất'));
    fireEvent.click(deXuatBtn!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-diagram"]')?.textContent).toContain('Chọn gói cước');
    });
  });

  it('Xuất PDF lấy SVG đã render và loại source Mermaid thô khỏi print sheet', async () => {
    vi.resetModules();
    mockDiagramProject();
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    try {
      const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
      const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

      await waitFor(() => expect(container.querySelector('[data-testid="mermaid-svg"]')).not.toBeNull());
      fireEvent.click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Xuất PDF')!);

      await waitFor(() => expect(printSpy).toHaveBeenCalled());
      const printSheet = document.body.querySelector<HTMLElement>('[data-od-print-sheet]');
      expect(printSheet?.querySelector('[data-testid="mermaid-svg"]')).not.toBeNull();
      expect(printSheet?.querySelector('code.language-mermaid')).toBeNull();
      expect(printSheet?.querySelector('button[aria-label="Zoom in"]')).toBeNull();
    } finally {
      printSpy.mockRestore();
    }
  });

  it('thẻ 3 dòng: rule_id không hiện ở mặt thẻ, bấm "Chi tiết" mới hiện', async () => {
    vi.resetModules();
    mockDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('[data-change-item="fd1"]')).not.toBeNull();
    });
    const card = container.querySelector('[data-change-item="fd1"]') as HTMLElement;
    expect(card.textContent).not.toContain(DIAGRAM_RULE_ID);
    expect(card.textContent).toContain('Thay sơ đồ bằng bản đề xuất');

    const detailBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.includes('Chi tiết'));
    expect(detailBtn, 'phải có nút "Chi tiết"').toBeTruthy();
    expect(detailBtn!.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(detailBtn!);
    await waitFor(() => {
      expect(card.textContent).toContain(DIAGRAM_RULE_ID);
    });
    expect(detailBtn!.getAttribute('aria-expanded')).toBe('true');
  });

  it('chip lọc "Sơ đồ" xuất hiện trong dải trạng thái khi có change flow-diagram', async () => {
    vi.resetModules();
    mockDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id]')).not.toBeNull();
    });
    const chip = Array.from(container.querySelectorAll('label')).find((l) => l.textContent?.includes('Sơ đồ'));
    expect(chip, 'phải có chip lọc "Sơ đồ"').toBeTruthy();
    expect(container.textContent).toContain('1 sơ đồ');
  });

  it('right panel: bấm nút ẩn thì rail hidden + docCol full-width; bấm mark trong tài liệu mở lại', async () => {
    vi.resetModules();
    mockDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id]')).not.toBeNull();
    });
    const rail = () => container.querySelector('[class*="rail"]') as HTMLElement;
    expect(rail().hasAttribute('hidden')).toBe(false);

    const toggleBtn = container.querySelector('button[aria-label="Ẩn/Hiện chú giải"]') as HTMLButtonElement;
    expect(toggleBtn, 'phải có nút ẩn/hiện panel').toBeTruthy();
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(rail().hasAttribute('hidden')).toBe(true);
      expect(rail().getAttribute('aria-hidden')).toBe('true');
    });
    const grid = container.querySelector('[class*="grid"]') as HTMLElement;
    expect(grid.className).toMatch(/gridFull/i);
    // Tab dọc mỏng hiện đếm S · D · X khi panel ẩn.
    const tab = container.querySelector('button[aria-label="Hiện chú giải"]');
    expect(tab).not.toBeNull();

    const mark = container.querySelector('mark[data-change-id="fd1"]') as HTMLElement;
    fireEvent.click(mark);
    await waitFor(() => {
      expect(rail().hasAttribute('hidden')).toBe(false);
    });
  });

  it('phím tắt "]" đổi trạng thái panel khi tiêu điểm không ở trong ô nhập', async () => {
    vi.resetModules();
    mockDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);
    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id]')).not.toBeNull();
    });
    const rail = () => container.querySelector('[class*="rail"]') as HTMLElement;
    expect(rail().hasAttribute('hidden')).toBe(false);

    fireEvent.keyDown(document, { key: ']' });
    await waitFor(() => {
      expect(rail().hasAttribute('hidden')).toBe(true);
    });
  });
});

describe('DocRedlinePreview — Bảng thành phần (kind component không before, rule_id comp/)', () => {
  it('nhãn "Bảng thành phần", tiêu đề + đếm N/M/K, Chi tiết dựng lại bảng markdown', async () => {
    vi.resetModules();
    mockTableProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={TABLE_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('[data-change-item="ct1"]')).not.toBeNull();
    });
    const card = container.querySelector('[data-change-item="ct1"]') as HTMLElement;
    const kindLabel = card.querySelector('[class*="cardKind"]');
    expect(kindLabel?.textContent).toBe('Bảng thành phần');
    expect(card.textContent).toContain('Chèn bảng 3 thành phần');
    expect(card.textContent).toContain('3 thành phần · 2 map DS · 1 DS không có');
    expect(card.textContent).not.toContain(TABLE_RULE_ID);

    const detailBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.includes('Chi tiết'));
    fireEvent.click(detailBtn!);
    await waitFor(() => {
      expect(card.textContent).toContain(TABLE_RULE_ID);
      expect(card.querySelector('table')).not.toBeNull();
    });
  });

  it('chip lọc "Bảng thành phần" xuất hiện trong dải trạng thái', async () => {
    vi.resetModules();
    mockTableProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={TABLE_FILE} />);
    await waitFor(() => {
      expect(container.querySelector('[data-change-item="ct1"]')).not.toBeNull();
    });
    const chip = Array.from(container.querySelectorAll('label')).find((l) => l.textContent?.includes('Bảng thành phần'));
    expect(chip, 'phải có chip lọc "Bảng thành phần"').toBeTruthy();
    expect(container.textContent).toContain('1 bảng');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// wp3b.yaml — vá B1/B2/N1 (executor trước làm WP3, reviewer độc lập fail) +
// khuôn thẻ 3-dòng cho MỌI thẻ (mục D/F).
// ═══════════════════════════════════════════════════════════════════════════

// ── Fixture 3: B1/B2 — host mermaid không owner + hai sơ đồ trùng dòng đầu ──
// B1: một sơ đồ KHÔNG thuộc change nào (`ORPHAN_QUOTE`) không được sơn/bấm
// được. B2: hai change flow-diagram (`fd1`/`fd2`) có `quote` CÙNG dòng mermaid
// đầu "flowchart TD" — trước khi vá, mark chữ của `fd2` (quoteSegments khớp
// lại đúng vị trí ĐẦU TIÊN trong tài liệu, không phải "chưa dùng") rơi NHẦM
// vào khối của `fd1`.
const FD1_BODY = ['flowchart TD', '    A([Bắt đầu]) --> B[Chọn gói cước]'].join('\n');
const FD2_BODY = ['flowchart TD', '    A([Bắt đầu]) --> C[Xác nhận OTP]'].join('\n');
const ORPHAN_BODY = ['flowchart TD', '    X([Khác]) --> Y[Không gắn change nào]'].join('\n');
const FD1_QUOTE = ['```mermaid', FD1_BODY, '```'].join('\n');
const FD2_QUOTE = ['```mermaid', FD2_BODY, '```'].join('\n');
const ORPHAN_QUOTE = ['```mermaid', ORPHAN_BODY, '```'].join('\n');

const TWO_DIAGRAM_EDITED = ['# Luồng đăng ký SIM', '', FD1_QUOTE, '', FD2_QUOTE, '', ORPHAN_QUOTE, ''].join('\n');
const TWO_DIAGRAM_CHANGES = JSON.stringify([
  {
    id: 'fd1',
    kind: 'flow-diagram',
    origin: 'system',
    severity: 'major',
    rule_id: 'flows/f1/ux-review.json',
    quote: FD1_QUOTE,
    reason: 'Bổ sung bước chọn gói cước.',
  },
  {
    id: 'fd2',
    kind: 'flow-diagram',
    origin: 'system',
    severity: 'major',
    rule_id: 'flows/f2/ux-review.json',
    quote: FD2_QUOTE,
    reason: 'Bổ sung bước xác nhận OTP.',
  },
]);

function mockTwoDiagramProject() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return TWO_DIAGRAM_CHANGES;
      if (name.endsWith('.notes.json')) return null;
      return TWO_DIAGRAM_EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}
const TWO_DIAGRAM_FILE = {
  name: 'docs-review/review/docs/confluence/flow2.md',
  kind: 'text',
  size: TWO_DIAGRAM_EDITED.length,
  mtime: 1,
} as never;

describe('DocRedlinePreview — B1 (wp3b.yaml): host mermaid không owner', () => {
  it('sơ đồ không thuộc change nào KHÔNG có class hl/hlOff, KHÔNG có style nền, KHÔNG có data-change-id', async () => {
    vi.resetModules();
    mockTwoDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={TWO_DIAGRAM_FILE} />);

    const hosts = await waitFor(() => {
      const found = Array.from(container.querySelectorAll<HTMLElement>('[class*="mermaidHost"]'));
      expect(found.length).toBe(3);
      return found;
    });

    const orphanHost = hosts.find((h) => !h.dataset.changeId);
    expect(orphanHost, 'phải có 1 host không owner (sơ đồ mồ côi)').toBeTruthy();
    expect(orphanHost!.className).not.toMatch(/(^| )hl( |$)/);
    expect(orphanHost!.className).not.toMatch(/hlOff/);
    expect(orphanHost!.getAttribute('style')).toBeNull();
    expect(orphanHost!.dataset.changeId).toBeUndefined();

    // Hai host CÓ owner vẫn được sơn như cũ — B1 chỉ chặn host KHÔNG owner.
    const ownedHosts = hosts.filter((h) => h.dataset.changeId);
    expect(ownedHosts.length).toBe(2);
    for (const host of ownedHosts) {
      expect(host.getAttribute('style')).toContain('background-color');
    }
  });
});

describe('DocRedlinePreview — B2 (wp3b.yaml): hai sơ đồ cùng dòng đầu "flowchart TD"', () => {
  it('mark của change 2 KHÔNG rơi vào block 1; click thẻ 2 cuộn tới đúng host của change 2', async () => {
    vi.resetModules();
    mockTwoDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={TWO_DIAGRAM_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('[data-change-item="fd2"]')).not.toBeNull();
    });

    // Đúng MỘT mark mang data-change-id="fd2" trong toàn cột, và đó phải là
    // HOST (mermaidHost) — nếu B2 còn lỗi, sẽ có thêm một mark CHỮ (không
    // phải host) khớp nhầm vào dòng "flowchart TD" của block 1.
    const marksFd2 = Array.from(container.querySelectorAll<HTMLElement>('mark[data-change-id="fd2"]'));
    expect(marksFd2.length).toBe(1);
    expect(marksFd2[0]!.className).toMatch(/mermaidHost/);

    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function scrollSpyImpl() {});
    const card = container.querySelector('[data-change-item="fd2"]') as HTMLElement;
    fireEvent.click(card);

    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalled();
    });
    // scrollIntoView phải được gọi TRÊN host của change 2 — không phải một
    // phần tử nằm trong block 1.
    expect(scrollSpy.mock.instances.at(-1)).toBe(marksFd2[0]);
    scrollSpy.mockRestore();
  });
});

// ── Fixture 4: N1 — changes.json về SAU text ────────────────────────────────
// Dùng lại Fixture 1 (một change flow-diagram) nhưng trì hoãn fetch
// `.changes.json`: editedText resolve trước, changesState còn 'loading' một
// nhịp. Sau B2 (sơ đồ không còn đóng góp mark chữ vào docHtml), `docHtml` có
// thể GIỮ NGUYÊN giá trị chuỗi giữa lượt "chỉ có text" và lượt "có cả
// changes" — nếu effect chèn host chỉ phụ thuộc `[docHtml]`, nó không chạy
// lại đúng lúc cột tài liệu (docColRef) mới thực sự mount, và host không bao
// giờ được chèn.
function mockDiagramProjectDelayed(delayMs: number) {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return DIAGRAM_CHANGES;
      }
      if (name.endsWith('.notes.json')) return null;
      return DIAGRAM_EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}

describe('DocRedlinePreview — N1 (wp3b.yaml): changes.json về sau text', () => {
  it('changes.json trả về SAU editedText vẫn chèn được host mermaid', async () => {
    vi.resetModules();
    mockDiagramProjectDelayed(20);
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    await waitFor(
      () => {
        expect(container.querySelector('[class*="mermaidHost"]')).not.toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it('render Mermaid bằng React dù DOM query hậu kỳ không thấy fence', async () => {
    vi.resetModules();
    mockDiagramProject();
    const originalQuerySelectorAll = Element.prototype.querySelectorAll;
    let diagramFenceScans = 0;
    const querySpy = vi.spyOn(Element.prototype, 'querySelectorAll').mockImplementation(function (this: Element, selectors: string) {
      if (selectors === 'pre > code.language-mermaid') {
        diagramFenceScans += 1;
        return originalQuerySelectorAll.call(document.createElement('div'), selectors);
      }
      return originalQuerySelectorAll.call(this, selectors);
    });

    try {
      const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
      const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

      await waitFor(
        () => {
          expect(container.querySelector('[class*="mermaidHost"]')).not.toBeNull();
          expect(container.querySelector('details.md-mermaid__source')).not.toBeNull();
          expect(container.querySelector('article > pre > code.language-mermaid')).toBeNull();
        },
        { timeout: 2000 },
      );
      // Đường render chính không còn cần scan/mutate fence sau commit.
      expect(diagramFenceScans).toBe(0);
    } finally {
      querySpy.mockRestore();
    }
  });
});

// ── Fixture 5: F — khuôn thẻ 3-dòng cho một thẻ agent kiểu SỬA "bình thường"
// (kind cũ, không phải sơ đồ/bảng) với reason > 60 ký tự ─────────────────────
const F_REASON =
  'Câu này thiếu ngữ cảnh về ai là người thực hiện thao tác đăng nhập vào hệ thống của công ty.'; // 92 ký tự
const F_BEFORE = 'Người dùng đăng nhập.';
const F_QUOTE = 'Người dùng đăng nhập vào hệ thống.';
const F_EDITED = ['# Đăng nhập', '', F_QUOTE, ''].join('\n');
const F_CHANGES = JSON.stringify([
  {
    id: 'f1',
    kind: 'ux-writing',
    severity: 'minor',
    origin: 'agent',
    before: F_BEFORE,
    quote: F_QUOTE,
    reason: F_REASON,
  },
]);

function mockFCardProject() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return F_CHANGES;
      if (name.endsWith('.notes.json')) return null;
      return F_EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}
const F_FILE = {
  name: 'docs-review/review/docs/confluence/login2.md',
  kind: 'text',
  size: F_EDITED.length,
  mtime: 1,
} as never;

describe('DocRedlinePreview — F (wp-redline-card-polish.yaml): khuôn thẻ 3-dòng cho thẻ agent "kiểu sửa" thường', () => {
  it('mặt thẻ hiện reason ĐẦY ĐỦ (không còn cắt 60 ký tự/dấu "…" — clamp 2 dòng chỉ bằng CSS); mở "Chi tiết" mới hiện EditDiff', async () => {
    vi.resetModules();
    mockFCardProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={F_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('[data-change-item="f1"]')).not.toBeNull();
    });
    const card = container.querySelector('[data-change-item="f1"]') as HTMLElement;
    // wp-redline-card-polish.yaml mục 1: cardTitle() thôi cắt 60 ký tự — reason
    // đầy đủ (92 ký tự) đã có ngay trên mặt thẻ; CSS line-clamp chỉ ẩn phần
    // thừa BẰNG MẮT, không cắt khỏi DOM, nên không còn dấu "…" của phép cắt cũ.
    const title = card.querySelector('[class*="cardTitle"]');
    expect(title?.textContent).toBe(F_REASON);
    expect(title?.textContent).not.toContain('…');
    expect(title?.getAttribute('title')).toBe(F_REASON);
    expect(card.textContent).toContain(F_REASON);

    const detailBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.includes('Chi tiết'));
    expect(detailBtn, 'phải có nút "Chi tiết"').toBeTruthy();
    expect(detailBtn!.getAttribute('aria-expanded')).toBe('false');
    // Phần "Chi tiết" (EditDiff/RuleChip/RefRow) vẫn gập cho tới khi mở, dù
    // reason đã hiện đầy đủ trên mặt thẻ.
    expect(card.querySelector('[class*="diffInline"]')).toBeNull();

    fireEvent.click(detailBtn!);
    await waitFor(() => {
      expect(detailBtn!.getAttribute('aria-expanded')).toBe('true');
    });
    // Cặp before/quote đủ nhỏ để word-diff — EditDiff (không rơi về layout
    // hai khối cũ).
    expect(card.querySelector('[class*="diffInline"]')).not.toBeNull();
  });
});

describe('DocRedlinePreview — N6 (wp3b.yaml): nút zoom/pan của MermaidDiagram không chọn nhầm change', () => {
  it('bấm nút "Zoom in" trong khối sơ đồ KHÔNG chọn change đó (mục trong rail không nổi lên)', async () => {
    vi.resetModules();
    mockDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('[data-change-item="fd1"]')).not.toBeNull();
    });
    const item = container.querySelector('[data-change-item="fd1"]') as HTMLElement;
    expect(item.className).not.toMatch(/itemActive/i);

    // Nút zoom được portal vào host mermaid ở một lượt hiệu ứng RIÊNG
    // (diagramMounts) — chờ nó có mặt thay vì giả định nó đã tới cùng lúc với
    // mục trong rail (hai thứ được hai effect khác nhau dựng).
    const zoomBtn = await waitFor(() => {
      const found = Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Zoom in',
      );
      expect(found, 'phải có nút "Zoom in" (mock MermaidDiagram)').toBeTruthy();
      return found as HTMLButtonElement;
    });
    fireEvent.click(zoomBtn);

    // Bấm nút zoom KHÔNG được chọn change fd1 — mục trong rail vẫn không nổi.
    expect(item.className).not.toMatch(/itemActive/i);

    // Đối chứng: bấm THẲNG vào host (ngoài vùng nút) VẪN phải chọn được, để
    // chắc chắn bài test này đo đúng chỗ chặn (không phải toàn bộ khối sơ đồ
    // bị vô hiệu hoá click).
    const host = container.querySelector('mark[data-change-id="fd1"]') as HTMLElement;
    fireEvent.click(host);
    await waitFor(() => {
      expect(item.className).toMatch(/itemActive/i);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// wp4.yaml mục 0 — vá tồn đọng từ review WP3b (bắt buộc TRƯỚC mục 1–4).
// ═══════════════════════════════════════════════════════════════════════════

// ── Fixture 6 (mục 0a): change flow-diagram có `quote` KHÔNG khớp fence nào
// đang có trong tài liệu (tài liệu đã đổi khác đi từ lúc rà soát) ──────────
const MISMATCH_QUOTE = [
  '```mermaid',
  'flowchart TD',
  '    A([Bắt đầu]) --> B[Chọn kênh khác]',
  '```',
  '*flow-diagram — sơ đồ ĐỀ XUẤT không khớp bản đang có*',
].join('\n');
const MISMATCH_DOC_FENCE = [
  '```mermaid',
  'flowchart TD',
  '    Z([Khác hẳn]) --> Y[Không liên quan tới change]',
  '```',
].join('\n');
const MISMATCH_EDITED = ['# Luồng khác', '', MISMATCH_DOC_FENCE, ''].join('\n');
const MISMATCH_REASON = 'Sơ đồ hiện tại không khớp bản đề xuất do tài liệu đã đổi khác đi.';
const MISMATCH_RULE_ID = 'flows/f9/ux-review.json';
const MISMATCH_CHANGES = JSON.stringify([
  {
    id: 'fdmiss',
    kind: 'flow-diagram',
    origin: 'system',
    severity: 'major',
    rule_id: MISMATCH_RULE_ID,
    quote: MISMATCH_QUOTE,
    reason: MISMATCH_REASON,
  },
]);
function mockMismatchProject() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return MISMATCH_CHANGES;
      if (name.endsWith('.notes.json')) return null;
      return MISMATCH_EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}
const MISMATCH_FILE = {
  name: 'docs-review/review/docs/confluence/flow-mismatch.md',
  kind: 'text',
  size: MISMATCH_EDITED.length,
  mtime: 1,
} as never;

describe('DocRedlinePreview — 0a (wp4.yaml, vá review WP3b): nút "Chi tiết" ra ngoài gate showActions', () => {
  it('change flow-diagram không khớp fence nào (không neo được) vẫn có nút "Chi tiết"; mở ra thấy reason + rule_id', async () => {
    vi.resetModules();
    mockMismatchProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={MISMATCH_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('[data-change-item="fdmiss"]')).not.toBeNull();
    });
    const item = container.querySelector('[data-change-item="fdmiss"]') as HTMLElement;
    // Không neo được (fence không khớp) — thẻ rơi vào nhóm "không tìm thấy",
    // nghĩa là showActions=false, KHÔNG có nút Chấp nhận/Giữ sơ đồ gốc.
    expect(item.textContent).toContain('Không tìm thấy trong tài liệu');
    expect(Array.from(item.querySelectorAll('button')).some((b) => b.textContent?.includes('Chấp nhận'))).toBe(false);

    const detailBtn = Array.from(item.querySelectorAll('button')).find((b) => b.textContent?.includes('Chi tiết'));
    expect(detailBtn, 'phải có nút "Chi tiết" dù không neo được').toBeTruthy();
    expect(detailBtn!.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(detailBtn!);
    await waitFor(() => {
      expect(item.textContent).toContain(MISMATCH_REASON);
      expect(item.textContent).toContain(MISMATCH_RULE_ID);
    });
  });
});

// ── Fixture 7 (mục 0b): change flow-diagram KHÔNG có caption (không có dòng
// `*...*` sau rào ```mermaid```) ─────────────────────────────────────────────
const NO_CAPTION_BEFORE = ['```mermaid', 'flowchart TD', '    A([Bắt đầu]) --> B[Cũ, không caption]', '```'].join('\n');
const NO_CAPTION_QUOTE = ['```mermaid', 'flowchart TD', '    A([Bắt đầu]) --> B[Không có caption]', '```'].join('\n');
const NO_CAPTION_EDITED = ['# Không caption', '', NO_CAPTION_QUOTE, ''].join('\n');
const NO_CAPTION_CHANGES = JSON.stringify([
  {
    id: 'fdnocap',
    kind: 'flow-diagram',
    origin: 'system',
    severity: 'major',
    rule_id: 'flows/f8/ux-review.json',
    before: NO_CAPTION_BEFORE,
    quote: NO_CAPTION_QUOTE,
    reason: 'Sơ đồ được viết lại nhưng không kèm caption mô tả.',
  },
]);
function mockNoCaptionProject() {
  vi.doMock('../../src/providers/registry', () => ({
    fetchProjectFileText: async (_projectId: string, name: string) => {
      if (name.endsWith('.changes.json')) return NO_CAPTION_CHANGES;
      if (name.endsWith('.notes.json')) return null;
      return NO_CAPTION_EDITED;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}
const NO_CAPTION_FILE = {
  name: 'docs-review/review/docs/confluence/flow-no-caption.md',
  kind: 'text',
  size: NO_CAPTION_EDITED.length,
  mtime: 1,
} as never;

describe('DocRedlinePreview — 0b (wp4.yaml, vá review WP3b): dòng 2 thẻ sơ đồ không in mã mermaid thô', () => {
  it('không trích được caption → dòng 2 hiện chuỗi cố định, KHÔNG phải mã mermaid thô', async () => {
    vi.resetModules();
    mockNoCaptionProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={NO_CAPTION_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('[data-change-item="fdnocap"]')).not.toBeNull();
    });
    const card = container.querySelector('[data-change-item="fdnocap"]') as HTMLElement;
    const line2 = card.querySelector('[class*="diffCompact"]');
    expect(line2?.textContent).toBe('Sơ đồ đề xuất thay sơ đồ gốc');
    expect(line2?.textContent).not.toContain('flowchart TD');
    expect(line2?.textContent).not.toContain('-->');
  });

  it('có caption (Fixture 1) → dùng class diffPreviewBefore/diffPreviewAfter, KHÔNG dùng diffBefore/diffAfter', async () => {
    vi.resetModules();
    mockDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('[data-change-item="fd1"]')).not.toBeNull();
    });
    const card = container.querySelector('[data-change-item="fd1"]') as HTMLElement;
    expect(card.querySelector('[class*="diffPreviewBefore"]')).not.toBeNull();
    expect(card.querySelector('[class*="diffPreviewAfter"]')).not.toBeNull();
    expect(card.querySelector('[class*="diffBefore"]')).toBeNull();
    expect(card.querySelector('[class*="diffAfter"]')).toBeNull();
  });
});

describe('DocRedlinePreview — 0c (wp4.yaml, vá review WP3b): sidecarJson giữ nguyên origin "system"', () => {
  it('lưu một change origin "system" (Giữ sơ đồ gốc) không rơi rụng về "agent"', async () => {
    vi.resetModules();
    mockDiagramProject();
    // "Giữ sơ đồ gốc" đi qua cùng `onDismiss` của nhánh mặc định (window.confirm
    // trước khi bỏ) — jsdom's confirm() mặc định trả `false`, không mock thì
    // dismissChange không bao giờ chạy.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('[data-change-item="fd1"]')).not.toBeNull();
    });
    const card = container.querySelector('[data-change-item="fd1"]') as HTMLElement;
    const dismissBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.includes('Giữ sơ đồ gốc'));
    expect(dismissBtn, 'phải có nút "Giữ sơ đồ gốc"').toBeTruthy();
    fireEvent.click(dismissBtn!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const sidecarCall = fetchMock.mock.calls.find((args) => {
      const init = args[1] as RequestInit | undefined;
      const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
      return typeof body.name === 'string' && body.name.endsWith('.changes.json');
    });
    expect(sidecarCall, 'phải có lệnh ghi *.changes.json').toBeTruthy();
    const written = JSON.parse(String((sidecarCall![1] as RequestInit).body)) as { content: string };
    const saved = JSON.parse(written.content) as { annotations: Array<Record<string, unknown>> };
    expect(saved.annotations[0]).toMatchObject({ id: 'fd1', origin: 'system' });
  });
});

describe('DocRedlinePreview — 0d (wp4.yaml, vá review WP3b): tắt chip "Sửa" repaint host mermaid dù docHtml không đổi', () => {
  it('tắt chip "Sửa" đổi host mermaid sang hlOff dù tài liệu chỉ có change sơ đồ (docHtml không đổi ký tự giữa hai lượt)', async () => {
    vi.resetModules();
    mockDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="fd1"]')).not.toBeNull();
    });
    expect(container.querySelector('mark[data-change-id="fd1"]')!.className).not.toMatch(/hlOff/);

    const chip = Array.from(container.querySelectorAll('label')).find((l) => l.textContent?.includes('Sửa'));
    expect(chip, 'phải có chip lọc "Sửa"').toBeTruthy();
    const checkbox = chip!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    fireEvent.click(checkbox!);

    await waitFor(() => {
      const host = container.querySelector<HTMLElement>('mark[data-change-id="fd1"]');
      expect(host?.className).toMatch(/hlOff/);
      expect(host?.getAttribute('style')).toContain('transparent');
    });
  });
});
