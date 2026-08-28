// WP screen-flow-platform-split (2026-08-28): helper id luồng màn hình theo
// nền tảng — cùng hợp đồng với daemon `flow-ux/screen-flow-xml.ts`.
import { describe, expect, it } from 'vitest';
import { SCREEN_FLOW_ID_RE, isScreenFlowId, screenFlowIdFor, screenFlowPlatformLabel, screenFlowPlatformOf } from '../../src/components/screen-flow-ids';

describe('screen-flow-ids', () => {
  it('nhận SCREEN-FLOW, SCREEN-FLOW--app, SCREEN-FLOW--web; từ chối id khác', () => {
    expect(isScreenFlowId('SCREEN-FLOW')).toBe(true);
    expect(isScreenFlowId('SCREEN-FLOW--app')).toBe(true);
    expect(isScreenFlowId('SCREEN-FLOW--web')).toBe(true);
    expect(isScreenFlowId('SCREEN-FLOW--ios')).toBe(false);
    expect(isScreenFlowId('SCREEN-FLOW-app')).toBe(false);
    expect(isScreenFlowId('SCREEN-FLOW--')).toBe(false);
    expect(isScreenFlowId('FLOW-a')).toBe(false);
    expect(isScreenFlowId('screen-flow')).toBe(false);
    expect(isScreenFlowId(undefined)).toBe(false);
    expect(isScreenFlowId(null)).toBe(false);
    expect(SCREEN_FLOW_ID_RE.source).toBe('^SCREEN-FLOW(--(app|web))?$');
  });

  it('platformOf / idFor / label đi vòng đúng', () => {
    expect(screenFlowPlatformOf('SCREEN-FLOW')).toBeNull();
    expect(screenFlowPlatformOf('SCREEN-FLOW--app')).toBe('app');
    expect(screenFlowPlatformOf('SCREEN-FLOW--web')).toBe('web');
    expect(screenFlowPlatformOf('FLOW-a')).toBeNull();
    expect(screenFlowIdFor(null)).toBe('SCREEN-FLOW');
    expect(screenFlowIdFor(undefined)).toBe('SCREEN-FLOW');
    expect(screenFlowIdFor('app')).toBe('SCREEN-FLOW--app');
    expect(screenFlowIdFor('web')).toBe('SCREEN-FLOW--web');
    for (const p of ['app', 'web'] as const) expect(screenFlowPlatformOf(screenFlowIdFor(p))).toBe(p);
    expect(screenFlowPlatformLabel('SCREEN-FLOW--app')).toBe('App');
    expect(screenFlowPlatformLabel('SCREEN-FLOW--web')).toBe('Web');
    expect(screenFlowPlatformLabel('SCREEN-FLOW')).toBeNull();
    expect(screenFlowPlatformLabel('FLOW-a')).toBeNull();
  });
});
