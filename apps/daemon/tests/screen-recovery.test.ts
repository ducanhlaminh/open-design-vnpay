import { describe, expect, it } from 'vitest';

import {
  canonicalizeRecoveredScreens,
  parseScreenRecovery,
  validateScreenRecovery,
  type ScreenRecoveryCandidate,
  type ScreenRecoveryContext,
} from '../src/screen-recovery.js';

const SOURCE = 'docs-feature/pay/2.1-PRD-Payment.md';

const markdown = `# Thanh toán

## SCR-005 — Thông tin thanh toán

Khách hàng kiểm tra đơn và bấm Thanh toán.

\`\`\`
## SCR-099 — Chỉ là ví dụ
\`\`\`
`;

const context: ScreenRecoveryContext = {
  markdownBySource: { [SOURCE]: markdown },
  flows: {
    'FLOW-pay': {
      cells: [
        { id: 'start', label: 'Bắt đầu', type: 'start' },
        { id: 'pay', label: 'Màn Thông tin thanh toán', type: 'action' },
        { id: 'confirm', label: 'Khách hàng xác nhận', type: 'action' },
        { id: 'billing', label: 'Billing gạch nợ', type: 'action' },
        { id: 'end', label: 'Kết thúc', type: 'end' },
        // Cạnh kiểu sequence-diagram (bug #ba03366c): thao tác UI nằm TRÊN
        // mũi tên — dùng `kind` (không phải `type`) đúng như cells.json
        // daemon ghi từ draw.io.
        { id: 'e-tap', label: 'Chọn icon chức năng "Apple Pay" ở MH trang chủ', kind: 'edge' },
        { id: 'e-api', label: 'API kiểm tra trạng thái thẻ', kind: 'edge' },
      ],
    },
  },
};

function candidate(overrides: Partial<ScreenRecoveryCandidate> = {}): ScreenRecoveryCandidate {
  return {
    flowId: 'FLOW-pay',
    name: 'Thông tin thanh toán',
    source: SOURCE,
    cells: ['pay'],
    confidence: 0.92,
    reason: 'Heading và node đều mô tả màn thanh toán hiện trạng.',
    anchorText: '## SCR-005 — Thông tin thanh toán',
    diagramEvidence: [{ cellId: 'pay', label: 'Màn Thông tin thanh toán' }],
    ...overrides,
  };
}

describe('parseScreenRecovery', () => {
  it('đọc schema v1 khoan dung, trim dữ liệu và bỏ candidate hỏng thay vì throw', () => {
    const parsed = parseScreenRecovery(
      JSON.stringify({
        schema_version: 1,
        ignored_future_field: true,
        candidates: [
          candidate({ name: '  Thông tin thanh toán  ', cells: [' pay ', '', 'confirm'] }),
          { flowId: 'FLOW-pay', name: '', source: SOURCE },
        ],
      }),
    );

    expect(parsed.document?.schema_version).toBe(1);
    expect(parsed.document?.candidates).toHaveLength(1);
    expect(parsed.document?.candidates[0]).toMatchObject({
      name: 'Thông tin thanh toán',
      cells: ['pay', 'confirm'],
    });
    expect(parsed.issues).toContain('candidates[1]: thiếu flowId/name/source/reason');
  });

  it.each([
    ['JSON hỏng', '{'],
    ['root sai', '[]'],
    ['schema sai', JSON.stringify({ schema_version: 2, candidates: [] })],
  ])('trả lỗi có cấu trúc cho %s', (_label, raw) => {
    const parsed = parseScreenRecovery(raw);
    expect(parsed.document).toBeNull();
    expect(parsed.issues.length).toBeGreaterThan(0);
  });
});

