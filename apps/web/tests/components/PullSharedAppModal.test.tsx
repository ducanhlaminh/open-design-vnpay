// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { listOrigins, preview } = vi.hoisted(() => ({
  listOrigins: vi.fn(),
  preview: vi.fn(),
}));

vi.mock('../../src/providers/project-sync', () => ({
  listProjectSyncOrigins: listOrigins,
}));

vi.mock('../../src/components/project-sync', () => ({
  ProjectSyncPreviewModal: (props: unknown) => {
    preview(props);
    return <div data-testid="preview">preview</div>;
  },
}));

import { PullSharedAppModal } from '../../src/components/pipelines/PullSharedAppModal';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('PullSharedAppModal', () => {
  it('opens PLAN without creating an empty local App first', async () => {
    listOrigins.mockResolvedValue([{
      originId: 'remote-accounting',
      name: 'Kế toán',
      kind: 'app',
      appId: null,
      visibility: 'visible',
      inMedia: true,
      mappingVersion: null,
    }]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <PullSharedAppModal
        mappedOriginIds={new Set()}
        localAppIds={new Set()}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Lấy về máy' }));

    expect(await screen.findByTestId('preview')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { kind: 'app', projectId: 'ke-toan' },
      origin: { mode: 'existing', originId: 'remote-accounting' },
    }));
  });

  it('uses a free destination id when the display-name slug already exists', async () => {
    listOrigins.mockResolvedValue([{
      originId: 'remote-accounting',
      name: 'Kế toán',
      kind: 'app',
      appId: null,
      visibility: 'visible',
      inMedia: true,
      mappingVersion: null,
    }]);

    render(
      <PullSharedAppModal
        mappedOriginIds={new Set()}
        localAppIds={new Set(['ke-toan', 'ke-toan-2'])}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Lấy về máy' }));
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { kind: 'app', projectId: 'ke-toan-3' },
    }));
  });
});
