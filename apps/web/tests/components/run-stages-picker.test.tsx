// @vitest-environment jsdom
//
// Section "Các bước sẽ chạy" của RunAllModal (focus='stages'): người dùng tự
// tick từng bước rồi "Chạy pipeline" chạy đúng những bước đó.
//
// KHÔNG còn ép phụ thuộc theo bước ở đây: tick một bước CHỈ thêm đúng bước đó
// vào lựa chọn, bỏ tick một bước CHỈ bỏ đúng bước đó — phụ thuộc chưa xong của
// nó không bị kéo theo tick, và các bước phụ thuộc NÓ cũng không bị bỏ theo.
// `missingRunDeps` là kênh thông tin MỀM thay cho cơ chế cũ: nó tính phụ thuộc
// tĩnh nào của một bước đang tick mà chưa tick/chưa `succeeded`, để danh sách
// hiện chú thích "sẽ chạy thiếu gì" — không chặn Lưu, không tự tick/bỏ tick hộ.
// Người dùng có toàn quyền chạy một bước với dữ liệu hiện có trên đĩa.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import type { PipelineStatus } from '@open-design/contracts';

// Không cleanup thì cây của test trước còn nguyên trong document.body và các
// phép đếm checkbox dưới đây cộng dồn qua các test.
afterEach(() => cleanup());

// Modal fetch danh sách design system lúc mount (section Design system, không
// hiện ở focus='stages') — mock đúng một hàm đó để test không chạm mạng. Mock
// TỪNG PHẦN: PipelineModals kéo theo FileViewer, module này còn export hằng số
// mà FileViewer đọc ở top level, nên một mock thay cả module sẽ nổ lúc import.
vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return { ...actual, fetchDesignSystems: async () => [] };
});

vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { RunAllModal, missingRunDeps } = await import('../../src/components/pipelines/PipelineModals');
type RunStageOption = import('../../src/components/pipelines/PipelineModals').RunStageOption;

// Chuỗi thật của docs-to-ui, thu gọn: docs → cj → ux → ui, với ux phụ thuộc cj
// và ui phụ thuộc ux — chuỗi nhiều tầng để chứng minh KHÔNG còn cascade nào
// (tick/bỏ tick một bước không lan sang bước khác, dù bắc cầu). `docs` đã
// succeeded nên nó KHÔNG nằm trong lựa chọn mặc định.
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
  // Danh sách bước là một <ol> (có đánh số thứ tự chạy). Thu phép tìm hàng về
  // đúng danh sách thay vì cả dialog: tên bước còn xuất hiện ở dòng tóm tắt
  // "Sẽ chạy N bước: …" bên dưới, nên getByText trên cả dialog sẽ nổ vì
  // "found multiple elements" — và cái nổ đó không nói gì về thứ test đang đo.
  const stageList = dialog.querySelector('ol');
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

  it('tick một bước CHỈ thêm đúng bước đó, không kéo theo phụ thuộc chưa xong', () => {
    const { boxFor, checkedNames, preset } = renderPicker();
    fireEvent.click(preset('Bỏ chọn hết'));
    expect(checkedNames()).toEqual([]);

    // Tick ui → CHỈ ui được thêm; ux (phụ thuộc trực tiếp) và cj (phụ thuộc
    // của ux), dù chưa succeeded, KHÔNG bị tự tick theo nữa.
    fireEvent.click(boxFor('UI-Spec (HTML)'));
    expect(checkedNames()).toEqual(['ui']);
    expect(boxFor('UX Spec').checked).toBe(false);
    expect(boxFor('Customer Journey').checked).toBe(false);
    expect(boxFor('Docs → Markdown').checked).toBe(false);
  });

  it('bỏ tick một bước KHÔNG làm mất bước nào khác', () => {
    const { boxFor, checkedNames } = renderPicker();
    expect(checkedNames()).toEqual(['cj', 'ux', 'ui']);

    // Bỏ cj → ux và ui (phụ thuộc bắc cầu vào cj) vẫn giữ nguyên tick; chỉ cj
    // rời khỏi lựa chọn.
    fireEvent.click(boxFor('Customer Journey'));
    expect(checkedNames()).toEqual(['ux', 'ui']);
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
    // Tick tường minh cả ba bước theo thứ tự NGƯỢC workflow (ui trước, cj sau
    // cùng) — không còn cascade nào tự kéo phụ thuộc vào giúp, nên fixture
    // phải tự tick từng bước cần thiết. stageIds gửi lên vẫn phải theo thứ tự
    // workflow, không theo thứ tự bấm.
    fireEvent.click(boxFor('UI-Spec (HTML)'));
    fireEvent.click(boxFor('UX Spec'));
    fireEvent.click(boxFor('Customer Journey'));
    fireEvent.click(saveBtn());
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    // `terminal` đi kèm vì bước cuối giờ nằm TRONG section này (không còn
    // section "Kết quả UI-Spec" riêng). Workflow này chỉ có một đầu ra nên
    // không có nhóm radio nào hiện ra, nhưng field vẫn phải được ghi — đường
    // chạy tự động (stageIds rỗng) đọc đúng nó để biết chạy đầu ra nào.
    expect(saved[0]).toEqual({ stageIds: ['cj', 'ux', 'ui'], terminal: 'ui-html' });
  });
});

