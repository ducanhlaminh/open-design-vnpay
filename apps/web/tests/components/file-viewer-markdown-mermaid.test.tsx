// @vitest-environment jsdom
// Tài liệu nạp từ Confluence (macro Mermaid) có fence ```mermaid — viewer Markdown
// phải dựng sơ đồ (MermaidDiagram qua portal) thay vì in mã thô; mã gốc gập lại
// bên dưới để vẫn copy được. Fence ngôn ngữ khác giữ nguyên.

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';
import { fetchProjectFileText } from '../../src/providers/registry';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>('../../src/providers/registry');
  return { ...actual, fetchProjectFileText: vi.fn() };
});

// mermaid không chạy trong jsdom — stub MermaidDiagram để kiểm mount + props.
vi.mock('../../src/components/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => <div data-testid="mermaid-diagram">{code}</div>,
}));

const mockedFetch = vi.mocked(fetchProjectFileText);

function baseFile(): ProjectFile {
  return {
    name: 'docs-review/docs-feature/prd.md',
    path: 'docs-review/docs-feature/prd.md',
    type: 'file',
    size: 256,
    mtime: 1710000000,
    kind: 'text',
    mime: 'text/markdown',
    artifactManifest: { version: 1, kind: 'markdown-document', title: 'PRD', entry: 'prd.md', renderer: 'markdown', exports: ['md'] },
  };
}

describe('FileViewer markdown ```mermaid', () => {
  beforeEach(() => {
    mockedFetch.mockResolvedValue(
      '### 3.1 Luồng sơ đồ\n\n```mermaid\nflowchart TD\n    A([Bắt đầu]) --> B[Chọn Mua SIM]\n```\n\n```json\n{"a":1}\n```\n',
    );
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('dựng MermaidDiagram cho fence mermaid, gập mã nguồn, fence khác giữ nguyên', async () => {
    const { container, findAllByTestId } = render(<FileViewer projectId="p1" projectKind="prototype" file={baseFile()} />);
    const diagrams = await findAllByTestId('mermaid-diagram');
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0]!.textContent).toContain('A([Bắt đầu]) --> B[Chọn Mua SIM]');
    await waitFor(() => {
      const host = container.querySelector('.md-mermaid');
      expect(host).toBeTruthy();
      // host đứng trước <details> chứa code block gốc
      const details = host!.nextElementSibling as HTMLElement | null;
      expect(details?.tagName).toBe('DETAILS');
      expect(details?.querySelector('code.language-mermaid')).toBeTruthy();
    });
    // fence json vẫn là code block thường, không host
    expect(container.querySelectorAll('.md-mermaid')).toHaveLength(1);
    expect(container.querySelector('code.language-json')?.textContent).toBe('{"a":1}');
  });
});
