// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PromptRunModal } from '../../src/components/pipelines/PipelineModals';

afterEach(cleanup);

describe('PromptRunModal', () => {
  it('submits trimmed optional guidance without document-source controls', async () => {
    const onRun = vi.fn(async () => undefined);
    render(
      <PromptRunModal
        pipelineName="Sáng tác màn"
        placeholder="Phạm vi màn / định hướng thị giác (tuỳ chọn)"
        defaultPrompt="  Ưu tiên luồng thanh toán  "
        onClose={() => undefined}
        onRun={onRun}
      />,
    );

    expect(screen.queryByRole('radiogroup', { name: /Document source/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Chạy bước này/i }));

    await waitFor(() => expect(onRun).toHaveBeenCalledWith('Ưu tiên luồng thanh toán'));
  });

  it('allows an empty prompt so the stage can use current docs and config', async () => {
    const onRun = vi.fn(async () => undefined);
    render(
      <PromptRunModal
        pipelineName="Lập bản đồ màn"
        placeholder="Luồng/màn cần ưu tiên (tuỳ chọn)"
        onClose={() => undefined}
        onRun={onRun}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Chạy bước này/i }));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith(''));
  });
});
