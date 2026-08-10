import { describe, expect, it } from 'vitest';

// resetScopeForRunAllStage lives in server.ts (not pipelines.ts): it is the
// pure 3-argument decision `runWorkflowAll`'s `runStage` reduces to before
// calling `runPipeline` for one stage of a full-workflow run. New file per
// spec (do NOT add to tests/pipelines.test.ts — another change is in flight
// on that file at the same time).
import { resetScopeForRunAllStage } from '../src/server.js';

// The bug this locks: a project with a SAVED `runAllConfig.stageIds` sets
// `manualStages = true` for every run-all, including a full re-run of the
// whole chain by hand-ticking every stage. The pre-fix expression fell
// through to `undefined` for every stage except the very first of an
// AUTOMATIC run — so a hand-ticked re-run cleared nothing and stale files
// from the previous pass sat in each stage's `outputs`, silently folded into
// the next run's result (worst case: a fan-out merge like
// `ux/<module>/ux-spec.json` picking up a module the current pass no longer
// emits). The fix: every stage that ACTUALLY RUNS clears at least itself
// (`'stage'`), and only the narrow "fresh full automatic run" case cascades
// to `'downstream'` too.
describe('resetScopeForRunAllStage', () => {
  it('không tick tay, bước đầu, không skipSucceeded → downstream (fresh full run resets the whole project up front)', () => {
    expect(
      resetScopeForRunAllStage({ manualStages: false, isFirstStage: true, skipSucceeded: false }),
    ).toBe('downstream');
  });

  it('không tick tay, bước thứ hai trở đi → stage (mọi bước SAU bước đầu chỉ dọn chính nó — downstream đã lo phần còn lại từ bước đầu)', () => {
    expect(
      resetScopeForRunAllStage({ manualStages: false, isFirstStage: false, skipSucceeded: false }),
    ).toBe('stage');
  });

  it('CÓ tick tay, bước đầu → stage — đây là ca ĐANG HỎNG trước khi sửa (từng rơi vào undefined, không dọn gì cả)', () => {
    expect(
      resetScopeForRunAllStage({ manualStages: true, isFirstStage: true, skipSucceeded: false }),
    ).toBe('stage');
  });

  it('CÓ tick tay, bước giữa → stage', () => {
    expect(
      resetScopeForRunAllStage({ manualStages: true, isFirstStage: false, skipSucceeded: false }),
    ).toBe('stage');
  });

  it('skipSucceeded bật, bước đầu, không tick tay → stage (không còn undefined — skipSucceeded chỉ tắt SUY LUẬN downstream, không tắt việc dọn output của chính bước đang chạy)', () => {
    expect(
      resetScopeForRunAllStage({ manualStages: false, isFirstStage: true, skipSucceeded: true }),
    ).toBe('stage');
  });

  it('skipSucceeded bật, tick tay, bước đầu → stage', () => {
    expect(
      resetScopeForRunAllStage({ manualStages: true, isFirstStage: true, skipSucceeded: true }),
    ).toBe('stage');
  });

  it('không nhánh nào trả undefined trên toàn bộ 8 tổ hợp boolean', () => {
    for (const manualStages of [false, true]) {
      for (const isFirstStage of [false, true]) {
        for (const skipSucceeded of [false, true]) {
          const scope = resetScopeForRunAllStage({ manualStages, isFirstStage, skipSucceeded });
          expect(scope === 'stage' || scope === 'downstream').toBe(true);
        }
      }
    }
  });
});
