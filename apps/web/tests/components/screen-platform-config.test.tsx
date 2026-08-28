// @vitest-environment jsdom
//
// "Nền tảng màn hình" (docs-review, WP docs-review-screen-platform): người dùng
// chọn Mobile app / Website / Cả hai ở rightPanel TRƯỚC khi chạy — KHÔNG
// default, KHÔNG đoán từ tài liệu. Web phải:
// - rail: hiện đúng giá trị đã lưu, hoặc "Chưa chọn" khi chưa có
//   (`screenPlatformRailLabel`, gate `hasScreenPlatformStage`);
// - modal (focus='screenPlatform'): 3 card radio, KHÔNG card nào tick sẵn, Lưu
//   khoá tới khi chọn, và patch gửi đúng `{ screenPlatform }`;
// - run-all payload: mang `screenPlatform` khi có, KHÔNG tự điền khi thiếu.
//
// Hàm thuần import từ PipelinesView (không mount cả màn — cùng lý do
// stage-run-uses-config.test.tsx); modal mount trực tiếp như run-stages-picker.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import type { PipelineView, RunAllConfig } from '@open-design/contracts';

afterEach(() => cleanup());

// Modal fetch design system lúc mount — mock TỪNG PHẦN (xem run-stages-picker).
vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return { ...actual, fetchDesignSystems: async () => [] };
});
vi.mock('../../src/components/Icon', () => ({ Icon: () => null }));

const { hasScreenPlatformStage, screenPlatformRailLabel, runAllPayloadFromConfig } = await import(
  '../../src/components/PipelinesView'
);
const { RunAllModal, SCREEN_PLATFORM_OPTIONS } = await import('../../src/components/pipelines/PipelineModals');

type Stage = Pick<PipelineView, 'id' | 'acceptsPlatform' | 'acceptsScreenPlatform'>;
const stage = (id: string, extra: Partial<Stage> = {}): Stage => ({ id, ...extra });

/** docs-review thu gọn: dr-docs → dr-flow (cần nền tảng) → dr-comp/dr-mockup (cần) → dr-review. */
const DOCS_REVIEW: Stage[] = [
  stage('dr-docs'),
  stage('dr-flow', { acceptsScreenPlatform: true }),
  stage('dr-comp', { acceptsScreenPlatform: true }),
  stage('dr-mockup', { acceptsScreenPlatform: true }),
  stage('dr-review'),
];
/** docs-to-ui thu gọn: không có bước nào cần "Nền tảng màn hình". */
const DOCS_TO_UI: Stage[] = [stage('docs'), stage('ux-spec', { acceptsPlatform: true }), stage('ui-html')];

describe('hasScreenPlatformStage — gate dòng rail / section / nút Chạy', () => {
  it('docs-review có dr-flow/dr-comp/dr-mockup → true', () => {
    expect(hasScreenPlatformStage(DOCS_REVIEW)).toBe(true);
  });
  it('docs-to-ui (chỉ acceptsPlatform) → false — không đụng hành vi docs-to-ui', () => {
    expect(hasScreenPlatformStage(DOCS_TO_UI)).toBe(false);
  });
  it('rỗng → false', () => {
    expect(hasScreenPlatformStage([])).toBe(false);
  });
});

describe('screenPlatformRailLabel — dòng rail "Nền tảng màn hình"', () => {
  it('chưa chọn → "Chưa chọn" (không có mặc định ngầm)', () => {
    expect(screenPlatformRailLabel(undefined)).toBe('Chưa chọn');
  });
  it('mobile / web / both → nhãn tương ứng', () => {
    expect(screenPlatformRailLabel('mobile')).toBe('Mobile app');
    expect(screenPlatformRailLabel('web')).toBe('Website');
    expect(screenPlatformRailLabel('both')).toBe('Cả hai (app + web)');
  });
});

