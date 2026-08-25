// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupMermaidRenderArtifacts,
  normalizeMermaidCodeForRender,
} from '../../src/components/MermaidDiagram';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MermaidDiagram render guards', () => {
  it('quotes unsafe square-node labels with parentheses without changing safe or already quoted labels', () => {
    const source = [
      'flowchart TD',
      '  A[Thông tin xuất hóa đơn<br>(Tùy chọn)] --> B[Thanh toán]',
      '  B --> C["Đã quote (giữ nguyên)"]',
    ].join('\n');
    expect(normalizeMermaidCodeForRender(source)).toBe([
      'flowchart TD',
      '  A["Thông tin xuất hóa đơn<br>(Tùy chọn)"] --> B[Thanh toán]',
      '  B --> C["Đã quote (giữ nguyên)"]',
    ].join('\n'));
  });

  it('removes the temporary error SVG wrapper Mermaid leaves in document.body', () => {
    document.body.innerHTML = '<main id="app"></main><div id="dmmd-42"><svg><text>Syntax error in text</text></svg></div>';
    cleanupMermaidRenderArtifacts('mmd-42');
    expect(document.getElementById('dmmd-42')).toBeNull();
    expect(document.getElementById('app')).not.toBeNull();
  });
});
