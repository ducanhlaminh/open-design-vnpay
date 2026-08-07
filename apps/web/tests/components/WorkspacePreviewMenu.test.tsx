// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { WorkspacePreviewMenu } from '../../src/components/WorkspacePreviewMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const FILES = [
  { name: 'docs-to-ui/prototype/index.html' },
  { name: 'docs-to-ui/docs/system-map.json' },
];

function renderMenu(
  overrides: Partial<React.ComponentProps<typeof WorkspacePreviewMenu>> = {},
) {
  const onOpenFile = vi.fn();
  const onReloadPreview = vi.fn();
  render(
    <WorkspacePreviewMenu
      files={FILES}
      activeTab={null}
      onOpenFile={onOpenFile}
      onReloadPreview={onReloadPreview}
      {...overrides}
    />,
  );
  return { onOpenFile, onReloadPreview };
}

describe('WorkspacePreviewMenu', () => {
  it('opens the popover on trigger click, with ready steps enabled and pending steps disabled', () => {
    renderMenu();
    expect(screen.queryByTestId('workspace-preview-menu')).toBeNull();

    act(() => {
      fireEvent.click(screen.getByTestId('workspace-preview-menu-trigger'));
    });

    expect(screen.getByTestId('workspace-preview-menu')).toBeTruthy();
    expect(screen.getByTestId('workspace-preview-menu-trigger').getAttribute('aria-expanded')).toBe(
      'true',
    );
    const ready = screen.getByTestId('workspace-preview-item-ui-html') as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    const pending = screen.getByTestId('workspace-preview-item-ui-react') as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute('aria-disabled')).toBe('true');
  });

  it('calls onOpenFile with the full path when a ready item is clicked', () => {
    const { onOpenFile } = renderMenu();
    act(() => {
      fireEvent.click(screen.getByTestId('workspace-preview-menu-trigger'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('workspace-preview-item-ui-html'));
    });
    expect(onOpenFile).toHaveBeenCalledWith('docs-to-ui/prototype/index.html');
    expect(screen.queryByTestId('workspace-preview-menu')).toBeNull();
  });

  it('calls onReloadPreview when the reload button is clicked', () => {
    const { onReloadPreview } = renderMenu();
    act(() => {
      fireEvent.click(screen.getByTestId('workspace-preview-reload'));
    });
    expect(onReloadPreview).toHaveBeenCalledTimes(1);
  });

  it('disables the reload button while a reload is in flight', () => {
    renderMenu({ reloading: true });
    const reload = screen.getByTestId('workspace-preview-reload') as HTMLButtonElement;
    expect(reload.disabled).toBe(true);
  });

  it('closes the popover on Escape', () => {
    renderMenu();
    act(() => {
      fireEvent.click(screen.getByTestId('workspace-preview-menu-trigger'));
    });
    expect(screen.getByTestId('workspace-preview-menu')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByTestId('workspace-preview-menu')).toBeNull();
  });

  it('closes the popover on an outside mousedown', () => {
    renderMenu();
    act(() => {
      fireEvent.click(screen.getByTestId('workspace-preview-menu-trigger'));
    });
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByTestId('workspace-preview-menu')).toBeNull();
  });

  it('marks the item matching the active tab as current', () => {
    renderMenu({ activeTab: 'docs-to-ui/prototype/index.html' });
    act(() => {
      fireEvent.click(screen.getByTestId('workspace-preview-menu-trigger'));
    });
    expect(
      screen.getByTestId('workspace-preview-item-ui-html').getAttribute('aria-current'),
    ).toBe('true');
  });

  it('suffixes item test ids with the target on a multi-target project', () => {
    renderMenu({
      files: [
        { name: 'docs-to-ui/mobile/prototype/index.html' },
        { name: 'docs-to-ui/web-user/prototype/index.html' },
      ],
    });
    act(() => {
      fireEvent.click(screen.getByTestId('workspace-preview-menu-trigger'));
    });
    expect(screen.getByTestId('workspace-preview-item-ui-html-mobile')).toBeTruthy();
    expect(screen.getByTestId('workspace-preview-item-ui-html-web-user')).toBeTruthy();
  });
});
