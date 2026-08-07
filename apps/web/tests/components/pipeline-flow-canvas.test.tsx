// @vitest-environment jsdom
//
// Pipeline vẽ thành SƠ ĐỒ NODE. Câu hỏi đắt nhất của cả khung nhìn này là câu
// thứ hai: ba đầu ra UI-Spec (ui-html | ui-react | ui-react-ds) phải nằm CÙNG
// MỘT TẦNG, ba node song song. Ở stepper dọc chúng bị nhồi vào một thẻ với ba
// badge, nên không ai nhìn ra đó là ba nhánh — và cũng không nói được nhánh nào
// sẽ chạy. Bố cục theo tầng là cái sửa đúng chuyện đó, nên nó phải có test giữ.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import type { PipelineStatus, PipelineView } from '@open-design/contracts';

// Không cleanup thì cây của test trước còn nguyên trong document.body và mọi
// phép ĐẾM node dưới đây cộng dồn qua các test.
afterEach(() => cleanup());

// PipelineFlowCanvas dùng lại luật tick lan theo phụ thuộc của PipelineModals,
// mà module đó kéo theo FileViewer + provider mạng. Mock TỪNG PHẦN đúng một
// hàm gọi mạng lúc mount: thay cả module sẽ làm hằng số FileViewer đọc ở top
// level thành undefined và nổ ngay lúc import.
vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return { ...actual, fetchDesignSystems: async () => [] };
});

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { PipelineFlowCanvas, layoutPipelineFlow, resolveToggle } = await import(
  '../../src/components/pipelines/PipelineFlowCanvas'
);
type StageLike = Parameters<typeof PipelineFlowCanvas>[0]['pipelines'][number];

// React Flow đo khung vẽ bằng ResizeObserver — jsdom không có, thiếu nó thì
// component ném ngay lúc mount. Và nếu canvas được coi là 0×0 thì React Flow
// không dựng đường nối nào, nên phép kiểm cạnh sẽ xanh giả.
beforeAll(() => {
  class StubResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(el: Element) {
      this.cb([{ target: el, contentRect: { width: 900, height: 600 } } as never], this as never);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 });
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 900 },
    offsetHeight: { configurable: true, get: () => 600 },
  });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 600, width: 900, height: 600 }) as DOMRect;
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 30, height: 12 }) as DOMRect;
});

// Chuỗi THẬT của docs-to-ui, thu gọn: docs → cj → ux → ba đầu ra UI-Spec song
// song. `docs` đã xong nên nó không bị tự tick khi tick bước sau — output có
// sẵn trên đĩa.
function stage(
  id: string,
  name: string,
  dependsOn: string[],
  status: PipelineStatus,
  extra: Partial<PipelineView> = {},
): PipelineView {
  return { id, name, dependsOn, status, active: status === 'succeeded' || dependsOn.length === 0, ...extra };
}

const PIPELINES: PipelineView[] = [
  stage('docs', 'Docs → Markdown', [], 'succeeded'),
  stage('cj', 'Customer Journey', ['docs'], 'idle', { active: true }),
  stage('ux', 'UX Spec', ['cj'], 'idle', { active: false }),
  stage('ui-html', 'UI-Spec (HTML)', ['ux'], 'idle', { active: false }),
  stage('ui-react', 'UI-Spec (React)', ['ux'], 'idle', { active: false }),
  stage('ui-react-ds', 'UI-Spec (React DS)', ['ux'], 'idle', { active: false }),
];

function renderCanvas(props?: {
  selectedIds?: string[];
  pipelines?: PipelineView[];
}) {
  const toggles: Array<{ id: string; next: boolean }> = [];
  // `StageLike` chứ không phải `PipelineView`: canvas cố ý chỉ đòi tập con các
  // trường nó thật sự đọc, để modal chọn bước (chỉ có RunStageOption) dùng được.
  const runs: StageLike[] = [];
  const view = render(
    <PipelineFlowCanvas
      pipelines={props?.pipelines ?? PIPELINES}
      selectedIds={props?.selectedIds ?? []}
      onToggle={(id, next) => toggles.push({ id, next })}
      onRunStage={(p) => runs.push(p)}
    />,
  );
  const nodeEl = (id: string): HTMLElement => {
    const el = view.container.querySelector(`[data-testid="rf__node-${id}"]`);
    if (!el) throw new Error(`Không thấy node “${id}” trên canvas`);
    return el as HTMLElement;
  };
  // React Flow đặt node bằng `transform: translate(Xpx,Ypx)` với TOẠ ĐỘ BỐ CỤC
  // (zoom nằm ở lớp viewport bên ngoài), nên đọc thẳng ra được vị trí đã tính.
  const posOf = (id: string): { x: number; y: number } => {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(nodeEl(id).style.transform);
    if (!m) throw new Error(`Node “${id}” chưa có toạ độ: ${nodeEl(id).style.transform}`);
    return { x: Number(m[1]), y: Number(m[2]) };
  };
  const tickOf = (id: string): HTMLInputElement => {
    const box = within(nodeEl(id)).getByRole('checkbox');
    return box as HTMLInputElement;
  };
  return { ...view, nodeEl, posOf, tickOf, toggles, runs };
}

