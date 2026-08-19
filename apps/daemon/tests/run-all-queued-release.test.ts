import { describe, expect, it } from 'vitest';

// `strandedQueuedStages` is the rule runWorkflowAll's `finally` reduces to
// when it releases the stages a launch marked `queued` but never reached.
//
// BUG THIS LOCKS (reported 19/08/2026, "bấm run-all xong bước nào cũng đang
// chạy"): clear-on-launch marks EVERY planned stage `queued`, the chain then
// aborts at its first failing stage and `return`s — and nothing ever reset the
// rest. They stayed `queued` forever: the wall-clock timeout only reaps a
// stage that is genuinely running, and the web card renders `queued` with a
// spinner and NO Run button, so those steps looked busy, could not be started,
// and never moved.
import { strandedQueuedStages } from '../src/pipelines.js';

describe('strandedQueuedStages', () => {
  it('bước đã lên hàng đợi mà chuỗi không chạy tới → được thả', () => {
    const state = {
      'dr-docs': { status: 'succeeded' },
      'dr-flow': { status: 'failed' },
      'dr-comp': { status: 'queued' },
      'dr-review': { status: 'queued' },
    };
    expect(strandedQueuedStages(state, ['dr-docs', 'dr-flow', 'dr-comp', 'dr-review'])).toEqual([
      'dr-comp',
      'dr-review',
    ]);
  });

  it('bước ĐANG chạy không phải bước kẹt — không đụng tới', () => {
    const state = { 'dr-flow': { status: 'running' }, 'dr-comp': { status: 'queued' } };
    expect(strandedQueuedStages(state, ['dr-flow', 'dr-comp'])).toEqual(['dr-comp']);
  });

  it('succeeded / failed / idle / thiếu row đều đã nói đúng sự thật — bỏ qua', () => {
    const state = {
      a: { status: 'succeeded' },
      b: { status: 'failed' },
      c: { status: 'idle' },
      d: undefined,
      e: {},
    };
    expect(strandedQueuedStages(state, ['a', 'b', 'c', 'd', 'e'])).toEqual([]);
  });

  it('bước queued NGOÀI danh sách của lần chạy này là của người khác — không thả', () => {
    const state = { mine: { status: 'queued' }, theirs: { status: 'queued' } };
    expect(strandedQueuedStages(state, ['mine'])).toEqual(['mine']);
  });

  it('id lặp trong danh sách chỉ trả về một lần, giữ nguyên thứ tự kế hoạch', () => {
    const state = { x: { status: 'queued' }, y: { status: 'queued' } };
    expect(strandedQueuedStages(state, ['y', 'x', 'y'])).toEqual(['y', 'x']);
  });

  it('không có bước nào kẹt → mảng rỗng (caller không ghi gì vào db)', () => {
    expect(strandedQueuedStages({ a: { status: 'succeeded' } }, ['a'])).toEqual([]);
  });
});
