import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { orderMockupsByChangeColumn } from '../src/mockup-order.js';

const FIXTURE_PATH = path.join(__dirname, 'fixtures/multi-platform-cr.md');

/** Cắt các dòng giữa 2 heading (không bao gồm heading kết thúc) từ fixture. */
function sectionBetween(startHeading: string, endHeading: string | null): string[] {
  const lines = readFileSync(FIXTURE_PATH, 'utf8').split('\n');
  const startIdx = lines.findIndex((l) => l.includes(startHeading));
  if (startIdx === -1) throw new Error(`heading không tìm thấy: ${startHeading}`);
  const endIdx = endHeading
    ? lines.findIndex((l, i) => i > startIdx && l.includes(endHeading))
    : lines.length;
  return lines.slice(startIdx + 1, endIdx === -1 ? lines.length : endIdx);
}

describe('orderMockupsByChangeColumn', () => {
  it('bảng chuẩn 2 ảnh/dòng → ảnh cột Thay đổi lên đầu, hasBeforeAfter true', () => {
    const section = sectionBetween('### 2.2 Màn hình MB', '### 2.3');
    const mockups = ['attachments/mb-quan-ly-cu.png', 'attachments/mb-quan-ly-moi.png'];

    const result = orderMockupsByChangeColumn(section, mockups);

    expect(result).toEqual({
      ordered: ['attachments/mb-quan-ly-moi.png', 'attachments/mb-quan-ly-cu.png'],
      hasBeforeAfter: true,
    });
  });

  it('màn chỉ có ảnh cột Hiện trạng (cột Thay đổi trống) → thứ tự gốc, hasBeforeAfter false', () => {
    const section = sectionBetween('### 2.2 Màn hình MB', '### 2.3');
    const mockups = ['attachments/mb-tao-yeu-cau.png'];

    const result = orderMockupsByChangeColumn(section, mockups);

    expect(result).toEqual({ ordered: ['attachments/mb-tao-yeu-cau.png'], hasBeforeAfter: false });
  });

  it('section không có bảng → giữ nguyên mockups, hasBeforeAfter false', () => {
    const section = sectionBetween('### 2.1 Luồng xử lý khởi tạo yêu cầu', '### 2.2');
    const mockups = ['attachments/khong-lien-quan.png'];

    const result = orderMockupsByChangeColumn(section, mockups);

    expect(result).toEqual({ ordered: ['attachments/khong-lien-quan.png'], hasBeforeAfter: false });
  });

  it('header đảo cột (Thay đổi trước, Hiện trạng sau) → vẫn phân loại đúng', () => {
    const section = [
      '| Thay đổi | Hiện trạng | Mô tả |',
      '| --- | --- | --- |',
      '| **Màn hình X** |  |  |',
      '| ![](attachments/x-moi.png) | ![](attachments/x-cu.png) | mô tả |',
    ];
    const mockups = ['attachments/x-cu.png', 'attachments/x-moi.png'];

    const result = orderMockupsByChangeColumn(section, mockups);

    expect(result).toEqual({
      ordered: ['attachments/x-moi.png', 'attachments/x-cu.png'],
      hasBeforeAfter: true,
    });
  });

  it('header bold (**Hiện trạng**/**Thay đổi**) → vẫn nhận diện được', () => {
    const section = [
      '| **Hiện trạng** | **Thay đổi** | **Mô tả** |',
      '| --- | --- | --- |',
      '| ![](attachments/z-cu.png) | ![](attachments/z-moi.png) | mô tả |',
    ];
    const mockups = ['attachments/z-cu.png', 'attachments/z-moi.png'];

    const result = orderMockupsByChangeColumn(section, mockups);

    expect(result).toEqual({
      ordered: ['attachments/z-moi.png', 'attachments/z-cu.png'],
      hasBeforeAfter: true,
    });
  });

  it('mockups path prefix khác markdown path (khớp theo basename) → vẫn phân loại đúng', () => {
    const section = sectionBetween('### 2.2 Màn hình MB', '### 2.3');
    // mockups mang prefix khác nhau (cwd khác, symlink, ../../..) so với path
    // tương đối viết trong markdown — chỉ đuôi/basename mới khớp.
    const mockups = [
      '../../../attachments/mb-quan-ly-cu.png',
      'docs-feature/attachments/mb-quan-ly-moi.png',
    ];

    const result = orderMockupsByChangeColumn(section, mockups);

    expect(result).toEqual({
      ordered: [
        'docs-feature/attachments/mb-quan-ly-moi.png',
        '../../../attachments/mb-quan-ly-cu.png',
      ],
      hasBeforeAfter: true,
    });
  });

  it('cell có nhiều ảnh (<br> giữa các ảnh) → lấy đủ cả hai bên', () => {
    const section = [
      '| Hiện trạng | Thay đổi | Mô tả |',
      '| --- | --- | --- |',
      '| **Màn hình Y** |  |  |',
      '| ![](attachments/y-cu-1.png)<br>![](attachments/y-cu-2.png) | ![](attachments/y-moi-1.png)<br>![](attachments/y-moi-2.png) | mô tả |',
    ];
    const mockups = [
      'attachments/y-cu-1.png',
      'attachments/y-cu-2.png',
      'attachments/y-moi-1.png',
      'attachments/y-moi-2.png',
    ];

    const result = orderMockupsByChangeColumn(section, mockups);

    expect(result).toEqual({
      ordered: [
        'attachments/y-moi-1.png',
        'attachments/y-moi-2.png',
        'attachments/y-cu-1.png',
        'attachments/y-cu-2.png',
      ],
      hasBeforeAfter: true,
    });
  });
});
