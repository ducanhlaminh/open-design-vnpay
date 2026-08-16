// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PROJECT_SYNC_STATUS_COPY,
  SyncStatusBadge,
} from '../../../src/components/project-sync/SyncStatusBadge';

afterEach(cleanup);

describe('SyncStatusBadge', () => {
  it.each(Object.entries(PROJECT_SYNC_STATUS_COPY))(
    'shows friendly copy and an accessible tooltip for %s',
    (status, copy) => {
      render(<SyncStatusBadge status={status as keyof typeof PROJECT_SYNC_STATUS_COPY} tooltipId="sync-help" />);

      const badge = screen.getByText(copy.label);
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip.textContent).toBe(copy.description);
      expect(tooltip.id).toBe('sync-help');
      expect(badge.parentElement?.hasAttribute('title')).toBe(false);
    },
  );

  it('opens the tooltip for touch without activating a parent action', () => {
    let parentClicks = 0;
    render(
      <button type="button" onClick={() => { parentClicks += 1; }}>
        Mở dự án
        <SyncStatusBadge status="update_available" tooltipId="parent-sync-help" />
      </button>,
    );

    const badgeRoot = screen.getByText('Có bản mới').parentElement!;
    fireEvent.pointerUp(badgeRoot, { pointerType: 'touch' });
    fireEvent.click(badgeRoot);

    expect(badgeRoot.dataset.touchOpen).toBe('true');
    expect(parentClicks).toBe(0);
  });

  it('uses the containing button as the single keyboard focus target', () => {
    render(
      <button type="button" aria-describedby="sync-help">
        Mở dự án
        <SyncStatusBadge status="up_to_date" tooltipId="sync-help" />
      </button>,
    );

    const badgeRoot = screen.getByText('Đã cập nhật').parentElement!;
    expect(badgeRoot.hasAttribute('tabindex')).toBe(false);
    expect(screen.getByRole('button').getAttribute('aria-describedby')).toBe('sync-help');
  });

  it('dismisses a touch tooltip with an outside tap or Escape', () => {
    render(
      <div>
        <SyncStatusBadge status="incomplete" />
        <span data-testid="outside">Ngoài badge</span>
      </div>,
    );
    const badgeRoot = screen.getByText('Cập nhật chưa xong').parentElement!;

    fireEvent.pointerUp(badgeRoot, { pointerType: 'touch' });
    expect(badgeRoot.dataset.touchOpen).toBe('true');
    fireEvent.pointerDown(screen.getByTestId('outside'), { pointerType: 'touch' });
    expect(badgeRoot.dataset.touchOpen).toBeUndefined();

    fireEvent.pointerUp(badgeRoot, { pointerType: 'touch' });
    expect(badgeRoot.dataset.touchOpen).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(badgeRoot.dataset.touchOpen).toBeUndefined();
  });

  it('never presents a file-level deleted status', () => {
    expect(Object.values(PROJECT_SYNC_STATUS_COPY).map((copy) => copy.label)).not.toContain('Đã xóa');
  });
});
