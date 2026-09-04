import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDocsSectionIndex,
  stripDiacritics,
  writeDocsSectionIndex,
  type DocsSectionSourceFile,
} from '../src/docs-section-index.js';

// Fixture với heading lồng nhau (H1 > H2 > H3), tiếng Việt có dấu, và một
// heading chứa `|` cần escape. Số dòng dưới đây PHẢI khớp `line` mong đợi
// trong assertion — đừng đổi mà không cập nhật cả hai.
const NESTED_MD = [
  /* 1  */ '# Tổng quan',
  /* 2  */ '',
  /* 3  */ 'Giới thiệu chung về tính năng đăng ký tài khoản người dùng mới cho hệ thống.',
  /* 4  */ '',
  /* 5  */ '## Bước 1: Xác thực OTP',
  /* 6  */ '',
  /* 7  */ 'Người dùng nhập số điện thoại để nhận mã OTP xác thực trước khi tạo tài khoản mới.',
  /* 8  */ '',
  /* 9  */ '### Ghi chú | quan trọng',
  /* 10 */ '',
  /* 11 */ 'OTP hết hạn sau 5 phút, hệ thống chặn gửi lại nhiều lần liên tục.',
].join('\n');

const NO_HEADING_MD = 'Trang này không có heading nào cả, chỉ có văn bản thuần tuý mô tả quy trình.';

describe('docs-section-index — buildDocsSectionIndex (pure)', () => {
  it('sinh một dòng mỗi heading, breadcrumb lồng đúng cấp, số dòng đúng', () => {
    const files: DocsSectionSourceFile[] = [{ rel: 'b/tai-khoan.md', content: NESTED_MD }];
    const text = buildDocsSectionIndex(files);
    const lines = text.trimEnd().split('\n');
    const dataLines = lines.filter((l) => /^b\/tai-khoan\.md:\d+ \| /.test(l));
    expect(dataLines).toHaveLength(3);

    expect(dataLines[0]).toMatch(/^b\/tai-khoan\.md:1 \| Tổng quan \| /);
    expect(dataLines[1]).toMatch(/^b\/tai-khoan\.md:5 \| Tổng quan › Bước 1: Xác thực OTP \| /);
    // `|` trong heading gốc phải bị escape thành `/` để không vỡ cột.
    expect(dataLines[2]).toMatch(
      /^b\/tai-khoan\.md:9 \| Tổng quan › Bước 1: Xác thực OTP › Ghi chú \/ quan trọng \| /,
    );
  });

  it('cột 3 (chuỗi tìm kiếm) đã strip dấu tiếng Việt; cột 1-2 giữ nguyên gốc', () => {
    const files: DocsSectionSourceFile[] = [{ rel: 'b/tai-khoan.md', content: NESTED_MD }];
    const text = buildDocsSectionIndex(files);
    const dataLines = text.trimEnd().split('\n').filter((l) => /^b\/tai-khoan\.md:\d+ \| /.test(l));
    for (const line of dataLines) {
      const [, breadcrumb, search] = line.split(' | ');
      expect(breadcrumb).toBeTruthy();
      expect(search).toBeTruthy();
      // Cột 3 tự strip đã là điểm cố định — strip lại không đổi gì thêm.
      expect(stripDiacritics(search!)).toBe(search);
      // Breadcrumb có dấu (cột 2) khi qua stripDiacritics phải khác chính nó
      // (chứng minh cột 2 KHÔNG bị strip trước).
      expect(stripDiacritics(breadcrumb!)).not.toBe(breadcrumb);
    }
    // Từ khoá "OTP" xuất hiện lặp trong body → phải lọt vào top keyword của
    // section H1 (bao trọn toàn file).
    expect(dataLines[0]).toMatch(/\botp\b/);
  });

  it('file không có heading → một section duy nhất, dòng 1, heading = dòng đầu', () => {
    const files: DocsSectionSourceFile[] = [{ rel: 'c/no-heading.md', content: NO_HEADING_MD }];
    const text = buildDocsSectionIndex(files);
    const dataLines = text.trimEnd().split('\n').filter((l) => l.includes('c/no-heading.md'));
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toMatch(/^c\/no-heading\.md:1 \| Trang này không có heading nào cả.*\| /);
  });

  it('deterministic: thứ tự input khác nhau → output byte giống hệt (sort theo path)', () => {
    const files: DocsSectionSourceFile[] = [
      { rel: 'b/tai-khoan.md', content: NESTED_MD },
      { rel: 'a/first.md', content: '# A\n\nnội dung a' },
      { rel: 'c/no-heading.md', content: NO_HEADING_MD },
    ];
    const shuffled = [files[2]!, files[0]!, files[1]!];
    expect(buildDocsSectionIndex(files)).toBe(buildDocsSectionIndex(shuffled));
    // Sort ổn định theo path: 'a/first.md' phải xuất hiện TRƯỚC 'b/tai-khoan.md'.
    const text = buildDocsSectionIndex(files);
    expect(text.indexOf('a/first.md')).toBeLessThan(text.indexOf('b/tai-khoan.md'));
    expect(text.indexOf('b/tai-khoan.md')).toBeLessThan(text.indexOf('c/no-heading.md'));
  });

  it('đầu file có 3-4 dòng hướng dẫn tiếng Việt (sinh cơ học, grep -i)', () => {
    const text = buildDocsSectionIndex([{ rel: 'a.md', content: '# A\n\nx' }]);
    const header = text.split('\n').slice(0, 6).join('\n');
    expect(header).toMatch(/sinh cơ học/i);
    expect(header).toMatch(/grep -i/i);
  });
});

