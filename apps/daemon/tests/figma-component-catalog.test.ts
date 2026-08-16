import { describe, expect, it } from 'vitest';

import { renderFigmaComponentsMarkdown } from '../src/figma-component-catalog.js';

describe('Figma component catalog markdown', () => {
  it('renders the closed catalog format with per-file disambiguation', () => {
    const markdown = renderFigmaComponentsMarkdown({
      schemaVersion: '1.0',
      generatedAt: '2026-08-16T00:00:00.000Z',
      files: [
        { fileKey: 'file-a', name: 'Core', url: 'https://www.figma.com/design/file-a/Core', components: [
          { nodeId: '1:2', name: 'Button', properties: [{ name: 'State', type: 'VARIANT', values: ['Default', 'Disabled'] }] },
          { nodeId: '1:3', name: 'Button', page: 'Actions', properties: [] },
        ] },
        { fileKey: 'file-b', name: 'Product', url: 'https://www.figma.com/design/file-b/Product', components: [
          { nodeId: '3:4', name: 'Button', description: 'Product action', properties: [] },
        ] },
      ],
    });
    expect(markdown).toContain('### `#figma-');
    expect(markdown).toContain('Button — Core (1:2)');
    expect(markdown).toContain('Button — Core (1:3)');
    expect(markdown).toContain('Button — Product');
    expect(markdown).toContain('| State | VARIANT | Default, Disabled |');
    expect(markdown).toContain('- Trang: Actions');
    expect(markdown).toContain('https://www.figma.com/design/file-a/Core');
  });
});
