// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@open-design/contracts';
import { DsCriteriaJobModal } from '../../src/components/DsCriteriaJobModal';
import { generateDesignSystemCriteria, getDesignSystemCriteria, streamRunLog } from '../../src/providers/registry';

vi.mock('../../src/providers/registry', () => ({
  generateDesignSystemCriteria: vi.fn(),
  getDesignSystemCriteria: vi.fn(),
  streamRunLog: vi.fn(() => () => {}),
}));

const system: DesignSystemSummary = { id: 'figma:one', title: 'VNPAY', category: 'Custom', summary: 'DS', hasReactBundle: true };
const job = (status: 'queued' | 'running' | 'succeeded' | 'failed', overrides = {}) => ({
  id: 'job-1', status, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
  runId: status === 'running' ? 'run-1' : undefined, notes: ['12:00:00 đọc catalog 42 KB'],
  steps: [
    { id: 'read-catalog', title: 'Đọc catalog', status: status === 'running' ? 'succeeded' : 'succeeded' },
    { id: 'generate', title: 'Sinh danh mục', status: status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'succeeded', ...(status === 'failed' ? { message: 'Agent gặp lỗi' } : {}) },
    { id: 'validate', title: 'Kiểm tra', status: status === 'succeeded' ? 'succeeded' : 'pending' },
  ], ...overrides,
});
const criteria = (currentJob: ReturnType<typeof job> | null, components = 0): any => ({ hasComponents: components > 0, hasRules: true, components, rules: 10, meta: components ? { generatedAt: '2026-01-01T00:00:00.000Z', components, rulesBytes: 10 } : null, job: currentJob });

beforeEach(() => { vi.useRealTimers(); vi.mocked(streamRunLog).mockReturnValue(() => {}); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('DsCriteriaJobModal', () => {
  it('opens idle and does not generate before clicking', async () => {
    vi.mocked(getDesignSystemCriteria).mockResolvedValue(criteria(null));
    render(<DsCriteriaJobModal system={system} onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Bắt đầu' })).toBeTruthy();
    expect(generateDesignSystemCriteria).not.toHaveBeenCalled();
  });

  it('starts exactly once and disables the button', async () => {
    vi.mocked(getDesignSystemCriteria).mockResolvedValue(criteria(null));
    vi.mocked(generateDesignSystemCriteria).mockResolvedValue({ jobId: 'job-1' });
    render(<DsCriteriaJobModal system={system} onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu' }));
    expect(generateDesignSystemCriteria).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Đang bắt đầu|Đang chạy/ })).toHaveProperty('disabled', true);
  });

  it('polls running to succeeded, calls onDone, then stops', async () => {
    vi.useFakeTimers();
    const running = criteria(job('running'));
    const succeeded = criteria(job('succeeded'), 34);
    vi.mocked(getDesignSystemCriteria).mockResolvedValueOnce(running).mockResolvedValueOnce(succeeded);
    const onDone = vi.fn();
    render(<DsCriteriaJobModal system={system} onClose={() => {}} onDone={onDone} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });
    expect(screen.getByText('Đã sinh 34 component')).toBeTruthy();
    expect(onDone).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(getDesignSystemCriteria).mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(getDesignSystemCriteria).toHaveBeenCalledTimes(calls);
  });

  it('renders daemon notes in the log', async () => {
    vi.mocked(getDesignSystemCriteria).mockResolvedValue(criteria(job('running')));
    render(<DsCriteriaJobModal system={system} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/đọc catalog 42 KB/)).toBeTruthy(), { timeout: 1000 });
  });

  it('shows step failure and allows retry', async () => {
    vi.mocked(getDesignSystemCriteria).mockResolvedValue(criteria(job('failed')));
    render(<DsCriteriaJobModal system={system} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Agent gặp lỗi')).toBeTruthy(), { timeout: 1000 });
    expect(screen.getByRole('button', { name: 'Chạy lại' })).toHaveProperty('disabled', false);
  });
});
