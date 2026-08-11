import { describe, expect, it } from 'vitest';
import { accessRoleLabel, projectTransferLabel, publishedDestinationNote, stepDifferenceLabel, SYNC_COPY } from '../../src/components/pipelines/sync-copy';

describe('pipeline sync copy', () => {
  it('keeps the user-facing vocabulary free of implementation terms', () => {
    const snapshot = JSON.stringify(SYNC_COPY);
    expect(snapshot).not.toMatch(/KGS|graph|remote|mirror|store|\bstage\b/i);
    expect(SYNC_COPY.shareTitle).toBe('Chia sẻ kết quả');
    expect(SYNC_COPY.downloadTitle).toBe('Lấy dự án về máy');
  });

  it('describes new/update and per-step differences in product language', () => {
    expect(projectTransferLabel(false)).toBe('Dự án mới');
    expect(projectTransferLabel(true)).toBe('Cập nhật bản trên máy');
    expect(stepDifferenceLabel(true, true)).toBe('Có thay đổi');
    expect(stepDifferenceLabel(false, true)).toBe('Đã cập nhật');
    expect(accessRoleLabel('viewer')).toBe('Chỉ xem');
  });

  it('maps publish destinations and failures', () => {
    expect(publishedDestinationNote({ status: 'pending_approval' })).toContain('đang chờ duyệt');
    expect(publishedDestinationNote({ status: 'published' })).toContain('dự án chính');
    expect(publishedDestinationNote({ status: 'auth_required' })).toContain('kết nối lại');
  });
});
