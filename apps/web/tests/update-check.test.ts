import { describe, expect, it } from 'vitest';

import { updateApplyFailureMessage } from '../src/components/UpdateCheck';

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
