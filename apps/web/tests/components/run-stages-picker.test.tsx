// @vitest-environment jsdom
//
// Section "Các bước sẽ chạy" của RunAllModal (focus='stages'): người dùng tự
// tick từng bước rồi "Chạy pipeline" chạy đúng những bước đó.
//
// Điều đắt nhất phải giữ đúng ở đây là TICK LAN LÊN PHỤ THUỘC. Daemon KHÔNG hỏi
// gating khi chạy run-all — nó gọi thẳng runPipeline theo thứ tự workflow — nên
// một lựa chọn thiếu phụ thuộc vẫn chạy thật, với thư mục input rỗng, và trả về
// output rác trông y như một lần chạy thành công. Chặn ngay lúc tick là chỗ
// đúng; báo lỗi sau khi người dùng đã bấm Chạy thì đã muộn.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import type { PipelineStatus } from '@open-design/contracts';

// Không cleanup thì cây của test trước còn nguyên trong document.body và các
// phép đếm checkbox dưới đây cộng dồn qua các test.
afterEach(() => cleanup());

// Section "Các bước sẽ chạy" giờ render kèm SƠ ĐỒ (React Flow), mà React Flow đo
// khung vẽ bằng ResizeObserver — jsdom không có, thiếu nó thì modal ném ngay lúc
// mount và mọi test dưới đây đỏ vì lý do không liên quan tới thứ chúng đo.
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


// Modal fetch danh sách design system lúc mount (section Design system, không
// hiện ở focus='stages') — mock đúng một hàm đó để test không chạm mạng. Mock
// TỪNG PHẦN: PipelineModals kéo theo FileViewer, module này còn export hằng số
// mà FileViewer đọc ở top level, nên một mock thay cả module sẽ nổ lúc import.
vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return { ...actual, fetchDesignSystems: async () => [] };
});

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { RunAllModal } = await import('../../src/components/pipelines/PipelineModals');
type RunStageOption = import('../../src/components/pipelines/PipelineModals').RunStageOption;

// Chuỗi thật của docs-to-ui, thu gọn: docs → cj → ux → ui, với ux phụ thuộc cj
// (bắc cầu qua để test đệ quy) và ui phụ thuộc ux. `docs` đã xong nên nó KHÔNG
// bị tự tick khi tick bước sau — output có sẵn trên đĩa.
const stage = (
  id: string,
  name: string,
  dependsOn: string[],
  status: PipelineStatus,
): RunStageOption => ({ id, name, dependsOn, status });

const STAGES: RunStageOption[] = [
  stage('docs', 'Docs → Markdown', [], 'succeeded'),
  stage('cj', 'Customer Journey', ['docs'], 'idle'),
  stage('ux', 'UX Spec', ['cj'], 'idle'),
  stage('ui', 'UI-Spec (HTML)', ['ux'], 'failed'),
];

function renderPicker(props?: { defaultStageIds?: string[] }) {
  const saved: Array<Record<string, unknown>> = [];
  const view = render(
    <RunAllModal
      workflowName="Docs → UI-Spec"
      stages={STAGES}
      {...(props?.defaultStageIds ? { defaultStageIds: props.defaultStageIds } : {})}
      anySucceeded
      focus="stages"
      onClose={() => {}}
      onSaveConfig={async (patch) => {
        saved.push(patch as Record<string, unknown>);
      }}
    />,
  );
  const dialog = within(view.baseElement).getByRole('dialog');
  // Section giờ có HAI chỗ hiện tên bước: sơ đồ node và danh sách checkbox.
  // Mọi phép tìm hàng phải thu về đúng DANH SÁCH, nếu không getByText nổ vì
  // "found multiple elements" — và cái nổ đó không nói gì về thứ test đang đo.
  const stageList = dialog.querySelector('ul');
  if (!stageList) throw new Error('Không thấy danh sách bước trong modal');
  const boxFor = (name: string): HTMLInputElement => {
    const row = within(stageList as HTMLElement).getByText(name).closest('label');
    if (!row) throw new Error(`Không thấy hàng bước “${name}”`);
    const box = row.querySelector('input[type="checkbox"]');
    if (!box) throw new Error(`Hàng “${name}” không có checkbox`);
    return box as HTMLInputElement;
  };
  const checkedNames = () =>
    STAGES.filter((s) => boxFor(s.name).checked).map((s) => s.id);
  const preset = (label: string) => within(dialog).getByRole('button', { name: label });
  // jest-dom không được cài trong bộ này, nên đọc thẳng thuộc tính `disabled`.
  const saveBtn = () => within(dialog).getByRole('button', { name: /Lưu/ }) as HTMLButtonElement;
  return { ...view, dialog, boxFor, checkedNames, preset, saveBtn, saved };
}

describe('RunAllModal · section "Các bước sẽ chạy"', () => {
  it('mặc định tick đúng các bước CHƯA xong (docs đã succeeded nên không tick)', () => {
    const { checkedNames } = renderPicker();
    expect(checkedNames()).toEqual(['cj', 'ux', 'ui']);
  });

  it('tick một bước kéo theo mọi phụ thuộc chưa xong của nó, đệ quy', () => {
    const { boxFor, checkedNames, preset } = renderPicker();
    fireEvent.click(preset('Bỏ chọn hết'));
    expect(checkedNames()).toEqual([]);

    // Tick ui → ux (phụ thuộc trực tiếp) và cj (phụ thuộc của ux) phải tick
    // theo; docs đã succeeded nên KHÔNG bị tự tick.
    fireEvent.click(boxFor('UI-Spec (HTML)'));
    expect(checkedNames()).toEqual(['cj', 'ux', 'ui']);
    expect(boxFor('Docs → Markdown').checked).toBe(false);
  });

  it('bỏ tick một bước thì các bước phụ thuộc nó cũng bị bỏ theo', () => {
    const { boxFor, checkedNames } = renderPicker();
    expect(checkedNames()).toEqual(['cj', 'ux', 'ui']);

    // Bỏ cj → ux mất input (cj chưa succeeded) → ui mất input theo.
    fireEvent.click(boxFor('Customer Journey'));
    expect(checkedNames()).toEqual([]);
  });

  it('preset "Chỉ bước chưa xong" cho đúng tập các bước chưa succeeded', () => {
    const { checkedNames, preset } = renderPicker({ defaultStageIds: ['docs', 'cj', 'ux', 'ui'] });
    expect(checkedNames()).toEqual(['docs', 'cj', 'ux', 'ui']);

    fireEvent.click(preset('Chỉ bước chưa xong'));
    expect(checkedNames()).toEqual(['cj', 'ux', 'ui']);
  });

  it('bỏ tick hết thì nút Lưu bị vô hiệu (chạy 0 bước không có nghĩa gì)', () => {
    const { checkedNames, preset, saveBtn } = renderPicker();
    expect(saveBtn().disabled).toBe(false);

    fireEvent.click(preset('Bỏ chọn hết'));
    expect(checkedNames()).toEqual([]);
    expect(saveBtn().disabled).toBe(true);
  });

  it('Lưu gửi stageIds theo THỨ TỰ workflow, không theo thứ tự tick', async () => {
    const { boxFor, preset, saveBtn, saved } = renderPicker();
    fireEvent.click(preset('Bỏ chọn hết'));
    fireEvent.click(boxFor('UI-Spec (HTML)')); // kéo theo ux + cj
    fireEvent.click(saveBtn());
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ stageIds: ['cj', 'ux', 'ui'] });
  });
});
