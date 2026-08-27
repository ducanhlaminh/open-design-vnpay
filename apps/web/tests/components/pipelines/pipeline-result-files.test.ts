// Regression for the docs-review Quick result bug: `WORKFLOW_DIR_RE` /
// `KNOWN_WORKFLOW_DIRS` (PipelineModals.tsx) list every workflow-folder head
// the daemon may prefix an output with, and MUST be kept in sync by hand with
// the daemon's `WORKFLOWS` registry (apps/daemon/src/pipelines.ts) — see the
// docblock above `WORKFLOW_DIR_RE`. When `docs-review` was added daemon-side
// without mirroring it here, `stripWorkflowDir` never stripped the
// `docs-review/` prefix off a dr-review output path, so `outputMatches`
// compared the WRONG (still-prefixed) relative path against the stage's
// `review/` pattern and always missed — Quick result reported "No output
// files yet" for a dr-review run that plainly succeeded on disk.
import { describe, expect, it } from 'vitest';
import { isUiPreviewFile, outputMatches, stripWorkflowDir } from '../../../src/components/pipelines/PipelineModals';

describe('stripWorkflowDir', () => {
  it('strips the docs-review workflow prefix off a dr-review output path', () => {
    expect(stripWorkflowDir('docs-review/review/docs/confluence/x.md')).toBe('review/docs/confluence/x.md');
  });

  it('keeps stripping the docs-to-prd prefix (pre-existing behavior, unchanged)', () => {
    expect(stripWorkflowDir('docs-to-prd/review/report.json')).toBe('review/report.json');
  });

  // ds-lab (WP-lab, 2026-08-22): same mirroring requirement — a ds-lab output
  // path must strip the same way or lab-compose's screens/ never resolves.
  it('strips the ds-lab workflow prefix off a lab-compose output path', () => {
    expect(stripWorkflowDir('ds-lab/screens/SCR-001.png')).toBe('screens/SCR-001.png');
    expect(stripWorkflowDir('ds-lab/lab-result.json')).toBe('lab-result.json');
  });
});

describe('outputMatches', () => {
  it('matches a stripped dr-review path against its "review/" outputs pattern', () => {
    expect(outputMatches(stripWorkflowDir('docs-review/review/docs/confluence/x.md'), 'review/')).toBe(true);
  });

  it('matches a stripped lab-compose path against its "screens/" outputs pattern', () => {
    expect(outputMatches(stripWorkflowDir('ds-lab/screens/SCR-001.png'), 'screens/')).toBe(true);
  });
});