describe('validateScreenRecovery', () => {
  it('nhận candidate có anchor duy nhất và diagram evidence as-is hợp lệ', () => {
    const result = validateScreenRecovery({ schema_version: 1, candidates: [candidate()] }, context);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      key: '2.1-PRD-Payment__SCR-005',
      provenance: 'inferred-flow',
      cells: ['pay'],
    });
  });

  it.each([
    ['source lạ', candidate({ source: 'docs-feature/unknown.md' }), 'source không tồn tại'],
    ['flow lạ', candidate({ flowId: 'FLOW-missing' }), 'flow không tồn tại'],
    ['cell lạ/proposed-only', candidate({ cells: ['od-new'], diagramEvidence: [{ cellId: 'od-new', label: 'Màn mới' }] }), 'cell chỉ tồn tại ở bản đề xuất'],
    ['label không khớp', candidate({ diagramEvidence: [{ cellId: 'pay', label: 'Sai nhãn' }] }), 'label không khớp'],
    ['anchor trong code fence', candidate({ anchorText: '## SCR-099 — Chỉ là ví dụ', diagramEvidence: [] }), 'anchor không xuất hiện ngoài code fence'],
  ])('loại %s và nêu reason', (_label, value, reason) => {
    const result = validateScreenRecovery({ schema_version: 1, candidates: [value] }, context);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reasons.join(' | ')).toContain(reason);
  });

  it('loại anchor không duy nhất', () => {
    const duplicatedContext: ScreenRecoveryContext = {
      ...context,
      markdownBySource: { [SOURCE]: `${markdown}\n## SCR-005 — Thông tin thanh toán\n` },
    };
    const result = validateScreenRecovery({ schema_version: 1, candidates: [candidate({ diagramEvidence: [] })] }, duplicatedContext);
    expect(result.rejected[0]?.reasons).toContain('anchorText phải là đúng một dòng duy nhất ngoài code fence trong source');
  });

  const startEndOnly = candidate({ cells: ['start', 'end'], diagramEvidence: [{ cellId: 'start', label: 'Bắt đầu' }] });
  delete startEndOnly.anchorText;
  const backendOnly = candidate({ cells: ['billing'], diagramEvidence: [{ cellId: 'billing', label: 'Billing gạch nợ' }] });
  delete backendOnly.anchorText;

  const backendEdgeOnly = candidate({ cells: ['e-api'], diagramEvidence: [{ cellId: 'e-api', label: 'API kiểm tra trạng thái thẻ' }] });
  delete backendEdgeOnly.anchorText;

  it.each([
    ['start/end thuần', startEndOnly],
    ['backend thuần', backendOnly],
    ['cạnh sequence label backend thuần', backendEdgeOnly],
  ])('loại candidate %s khi không có bằng chứng UI', (_label, value) => {
    const result = validateScreenRecovery({ schema_version: 1, candidates: [value] }, context);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reasons).toContain('candidate chỉ mô tả start/end/backend, không có bằng chứng UI');
  });

  // Bug #ba03366c: sơ đồ sequence chỉ có bằng chứng UI TRÊN cạnh — trước đây
  // isUiCell loại thẳng kind 'edge' khiến 21/21 candidate hợp lệ bị từ chối
  // và recovery không bao giờ qua được với tài liệu dạng này.
  it('nhận candidate chỉ có cạnh sequence mang label thao tác UI (không anchorText)', () => {
    const seq = candidate({
      name: 'MH 1: Trang chủ',
      cells: ['e-tap'],
      diagramEvidence: [{ cellId: 'e-tap', label: 'Chọn icon chức năng "Apple Pay" ở MH trang chủ' }],
    });
    delete seq.anchorText;
    const result = validateScreenRecovery({ schema_version: 1, candidates: [seq] }, context);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.cells).toEqual(['e-tap']);
  });

  it('dedupe cùng screen, gộp nhiều cell và sinh AUTO key ổn định', () => {
    const first = candidate({
      name: 'Xác nhận đơn',
      anchorText: 'Khách hàng kiểm tra đơn và bấm Thanh toán.',
      diagramEvidence: [],
      cells: ['pay'],
    });
    const duplicate = candidate({
      name: 'Xác nhận đơn',
      anchorText: 'Khách hàng kiểm tra đơn và bấm Thanh toán.',
      diagramEvidence: [{ cellId: 'confirm', label: 'Khách hàng xác nhận' }],
      cells: ['confirm'],
      confidence: 0.8,
    });
    const one = validateScreenRecovery({ schema_version: 1, candidates: [first, duplicate] }, context);
    const two = validateScreenRecovery({ schema_version: 1, candidates: [duplicate, first] }, context);

    expect(one.accepted).toHaveLength(1);
    expect(one.accepted[0]?.key).toMatch(/^2\.1-PRD-Payment__AUTO-[A-F0-9]{12}$/);
    expect(one.accepted[0]?.key).toBe(two.accepted[0]?.key);
    expect(one.accepted[0]?.cells).toEqual(['confirm', 'pay']);
    expect(one.accepted[0]?.diagramEvidence).toEqual([{ cellId: 'confirm', label: 'Khách hàng xác nhận' }]);
  });

  it('giữ mapping cùng một screen khi screen xuất hiện trong nhiều flow', () => {
    const multiFlowContext: ScreenRecoveryContext = {
      ...context,
      flows: {
        ...context.flows,
        'FLOW-refund': { cells: [{ id: 'refund-pay', label: 'Màn Thông tin thanh toán', type: 'action' }] },
      },
    };
    const result = validateScreenRecovery(
      {
        schema_version: 1,
        candidates: [
          candidate(),
          candidate({
            flowId: 'FLOW-refund',
            cells: ['refund-pay'],
            diagramEvidence: [{ cellId: 'refund-pay', label: 'Màn Thông tin thanh toán' }],
          }),
        ],
      },
      multiFlowContext,
    );

    expect(result.accepted).toHaveLength(2);
    expect(result.accepted.map((screen) => screen.flowId)).toEqual(['FLOW-pay', 'FLOW-refund']);
    expect(new Set(result.accepted.map((screen) => screen.key))).toEqual(new Set(['2.1-PRD-Payment__SCR-005']));
  });
});

describe('canonicalizeRecoveredScreens', () => {
  it('merge vào ScreensFile; explicit hiện có thắng inferred và metadata optional được giữ', () => {
    const validation = validateScreenRecovery(
      {
        schema_version: 1,
        candidates: [candidate({ cells: ['pay', 'confirm'] })],
      },
      context,
    );
    const merged = canonicalizeRecoveredScreens(
      {
        cells: { pay: 'manual__SCR-001' },
        names: { 'manual__SCR-001': 'Màn khai trong tài liệu' },
        note: 'ghi chú cũ',
      },
      validation.accepted,
    );

    expect(merged.cells).toEqual({
      pay: 'manual__SCR-001',
      confirm: '2.1-PRD-Payment__SCR-005',
    });
    expect(merged.names).toMatchObject({
      'manual__SCR-001': 'Màn khai trong tài liệu',
      '2.1-PRD-Payment__SCR-005': 'Thông tin thanh toán',
    });
    expect(merged.note).toBe('ghi chú cũ');
    expect(merged.meta?.['2.1-PRD-Payment__SCR-005']).toMatchObject({
      provenance: 'inferred-flow',
      confidence: 0.92,
      evidence: {
        source: SOURCE,
        anchorText: '## SCR-005 — Thông tin thanh toán',
      },
    });
    expect(merged.meta?.['manual__SCR-001']).toBeUndefined();
  });
});
