import { describe, expect, it } from 'vitest';

import { applyPendingStarts } from '../src/runtime/pipeline-pending-starts';

const rows = (...pairs: Array<[string, string]>) => pairs.map(([id, status]) => ({ id, status }));

describe('applyPendingStarts', () => {
  it('holds a just-started stage at running while the daemon still says idle', () => {
    // The bug: run-all answers 202 before the stage is marked running, so the
    // refresh that follows reports `idle` and wipes the optimistic row. With
    // nothing "running" the 2.5s poller never starts and the board freezes
    // until the user leaves the route and comes back.
    const pending = new Map([['cj', 1_000]]);

    const out = applyPendingStarts(rows(['docs', 'succeeded'], ['cj', 'idle']), pending, 500);

    expect(out).toEqual(rows(['docs', 'succeeded'], ['cj', 'running']));
    expect(pending.has('cj')).toBe(true); // still waiting on the daemon
  });

  it('stops holding as soon as the daemon reports any non-idle status', () => {
    const pending = new Map([['cj', 1_000]]);

    expect(applyPendingStarts(rows(['cj', 'running']), pending, 500)).toEqual(rows(['cj', 'running']));
    expect(pending.has('cj')).toBe(false);
  });

  it('releases a run that failed fast, rather than showing it as running', () => {
    const pending = new Map([['cj', 1_000]]);

    expect(applyPendingStarts(rows(['cj', 'failed']), pending, 500)).toEqual(rows(['cj', 'failed']));
    expect(pending.has('cj')).toBe(false);
  });

  it('gives up after the deadline so a run that never started cannot pin the row', () => {
    const pending = new Map([['cj', 1_000]]);

    expect(applyPendingStarts(rows(['cj', 'idle']), pending, 1_001)).toEqual(rows(['cj', 'idle']));
    expect(pending.has('cj')).toBe(false);
  });

  it('leaves every other stage untouched', () => {
    const pending = new Map([['cj', 1_000]]);

    const out = applyPendingStarts(rows(['docs', 'idle'], ['ux', 'idle']), pending, 500);

    expect(out).toEqual(rows(['docs', 'idle'], ['ux', 'idle']));
  });

  it('returns the rows unchanged when nothing is pending', () => {
    const input = rows(['docs', 'idle']);

    expect(applyPendingStarts(input, new Map(), 500)).toBe(input);
  });
});
