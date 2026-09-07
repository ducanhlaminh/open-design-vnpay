import { describe, expect, it } from 'vitest';

import { DOCS_SEARCH_DEFAULT_LIMIT, DOCS_TOOLS_USAGE } from '../src/tools-docs-cli.js';

// Điểm cosine KHÔNG phải trọng tài đúng/sai — đo trên pool thật: một câu hỏi
// sai chủ đề đạt 0.694 trong khi một câu đúng chỉ 0.604, và chênh điểm giữa
// hạng 1 với hạng 5 chỉ 0.019–0.047. Nên: không có ngưỡng nào cả, danh sách
// ngắn lại và luật là đọc hết.
describe('tools docs search — không lấy điểm làm gate', () => {
  it('mặc định trả 5 kết quả (đủ ngắn để bắt buộc đọc hết)', () => {
    expect(DOCS_SEARCH_DEFAULT_LIMIT).toBe(5);
  });

  it('help dặn đọc CẢ danh sách và nói rõ điểm không quyết định đúng/sai', () => {
    expect(DOCS_TOOLS_USAGE).toContain('ĐỌC CẢ danh sách');
    expect(DOCS_TOOLS_USAGE).toMatch(/điểm KHÔNG nói lên\s+đúng\/sai/);
    expect(DOCS_TOOLS_USAGE).toContain('chưa xác định được');
  });

  it('help dặn hỏi bằng câu đầy đủ (câu ghép từ khoá bị chấm thấp giả)', () => {
    expect(DOCS_TOOLS_USAGE).toContain('CÂU ĐẦY ĐỦ');
  });
});
