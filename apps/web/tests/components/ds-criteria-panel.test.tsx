// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesignSystemCriteriaPanel, DesignSystemDetailView } from '../../src/components/DesignSystemFlow';
import type { AppConfig, DesignSystemDetail } from '../../src/types';
import { ensureDesignSystemWorkspace, fetchDesignSystem, fetchDesignSystemRevisions, generateDesignSystemCriteria, getDesignSystemCriteria } from '../../src/providers/registry';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>('../../src/providers/registry');
  return { ...actual, generateDesignSystemCriteria: vi.fn(), getDesignSystemCriteria: vi.fn(), fetchDesignSystem: vi.fn(), fetchDesignSystemRevisions: vi.fn(), ensureDesignSystemWorkspace: vi.fn() };
});

type Criteria = Awaited<ReturnType<typeof getDesignSystemCriteria>>;
const result = (status: 'queued' | 'running' | 'succeeded' | 'failed', extra: Record<string, unknown> = {}): Criteria => ({
  hasComponents: status === 'succeeded',
  hasRules: true,
  components: status === 'succeeded' ? 3 : 0,
  rules: 1,
  meta: status === 'succeeded' ? { generatedAt: '2026-08-09T00:00:00.000Z', components: 3, rulesBytes: 10 } : null,
  job: {
    id: 'job-1', status, message: 'status', createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:01.000Z',
    steps: [{ id: 'read-catalog', title: 'Read catalog', status: status === 'queued' ? 'pending' : status }, { id: 'generate', title: 'Generate', status: 'pending' }, { id: 'validate', title: 'Validate', status: status === 'queued' ? 'pending' : status }],
    notes: [], ...extra,
  },
});

const empty = (): Criteria => ({ hasComponents: false, hasRules: false, components: 0, rules: 0, meta: null, job: null });

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const detail: DesignSystemDetail = {
  id: 'user:lib-x', title: 'Library', category: 'Custom', summary: 'Library', swatches: [],
  surface: 'web', body: '# Library', status: 'draft', source: 'user', isEditable: true,
  projectId: 'ds-lib-x', hasReactBundle: true,
};
const config: AppConfig = {
  mode: 'daemon', apiKey: '', baseUrl: '', model: '', agentId: 'agent-1', agentModels: {},
  skillId: null, designSystemId: null,
};


describe('DesignSystemCriteriaPanel', () => {
  it('loads without generating, starts once, then opens the exact conversation', async () => {
    vi.mocked(getDesignSystemCriteria).mockResolvedValue(empty());
    vi.mocked(generateDesignSystemCriteria).mockResolvedValue({ jobId: 'job-1' });
    const open = vi.fn();
    render(<DesignSystemCriteriaPanel systemId="ds-1" onOpenProject={open} />);
    await screen.findByText('Chưa sinh danh mục component');
    expect(generateDesignSystemCriteria).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Sinh danh mục' }));
    await waitFor(() => expect(generateDesignSystemCriteria).toHaveBeenCalledTimes(1));

    vi.mocked(getDesignSystemCriteria).mockResolvedValue(result('running', { projectId: 'project-7', conversationId: 'conversation-9' }));
    cleanup();
    render(<DesignSystemCriteriaPanel systemId="ds-1" onOpenProject={open} />);
    await screen.findByRole('button', { name: 'Mở hội thoại' });
    expect((screen.getByRole('button', { name: 'Mở hội thoại' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Mở hội thoại' }));
    expect(open).toHaveBeenCalledWith('project-7', 'conversation-9');
  });

  it('keeps the conversation button enabled on failed jobs and re-enables Run', async () => {
    vi.mocked(getDesignSystemCriteria).mockResolvedValue(result('failed', { projectId: 'project-7', conversationId: 'conversation-9' }));
    render(<DesignSystemCriteriaPanel systemId="ds-1" onOpenProject={vi.fn()} />);
    await screen.findByRole('button', { name: 'Mở hội thoại' });
    expect((screen.getByRole('button', { name: 'Mở hội thoại' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Sinh danh mục' }) as HTMLButtonElement).disabled).toBe(false);
  });


  it('opens the full-window review catalog without auto-opening the workspace', async () => {
    vi.mocked(fetchDesignSystem).mockResolvedValue(detail);
    vi.mocked(fetchDesignSystemRevisions).mockResolvedValue([]);
    vi.mocked(getDesignSystemCriteria).mockResolvedValue(empty());
    const open = vi.fn();
    render(<DesignSystemDetailView id={detail.id} section="criteria" selectedId={null} config={config} agents={[]} onBack={vi.fn()} onSetDefault={vi.fn()} onOpenProject={open} />);
    expect(await screen.findByRole('dialog', { name: 'Danh mục review' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Showcase',
      'Thành phần',
      'Nguyên tắc',
    ]);
    await act(async () => { await Promise.resolve(); });
    expect(open).not.toHaveBeenCalled();
    expect(ensureDesignSystemWorkspace).not.toHaveBeenCalled();
  });

  it('keeps auto-opening the workspace on the default route for a plain design system', async () => {
    const plain: DesignSystemDetail = { ...detail, hasReactBundle: false };
    vi.mocked(fetchDesignSystem).mockResolvedValue(plain);
    vi.mocked(fetchDesignSystemRevisions).mockResolvedValue([]);
    vi.mocked(ensureDesignSystemWorkspace).mockResolvedValue({ project: { id: plain.projectId! }, files: [] } as never);
    const open = vi.fn();
    render(<DesignSystemDetailView id={plain.id} selectedId={null} config={config} agents={[]} onBack={vi.fn()} onSetDefault={vi.fn()} onOpenProject={open} />);
    await waitFor(() => expect(open).toHaveBeenCalledWith(plain.projectId));
  });

  // DS Figma đi ngược lại: màn này CHÍNH LÀ preview (Showcase / Thành phần /
  // Nguyên tắc), nên nhảy sang /projects/:id sẽ unmount đúng thứ vừa mở.
  it('stays on the preview for a react-bundle design system instead of routing to the project', async () => {
    vi.mocked(fetchDesignSystem).mockResolvedValue(detail);
    vi.mocked(fetchDesignSystemRevisions).mockResolvedValue([]);
    vi.mocked(ensureDesignSystemWorkspace).mockResolvedValue({ project: { id: detail.projectId! }, files: [] } as never);
    const open = vi.fn();
    render(<DesignSystemDetailView id={detail.id} selectedId={null} config={config} agents={[]} onBack={vi.fn()} onSetDefault={vi.fn()} onOpenProject={open} />);
    // Workspace vẫn phải resolve (chat bên trái cần project đó), chỉ là không điều hướng.
    await waitFor(() => expect(ensureDesignSystemWorkspace).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(open).not.toHaveBeenCalled();
    expect(await screen.findByRole('tab', { name: 'Nguyên tắc' })).toBeTruthy();
  });

  it('stops polling after success', async () => {
    vi.useFakeTimers();
    vi.mocked(getDesignSystemCriteria).mockResolvedValue(result('succeeded'));
    render(<DesignSystemCriteriaPanel systemId="ds-1" />);
    await act(async () => { await Promise.resolve(); });
    const calls = vi.mocked(getDesignSystemCriteria).mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(getDesignSystemCriteria).toHaveBeenCalledTimes(calls);
  });
});
