// Pure helpers used by PipelinesView to gate the pull-view-mode UI: whether
// the selected project was pulled "Chỉ xem" (view-only), and whether "Xác
// nhận hoàn tất" is ready (only `dr-flow` + `dr-review` need to have
// succeeded — the "Tài liệu (nạp)" step is no longer required).

import { describe, expect, it } from 'vitest';
import type { PipelineProject, PipelineView } from '@open-design/contracts';
import { docsReviewReadyToConfirmOf, isViewOnlyProject } from '../../src/components/PipelinesView';

function pipeline(overrides: Partial<PipelineView> = {}): PipelineView {
  return { id: 'dr-docs', name: 'Tài liệu (nạp)', dependsOn: [], status: 'idle', active: true, ...overrides };
}

describe('docsReviewReadyToConfirmOf', () => {
  it('is true when only dr-flow and dr-review succeeded, even with dr-docs/dr-mockup idle', () => {
    const pipelines: PipelineView[] = [
      pipeline({ id: 'dr-docs', status: 'idle' }),
      pipeline({ id: 'dr-flow', status: 'succeeded' }),
      pipeline({ id: 'dr-flow-improve', status: 'idle' }),
      pipeline({ id: 'dr-mockup', status: 'idle' }),
      pipeline({ id: 'dr-review', status: 'succeeded' }),
    ];
    expect(docsReviewReadyToConfirmOf(pipelines)).toBe(true);
  });

  it('is false when dr-review has not succeeded', () => {
    const pipelines: PipelineView[] = [
      pipeline({ id: 'dr-docs', status: 'succeeded' }),
      pipeline({ id: 'dr-flow', status: 'succeeded' }),
      pipeline({ id: 'dr-review', status: 'idle' }),
    ];
    expect(docsReviewReadyToConfirmOf(pipelines)).toBe(false);
  });

  it('is false when dr-flow has not succeeded', () => {
    const pipelines: PipelineView[] = [
      pipeline({ id: 'dr-flow', status: 'idle' }),
      pipeline({ id: 'dr-review', status: 'succeeded' }),
    ];
    expect(docsReviewReadyToConfirmOf(pipelines)).toBe(false);
  });
});

describe('isViewOnlyProject', () => {
  it('is true when the project mapping is in view mode', () => {
    const project = { id: 'p1', name: 'P1', syncPullMode: 'view' } as PipelineProject;
    expect(isViewOnlyProject(project)).toBe(true);
  });

  it('is false when the project mapping is in work mode', () => {
    const project = { id: 'p1', name: 'P1', syncPullMode: 'work' } as PipelineProject;
    expect(isViewOnlyProject(project)).toBe(false);
  });

  it('is false when the project has no sync mapping at all', () => {
    const project = { id: 'p1', name: 'P1' } as PipelineProject;
    expect(isViewOnlyProject(project)).toBe(false);
  });

  it('is false for an undefined/null project', () => {
    expect(isViewOnlyProject(undefined)).toBe(false);
    expect(isViewOnlyProject(null)).toBe(false);
  });
});
