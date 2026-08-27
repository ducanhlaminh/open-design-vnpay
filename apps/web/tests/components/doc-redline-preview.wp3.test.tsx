// @vitest-environment jsdom
//
// WP3 (.tmp/pipeline/wp3.yaml): change `kind: 'flow-diagram'` (sơ đồ mermaid
// Gốc/Đề xuất), change `component` không `before` với `rule_id` bắt đầu
// `comp/` ("Bảng thành phần"), B1/B2/N1 (wp3b.yaml), khuôn thẻ 3-dòng (F).
//
// wp-doc-redline-nondestructive: rail/thẻ bên phải đã bị BỎ HẲN (thay bằng
// panel chi tiết cạnh phải mở khi bấm vùng bôi — xem AnnotationDetailPanel trong
// component). Enrichment (`flow-diagram`/bảng thành phần `component`) KHÔNG
// có modal — nó giữ nguyên tương tác riêng (toggle Gốc/Đề xuất, bảng inline).
// Những test cũ đo RIÊNG rail-card của enrichment (nhãn "Bảng thành phần",
// đếm N/M/K, chip lọc theo loại, panel ẩn/hiện, phím tắt ']', dòng 2 thẻ sơ
// đồ, nút "Giữ sơ đồ gốc" trong thẻ) đo một bề mặt UI không còn tồn tại —
// ĐÃ BỎ, ghi lại lý do ở not_done của báo cáo thực thi thay vì đo áng chừng.
//
// Fixture tách khỏi doc-redline-preview.test.tsx (khoá tập id neo được của
// luồng "sửa" cũ) — cùng lý do các file *.ops/*.refs/*.rule-chip tách riêng.
//
// mermaid không chạy trong jsdom — stub MermaidDiagram để kiểm code truyền
// vào (cùng cách file-viewer-markdown-mermaid.test.tsx làm với FileViewer).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';

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

  it('dải trạng thái đếm "N sơ đồ" khi có change flow-diagram (rail + chip lọc theo loại đã bỏ — xem docblock đầu file)', async () => {
    vi.resetModules();
    mockDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id]')).not.toBeNull();
    });
    const strip = container.querySelector('[class*="strip"]');
    expect((strip?.textContent ?? '').replace(/\s+/g, ' ')).toContain('1 sơ đồ');
  });
});

describe('DocRedlinePreview — Bảng thành phần (kind component không before, rule_id comp/)', () => {
  // ── Fixture 2: bảng thành phần ─────────────────────────────────────────────
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

  it('bảng vẫn hiện nguyên vẹn trong tài liệu (render inline không đổi) và dải trạng thái đếm "N bảng"', async () => {
    vi.resetModules();
    mockTableProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={TABLE_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="ct1"]')).not.toBeNull();
    });
    // Bảng thật vẫn được daemon render inline trong tài liệu — cơ chế bôi
    // quote-based cũ cho bảng KHÔNG đổi (xem isComponentTableChange trong
    // component); chỉ rail card hiển thị lại nội dung bảng là đã bỏ.
    expect(container.querySelector('table')).not.toBeNull();
    const strip = container.querySelector('[class*="strip"]');
    expect((strip?.textContent ?? '').replace(/\s+/g, ' ')).toContain('1 bảng');
    // Bấm mark bảng KHÔNG mở modal (enrichment không có modal).
    fireEvent.click(container.querySelector('mark[data-change-id="ct1"]')!);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
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
  it('mark của change 2 KHÔNG rơi vào block 1; điều hướng "Sau" tới change 2 cuộn đúng host của nó', async () => {
    vi.resetModules();
    mockTwoDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={TWO_DIAGRAM_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="fd2"]')).not.toBeNull();
    });

    // Đúng MỘT mark mang data-change-id="fd2" trong toàn cột, và đó phải là
    // HOST (mermaidHost) — nếu B2 còn lỗi, sẽ có thêm một mark CHỮ (không
    // phải host) khớp nhầm vào dòng "flowchart TD" của block 1.
    const marksFd2 = Array.from(container.querySelectorAll<HTMLElement>('mark[data-change-id="fd2"]'));
    expect(marksFd2.length).toBe(1);
    expect(marksFd2[0]!.className).toMatch(/mermaidHost/);

    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function scrollSpyImpl() {});
    // Rail card đã bỏ — dùng điều hướng "Sau" (mục trong nav luôn theo thứ tự
    // tài liệu: fd1 rồi fd2) thay cho bấm thẳng vào thẻ cũ.
    const nav = within(container).getByRole('navigation', { name: 'Điều hướng thay đổi' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Thay đổi sau' }));
    fireEvent.click(within(nav).getByRole('button', { name: 'Thay đổi sau' }));

    await waitFor(() => {
      expect(nav.textContent).toContain('2 / 2');
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

// ── Fixture 5: F — một chỗ SỬA kiểu agent "bình thường" (kind cũ, không phải
// sơ đồ/bảng) với reason > 60 ký tự — modal chi tiết của nó phải hiện đúng
// EditDiff (word-diff), không còn khuôn thẻ 3 dòng của rail đã bỏ ─────────────
const F_REASON =
  'Câu này thiếu ngữ cảnh về ai là người thực hiện thao tác đăng nhập vào hệ thống của công ty.'; // 92 ký tự
const F_BEFORE = 'Người dùng đăng nhập.';
const F_QUOTE = 'Người dùng đăng nhập vào hệ thống.';
// Tài liệu hiển thị KHÔNG BAO GIỜ bị sửa (wp-doc-redline-nondestructive) — nó
// phải chứa F_BEFORE (chữ gốc, nơi mark bôi vàng neo vào), không phải F_QUOTE.
const F_DOC = ['# Đăng nhập', '', F_BEFORE, ''].join('\n');
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
      return F_DOC;
    },
    projectRawUrl: (projectId: string, filePath: string) => `/api/projects/${projectId}/raw/${filePath}`,
  }));
}
const F_FILE = {
  name: 'docs-review/review/docs/confluence/login2.md',
  kind: 'text',
  size: F_DOC.length,
  mtime: 1,
} as never;

