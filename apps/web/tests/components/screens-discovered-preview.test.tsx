// @vitest-environment jsdom
//
// ScreensDiscoveredPreview (0.8.143) — preview cho screens-discovered.json
// (danh sách màn; nay sinh cùng bước Luồng màn hình dr-flow, trước là stage
// dr-screens riêng). Trước đây stage này không có preview riêng:
// Quick result fallback mở comp/_screens.json và SpecFileViewer render nhầm
// thành UX Spec toàn dấu "−". Test cả shape guard (isScreensDiscoveredDoc)
// mà FileViewer dùng để tránh lặp lại chuyện nhận nhầm.
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  ScreensDiscoveredPreview,
  isScreensDiscoveredDoc,
  type ScreensDiscoveredDoc,
} from '../../src/components/ScreensDiscoveredPreview';

afterEach(cleanup);

const DOC: ScreensDiscoveredDoc = {
  schema_version: 1,
  generatedAt: '2026-08-25T00:00:00.000Z',
  pages: [
    {
      source: 'docs-feature/sim/2.1-PRD-Mua-SIM.md',
      screens: [
        {
          code: null,
          name: 'Màn hình trang chủ',
          anchorText: '## 2.1 Trang chủ',
          blocks: [{ name: 'Voucher', anchorText: '### Voucher', why: 'Khối nhập mã giảm giá bên trong màn.' }],
        },
        { code: 'SCR-002', name: 'Chọn gói cước', anchorText: '### 4.2 SCR-002 Chọn gói cước' },
        { code: null, name: 'Nhập thông tin', anchorText: '**Nhập thông tin**' },
        { code: 'SCR-003-APP', name: 'Kết quả giao dịch', anchorText: '| Kết quả giao dịch | MB |' },
        { code: 'SCR-003-WEB', name: 'Kết quả giao dịch', anchorText: '| Kết quả giao dịch | IB |' },
      ],
    },
  ],
  excluded: [{ name: 'Danh sách màn hình', source: 'docs-feature/sim/2.1-PRD-Mua-SIM.md', reason: 'Tiêu đề mục liệt kê, không phải giao diện.' }],
  groupSuggestions: [
    { suggestionId: 'ket-qua-giao-dich__mb-ib', decision: 'confirm', why: 'Hai biến thể App/Web của cùng màn.' },
  ],
};

describe('isScreensDiscoveredDoc', () => {
  it('nhận đúng shape v1 và từ chối ScreensManifest / ux-spec / rác', () => {
    expect(isScreensDiscoveredDoc(DOC)).toBe(true);
    // ScreensManifest (comp/_screens.json) — mảng screens phẳng, không pages.
    expect(isScreensDiscoveredDoc({ schema_version: 1, screens: [{ key: 'a__X1', origin: 'doc' }] })).toBe(false);
    // ux-spec — có screens nhưng không schema_version/pages.
    expect(isScreensDiscoveredDoc({ screens: [{ id: 's1', name: 'Home' }] })).toBe(false);
    expect(isScreensDiscoveredDoc(null)).toBe(false);
    expect(isScreensDiscoveredDoc({ schema_version: 2, pages: [] })).toBe(false);
    expect(isScreensDiscoveredDoc({ schema_version: 1, pages: [{ screens: [] }] })).toBe(false); // page thiếu source
  });
});

describe('ScreensDiscoveredPreview', () => {
  it('render đủ: header đếm màn/trang, mã X-auto chỉ đếm màn không mã, khối bổ sung lồng, badge App/Web', () => {
    render(<ScreensDiscoveredPreview doc={DOC} />);
    const root = screen.getByTestId('screens-discovered-preview');
    expect(root.textContent).toContain('5 màn · 1 trang');

    // Mã: X-auto đếm QUA màn không mã (X1 = trang chủ, X2 = nhập thông tin),
    // màn có mã giữ nguyên — không phải X theo chỉ số hàng.
    expect(root.textContent).toContain('X1');
    expect(root.textContent).toContain('X2');
    expect(root.textContent).not.toContain('X3');
    expect(root.textContent).toContain('SCR-002');

    // Anchor hiện nguyên văn; khối bổ sung lồng dưới màn cha.
    expect(root.textContent).toContain('## 2.1 Trang chủ');
    const blocks = screen.getAllByTestId('sd-block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.textContent).toContain('Voucher');
    expect(blocks[0]!.textContent).toContain('khối bổ sung');

    // Badge App/Web suy từ hậu tố -APP/-WEB (quy ước screen-variants).
    expect(root.textContent).toContain('App');
    expect(root.textContent).toContain('Web');

    // Nhóm biến thể đã xác nhận.
    expect(screen.getByTestId('sd-suggestions').textContent).toContain('Xác nhận nhóm');
  });

  it('mục "Đã loại trừ" gập mặc định, bấm mới xổ lý do', () => {
    render(<ScreensDiscoveredPreview doc={DOC} />);
    const toggle = screen.getByTestId('sd-excluded-toggle');
    expect(toggle.textContent).toContain('Đã loại trừ (1)');
    expect(screen.getByTestId('sd-excluded').textContent).not.toContain('Tiêu đề mục liệt kê');
    fireEvent.click(toggle);
    expect(screen.getByTestId('sd-excluded').textContent).toContain('Tiêu đề mục liệt kê');
  });

  it('doc tối thiểu (không excluded/suggestions/blocks) → không render các mục đó, không crash', () => {
    render(
      <ScreensDiscoveredPreview
        doc={{ schema_version: 1, pages: [{ source: 'docs/a.md', screens: [{ code: null, name: 'Màn A' }] }] }}
      />,
    );
    const root = screen.getByTestId('screens-discovered-preview');
    expect(root.textContent).toContain('1 màn · 1 trang');
    expect(root.textContent).toContain('Màn A');
    expect(screen.queryByTestId('sd-excluded')).toBeNull();
    expect(screen.queryByTestId('sd-suggestions')).toBeNull();
    expect(screen.queryAllByTestId('sd-block')).toHaveLength(0);
  });
});