// Ba đầu ra UI-Spec của docs-to-ui: cùng phụ thuộc ux-review, là BA LỰA CHỌN
// thay thế nhau. Bề mặt phải cưỡng chế đúng một — daemon thì không: nó chạy
// tuần tự mọi id có trong `stageIds`, nên ba nhánh cùng tick sẽ build ba lần.
const FORK_STAGES: RunStageOption[] = [
  stage('ux', 'UX Spec', [], 'succeeded'),
  stage('ux-review', 'UX Heuristic Review', ['ux'], 'idle'),
  stage('ui-html', 'UI-Spec (HTML)', ['ux-review'], 'idle'),
  stage('ui-react', 'UI-Spec (React)', ['ux-review'], 'idle'),
  stage('ui-react-ds', 'UI-Spec (React DS)', ['ux-review'], 'idle'),
];

function renderFork(props?: { defaultStageIds?: string[] }) {
  const saved: Array<Record<string, unknown>> = [];
  const view = render(
    <RunAllModal
      workflowName="Docs → UI-Spec"
      stages={FORK_STAGES}
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
  const radios = () => within(dialog).getAllByRole('radio') as HTMLButtonElement[];
  const radio = (label: string) =>
    radios().find((r) => r.textContent?.includes(label)) ??
    (() => {
      throw new Error(`Không thấy lựa chọn “${label}”`);
    })();
  const checkedRadio = () => radios().find((r) => r.getAttribute('aria-checked') === 'true');
  const forkBox = () => {
    const row = within(dialog).getByText('Kết quả UI-Spec').closest('label');
    return row!.querySelector('input[type="checkbox"]') as HTMLInputElement;
  };
  const preset = (label: string) => within(dialog).getByRole('button', { name: label });
  const saveBtn = () => within(dialog).getByRole('button', { name: /Lưu/ }) as HTMLButtonElement;
  return { ...view, dialog, radios, radio, checkedRadio, forkBox, preset, saveBtn, saved };
}

describe('RunAllModal · bước cuối "chọn 1 trong 3"', () => {
  it('ba đầu ra gộp thành MỘT hàng bước, không phải ba hàng nối tiếp', () => {
    const { dialog, radios } = renderFork();
    const list = dialog.querySelector('ol')!;
    // 2 bước thường + 1 hàng bước cuối = 3 hàng, dù workflow có 5 bước.
    expect(list.querySelectorAll(':scope > li')).toHaveLength(3);
    expect(radios()).toHaveLength(3);
    // Đánh số phải dừng ở 3 — không có bước 4, 5.
    expect([...list.querySelectorAll('li')].map((li) => li.textContent?.trim()[0])).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('chọn một đầu ra thì bỏ đầu ra đang chọn trước đó (không bao giờ tick hai)', async () => {
    const { radio, checkedRadio, saveBtn, saved } = renderFork({
      defaultStageIds: ['ux-review', 'ui-html'],
    });
    expect(checkedRadio()?.textContent).toContain('HTML prototype');

    fireEvent.click(radio('React app'));
    expect(checkedRadio()?.textContent).toContain('React app');

    fireEvent.click(saveBtn());
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ stageIds: ['ux-review', 'ui-react'], terminal: 'ui-react' });
  });

  it('preset "Tất cả" vẫn chỉ giữ MỘT đầu ra', async () => {
    const { preset, radios, saveBtn, saved } = renderFork();
    fireEvent.click(preset('Tất cả'));
    expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);

    fireEvent.click(saveBtn());
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.stageIds).toEqual(['ux', 'ux-review', 'ui-html']);
  });

  it('bỏ tick bước cuối thì không đầu ra nào chạy, nhưng lựa chọn vẫn nhớ', () => {
    const { forkBox, checkedRadio, radio } = renderFork({ defaultStageIds: ['ux-review', 'ui-react'] });
    expect(forkBox().checked).toBe(true);

    fireEvent.click(forkBox());
    expect(forkBox().checked).toBe(false);
    expect(checkedRadio()).toBeUndefined();

    // Bấm thẳng vào một lựa chọn là cách bật lại bước — không phải quay lên tick
    // ô vuông trước rồi mới chọn được.
    fireEvent.click(radio('React DS'));
    expect(forkBox().checked).toBe(true);
    expect(checkedRadio()?.textContent).toContain('React DS');
  });

  it('chọn đầu ra CHỈ thêm đúng đầu ra đó, không kéo theo phụ thuộc chưa xong của nó', async () => {
    const { preset, radio, saveBtn, saved } = renderFork();
    fireEvent.click(preset('Bỏ chọn hết'));

    // ux-review chưa xong (idle) nhưng KHÔNG còn tự tick theo nữa — chỉ đúng
    // đầu ra vừa chọn (ui-react) được thêm vào lựa chọn. Cơ chế "chọn 1 trong
    // 3 đầu ra" (radio loại trừ nhau) không đổi — test riêng ở trên.
    fireEvent.click(radio('React app'));
    fireEvent.click(saveBtn());
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.stageIds).toEqual(['ui-react']);
  });
});

