import { describe, expect, it } from 'vitest';

import {
  shouldReloadAfterUpdate,
  updateApplyFailureMessage,
  updateRestartRequiredMessage,
} from '../src/components/UpdateCheck';

describe('updateApplyFailureMessage', () => {
  it('returns null for a started update', () => {
    expect(updateApplyFailureMessage(true, { started: true })).toBeNull();
  });

  it('surfaces an active-run rejection immediately', () => {
    expect(updateApplyFailureMessage(true, { started: false, reason: 'runs-active' })).toContain(
      'tác vụ AI',
    );
  });

  it('surfaces an already-running update immediately', () => {
    expect(
      updateApplyFailureMessage(true, { started: false, reason: 'already-in-progress' }),
    ).toContain('đang được thực hiện');
  });

  it('prefers the backend error for an HTTP failure', () => {
    expect(
      updateApplyFailureMessage(false, {
        started: false,
        reason: 'error',
        error: 'powershell not found',
      }),
    ).toBe('powershell not found');
  });
});

describe('shouldReloadAfterUpdate', () => {
  it('reloads when the restarted daemon confirms the installed version', () => {
    expect(shouldReloadAfterUpdate({ version: '0.8.18', at: '2026-08-15T00:00:00.000Z' })).toBe(true);
  });

  it('does not reload before an update is confirmed', () => {
    expect(shouldReloadAfterUpdate(null)).toBe(false);
  });
});

describe('updateRestartRequiredMessage', () => {
  it('returns restart guidance only for the safe Windows fallback state', () => {
    expect(updateRestartRequiredMessage('restart-required')).toContain('đăng xuất/đăng nhập');
    expect(updateRestartRequiredMessage('failed')).toBeNull();
    expect(updateRestartRequiredMessage(null)).toBeNull();
  });
});