describe('docs-section-index — writeDocsSectionIndex (fs, filter _*/attachments)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-docs-sections-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('bỏ file bắt đầu _ và mọi thứ dưới attachments/, quét *.md đệ quy', async () => {
    await mkdir(path.join(root, 'branch-a'), { recursive: true });
    await mkdir(path.join(root, 'attachments'), { recursive: true });
    await writeFile(path.join(root, 'branch-a/page-one.md'), '# Trang một\n\nnội dung trang một');
    await writeFile(path.join(root, '_index.md'), '# Bản đồ tài liệu (sinh cơ học)');
    await writeFile(path.join(root, 'attachments/leaked.md'), '# Không được quét');

    const result = await writeDocsSectionIndex(root);
    expect(result).toEqual({ sections: 1, files: 1 });

    const text = await readFile(path.join(root, '_sections.md'), 'utf8');
    expect(text).toContain('branch-a/page-one.md:1');
    expect(text).not.toContain('_index.md');
    expect(text).not.toContain('leaked.md');
  });

  it('thư mục không tồn tại → no-op, không tạo _sections.md', async () => {
    const missing = path.join(root, 'does-not-exist');
    const result = await writeDocsSectionIndex(missing);
    expect(result).toEqual({ sections: 0, files: 0 });
    await expect(readFile(path.join(missing, '_sections.md'), 'utf8')).rejects.toThrow();
  });

  it('refresh rẻ: không đổi *.md nguồn → build lại vẫn ra cùng số liệu (skip re-parse)', async () => {
    await writeFile(path.join(root, 'page.md'), '# Trang\n\nnội dung');
    const first = await writeDocsSectionIndex(root);
    const second = await writeDocsSectionIndex(root);
    expect(second).toEqual(first);
  });

  it('xoá bớt trang → refresh phát hiện qua số file lệch, không giữ dòng mồ côi', async () => {
    await writeFile(path.join(root, 'a.md'), '# A\n\nx');
    await writeFile(path.join(root, 'b.md'), '# B\n\ny');
    await writeDocsSectionIndex(root);
    await rm(path.join(root, 'b.md'));
    const result = await writeDocsSectionIndex(root);
    expect(result).toEqual({ sections: 1, files: 1 });
    const text = await readFile(path.join(root, '_sections.md'), 'utf8');
    expect(text).not.toContain('b.md');
  });
});