// missingRunDeps: kênh THÔNG BÁO thay cho cascade cũ. Một bước đang tick mà
// phụ thuộc tĩnh của nó chưa tick VÀ chưa succeeded trên đĩa thì hàm trả về
// đúng phụ thuộc đó — không tick/bỏ tick hộ, chỉ để danh sách hiện chú thích
// mềm "sẽ chạy thiếu gì".
describe('missingRunDeps · chú thích mềm thay cho cascade', () => {
  it('phụ thuộc chưa tick và chưa succeeded → trả về đúng bước đó', () => {
    // ui phụ thuộc ux (idle, chưa succeeded); chỉ ui được tick.
    const uiStage = STAGES.find((s) => s.id === 'ui')!;
    const uxStage = STAGES.find((s) => s.id === 'ux')!;
    expect(missingRunDeps(uiStage, STAGES, new Set(['ui']))).toEqual([uxStage]);
  });

  it('phụ thuộc đã tick → không còn thiếu, trả về rỗng', () => {
    const uiStage = STAGES.find((s) => s.id === 'ui')!;
    expect(missingRunDeps(uiStage, STAGES, new Set(['ui', 'ux']))).toEqual([]);
  });

  it('phụ thuộc đã succeeded trên đĩa → không cần tick, trả về rỗng', () => {
    // cj phụ thuộc docs — docs đã succeeded dù không nằm trong lựa chọn.
    const cjStage = STAGES.find((s) => s.id === 'cj')!;
    expect(missingRunDeps(cjStage, STAGES, new Set(['cj']))).toEqual([]);
  });
});
