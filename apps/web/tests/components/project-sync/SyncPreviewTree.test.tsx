// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectSyncPlan } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { SyncPreviewTree } = await import('../../../src/components/project-sync');

afterEach(() => { cleanup(); });

const feature = { id: 'feature-a', name: 'QR', kind: 'feature' as const, state: 'changed' as const, mappingValid: true, totals: { created: 0, unchanged: 0, changed: 2, deleted: 0 } };

function planOf(entries: ProjectSyncPlan['entries']): ProjectSyncPlan {
  return {
    planId: 'plan-t', createdAt: '', direction: 'pull', scope: { kind: 'app', projectId: 'app-a' }, origin: { mode: 'existing', originId: 'shared-a' },
    app: { id: 'app-a', name: 'Thanh toán', kind: 'app', state: 'changed', mappingValid: true, totals: { created: 0, unchanged: 0, changed: 2, deleted: 0 } },
    features: [feature], entries, summary: { created: 0, unchanged: 0, changed: entries.length, deleted: 0, confluence: { files: 13, bytes: 1.5 * 1024 * 1024 } },
  };
}

describe('SyncPreviewTree', () => {
  it('renders a Confluence ledger as one grouped leaf with file count, size and the missing badge', () => {
    const plan = planOf([
      {
        path: 'features/feature-a/attachments/_sources.json', kind: 'output', change: 'changed', featureId: 'feature-a',
        local: { checksum: 'same', size: 300 }, origin: { checksum: 'same', size: 300 }, resolution: 'pull',
        confluenceGroup: { files: 12, bytes: 1.5 * 1024 * 1024, missing: 3 },
      },
      {
        path: 'features/feature-a/output/a.png', kind: 'output', change: 'new', featureId: 'feature-a', resolution: 'pull',
        origin: { checksum: 'abc', size: 1024 },
        confluence: { base: 'https://wiki.example.vn', pageId: '1', spaceKey: 'SMB', attachment: 'a.png', attachmentVersion: 3 },
      },
    ]);
    render(<SyncPreviewTree plan={plan} resolutions={{}} onResolutionChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^attachments/ }));

    const leaf = screen.getByTitle('features/feature-a/attachments/_sources.json');
    expect(leaf.textContent).toBe('Bộ tài liệu Confluence · 12 file · 1.5 MB');
    expect(screen.queryByText('_sources.json')).toBeNull();
    expect(screen.getByLabelText('Thiếu 3 file trên máy').textContent).toBe('thiếu 3');
    expect(screen.getByLabelText('Tải từ Confluence: 12 file').textContent).toBe('wiki');
    // A group leaf with a local copy still offers the pull/keep choice.
    expect(screen.getByLabelText('Tệp có xung đột giữa bản trên máy và kho chung: features/feature-a/attachments/_sources.json')).toBeTruthy();

    // Single wiki-backed entries keep their per-file chip.
    fireEvent.click(screen.getByRole('button', { name: /Kết quả/ }));
    expect(screen.getByTitle('a.png v3').textContent).toBe('wiki');
    expect(screen.getByText('a.png')).toBeTruthy();
  });

  it('omits the missing badge when every ledger item is already on disk', () => {
    const plan = planOf([{
      path: 'features/feature-a/attachments/_sources.json', kind: 'output', change: 'unchanged', featureId: 'feature-a',
      local: { checksum: 'same', size: 300 }, origin: { checksum: 'same', size: 300 }, resolution: 'skip',
      confluenceGroup: { files: 4, bytes: 512 * 1024, missing: 0 },
    }]);
    render(<SyncPreviewTree plan={plan} resolutions={{}} onResolutionChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^attachments/ }));
    expect(screen.getByText('Bộ tài liệu Confluence · 4 file · 512 KB')).toBeTruthy();
    expect(screen.queryByText(/^thiếu/)).toBeNull();
  });
});
