// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineProject } from '@open-design/contracts';

vi.mock('../../../src/providers/registry', () => ({
  fetchDesignSystems: vi.fn(async () => [{ id: 'ds-1', title: 'VNPAY DS', category: 'Product', summary: '', status: 'published' }]),
  fetchDesignSystemReactInfo: vi.fn(async () => ({ components: 3, icons: 2, styleGuide: '', catalog: '' })),
  fetchDesignSystemCriteriaFile: vi.fn(async () => ({ error: 'not-found' })),
}));

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

import { PipelinesFeaturesView } from '../../../src/components/pipelines/PipelinesFeaturesView';
import { groupByApp } from '../../../src/components/pipelines/usePipelineNav';

function navFor(knownApps: Array<{ id: string; name?: string; designSystemId?: string | null }>) {
  const projects: PipelineProject[] = [];
  const apps = groupByApp(projects, knownApps);
  return { apps, projects, loading: false, loaded: true, error: null, reload: async () => {}, appById: (id: string) => apps.find((app) => app.id === id) ?? null, featureOf: () => null };
}

function renderView(knownApps: Array<{ id: string; name?: string; designSystemId?: string | null }>) {
  return render(<PipelinesFeaturesView nav={navFor(knownApps)} appId={knownApps[0]?.id ?? 'unassigned'} />);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Pipelines App · DS tab', () => {
  it('hiện tab DS, bấm vào thì render panel', async () => {
    renderView([{ id: 'app-1', name: 'App', designSystemId: 'ds-1' }]);
    expect(screen.getByRole('tab', { name: /DS/ })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /DS/ })); });
    expect(await screen.findByRole('heading', { name: 'VNPAY DS' })).toBeTruthy();
  });

  it('không hiện tab DS cho bucket Chưa gán app', () => {
    renderView([{ id: '__unassigned', name: 'Chưa gán app' }]);
    expect(screen.queryByRole('tab', { name: /DS/ })).toBeNull();
  });

  it('App chưa chọn DS hiện meta và empty state hướng sang Sửa App', async () => {
    renderView([{ id: 'app-1', name: 'App' }]);
    expect(screen.getByText(/chưa chọn/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /DS/ })); });
    expect(screen.getAllByText((_, node) => node?.textContent?.includes('Chọn DS ở Sửa App') ?? false).length).toBeGreaterThan(0);
  });

  it('criteria 404 hiện empty state Sinh lại, không crash', async () => {
    renderView([{ id: 'app-1', name: 'App', designSystemId: 'ds-1' }]);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /DS/ })); });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Danh mục component' })); });
    expect(screen.getAllByText((_, node) => node?.textContent?.includes('bấm Sinh lại') ?? false).length).toBeGreaterThan(0);
    expect(screen.queryByText(/HTTP/)).toBeNull();
  });

  it('criteria render nội dung, đếm đúng 3 component', async () => {
    const { fetchDesignSystemCriteriaFile } = await import('../../../src/providers/registry');
    vi.mocked(fetchDesignSystemCriteriaFile).mockResolvedValue({
      path: 'criteria/components.md', name: 'components.md', kind: 'document', updatedAt: '2026-08-09T10:00:00Z',
      content: '### `#a` A\n\n### `#b` B\n\n### `#c` C',
    });
    renderView([{ id: 'app-1', name: 'App', designSystemId: 'ds-1' }]);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /DS/ })); });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Danh mục component' })); });
    expect(await screen.findByText(/3 component/)).toBeTruthy();
    expect(screen.getByText(/#a/)).toBeTruthy();
  });
});