describe('DocRedlinePreview — F (wp-redline-card-polish.yaml, chuyển sang modal chi tiết): reason đầy đủ + EditDiff', () => {
  it('modal chi tiết hiện reason ĐẦY ĐỦ (không cắt 60 ký tự) và EditDiff (word-diff) cho chỗ SỬA agent', async () => {
    vi.resetModules();
    mockFCardProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={F_FILE} />);

    await waitFor(() => {
      expect(container.querySelector('mark[data-change-id="f1"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('mark[data-change-id="f1"]')!);
    const dialog = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[role="dialog"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    // reason đầy đủ (92 ký tự), không dấu "…" của phép cắt cũ.
    expect(dialog.textContent).toContain(F_REASON);
    expect(dialog.textContent).not.toContain('…');
    // Cặp before/quote đủ nhỏ để word-diff — EditDiff (không rơi về layout
    // hai khối "Nguyên bản"/"Đề xuất" cũ).
    expect(dialog.querySelector('[class*="diffInline"]')).not.toBeNull();
    const labels = Array.from(dialog.querySelectorAll('[class*="detailLabel"]')).map((el) => el.textContent);
    expect(labels).not.toContain('Nguyên bản');
    expect(labels).not.toContain('Đề xuất');
  });
});

describe('DocRedlinePreview — N6 (wp3b.yaml): nút zoom/pan của MermaidDiagram không chọn nhầm change', () => {
  it('bấm nút "Zoom in" trong khối sơ đồ KHÔNG chọn change đó (host không nổi hlActive); bấm thẳng vào host thì có', async () => {
    vi.resetModules();
    mockDiagramProject();
    const { DocRedlinePreview: Comp } = await import('../../src/components/DocRedlinePreview');
    const { container } = render(<Comp projectId="p1" file={DIAGRAM_FILE} />);

    const host = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('mark[data-change-id="fd1"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(host.className).not.toMatch(/hlActive/i);

    // Nút zoom được portal vào host mermaid ở một lượt hiệu ứng RIÊNG
    // (diagramMounts) — chờ nó có mặt thay vì giả định nó đã tới cùng lúc với
    // host mermaid (hai thứ được hai effect khác nhau dựng).
    const zoomBtn = await waitFor(() => {
      const found = Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Zoom in',
      );
      expect(found, 'phải có nút "Zoom in" (mock MermaidDiagram)').toBeTruthy();
      return found as HTMLButtonElement;
    });
    fireEvent.click(zoomBtn);

    // Bấm nút zoom KHÔNG được chọn change fd1 — host vẫn không nổi hlActive,
    // và modal chi tiết KHÔNG mở (enrichment không có modal).
    expect(host.className).not.toMatch(/hlActive/i);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    // Đối chứng: bấm THẲNG vào host (ngoài vùng nút) VẪN phải chọn được, để
    // chắc chắn bài test này đo đúng chỗ chặn (không phải toàn bộ khối sơ đồ
    // bị vô hiệu hoá click).
    fireEvent.click(host);
    await waitFor(() => {
      expect(host.className).toMatch(/hlActive/i);
    });
    // Nhưng vẫn không có modal — enrichment chỉ được CHỌN (nháy sáng), không
    // có gì để "xem chi tiết" ngoài chính sơ đồ đang hiện.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
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
    expect(chip, 'phải có chip lọc "Sửa" (HighlightFilters — nhóm 4 chip màu ở đầu trang, KHÔNG phải chip lọc theo loại đã bỏ)').toBeTruthy();
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
