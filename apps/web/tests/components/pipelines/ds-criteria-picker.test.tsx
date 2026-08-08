// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DesignSystemSummary } from '@open-design/contracts';

vi.mock('../../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/registry')>();
  return {
    ...actual,
    fetchDesignSystems: async () => [
      { id: 'criteria-ds', title: 'Review DS', category: 'Product', summary: 'Criteria source', status: 'published' },
      { id: 'ui-ds', title: 'UI DS', category: 'Product', summary: 'UI source', status: 'published', hasReactBundle: true },
    ] satisfies DesignSystemSummary[],
  };
});

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

const { RunAllModal } = await import('../../../src/components/pipelines/PipelineModals');

afterEach(() => cleanup());

function renderModal(options: {
  stages: Array<{ id: string; name: string; usesDesignSystemCriteria?: boolean; acceptsDesignSystem?: boolean }>;
  targets?: ('mobile' | 'web-user')[];
  designSystemPurpose?: 'ui' | 'criteria';
  onSaveConfig?: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const saved: Record<string, unknown>[] = [];
  const view = render(
    <RunAllModal
      workflowName="Docs → Review tài liệu"
      stages={options.stages.map((stage) => ({ ...stage, dependsOn: [], status: 'idle' as const }))}
      defaultTargets={options.targets}
      hasPlatform={options.targets !== undefined}
      hasTerminal={false}
      hasDesignSystem={options.stages.some((stage) => stage.acceptsDesignSystem || stage.usesDesignSystemCriteria)}
      designSystemPurpose={options.designSystemPurpose ?? (options.stages.some((stage) => stage.usesDesignSystemCriteria) ? 'criteria' : 'ui')}
      anySucceeded={false}
      focus="designSystem"
      onClose={() => {}}
      onSaveConfig={async (patch) => {
        saved.push(patch as Record<string, unknown>);
        await options.onSaveConfig?.(patch as Record<string, unknown>);
      }}
    />,
  );
  return { ...view, saved };
}

describe('RunAllModal · design-system criteria picker', () => {
  it('shows the DS section when a stage uses design-system criteria', async () => {
    renderModal({ stages: [{ id: 'dr-docs', name: 'Tài liệu (nạp)', usesDesignSystemCriteria: true }] });
    expect(await screen.findByText('Design system (tùy chọn — nguồn bộ tiêu chí review)')).toBeTruthy();
  });

  it('saves criteriaDesignSystemId without changing designSystemId', async () => {
    const { saved } = renderModal({
      stages: [{ id: 'dr-docs', name: 'Tài liệu (nạp)', usesDesignSystemCriteria: true }],
    });
    fireEvent.click(await screen.findByTestId('project-ds-picker-trigger'));
    fireEvent.click(await screen.findByTestId('project-ds-picker-option-criteria-ds'));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(saved).toEqual([{ criteriaDesignSystemId: 'criteria-ds' }]);
  });

  it('keeps the existing UI design-system field for UI stages', async () => {
    const { saved } = renderModal({
      stages: [{ id: 'ui-html', name: 'UI-Spec', acceptsDesignSystem: true }],
      designSystemPurpose: 'ui',
    });
    fireEvent.click(await screen.findByTestId('project-ds-picker-trigger'));
    fireEvent.click(await screen.findByTestId('project-ds-picker-option-ui-ds'));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(saved).toEqual([{ designSystemId: 'ui-ds' }]);
  });

  it('hides the DS section when no stage consumes either DS field', () => {
    renderModal({ stages: [{ id: 'dr-flow', name: 'Sơ đồ luồng' }] });
    expect(screen.queryByTestId('project-ds-picker-trigger')).toBeNull();
  });

  it('does not render per-target DS pickers for criteria purpose', async () => {
    renderModal({
      stages: [{ id: 'dr-docs', name: 'Tài liệu (nạp)', usesDesignSystemCriteria: true }],
      targets: ['mobile', 'web-user'],
      designSystemPurpose: 'criteria',
    });
    expect(await screen.findByTestId('project-ds-picker-trigger')).toBeTruthy();
    expect(screen.queryByText('Design system TỪNG TARGET (tùy chọn)')).toBeNull();
  });
});