describe('runAllPayloadFromConfig — payload run-all mang screenPlatform', () => {
  const cfgBase: RunAllConfig = { confluencePages: [{ id: '1', url: 'https://cf/x' }] };

  it('đã chọn → payload có đúng screenPlatform đã lưu', () => {
    for (const screenPlatform of ['mobile', 'web', 'both'] as const) {
      const payload = runAllPayloadFromConfig(DOCS_REVIEW, { ...cfgBase, screenPlatform });
      expect(payload.screenPlatform).toBe(screenPlatform);
    }
  });

  it('chưa chọn → KHÔNG có field screenPlatform (không tự điền như platform)', () => {
    const payload = runAllPayloadFromConfig(DOCS_REVIEW, cfgBase);
    expect('screenPlatform' in payload).toBe(false);
    // Đối chiếu: `platform` legacy vẫn có mặc định 'mobile' — hành vi cũ giữ nguyên.
    expect(payload.platform).toBe('mobile');
  });

  it('docs-to-ui không bị ảnh hưởng: targets/platform như cũ, không có screenPlatform', () => {
    const payload = runAllPayloadFromConfig(DOCS_TO_UI, { ...cfgBase, targets: ['web-user'] });
    expect(payload.targets).toEqual(['web-user']);
    expect(payload.platform).toBe('web');
    expect('screenPlatform' in payload).toBe(false);
  });
});

describe('RunAllModal focus="screenPlatform" — 3 card radio, không mặc định, ghi qua run-config', () => {
  function renderModal(props?: { defaultScreenPlatform?: 'mobile' | 'web' | 'both'; hasScreenPlatform?: boolean }) {
    const saved: Array<Record<string, unknown>> = [];
    const view = render(
      <RunAllModal
        workflowName="Docs → Review tài liệu"
        hasPlatform={false}
        hasTerminal={false}
        hasDesignSystem={false}
        supportsLean={false}
        hasScreenPlatform={props?.hasScreenPlatform ?? true}
        {...(props?.defaultScreenPlatform ? { defaultScreenPlatform: props.defaultScreenPlatform } : {})}
        anySucceeded={false}
        focus="screenPlatform"
        onClose={() => {}}
        onSaveConfig={async (patch) => {
          saved.push(patch as Record<string, unknown>);
        }}
      />,
    );
    const dialog = within(view.baseElement).getByRole('dialog');
    return { dialog, saved };
  }

  it('hiện đúng 3 card Mobile app / Website / Cả hai, KHÔNG card nào tick sẵn khi chưa có config', () => {
    const { dialog } = renderModal();
    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.textContent)).toEqual(
      expect.arrayContaining(SCREEN_PLATFORM_OPTIONS.map((o) => expect.stringContaining(o.label))),
    );
    for (const r of radios) expect(r.getAttribute('aria-checked')).toBe('false');
    // Chưa chọn thì Lưu khoá — không được lưu một cấu hình trống rỗng.
    const save = within(dialog).getByRole('button', { name: /Lưu/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    // Tiêu đề modal + nhãn section cùng = tên dòng rail (cùng một khái niệm, một tên).
    expect(within(dialog).getAllByText('Nền tảng màn hình').length).toBeGreaterThanOrEqual(1);
  });

  it('chọn Website rồi Lưu → patch đúng { screenPlatform: "web" }, không kèm field khác', async () => {
    const { dialog, saved } = renderModal();
    fireEvent.click(within(dialog).getByRole('radio', { name: /Website/ }));
    expect(within(dialog).getByRole('radio', { name: /Website/ }).getAttribute('aria-checked')).toBe('true');
    const save = within(dialog).getByRole('button', { name: /Lưu/ });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ screenPlatform: 'web' });
  });

  it('đã lưu "both" → mở modal thấy card Cả hai tick sẵn; đổi sang Mobile app → patch mobile', async () => {
    const { dialog, saved } = renderModal({ defaultScreenPlatform: 'both' });
    expect(within(dialog).getByRole('radio', { name: /Cả hai/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Mobile app/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Lưu/ }));
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ screenPlatform: 'mobile' });
  });

  it('workflow không có bước cần nền tảng (docs-to-ui) → focus báo "không có lựa chọn đó"', () => {
    const { dialog } = renderModal({ hasScreenPlatform: false });
    expect(within(dialog).getByText('Workflow này không có lựa chọn đó.')).toBeTruthy();
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
  });
});
