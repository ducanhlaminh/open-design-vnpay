// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';

afterEach(cleanup);

describe('EntryNavRail', () => {
  it('does not render New Project, Automations, or Plugins in the primary rail', () => {
    render(
      <EntryNavRail
        view="workspaces"
        onViewChange={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('entry-nav-new-project')).toBeNull();
    expect(screen.queryByTestId('entry-nav-tasks')).toBeNull();
    expect(screen.queryByTestId('entry-nav-plugins')).toBeNull();
  });

  it.each(['tasks', 'plugins'] as const)(
    'keeps the focused %s route renderable without a corresponding rail item',
    (view) => {
      render(<EntryNavRail view={view} onViewChange={vi.fn()} />);

      expect(screen.getByTestId('entry-nav-home')).toBeTruthy();
      expect(screen.queryByTestId(`entry-nav-${view}`)).toBeNull();
    },
  );
});
