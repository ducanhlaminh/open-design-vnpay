// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { AgentEvent, ChatMessage } from '../../src/types';

function messageWithEvents(events: AgentEvent[]): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    events,
    startedAt: 1_000,
    endedAt: 3_000,
    runStatus: 'succeeded',
  };
}

const TOOL_CHAIN: AgentEvent[] = [
  { kind: 'thinking', text: 'Weighing two layouts before writing anything.' },
  { kind: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pnpm guard' } },
  { kind: 'tool_result', toolUseId: 'tool-1', content: 'ok', isError: false },
  { kind: 'status', label: 'model', detail: 'claude-opus-4-7' },
  { kind: 'text', text: 'Trang chu da san sang.' },
];

describe('AssistantMessage simple mode', () => {
  afterEach(() => cleanup());

  it('keeps the prose but drops the tool card, reasoning and status pill', () => {
    const { container } = render(
      <AssistantMessage
        projectKind="prototype"
        conversationId="conv-1"
        message={messageWithEvents(TOOL_CHAIN)}
        streaming={false}
        projectId="project-1"
        simpleMode
      />,
    );

    expect(screen.getByText(/Trang chu da san sang/)).toBeTruthy();
    expect(container.querySelector('.action-card')).toBeNull();
    expect(container.querySelector('.thinking-block')).toBeNull();
    expect(container.querySelector('.status-pill')).toBeNull();
    // Elapsed / token / cost readout is developer-facing.
    expect(container.querySelector('.assistant-stats')).toBeNull();
  });

  it('renders the whole flow when simple mode is off', () => {
    const { container } = render(
      <AssistantMessage
        projectKind="prototype"
        conversationId="conv-1"
        message={messageWithEvents(TOOL_CHAIN)}
        streaming={false}
        projectId="project-1"
      />,
    );

    expect(container.querySelector('.thinking-block')).toBeTruthy();
    expect(container.querySelector('.assistant-stats')).toBeTruthy();
    expect(screen.getByText(/pnpm guard/)).toBeTruthy();
  });

  it('still shows an AskUserQuestion card — hiding it would stall the run', () => {
    const { container } = render(
      <AssistantMessage
        projectKind="prototype"
        conversationId="conv-1"
        isLast
        message={messageWithEvents([
          {
            kind: 'tool_use',
            id: 'tool-auq',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Ban muon mau chu dao nao?',
                  header: 'Mau',
                  multiSelect: false,
                  options: [
                    { label: 'Xanh VNPAY', description: 'Mau thuong hieu' },
                    { label: 'Do', description: 'Mau nhan' },
                  ],
                },
              ],
            },
          },
        ])}
        streaming={false}
        projectId="project-1"
        simpleMode
      />,
    );

    expect(container.querySelector('.op-ask-question-body')).toBeTruthy();
    expect(screen.getByText(/Ban muon mau chu dao nao/)).toBeTruthy();
  });

  it('surfaces a working pill while hidden tools are still running', () => {
    const { container } = render(
      <AssistantMessage
        projectKind="prototype"
        conversationId="conv-1"
        isLast
        message={{
          ...messageWithEvents([
            { kind: 'text', text: 'Bat dau dung trang.' },
            { kind: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: 'index.html' } },
          ]),
          endedAt: undefined,
          runStatus: 'running',
        }}
        streaming
        projectId="project-1"
        simpleMode
      />,
    );

    expect(container.querySelector('.op-card-head')).toBeNull();
    expect(container.querySelector('.op-waiting')).toBeTruthy();
  });
});
