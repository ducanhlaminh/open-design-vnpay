import { describe, expect, it } from 'vitest';

// relClearedByRunAllLaunch lives in pipelines.ts: the pure clear-on-launch
// scope predicate `runWorkflowAll` (server.ts) reduces to before wiping the
// previous run's stale outputs of a full-workflow run. New file per spec (do
// NOT add to tests/pipelines.test.ts — another change is in flight there).
//
// BUG THIS LOCKS: runWorkflowAll used to reset nothing at launch — only call
// runStage(id) in sequence — so a stage still waiting its turn kept showing
// the PREVIOUS run's "Xong · Nm ago" with its stale files still on disk.
// USER-MANDATED CONSTRAINT (non-negotiable): clearing must stay confined to
// the workflow tree THIS run-all launch belongs to — a project can hold
// several parallel workflow trees in the same directory (`docs-to-ui/`,
// `docs-review/`, …) and a run of one must never touch another's files.
//
// relClearedByRunAllLaunch = relClearedByRegen (unchanged) AND an EXPLICIT
// workflow fence: baseWfDir null/empty → same as relClearedByRegen; baseWfDir
// set → rel must start with `${baseWfDir}/`. The fence exists because
// `stagesForOutput` (pipelines.ts:509) lets an UNPREFIXED path — one that
// doesn't sit under any known workflow folder — match across EVERY
// PIPELINE_DEFS entry regardless of workflow (kept for pre-namespacing
// projects); `relClearedByRegen` alone can't tell "legitimately unprefixed"
// apart from "prefixed under a DIFFERENT workflow's folder".
import { relClearedByRegen, relClearedByRunAllLaunch } from '../src/pipelines.js';

describe('relClearedByRunAllLaunch', () => {
  it('file trong ĐÚNG workflow đang chạy, đúng bước đang xoá → true', () => {
    expect(
      relClearedByRunAllLaunch(
        'docs-to-ui/web-user/wireframes/A.wire.json',
        new Set(['ux']),
        null,
        'docs-to-ui',
      ),
    ).toBe(true);
  });

  it('RÀNG BUỘC CHÍNH NGƯỜI DÙNG NÊU: file thuộc workflow KHÁC (docs-review/) → false dù trùng regenIds', () => {
    expect(
      relClearedByRunAllLaunch('docs-review/comp/x.json', new Set(['ux']), null, 'docs-to-ui'),
    ).toBe(false);
  });

  it('criteria/ không phải output của bước nào → false', () => {
    expect(
      relClearedByRunAllLaunch(
        'docs-to-ui/web-user/criteria/components.md',
        new Set(['ux']),
        null,
        'docs-to-ui',
      ),
    ).toBe(false);
  });

  it('docs-app/ không phải output của bước nào → false', () => {
    expect(
      relClearedByRunAllLaunch('docs-to-ui/docs-app/_index.md', new Set(['ux']), null, 'docs-to-ui'),
    ).toBe(false);
  });

  it('.odhistory/ không phải output của bước nào → false', () => {
    expect(
      relClearedByRunAllLaunch('.odhistory/2026-08-09T00-00-00.json', new Set(['ux']), null, 'docs-to-ui'),
    ).toBe(false);
  });

  it('file thuộc ui-html — KHÔNG nằm trong tập bước đang xoá (ux) → false', () => {
    expect(
      relClearedByRunAllLaunch(
        'docs-to-ui/web-user/prototype/index.html',
        new Set(['ux']),
        null,
        'docs-to-ui',
      ),
    ).toBe(false);
  });

  it('multi-target: fence target SẴN CÓ vẫn còn tác dụng (mobile output khi wfDir đang xoá là web-user)', () => {
    expect(
      relClearedByRunAllLaunch(
        'docs-to-ui/mobile/wireframes/A.wire.json',
        new Set(['ux']),
        'docs-to-ui/web-user',
        'docs-to-ui',
      ),
    ).toBe(false);
  });

  it('baseWfDir null/undefined → hành vi giống hệt relClearedByRegen (không thêm hàng rào)', () => {
    const cases: Array<[string, ReadonlySet<string>, string | null | undefined]> = [
      ['docs-to-ui/web-user/wireframes/A.wire.json', new Set(['ux']), null],
      ['docs-review/comp/x.json', new Set(['ux']), null],
      ['docs-to-ui/web-user/prototype/index.html', new Set(['ux']), null],
      ['docs-to-ui/mobile/wireframes/A.wire.json', new Set(['ux']), 'docs-to-ui/web-user'],
      ['wireframes/A.wire.json', new Set(['ux']), null],
    ];
    for (const [rel, regenIds, wfDir] of cases) {
      expect(relClearedByRunAllLaunch(rel, regenIds, wfDir, null)).toBe(relClearedByRegen(rel, regenIds, wfDir));
      expect(relClearedByRunAllLaunch(rel, regenIds, wfDir, undefined)).toBe(
        relClearedByRegen(rel, regenIds, wfDir),
      );
    }
  });

  // Bổ sung ngoài danh sách spec: chứng minh TRỰC TIẾP cái bẫy mà hàng rào mới
  // đóng lại — một path KHÔNG nằm dưới thư mục workflow nào rơi vào nhánh
  // "khớp với MỌI PIPELINE_DEFS" của stagesForOutput (pipelines.ts:509), nên
  // relClearedByRegen một mình vẫn trả true (hành vi legacy có chủ đích, giữ
  // cho dự án cũ trước khi có namespacing). Khi baseWfDir được truyền vào (như
  // runWorkflowAll luôn làm — nó luôn biết đang chạy workflow nào),
  // relClearedByRunAllLaunch phải chặn lại.
  it('path KHÔNG namespace dưới workflow nào: relClearedByRegen vẫn xoá (legacy), relClearedByRunAllLaunch với baseWfDir CHẶN lại', () => {
    const rel = 'wireframes/A.wire.json';
    const regenIds = new Set(['ux']);
    expect(relClearedByRegen(rel, regenIds, null)).toBe(true);
    expect(relClearedByRunAllLaunch(rel, regenIds, null, 'docs-to-ui')).toBe(false);
  });
});
