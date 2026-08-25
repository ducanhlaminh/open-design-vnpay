// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const FILES: Record<string, string | null> = {};
const K1 = 'SIM__6.1.1';
const K2 = 'SIM__6.2.1';

vi.mock('../../src/providers/registry', () => ({ fetchProjectFileText: async (_projectId: string, name: string) => FILES[name] ?? null }));
vi.mock('../../src/components/ScreenFlowPreview', () => ({
  ScreenFlowPreview: ({ onOpenScreen }: { onOpenScreen: (key: string) => void }) => <button data-testid="fake-flow-node" onClick={() => onOpenScreen(K2)}>Flow node</button>,
}));

const { ScreenComponentsPreview, isScreenComponentsFile, screenComponentsLocationOf } = await import('../../src/components/ScreenComponentsPreview');
const file = (name: string) => ({ name, size: 1, mtime: 1, kind: 'code' as const, mime: 'application/json' });

function seed() {
  FILES['docs-review/comp/index.json'] = JSON.stringify({ schema_version: '2.0', screens: [{ key: K1, name: 'Trang chủ', order: 0 }, { key: K2, name: 'Chọn quốc gia', order: 1 }], failed: [] });
  FILES['docs-review/comp/screen-flows/index.json'] = JSON.stringify({ schemaVersion: '1.0', flows: [] });
  FILES['docs-review/comp/_role-map.json'] = JSON.stringify({ platform: 'mobile', roles: [] });
  FILES[`docs-review/comp/${K1}.screen.json`] = JSON.stringify({ key: K1, name: 'Trang chủ', platform: 'mobile', elements: [], nav: [] });
  FILES[`docs-review/comp/${K2}.screen.json`] = JSON.stringify({ key: K2, name: 'Chọn quốc gia', platform: 'mobile', elements: [{ id: 'title', label: 'Quốc gia', role: 'title', confidence: 'high', provenance: 'text' }], nav: [] });
  FILES[`docs-review/wireframes/${K1}.html`] = '<html><body>home</body></html>';
  FILES[`docs-review/wireframes/${K2}.html`] = '<html><body>country</body></html>';
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); for (const key of Object.keys(FILES)) delete FILES[key]; });

describe('ScreenComponentsPreview screen-flow integration', () => {
  it('route chính xác artifact screen-flow và giữ root/flowId', () => {
    expect(isScreenComponentsFile(file('docs-review/comp/screen-flows/index.json'))).toBe(true);
    expect(isScreenComponentsFile(file('docs-review/comp/screen-flows/FLOW-A.screen-flow.json'))).toBe(true);
    expect(isScreenComponentsFile(file('docs-review/comp/screen-flows/FLOW-A.drawio'))).toBe(true);
    expect(screenComponentsLocationOf('docs-review/comp/screen-flows/FLOW-A.drawio')).toEqual({ root: 'docs-review/', key: null, flowId: 'FLOW-A', entry: 'flow' });
  });

  it('mở comp/index mặc định flow; click node chuyển wireframe đúng screen; tab có ARIA', async () => {
    seed();
    render(<ScreenComponentsPreview projectId="p1" file={file('docs-review/comp/index.json')} />);
    await waitFor(() => expect(screen.getByTestId('fake-flow-node')).toBeTruthy());
    const flowTab = screen.getByRole('tab', { name: 'Luồng màn hình' });
    const wireframeTab = screen.getByRole('tab', { name: 'Wireframe màn hình' });
    expect(flowTab.getAttribute('aria-selected')).toBe('true');
    expect(wireframeTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByLabelText('Component đề xuất')).toBeNull();
    fireEvent.click(screen.getByTestId('fake-flow-node'));
    await waitFor(() => expect(wireframeTab.getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(screen.getByTestId(`rail-${K2}`).getAttribute('aria-current')).toBe('true'));
    expect(screen.getByLabelText('Component đề xuất')).toBeTruthy();
    expect(screen.getByTestId('element-list').textContent).toContain('Quốc gia');
  });

  it('mở screen.json mặc định wireframe; đổi tab giữ current', async () => {
    seed();
    render(<ScreenComponentsPreview projectId="p1" file={file(`docs-review/comp/${K2}.screen.json`)} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Wireframe màn hình' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByTestId(`rail-${K2}`).getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Luồng màn hình' }));
    expect(screen.getByTestId(`rail-${K2}`).getAttribute('aria-current')).toBe('true');
  });
});
