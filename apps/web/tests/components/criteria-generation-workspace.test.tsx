// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CriteriaGenerationDocumentResponse,
  CriteriaGenerationJob,
} from '@open-design/contracts';
import { CriteriaGenerationWorkspace } from '../../src/components/CriteriaGenerationWorkspace';
import {
  fetchCriteriaGenerationDocument,
  startCriteriaGeneration,
} from '../../src/providers/design-system-criteria';
import { approveDesignSystemCriteriaDraft } from '../../src/providers/design-system-figma-update';
import { listConversations, listMessages } from '../../src/state/projects';

vi.mock('../../src/providers/design-system-criteria', () => ({
  fetchCriteriaGenerationDocument: vi.fn(),
  startCriteriaGeneration: vi.fn(),
}));

vi.mock('../../src/providers/design-system-figma-update', () => ({
  approveDesignSystemCriteriaDraft: vi.fn(),
}));

vi.mock('../../src/state/projects', () => ({
  listMessages: vi.fn(),
  listConversations: vi.fn(),
}));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: ({ messages, streaming, onStop }: { messages: Array<{ id: string; content: string }>; streaming: boolean; onStop: () => void }) => (
    <div data-testid="criteria-chat-frame">
      {messages.map((message) => <p key={message.id}>{message.content}</p>)}
      {streaming ? <button type="button" onClick={onStop}>Dừng agent</button> : null}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const job: CriteriaGenerationJob = {
  id: 'job-1',
  designSystemId: 'ds-1',
  kind: 'components',
  status: 'running',
  message: 'Đang đọc bộ Figma',
  error: null,
  steps: [
    { id: 'read', title: 'Đọc thành phần', status: 'succeeded' },
    { id: 'generate', title: 'Soạn tài liệu', status: 'running', message: 'Đang viết bản mới' },
  ],
  createdAt: '2026-08-11T01:00:00.000Z',
  updatedAt: '2026-08-11T01:01:00.000Z',
  workspace: { projectId: 'project-1', conversationId: 'conversation-1', runId: 'run-1' },
  notes: [],
};

function response(patch: Partial<CriteriaGenerationDocumentResponse> = {}): CriteriaGenerationDocumentResponse {
  return {
    kind: 'components',
    current: { content: '# Bản đang dùng', updatedAt: job.createdAt, count: 12, status: 'current' },
    draft: null,
    job,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchCriteriaGenerationDocument).mockResolvedValue({ ok: true, value: response() });
  vi.mocked(startCriteriaGeneration).mockResolvedValue({ ok: true, value: { job, reused: false } });
  vi.mocked(approveDesignSystemCriteriaDraft).mockResolvedValue({ ok: true, value: {} as never });
  vi.mocked(listMessages).mockResolvedValue([
    { id: 'm-1', role: 'assistant', content: 'Đang đọc danh mục thành phần.' },
  ]);
  vi.mocked(listConversations).mockResolvedValue([]);
});

describe('CriteriaGenerationWorkspace', () => {
  it('shows job progress and opens the exact generated conversation', async () => {
    render(
      <CriteriaGenerationWorkspace
        designSystemId="ds-1"
        kind="components"
        onBack={vi.fn()}
        onOpenConversation={vi.fn()}
      />,
    );

    expect(await screen.findByText('Đang đọc bộ Figma')).toBeTruthy();
    expect(screen.getByText('Soạn tài liệu')).toBeTruthy();
    expect(await screen.findByText('Đang đọc danh mục thành phần.')).toBeTruthy();

    expect(screen.getByTestId('criteria-chat-frame')).toBeTruthy();
  });

  it('lets the designer stop the active agent run', async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', cancel);
    render(
      <CriteriaGenerationWorkspace
        designSystemId="ds-1"
        kind="components"
        onBack={vi.fn()}
        onOpenConversation={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Dừng tác vụ' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('/api/runs/run-1/cancel', { method: 'POST' }));
  });

  it('starts automatically when a refreshed deep link has no job yet', async () => {
    vi.mocked(fetchCriteriaGenerationDocument).mockResolvedValue({
      ok: true,
      value: response({ current: null, job: null }),
    });

    render(
      <CriteriaGenerationWorkspace
        designSystemId="ds-1"
        kind="components"
        onBack={vi.fn()}
        onOpenConversation={vi.fn()}
      />,
    );

    await waitFor(() => expect(startCriteriaGeneration).toHaveBeenCalledTimes(1));
    expect(startCriteriaGeneration).toHaveBeenCalledWith('ds-1', 'components');
  });

  it('previews and approves a draft before returning to the catalog', async () => {
    const onBack = vi.fn();
    vi.mocked(fetchCriteriaGenerationDocument).mockResolvedValue({
      ok: true,
      value: response({
        draft: { content: '# Bản mới\nDate picker', updatedAt: job.updatedAt, count: 13, status: 'draft' },
        job: { ...job, status: 'succeeded', message: 'Đã sinh xong' },
      }),
    });

    render(
      <CriteriaGenerationWorkspace
        designSystemId="ds-1"
        kind="components"
        onBack={onBack}
        onOpenConversation={vi.fn()}
      />,
    );

    expect(await screen.findByText('Date picker')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt dùng cho Design System' }));

    await waitFor(() => expect(approveDesignSystemCriteriaDraft).toHaveBeenCalledWith('ds-1', 'components'));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });

  it('offers retry after a failed job', async () => {
    vi.mocked(fetchCriteriaGenerationDocument).mockResolvedValue({
      ok: true,
      value: response({ job: { ...job, status: 'failed', message: 'Không sinh được', error: 'Skill dừng' } }),
    });

    render(
      <CriteriaGenerationWorkspace
        designSystemId="ds-1"
        kind="components"
        onBack={vi.fn()}
        onOpenConversation={vi.fn()}
      />,
    );

    expect((await screen.findByRole('alert')).textContent).toContain('Skill dừng');
    fireEvent.click(await screen.findByRole('button', { name: 'Thử lại' }));
    await waitFor(() => expect(startCriteriaGeneration).toHaveBeenCalledWith('ds-1', 'components'));
  });
});
