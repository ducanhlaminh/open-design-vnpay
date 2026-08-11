// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DesignSystemSyncStatus,
  DesignSystemVersionManifest,
  PullDesignSystemPlan,
  RemoteDesignSystemSummary,
} from '@open-design/contracts';
import { designSystemSyncContractFixtures } from '@open-design/contracts';
import {
  DesignSystemSyncActions,
  PullDesignSystemModal,
  ShareDesignSystemModal,
} from '../../src/components/DesignSystemSync';

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  listRemote: vi.fn(),
  planPull: vi.fn(),
  publish: vi.fn(),
  pull: vi.fn(),
}));

vi.mock('../../src/providers/design-system-sync', () => ({
  fetchDesignSystemSyncStatus: mocks.fetchStatus,
  listRemoteDesignSystems: mocks.listRemote,
  planPullDesignSystem: mocks.planPull,
  publishDesignSystem: mocks.publish,
  pullDesignSystem: mocks.pull,
}));

const remote: RemoteDesignSystemSummary = {
  ...designSystemSyncContractFixtures.remote,
  owner: { ...designSystemSyncContractFixtures.remote.owner },
  versions: [...designSystemSyncContractFixtures.remote.versions],
  usage: [],
};

const manifest: DesignSystemVersionManifest = {
  schemaVersion: 1,
  kind: 'design-system-version',
  remoteDesignSystemId: remote.remoteDesignSystemId,
  name: remote.name,
  version: 'v2',
  sourceVersion: 2,
  contentDigest: 'sha256:bbbb',
  figmaDigest: 'sha256:figma',
  publishedAt: remote.updatedAt,
  owner: remote.owner,
  criteria: {
    components: { status: 'current', generatedFromVersion: 2, digest: 'sha256:components' },
    rules: { status: 'current', generatedFromVersion: 2, digest: 'sha256:rules' },
  },
  usage: [],
  files: [],
};

const shareable: DesignSystemSyncStatus = {
  localDesignSystemId: 'user:payments',
  remoteDesignSystemId: remote.remoteDesignSystemId,
  localVersion: 2,
  localDigest: 'sha256:local',
  remote,
  changes: [
    { path: 'react/Button.tsx', operation: 'edit', localDigest: 'sha256:new', remoteDigest: 'sha256:old' },
    { path: 'assets/icon.svg', operation: 'add', localDigest: 'sha256:icon' },
  ],
  historicalVersions: ['v1'],
  canPush: true,
};

const localSystem = {
  id: 'user:payments',
  title: 'Payments Design System',
  category: 'Custom',
  summary: 'Payments UI',
  source: 'user' as const,
  status: 'published' as const,
  isEditable: true,
  hasReactBundle: true,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.fetchStatus.mockResolvedValue({ ok: true, value: shareable });
  mocks.listRemote.mockResolvedValue({ ok: true, value: { items: [remote], total: 1 } });
});

