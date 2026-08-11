import { describe, expect, it } from 'vitest';

import {
  contextNeedsUpdate,
  contextVersionLabel,
  contextVersionsForSelection,
  diffContextManifests,
  emptyContextSelection,
  featureHasNewContext,
  isPartOfAppSelected,
  isWholeAppSelected,
  selectionForFeatures,
  serializeContextSelection,
  summarizeContextChanges,
  toggleAppContext,
  toggleContextFeature,
  toggleWholeApp,
  type ContextTreeApp,
} from '../../../src/components/pipelines/context-sync-tree';

const app: ContextTreeApp = {
  id: 'app-pay',
  name: 'Thanh toán',
  context: { currentVersion: 'v4', latestVersion: 'v4' },
  features: [
    { id: 'qr', name: 'QR', boundVersion: 'v3' },
    { id: 'card', name: 'Thẻ', boundVersion: 'v4' },
  ],
};

describe('context sync tree selection', () => {
  it('chọn App chọn Context và toàn bộ Feature con', () => {
    const selected = toggleWholeApp(app, emptyContextSelection());
    expect(serializeContextSelection(selected)).toEqual({ appIds: ['app-pay'], projectIds: ['card', 'qr'] });
    expect(isWholeAppSelected(app, selected)).toBe(true);
    expect(isPartOfAppSelected(app, selected)).toBe(false);
  });

  it('App rỗng vẫn chọn và chia sẻ Context độc lập', () => {
    const emptyApp = { ...app, id: 'app-empty', features: [] };
    const selected = toggleWholeApp(emptyApp, emptyContextSelection());
    expect(serializeContextSelection(selected)).toEqual({ appIds: ['app-empty'], projectIds: [] });
    expect(isWholeAppSelected(emptyApp, selected)).toBe(true);
  });

  it('chọn một Feature tự chọn Context cha và tạo trạng thái chọn một phần', () => {
    const selected = toggleContextFeature(app, 'qr', emptyContextSelection());
    expect(serializeContextSelection(selected)).toEqual({ appIds: ['app-pay'], projectIds: ['qr'] });
    expect(isPartOfAppSelected(app, selected)).toBe(true);
  });

  it('không cho bỏ Context khi Feature con vẫn đang được chọn', () => {
    const withFeature = toggleContextFeature(app, 'qr', emptyContextSelection());
    expect(toggleAppContext(app, withFeature).appIds.has(app.id)).toBe(true);
  });

  it('preselect Feature cũng kéo theo Context cha', () => {
    expect(serializeContextSelection(selectionForFeatures([app], ['card']))).toEqual({
      appIds: ['app-pay'],
      projectIds: ['card'],
    });
  });

  it('chuyển cả version Feature đã khóa và để Context hiện tại ở cuối', () => {
    const selected = toggleWholeApp(app, emptyContextSelection());
    expect(contextVersionsForSelection([app], selected)).toEqual({ 'app-pay': ['v3', 'v4'] });
  });
});

describe('context version copy', () => {
  it('chuẩn hóa version và legacy không version', () => {
    expect(contextVersionLabel('4')).toBe('v4');
    expect(contextVersionLabel('v4')).toBe('v4');
    expect(contextVersionLabel(null)).toBe('Chưa tạo version');
  });

  it('phát hiện Context và binding cũ', () => {
    expect(contextNeedsUpdate({ localDigest: 'sha:a', sharedDigest: 'sha:b' })).toBe(true);
    expect(featureHasNewContext(app.features[0]!, app.context)).toBe(true);
    expect(featureHasNewContext(app.features[1]!, app.context)).toBe(false);
  });

  it('tóm tắt diff file bằng tiếng Việt', () => {
    expect(summarizeContextChanges([
      { path: 'components.md', operation: 'edit' },
      { path: 'rules.md', operation: 'edit' },
      { path: 'docs/new.md', operation: 'add' },
    ])).toBe('1 tệp thêm · 2 tệp sửa');
  });

  it('so sánh manifest thành add/edit/delete mà không cần đọc nội dung', () => {
    expect(diffContextManifests(
      { files: [{ path: 'components.md', digest: 'new' }, { path: 'docs/new.md', digest: 'same' }] },
      { files: [{ path: 'components.md', digest: 'old' }, { path: 'rules.md', digest: 'gone' }] },
    )).toEqual([
      { path: 'components.md', operation: 'edit' },
      { path: 'docs/new.md', operation: 'add' },
      { path: 'rules.md', operation: 'delete' },
    ]);
  });
});
