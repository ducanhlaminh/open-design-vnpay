// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DesignSystemReviewCatalogModal,
} from '../../src/components/DesignSystemReviewCatalogModal';
import type {
  CriteriaDocumentKind,
  CriteriaDocumentLoader,
} from '../../src/components/FigmaDsPreviewTabs';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.style.overflow = '';
});

function loaderFor(
  values: Partial<Record<CriteriaDocumentKind, { current: string | null; draft?: string | null }>>,
): CriteriaDocumentLoader {
  return vi.fn<CriteriaDocumentLoader>(async (_systemId, kind) => ({
    kind,
    current: values[kind]?.current ? { content: values[kind]!.current!, status: 'current' as const } : null,
    draft: values[kind]?.draft ? { content: values[kind]!.draft!, status: 'draft' as const } : null,
  }));
}

describe('DesignSystemReviewCatalogModal', () => {
  it('opens as a full-window read-only catalog with exactly three content tabs', async () => {
    render(
      <DesignSystemReviewCatalogModal
        open
        systemId="ds-1"
        title="Bộ thanh toán"
        loadCriteriaDocument={loaderFor({
          components: { current: '# Thành phần\nButton' },
          rules: { current: '# Nguyên tắc\nMàu sắc' },
        })}
        onClose={vi.fn()}
      />,
    );

    const modal = screen.getByTestId('design-system-review-catalog-modal');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(within(modal).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Showcase',
      'Thành phần',
      'Nguyên tắc',
    ]);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('lets the designer compare the current document and generated draft', async () => {
    render(
      <DesignSystemReviewCatalogModal
        open
        systemId="ds-1"
        title="Bộ thanh toán"
        initialTab="components"
        loadCriteriaDocument={loaderFor({
          components: { current: '# Thành phần đang dùng\nButton', draft: '# Bản mới\nDate picker' },
          rules: { current: '# Nguyên tắc' },
        })}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('Thành phần đang dùng')).toBeTruthy();
    expect(screen.getByText('Bản Design System đang dùng')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bản nháp' }));
    expect(await screen.findByText('Bản mới')).toBeTruthy();
    expect(screen.getByText('Date picker')).toBeTruthy();
    expect(screen.getByText('Bản mới đang chờ bạn duyệt')).toBeTruthy();
    expect(screen.queryByText('criteria/components.md')).toBeNull();
  });

  it('shows the workspace CTA only when the selected document is missing', async () => {
    const onGenerate = vi.fn();
    render(
      <DesignSystemReviewCatalogModal
        open
        systemId="ds-1"
        title="Bộ thanh toán"
        initialTab="rules"
        loadCriteriaDocument={loaderFor({
          components: { current: '# Thành phần' },
          rules: { current: null },
        })}
        onGenerate={onGenerate}
        onClose={vi.fn()}
      />,
    );

    const cta = await screen.findByRole('button', { name: 'Mở workspace để sinh nguyên tắc' });
    fireEvent.click(cta);
    expect(onGenerate).toHaveBeenCalledWith('rules');

    fireEvent.click(screen.getByRole('tab', { name: 'Thành phần' }));
    expect(await screen.findByText('Đang được dùng cho Design System')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Mở workspace để sinh/ })).toBeNull();
  });

  it('reloads both criteria documents and the external source without cache', async () => {
    const loader = loaderFor({
      components: { current: '# Thành phần' },
      rules: { current: '# Nguyên tắc' },
    });
    const onReload = vi.fn(async () => undefined);
    render(
      <DesignSystemReviewCatalogModal
        open
        systemId="ds-1"
        title="Bộ thanh toán"
        loadCriteriaDocument={loader}
        onReload={onReload}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(4));
    expect(onReload).toHaveBeenCalledTimes(1);
    for (const call of vi.mocked(loader).mock.calls) {
      expect(call[2].cache).toBe('no-store');
    }
  });

  it('keeps all three update actions inside the review modal menu', async () => {
    const onUpdateFigma = vi.fn();
    const onGenerate = vi.fn();
    render(
      <DesignSystemReviewCatalogModal
        open
        systemId="ds-1"
        title="Bộ thanh toán"
        loadCriteriaDocument={loaderFor({
          components: { current: '# Thành phần' },
          rules: { current: '# Nguyên tắc' },
        })}
        onUpdateFigma={onUpdateFigma}
        onGenerate={onGenerate}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Cập nhật/ }));
    expect(screen.getByRole('menu', { name: 'Cập nhật Design System Figma' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /Cập nhật file ZIP Figma/ }));
    expect(onUpdateFigma).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Cập nhật/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Cập nhật file mô tả thành phần/ }));
    expect(onGenerate).toHaveBeenCalledWith('components');

    fireEvent.click(screen.getByRole('button', { name: /Cập nhật/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Cập nhật file nguyên tắc/ }));
    expect(onGenerate).toHaveBeenCalledWith('rules');
  });
});
