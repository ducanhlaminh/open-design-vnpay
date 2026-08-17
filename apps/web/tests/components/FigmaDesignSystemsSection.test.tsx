// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FigmaDesignSystemSource } from '@open-design/contracts';

import { FigmaDesignSystemsSection } from '../../src/components/FigmaDesignSystemsSection';
import {
  createFigmaDesignSystem,
  deleteFigmaDesignSystem,
  fetchFigmaDesignSystems,
  refreshFigmaDesignSystem,
} from '../../src/providers/figma-design-systems';

vi.mock('../../src/providers/figma-design-systems', () => ({
  fetchFigmaDesignSystems: vi.fn(),
  fetchFigmaDesignSystem: vi.fn(),
  createFigmaDesignSystem: vi.fn(),
  updateFigmaDesignSystem: vi.fn(),
  refreshFigmaDesignSystem: vi.fn(),
  deleteFigmaDesignSystem: vi.fn(),
}));

vi.mock('../../src/components/pipelines/FigmaLinksPanel', async () => {
  const React = await import('react');
  return {
    figmaLinksVerificationKey: (links: Array<{ fileKey: string }>) => links.map((link) => `${link.fileKey}:`).join('|'),
    FigmaLinksPanel: ({ links, onVerificationChange }: {
      links: Array<{ fileKey: string }>;
      onVerificationChange?: (value: { status: 'verified'; linksKey: string }) => void;
    }) => {
      React.useEffect(() => {
        if (links.length > 0) onVerificationChange?.({
          status: 'verified',
          linksKey: links.map((link) => `${link.fileKey}:`).join('|'),
        });
      }, [links, onVerificationChange]);
      return <div data-testid="figma-links-verification">verified</div>;
    },
  };
});

const source: FigmaDesignSystemSource = {
  id: 'figma:retail',
  name: 'Retail UI Library',
  kind: 'figma-links',
  links: ['https://www.figma.com/design/Abc123'],
  status: 'ready',
  refreshProgress: null,
  catalog: {
    generatedAt: '2026-08-17T03:30:00.000Z',
    digest: 'digest',
    fileCount: 1,
    componentCount: 48,
    files: [{ fileKey: 'Abc123', name: 'Retail UI', url: 'https://www.figma.com/design/Abc123', componentCount: 48 }],
  },
  lastError: null,
  hasShowcase: false,
  hasReactBundle: false,
  createdAt: '2026-08-17T03:00:00.000Z',
  updatedAt: '2026-08-17T03:30:00.000Z',
};

beforeEach(() => {
  vi.mocked(fetchFigmaDesignSystems).mockResolvedValue([source]);
  vi.mocked(createFigmaDesignSystem).mockResolvedValue({ ...source, status: 'empty', catalog: null });
  vi.mocked(refreshFigmaDesignSystem).mockResolvedValue({
    source,
    changes: {
      previousComponentCount: 48,
      currentComponentCount: 48,
      addedComponents: 0,
      removedComponents: 0,
      changedComponents: 0,
      unchangedComponents: 48,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FigmaDesignSystemsSection', () => {
  it('renders catalog facts and never offers Showcase or preview', async () => {
    render(<FigmaDesignSystemsSection />);

    expect(await screen.findByText('Retail UI Library')).toBeTruthy();
    expect(screen.getByText('48')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Showcase/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Preview/i })).toBeNull();
  });

  it('shows a useful empty state', async () => {
    vi.mocked(fetchFigmaDesignSystems).mockResolvedValueOnce([]);
    render(<FigmaDesignSystemsSection />);

    expect(await screen.findByText(/No Figma component catalogs yet/i)).toBeTruthy();
  });

  it('keeps load failures visible instead of replacing them with an empty state', async () => {
    vi.mocked(fetchFigmaDesignSystems).mockRejectedValueOnce(new Error('Daemon is unavailable'));
    render(<FigmaDesignSystemsSection />);

    expect((await screen.findByRole('alert')).textContent).toContain('Daemon is unavailable');
  });

  it('confirms before deleting a catalog', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FigmaDesignSystemsSection />);
    await screen.findByText('Retail UI Library');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Retail UI Library' }));

    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(deleteFigmaDesignSystem).toHaveBeenCalledWith('figma:retail'));
    await waitFor(() => expect(screen.queryByText('Retail UI Library')).toBeNull());
  });

  it('reruns the Figma import and reports added, removed, and changed components', async () => {
    vi.mocked(refreshFigmaDesignSystem).mockResolvedValueOnce({
      source: {
        ...source,
        catalog: { ...source.catalog!, componentCount: 50, digest: 'new-digest' },
      },
      changes: {
        previousComponentCount: 48,
        currentComponentCount: 50,
        addedComponents: 4,
        removedComponents: 2,
        changedComponents: 3,
        unchangedComponents: 43,
      },
    });
    render(<FigmaDesignSystemsSection />);
    await screen.findByText('Retail UI Library');

    fireEvent.click(screen.getByRole('button', { name: 'Rerun update' }));

    await waitFor(() => expect(refreshFigmaDesignSystem).toHaveBeenCalledWith('figma:retail'));
    expect(await screen.findByText('Update completed')).toBeTruthy();
    expect(screen.getByText('+4 added · −2 removed · 3 changed')).toBeTruthy();
    expect(screen.getByText('50 components in the latest catalog')).toBeTruthy();
  });

  it('verifies links before creating and refreshing a reusable catalog', async () => {
    render(<FigmaDesignSystemsSection />);
    await screen.findByText('Retail UI Library');

    fireEvent.click(screen.getByRole('button', { name: 'Add Figma links' }));
    fireEvent.change(screen.getByLabelText('Design system name'), { target: { value: 'Payments Library' } });
    fireEvent.change(screen.getByLabelText('Figma file links'), {
      target: { value: 'https://www.figma.com/design/Abc123/payments' },
    });

    const submit = await screen.findByRole('button', { name: 'Load catalog' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(createFigmaDesignSystem).toHaveBeenCalledWith({
      name: 'Payments Library',
      links: ['https://www.figma.com/design/Abc123'],
    }));
    await waitFor(() => expect(refreshFigmaDesignSystem).toHaveBeenCalledWith('figma:retail'));
  });
});