describe('ShareDesignSystemModal', () => {
  it('shows the exact file/version preview and publishes against the observed remote digest', async () => {
    mocks.publish.mockResolvedValue({
      ok: true,
      value: { status: 'published', summary: remote, manifest, uploadedVersions: ['v1', 'v2'] },
    });
    render(<ShareDesignSystemModal systems={[localSystem]} onClose={() => {}} />);

    expect(await screen.findByText('2 tệp sẽ được đồng bộ')).toBeTruthy();
    expect(screen.getByText('react/Button.tsx')).toBeTruthy();
    expect(screen.getByText('v1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Chia sẻ lên kho chung' }));

    await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith('user:payments', { expectedRemoteDigest: 'sha256:bbbb' }));
    expect(await screen.findByText(/App và Feature trên máy vẫn giữ nguyên phiên bản đang dùng/)).toBeTruthy();
  });

  it('blocks a stale Design System with designer-friendly copy', async () => {
    mocks.fetchStatus.mockResolvedValue({
      ok: true,
      value: { ...shareable, canPush: false, blockReason: 'criteria_stale' },
    });
    render(<ShareDesignSystemModal systems={[localSystem]} onClose={() => {}} />);

    expect(await screen.findByText(/Danh mục component hoặc quy tắc thiết kế cần được cập nhật/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Chia sẻ lên kho chung' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('PullDesignSystemModal', () => {
  const conflictPlan: PullDesignSystemPlan = {
    remote,
    manifest,
    localDesignSystemId: 'user:payments',
    localExists: true,
    localDigest: 'sha256:local',
    changes: [{ path: 'tokens/colors.json', operation: 'edit', localDigest: 'sha256:local-file', remoteDigest: 'sha256:remote-file' }],
    conflict: true,
  };

  it('requires an explicit conflict choice and never implies automatic App/Feature binding', async () => {
    mocks.planPull.mockResolvedValue({ ok: true, value: conflictPlan });
    mocks.pull.mockResolvedValue({
      ok: true,
      value: {
        status: 'pulled',
        localDesignSystemId: 'user:payments',
        remoteDesignSystemId: remote.remoteDesignSystemId,
        manifest,
        bindingsChanged: false,
        contextCreated: false,
      },
    });
    const refresh = vi.fn();
    render(<PullDesignSystemModal onClose={() => {}} onInstalled={refresh} />);

    fireEvent.click(await screen.findByRole('button', { name: /Payments Design System/ }));
    expect(await screen.findByText('tokens/colors.json')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Cập nhật trên máy' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: /Dùng bản từ kho chung/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledWith({
      remoteDesignSystemId: 'payments-ds',
      version: 'v2',
      localDesignSystemId: 'user:payments',
      expectedLocalDigest: 'sha256:local',
      resolution: 'use_remote',
    }));
    expect(await screen.findByText(/chưa được áp dụng tự động cho App hoặc Feature/)).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('supports keeping the local version without overwriting files', async () => {
    mocks.planPull.mockResolvedValue({ ok: true, value: conflictPlan });
    mocks.pull.mockResolvedValue({
      ok: true,
      value: { status: 'kept_local', localDesignSystemId: 'user:payments', remoteDesignSystemId: 'payments-ds', bindingsChanged: false, contextCreated: false },
    });
    render(<PullDesignSystemModal onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: /Payments Design System/ }));
    await screen.findByText('tokens/colors.json');
    fireEvent.click(screen.getByRole('radio', { name: /Giữ bản trên máy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Giữ bản trên máy' }));

    expect(await screen.findByText(/Không có tệp nào bị thay đổi/)).toBeTruthy();
  });

  it('shows an actionable service error instead of an empty remote list', async () => {
    mocks.listRemote.mockResolvedValue({ ok: false, error: { message: 'Tài khoản chưa được kết nối với kho dự án.' } });
    render(<PullDesignSystemModal onClose={() => {}} />);

    expect(await screen.findByText('Chưa mở được kho chung')).toBeTruthy();
    expect(screen.getByText('Tài khoản chưa được kết nối với kho dự án.')).toBeTruthy();
    expect(screen.queryByText('Không tìm thấy bộ Design System')).toBeNull();
  });

  it('renders a calm empty state when the shared store has no matching Design System', async () => {
    mocks.listRemote.mockResolvedValue({ ok: true, value: { items: [], total: 0 } });
    render(<PullDesignSystemModal onClose={() => {}} />);

    expect(await screen.findByText('Không tìm thấy bộ Design System')).toBeTruthy();
  });
});

describe('DesignSystemSyncActions', () => {
  it('keeps Pull available even when the machine has no local Figma Design System', () => {
    render(<DesignSystemSyncActions systems={[]} />);
    expect((screen.getByRole('button', { name: 'Lấy bộ Design System về máy' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Chia sẻ bộ Design System' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