// Regression: App-pool projects (App docs pool, 08/2026) ingest into
// docs-feature/ instead of docs/, and dr-review clones that into
// review/docs-feature/ (see docs-review.ts's cloneDocsForReview). Quick
// result's isUiPreviewFile only matched `docs/**/*.md`, so a docs-feature
// project's redline pages never showed up in the rail — only index.json +
// summary.md did. Same `docs|docs-feature` pairing as
// FileViewer.isDocsReviewRedlinePage (fix ab41f3e).
describe('isUiPreviewFile', () => {
  it('matches a dr-review redline page cloned from the App docs pool (docs-feature)', () => {
    expect(isUiPreviewFile('docs-review/review/docs-feature/A/x.md')).toBe(true);
  });

  it('keeps matching a dr-review redline page cloned from Confluence docs (unchanged)', () => {
    expect(isUiPreviewFile('docs-review/review/docs/confluence/a.md')).toBe(true);
  });

  it('does not treat a docs-feature .changes.json sidecar as a previewable page', () => {
    expect(isUiPreviewFile('docs-review/review/docs-feature/A/x.changes.json')).toBe(false);
  });

  it('does not treat a docs-feature _index.md companion as a previewable page', () => {
    expect(isUiPreviewFile('docs-review/review/docs-feature/A/_index.md')).toBe(false);
  });

  it('matches a dr-docs ingest output page under docs-feature (not under review/)', () => {
    expect(isUiPreviewFile('docs-review/docs-feature/A/x.md')).toBe(true);
  });

  // Feedback 08/2026: rail chỉ liệt kê TRANG nội dung — manifest/digest
  // máy-đọc (index.json, summary.md) ẩn ở mọi vị trí. review/index.json từng
  // lọt qua rule report-JSON cuối hàm chỉ vì nằm trong review/.
  it('hides index.json and summary.md everywhere in the rail', () => {
    expect(isUiPreviewFile('docs-review/review/index.json')).toBe(false);
    expect(isUiPreviewFile('docs-review/review/summary.md')).toBe(false);
    expect(isUiPreviewFile('docs-review/docs-feature/summary.md')).toBe(false);
    expect(isUiPreviewFile('docs-to-prd/review/summary.md')).toBe(false);
  });

  // WP dr-mockup (2026-08-27): Quick result của bước "Mockup màn" CHỈ liệt kê
  // `mockups/index.json` (MockupsPreview); HTML từng màn + file phụ ẩn. Rule
  // này phải đứng TRƯỚC rule ẩn index.json chung — comp/index.json vẫn ẩn.
  it('dr-mockup: mockups/index.json hiện, mockups/*.html + file phụ ẩn, comp/index.json vẫn ẩn', () => {
    expect(isUiPreviewFile('docs-review/mockups/index.json')).toBe(true);
    expect(isUiPreviewFile('docs-review/mockups/index.json', 'dr-mockup')).toBe(true);
    expect(isUiPreviewFile('docs-review/mockups/SCR-001.html')).toBe(false);
    expect(isUiPreviewFile('docs-review/mockups/_inputs.json')).toBe(false);
    expect(isUiPreviewFile('docs-review/mockups/_audit.json')).toBe(false);
    expect(isUiPreviewFile('docs-review/mockups/_mockup.css')).toBe(false);
    expect(isUiPreviewFile('docs-review/comp/index.json')).toBe(false);
  });

  // screens-discovered.json (0.8.143; từ WP dr-screens-merge sinh cùng bước
  // Luồng màn hình dr-flow, cùng contract dr-screens cũ): Quick result mở
  // ScreensDiscoveredPreview; digest .md và comp/_screens.json (manifest —
  // trước đây lọt fallback rồi render nhầm thành UX Spec) phải ẩn.
  it('matches screens-discovered.json (dr-flow, formerly dr-screens) and hides its siblings', () => {
    expect(isUiPreviewFile('docs-review/screens-discovered.json')).toBe(true);
    expect(isUiPreviewFile('docs-review/screens-discovered.md')).toBe(false);
    expect(isUiPreviewFile('docs-review/comp/_screens.json')).toBe(false);
  });

  // ds-lab (0.8.105): Quick result of "Đề xuất kit" opened on kit-plan.json
  // (raw JSON, sorted first) instead of the human table kit-plan.md — the user
  // read it as "no Quick result". Readable Lab outputs are previewable; their
  // machine-read siblings stay hidden.
  it('ds-lab: kit-plan.md is previewable, kit-plan.json is not', () => {
    expect(isUiPreviewFile('ds-lab/kit-plan.md')).toBe(true);
    expect(isUiPreviewFile('ds-lab/kit-plan.json')).toBe(false);
  });

  it('ds-lab: kit-shots/*.png + screens/*.png + their _audit.md are previewable; result JSONs are not', () => {
    expect(isUiPreviewFile('ds-lab/kit-shots/card-plan.png')).toBe(true);
    expect(isUiPreviewFile('ds-lab/screens/SCR-01.png')).toBe(true);
    expect(isUiPreviewFile('ds-lab/kit-shots/_audit.md')).toBe(true);
    expect(isUiPreviewFile('ds-lab/screens/_audit.md')).toBe(true);
    expect(isUiPreviewFile('ds-lab/kit-result.json')).toBe(false);
    expect(isUiPreviewFile('ds-lab/lab-result.json')).toBe(false);
    expect(isUiPreviewFile('ds-lab/kit/kit.json')).toBe(false);
  });

  // ds-lab "Bản đồ màn" (lab-map, WP-lab-map 2026-08-23): screen-map.md is the
  // human table for the approval gate — same "readable sibling wins" pairing
  // as kit-plan.md/kit-plan.json above.
  it('ds-lab: screen-map.md is previewable, screen-map.json is not', () => {
    expect(isUiPreviewFile('ds-lab/screen-map.md')).toBe(true);
    expect(isUiPreviewFile('ds-lab/screen-map.json')).toBe(false);
  });
});

// WP dr-flow-result-split (2026-08-27): Quick result là của MỘT BƯỚC — cùng
// thư mục flows/<id>/ nhưng dr-flow mở sơ đồ nguyên bản as-is.drawio (ux-review
// .json là file của dr-flow-improve, không hiện "ké"), dr-flow-improve mở
// ux-review.json (khung Nguyên bản | Cải thiện). Không truyền pipelineId →
// luật cũ nguyên vẹn.
describe('isUiPreviewFile theo bước (pipelineId)', () => {
  it('dr-flow: as-is.drawio hiện, ux-review.json + proposed.* ẩn, screens-discovered.json vẫn hiện', () => {
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/as-is.drawio', 'dr-flow')).toBe(true);
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/ux-review.json', 'dr-flow')).toBe(false);
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/proposed.drawio', 'dr-flow')).toBe(false);
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/proposed.edited.json', 'dr-flow')).toBe(false);
    expect(isUiPreviewFile('docs-review/screens-discovered.json', 'dr-flow')).toBe(true);
    expect(isUiPreviewFile('docs-review/flows/index.json', 'dr-flow')).toBe(false);
  });

  it('dr-flow-improve: ux-review.json hiện, as-is.drawio + proposed.drawio ẩn', () => {
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/ux-review.json', 'dr-flow-improve')).toBe(true);
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/as-is.drawio', 'dr-flow-improve')).toBe(false);
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/proposed.drawio', 'dr-flow-improve')).toBe(false);
  });

  it('không pipelineId / bước khác → hành vi cũ: ux-review.json hiện, as-is.drawio ẩn', () => {
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/ux-review.json')).toBe(true);
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/as-is.drawio')).toBe(false);
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/ux-review.json', 'dr-comp')).toBe(true);
    expect(isUiPreviewFile('docs-review/flows/SCREEN-FLOW/as-is.drawio', 'dr-comp')).toBe(false);
    // Luật khác không đổi khi có pipelineId.
    expect(isUiPreviewFile('docs-review/review/docs-feature/A/x.md', 'dr-flow')).toBe(true);
    expect(isUiPreviewFile('docs-review/comp/_screens.json', 'dr-flow')).toBe(false);
  });
});
