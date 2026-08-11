// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesignSystemSummary } from '../../src/types';

vi.mock('../../src/providers/registry', () => ({
  fetchDesignSystemPreview: vi.fn(),
}));

import { ProjectDesignSystemPicker } from '../../src/components/ProjectDesignSystemPicker';
import { I18nProvider, type Locale } from '../../src/i18n';

const designSystems: DesignSystemSummary[] = [
  {
    id: 'clay',
    title: 'Clay',
    summary: 'Friendly tactile product UI.',
    category: 'Product',
    swatches: ['#f4efe7', '#25211d'],
  },
  {
    id: 'noir',
    title: 'Editorial Noir',
    summary: 'High-contrast editorial system.',
    category: 'Editorial',
    swatches: ['#111111', '#f7f0e8'],
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectDesignSystemPicker', () => {
  function renderPicker(
    props: Partial<ComponentProps<typeof ProjectDesignSystemPicker>> = {},
    locale: Locale = 'zh-CN',
  ) {
    return render(
      <I18nProvider initial={locale}>
        <ProjectDesignSystemPicker
          designSystems={designSystems}
          selectedId="noir"
          onChange={vi.fn()}
          {...props}
        />
      </I18nProvider>,
    );
  }

  it('renders the active design system directly in the form list', () => {
    renderPicker();

    const activeOption = screen.getByTestId('project-ds-picker-option-noir');
    expect(activeOption.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('project-ds-picker-trigger')).toBeNull();
  });

  it('filters and selects directly without opening a dropdown', () => {
    const onChange = vi.fn();
    renderPicker({ onChange });

    fireEvent.change(screen.getByTestId('project-ds-picker-search'), { target: { value: 'Clay' } });
    expect(screen.getByTestId('project-ds-picker-option-clay')).toBeTruthy();
    expect(screen.queryByTestId('project-ds-picker-option-noir')).toBeNull();
    fireEvent.click(screen.getByTestId('project-ds-picker-option-clay'));
    expect(onChange).toHaveBeenCalledWith('clay');
  });

  it('uses localized picker copy and design-system category labels', () => {
    renderPicker({}, 'fr');

    expect(screen.getByPlaceholderText('Rechercher des design systems')).toBeTruthy();
    expect(screen.getByText(/Produit ·/)).toBeTruthy();
    expect(screen.getByText('Aucun design system')).toBeTruthy();
  });
});
