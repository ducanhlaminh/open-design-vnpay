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

  // WP-lab-clean (.tmp/pipeline/wp-lab-clean.yaml): renderFigmaComponentsMarkdown
  // từng BỎ `key` dù catalog có sẵn — agent không import được base thật
  // (transcript thật: 0 lần importComponentByKeyAsync).
  it('prints a "- Key:" line when component.key is present, and an import comment near the top', () => {
    const markdown = renderFigmaComponentsMarkdown({
      schemaVersion: '1.0',
      generatedAt: '2026-08-16T00:00:00.000Z',
      files: [
        { fileKey: 'file-a', name: 'Core', url: 'https://www.figma.com/design/file-a/Core', components: [
          { nodeId: '1:2', name: 'Button', key: 'abc123key', properties: [] },
        ] },
      ],
    });
    expect(markdown).toContain('- Key: `abc123key`');
    expect(markdown).toContain('importComponentByKeyAsync');
  });

  it('omits the "- Key:" line when component.key is absent — older catalogues still parse/render', () => {
    const markdown = renderFigmaComponentsMarkdown({
      schemaVersion: '1.0',
      generatedAt: '2026-08-16T00:00:00.000Z',
      files: [
        { fileKey: 'file-a', name: 'Core', url: 'https://www.figma.com/design/file-a/Core', components: [
          { nodeId: '1:2', name: 'Button', properties: [] },
        ] },
      ],
    });
    expect(markdown).not.toContain('- Key:');
  });

  it('prints "- Biến thể (key):" listing each variant, capped at 12 with "… +N" for the rest', () => {
    const variants = Array.from({ length: 14 }, (_, i) => ({
      nodeId: `2:${i}`,
      key: `variant-key-${i}`,
      name: `State=${i}`,
    }));
    const markdown = renderFigmaComponentsMarkdown({
      schemaVersion: '1.0',
      generatedAt: '2026-08-16T00:00:00.000Z',
      files: [
        { fileKey: 'file-a', name: 'Core', url: 'https://www.figma.com/design/file-a/Core', components: [
          { nodeId: '1:2', name: 'Button Set', key: 'set-key', properties: [], variants },
        ] },
      ],
    });
    expect(markdown).toContain('- Biến thể (key):');
    expect(markdown).toContain('State=0 → `variant-key-0`');
    expect(markdown).toContain('State=11 → `variant-key-11`');
    expect(markdown).not.toContain('State=12 → `variant-key-12`');
    expect(markdown).toContain('… +2');
  });

  it('omits the "- Biến thể (key):" line when no variant carries a key', () => {
    const markdown = renderFigmaComponentsMarkdown({
      schemaVersion: '1.0',
      generatedAt: '2026-08-16T00:00:00.000Z',
      files: [
        { fileKey: 'file-a', name: 'Core', url: 'https://www.figma.com/design/file-a/Core', components: [
          { nodeId: '1:2', name: 'Button Set', properties: [], variants: [{ nodeId: '2:0', name: 'State=0' }] },
        ] },
      ],
    });
    expect(markdown).not.toContain('- Biến thể (key):');
  });
});
