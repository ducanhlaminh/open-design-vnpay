// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PipelineProject } from '@open-design/contracts';

import { PipelinePickerView } from '../../../src/components/pipelines/PipelinePickerView';
import { groupByApp } from '../../../src/components/pipelines/usePipelineNav';

vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('explains the shared URD/PRD input before a workflow is opened', () => {
  const project: PipelineProject = {
    id: 'feature-1',
    name: 'Thanh toán',
    done: 0,
    total: 0,
    running: 0,
    app: { id: 'app-1', name: 'VNPAY' },
  };
  const apps = groupByApp([project], []);
  const nav = {
    apps,
    projects: [project],
    loading: false,
    loaded: true,
    error: null,
    reload: async () => {},
    appById: (id: string) => apps.find((app) => app.id === id) ?? null,
    featureOf: (appId: string, featureId: string) =>
      apps.find((app) => app.id === appId)?.features.find((feature) => feature.id === featureId) ?? null,
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ workflows: [] }), { status: 200 })));

  render(<PipelinePickerView nav={nav} appId="app-1" featureId="feature-1" />);

  const callout = screen.getByLabelText('Tài liệu đầu vào dùng chung');
  expect(callout.textContent).toContain('URD');
  expect(callout.textContent).toContain('PRD');
  expect(callout.textContent).toContain('Tài liệu đầu vào dùng chung cho 3 workflow');
});
