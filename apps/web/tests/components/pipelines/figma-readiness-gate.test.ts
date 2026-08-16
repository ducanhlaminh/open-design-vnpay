import { describe, expect, it } from 'vitest';
import { figmaSourceIssue, needsFigmaSource } from '../../../src/components/PipelinesView';

describe('Figma component-review gate', () => {
  it('chỉ gate dr-comp khi App dùng figma-links', () => {
    const source = { mode: 'figma-links' as const, links: [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }] };
    expect(needsFigmaSource(['dr-docs', 'dr-comp'], source)).toBe(true);
    expect(needsFigmaSource(['dr-docs', 'dr-flow'], source)).toBe(false);
    expect(needsFigmaSource(['dr-comp'], { mode: 'app-design-system' })).toBe(false);
  });

  it('chỉ chặn khi thiếu token; link lỗi để daemon báo cụ thể lúc chạy', () => {
    expect(figmaSourceIssue({ hasToken: true })).toBeNull();
    expect(figmaSourceIssue({ hasToken: false })).toMatch(/token Figma/i);
    expect(figmaSourceIssue(null)).toMatch(/daemon/i);
  });
});
