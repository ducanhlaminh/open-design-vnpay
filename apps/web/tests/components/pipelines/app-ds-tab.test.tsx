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
vi.mock('../../../src/state/figma-config', () => ({
  fetchAppFigmaCatalog: vi.fn(async () => null),
  refreshAppFigmaCatalog: vi.fn(async () => ({ ok: false, error: 'unmocked' })),
}));

import { PipelinesFeaturesView } from '../../../src/components/pipelines/PipelinesFeaturesView';
import { groupByApp } from '../../../src/components/pipelines/usePipelineNav';

type KnownApp = { id: string; name?: string; designSystemId?: string | null; docsReviewComponentSource?: { mode: 'app-design-system' } | { mode: 'figma-links'; links: Array<{ url: string; fileKey: string }> } };

function navFor(knownApps: KnownApp[]) {
  const projects: PipelineProject[] = [];
  const apps = groupByApp(projects, knownApps);
  return { apps, projects, loading: false, loaded: true, error: null, reload: async () => {}, appById: (id: string) => apps.find((app) => app.id === id) ?? null, featureOf: () => null };
}

function renderView(knownApps: KnownApp[]) {
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

  it('App dùng nguồn Link Figma: tab DS hiện danh mục component đọc từ Figma (tự đọc lần đầu khi chưa có)', async () => {
    const { fetchAppFigmaCatalog, refreshAppFigmaCatalog } = await import('../../../src/state/figma-config');
    const links = [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }];
    vi.mocked(fetchAppFigmaCatalog).mockResolvedValue({ links, hasToken: true, generatedAt: null, files: [], componentCount: 0, markdown: null });
    vi.mocked(refreshAppFigmaCatalog).mockResolvedValue({ ok: true, catalog: {
      links, hasToken: true, generatedAt: '2026-08-16T10:00:00Z', componentCount: 2, markdown: '### `10:1` Button\n\n### `10:2` Input',
      files: [{ fileKey: 'ABC', name: 'Kit', url: 'https://www.figma.com/design/ABC', componentCount: 2 }],
    } });
    renderView([{ id: 'app-1', name: 'App', docsReviewComponentSource: { mode: 'figma-links', links } }]);
    expect(screen.getByText(/Link Figma \(1 file\)/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /DS/ })); });
    expect(await screen.findByRole('heading', { name: 'Danh mục component từ Figma' })).toBeTruthy();
    expect(await screen.findByText(/2 component · đọc lúc/)).toBeTruthy();
    expect(screen.getByText(/10:1/)).toBeTruthy();
    expect(refreshAppFigmaCatalog).toHaveBeenCalledWith('app-1');
    expect(screen.getByRole('link', { name: 'Kit' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'VNPAY DS' })).toBeNull();
  });

  it('App Link Figma chưa có token: tab DS nói rõ và không tự gọi Figma', async () => {
    const { fetchAppFigmaCatalog, refreshAppFigmaCatalog } = await import('../../../src/state/figma-config');
    const links = [{ url: 'https://www.figma.com/design/ABC', fileKey: 'ABC' }];
    vi.mocked(refreshAppFigmaCatalog).mockClear();
    vi.mocked(fetchAppFigmaCatalog).mockResolvedValue({ links, hasToken: false, generatedAt: null, files: [], componentCount: 0, markdown: null });
    renderView([{ id: 'app-1', name: 'App', docsReviewComponentSource: { mode: 'figma-links', links } }]);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /DS/ })); });
    expect(await screen.findByText(/Chưa có token Figma/)).toBeTruthy();
    expect(refreshAppFigmaCatalog).not.toHaveBeenCalled();
    expect((screen.getByTestId('figma-catalog-refresh') as HTMLButtonElement).disabled).toBe(true);
  });

  it('không hiện tab DS cho bucket Chưa gán app', () => {
    renderView([{ id: '__unassigned', name: 'Chưa gán app' }]);
    expect(screen.queryByRole('tab', { name: /DS/ })).toBeNull();
  });

  it('App chưa chọn DS hiện meta và empty state hướng sang Sửa dự án', async () => {
    renderView([{ id: 'app-1', name: 'App' }]);
    expect(screen.getByText(/chưa chọn/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /DS/ })); });
    expect(screen.getAllByText((_, node) => node?.textContent?.includes('Chọn DS ở Sửa dự án') ?? false).length).toBeGreaterThan(0);
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
