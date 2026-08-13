// @vitest-environment jsdom

// WP8 — JIRA ingest removed: RunInputModal used to hide a legacy free-text
// "Advanced: JIRA key / JQL" panel behind a link. That panel + link must be
// gone; the modal only ever offers the Confluence/BAS radiogroup now.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RunInputModal } from '../../src/components/pipelines/PipelineModals';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('RunInputModal', () => {
  it('never renders the legacy "Advanced: JIRA" link or a JIRA key/JQL input', () => {
    render(
      <RunInputModal
        pipelineName="Tài liệu (nạp)"
        placeholder="Confluence page URL/id"
        onClose={() => undefined}
        onRun={async () => undefined}
      />,
    );

    expect(screen.queryByText(/Advanced/i)).toBeNull();
    expect(screen.queryByText(/JIRA/i)).toBeNull();
    expect(screen.queryByLabelText(/JIRA key/i)).toBeNull();
    // The Confluence/BAS radiogroup is still there — removal only touched
    // the Advanced branch, not the normal source picker.
    expect(screen.getByRole('radiogroup', { name: /Document source/i })).toBeTruthy();
    expect(screen.getByText('Confluence')).toBeTruthy();
  });

  it('the BAS card stays visibly disabled (maintenance) without any JIRA fallback copy', () => {
    render(
      <RunInputModal
        pipelineName="Tài liệu (nạp)"
        placeholder="Confluence page URL/id"
        onClose={() => undefined}
        onRun={async () => undefined}
      />,
    );

    const basRadio = screen.getByRole('radio', { name: /BAS/i });
    expect(basRadio.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Tạm khóa — dùng nguồn Confluence.')).toBeTruthy();
  });
});