describe('PipelineFlowCanvas · sơ đồ node', () => {
  it('mỗi bước ra ĐÚNG MỘT node — số node bằng số bước', () => {
    const { container, nodeEl } = renderCanvas();
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(PIPELINES.length);
    // Và đúng những bước đó, không phải sáu node trùng tên nhau.
    for (const p of PIPELINES) expect(nodeEl(p.id).textContent).toContain(p.name);
  });

  it('ba đầu ra UI-Spec nằm CÙNG MỘT TẦNG: cùng x, khác y', () => {
    const { posOf } = renderCanvas();
    const html = posOf('ui-html');
    const react = posOf('ui-react');
    const reactDs = posOf('ui-react-ds');

    expect(react.x).toBe(html.x);
    expect(reactDs.x).toBe(html.x);
    expect(new Set([html.y, react.y, reactDs.y]).size).toBe(3);
    // Và tầng đó nằm SAU ux, không phải cạnh nó.
    expect(html.x).toBeGreaterThan(posOf('ux').x);

    // Cùng phép kiểm ở tầng hàm thuần, để hồi quy chỉ ra ngay chỗ hỏng là bố
    // cục chứ không phải cách React Flow dựng DOM.
    const layout = layoutPipelineFlow(PIPELINES);
    expect(layout.get('ui-html')!.tier).toBe(3);
    expect(layout.get('ui-react')!.tier).toBe(3);
    expect(layout.get('ui-react-ds')!.tier).toBe(3);
    expect(layout.get('docs')!.tier).toBe(0);
  });

  it('tầng của một bước là độ sâu LỚN NHẤT theo dependsOn', () => {
    // `ui` phụ thuộc cả `docs` (tầng 0) lẫn `ux` (tầng 2). Lấy min sẽ vẽ nó
    // đứng ngay sau docs — trước một bước nó phải chờ.
    const forked: PipelineView[] = [
      stage('docs', 'Docs', [], 'succeeded'),
      stage('cj', 'CJ', ['docs'], 'idle'),
      stage('ux', 'UX', ['cj'], 'idle'),
      stage('ui', 'UI', ['docs', 'ux'], 'idle'),
    ];
    expect(layoutPipelineFlow(forked).get('ui')!.tier).toBe(3);
  });

  it('cạnh dựng đúng theo dependsOn', () => {
    const { container } = renderCanvas();
    const ids = Array.from(container.querySelectorAll('.react-flow__edge'))
      .map((el) => el.getAttribute('data-id'))
      .sort();
    expect(ids).toEqual(
      ['docs->cj', 'cj->ux', 'ux->ui-html', 'ux->ui-react', 'ux->ui-react-ds'].sort(),
    );
    // Có đường vẽ thật, không phải năm phần tử rỗng.
    expect(container.querySelectorAll('.react-flow__edge-path')).toHaveLength(5);
  });

  it('bấm ô tick trên node gọi onToggle với đúng id và giá trị MỚI', () => {
    const { tickOf, toggles } = renderCanvas({ selectedIds: ['cj'] });
    expect(tickOf('cj').checked).toBe(true);
    expect(tickOf('ux').checked).toBe(false);

    fireEvent.click(tickOf('ux'));
    expect(toggles).toEqual([{ id: 'ux', next: true }]);

    // Bỏ tick một bước ĐANG tick phải báo `false`, không phải lặp lại `true`.
    fireEvent.click(tickOf('cj'));
    expect(toggles[1]).toEqual({ id: 'cj', next: false });
  });

  it('bước bị khoá vẫn tick được, và nói rõ cần xong bước nào trước', () => {
    const { nodeEl, tickOf, toggles } = renderCanvas();
    const locked = nodeEl('ux').querySelector('[data-stage-id="ux"]') as HTMLElement;
    expect(locked.getAttribute('data-locked')).toBe('true');
    expect(locked.getAttribute('title')).toContain('Customer Journey');

    fireEvent.click(tickOf('ux'));
    expect(toggles).toEqual([{ id: 'ux', next: true }]);
  });

  it('nút Chạy của một node trả về đúng bước đó', () => {
    const { nodeEl, runs } = renderCanvas();
    fireEvent.click(within(nodeEl('ui-react')).getByRole('button', { name: /Chạy/ }));
    expect(runs.map((p) => p.id)).toEqual(['ui-react']);
  });
});

describe('resolveToggle (hàm thuần)', () => {
  it('tick một bước kéo theo mọi phụ thuộc CHƯA xong, đệ quy', () => {
    // Tick ui-react → ux (phụ thuộc trực tiếp) và cj (phụ thuộc của ux) theo;
    // docs đã succeeded nên KHÔNG bị tự tick.
    expect(resolveToggle(PIPELINES, [], 'ui-react', true)).toEqual(['cj', 'ux', 'ui-react']);
  });

  it('trả về theo THỨ TỰ workflow, không theo thứ tự tick', () => {
    const afterUx = resolveToggle(PIPELINES, [], 'ux', true);
    expect(afterUx).toEqual(['cj', 'ux']);
    expect(resolveToggle(PIPELINES, afterUx, 'docs', true)).toEqual(['docs', 'cj', 'ux']);
  });

  it('bỏ tick loại luôn các bước phụ thuộc nó', () => {
    const all = ['cj', 'ux', 'ui-html', 'ui-react', 'ui-react-ds'];
    // Bỏ cj → ux mất input (cj chưa succeeded) → cả ba đầu ra mất theo.
    expect(resolveToggle(PIPELINES, all, 'cj', false)).toEqual([]);
    // Bỏ một đầu ra chỉ mất đúng nó: không bước nào phụ thuộc vào nó.
    expect(resolveToggle(PIPELINES, all, 'ui-html', false)).toEqual([
      'cj',
      'ux',
      'ui-react',
      'ui-react-ds',
    ]);
  });

  it('nhận cả Set lẫn mảng và KHÔNG sửa tập đang có', () => {
    const current = new Set(['cj', 'ux']);
    expect(resolveToggle(PIPELINES, current, 'ui-html', true)).toEqual(['cj', 'ux', 'ui-html']);
    expect([...current]).toEqual(['cj', 'ux']);
  });
});
