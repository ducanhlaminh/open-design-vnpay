// @vitest-environment jsdom
// Nút Back của workspace: theo history khi trang trước là của app (mở
// workspace từ danh sách pipeline → Back về lại danh sách), chỉ khi tab mở
// thẳng deep-link (không có gì phía sau) mới về fallback (home).

import { describe, expect, it, vi } from 'vitest';

import { navigate, navigateBack } from '../src/router';

describe('navigateBack', () => {
  it('deep link / tab mới → không có in-app history → thay bằng fallback, không gọi history.back', () => {
    window.history.replaceState(null, '', '/workspaces/p1');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    navigateBack({ kind: 'home', view: 'home' });
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
    back.mockRestore();
  });

  it('đã điều hướng trong app → history.back()', () => {
    window.history.replaceState(null, '', '/');
    navigate({ kind: 'home', view: 'pipelines' });
    navigate({ kind: 'project', projectId: 'p1', conversationId: null, fileName: null });
    // replace (đổi file trong workspace) không cộng thêm bậc history
    navigate({ kind: 'project', projectId: 'p1', conversationId: null, fileName: 'a.md' }, { replace: true });
    expect((window.history.state as { odIdx?: number }).odIdx).toBe(2);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    navigateBack({ kind: 'home', view: 'home' });
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });
});
