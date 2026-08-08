// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FeedbackFormDef, FeedbackSubmission } from '@open-design/contracts';
import { FeedbackOverview, overviewAggregate } from '../../src/components/feedback/FeedbackOverview';

afterEach(cleanup);

const form = (version: number, questions: FeedbackFormDef['questions'], sections: FeedbackFormDef['sections']): FeedbackFormDef => ({ version, title: 'Pipeline', questions, sections, createdAt: version });
const sections: FeedbackFormDef['sections'] = [
  { id: 'overview', title: 'Tổng quan' },
  { id: 'per-step', title: 'Theo bước', repeatForQuestionId: 'steps' },
  { id: 'notes', title: 'Không có điểm' },
];
const v1 = form(1, [
  { id: 'nps', label: 'NPS', type: 'scale', scaleMin: 0, scaleMax: 10, sectionId: 'overview' },
  { id: 'quality', label: 'Quality', type: 'scale', scaleMax: 5, sectionId: 'overview' },
  { id: 'steps', label: 'Steps', type: 'checkbox', options: ['Build', 'Review'] },
  { id: 'step-quality', label: 'Step quality', type: 'scale', scaleMax: 5, sectionId: 'per-step' },
  { id: 'step-stability', label: 'Step stability', type: 'radio', options: ['4 — Smooth', '2 — Slow', 'Unknown'], sectionId: 'per-step' },
  { id: 'production-ready', label: 'Ready?', type: 'radio', options: ['Yes', 'With changes', 'No'] },
], sections);
const v2 = form(2, [
  ...v1.questions,
  { id: 'new-quality', label: 'New quality', type: 'scale', scaleMax: 5, sectionId: 'overview' },
], sections);
const submission = (id: string, formVersion: number, user: string, answers: FeedbackSubmission['answers']): FeedbackSubmission => ({ id, formVersion, user, channel: 'packaged', workflowId: 'wf', answers, createdAt: 1 });
const submissions = [
  submission('1', 1, 'a', { nps: 9, quality: 4, steps: ['Build', 'Review'], 'step-quality@Build': 4, 'step-stability@Build': '4 — Smooth', 'step-quality@Review': 3, 'step-stability@Review': '2 — Slow', 'production-ready': 'Yes' }),
  submission('2', 1, 'b', { nps: 7, quality: 5, steps: ['Build'], 'step-quality@Build': 5, 'step-stability@Build': '4 — Smooth', 'production-ready': 'With changes' }),
  submission('3', 2, 'c', { nps: 4, quality: 3, 'new-quality': 5, 'step-quality@Build': 3, 'step-stability@Build': 'Unknown', 'production-ready': 'No' }),
  submission('4', 2, 'a', { nps: 10, quality: 2, 'new-quality': 4, 'step-quality@Review': 5, productionReady: 'Yes', 'production-ready': 'Yes' }),
];

describe('overviewAggregate', () => {
  it('aggregates versions, repeated sections, NPS, and production choices', () => {
    const result = overviewAggregate([v1, v2], submissions);
    expect(result.kpis).toEqual({ submissions: 4, users: 3, nps: 25, avgQuality: 3.9 });
    expect(result.sectionAverages).toEqual([{ sectionTitle: 'Tổng quan', average: 3.8, questionCount: 2, sampleCount: 6 }, { sectionTitle: 'Theo bước', average: 4, questionCount: 1, sampleCount: 5 }]);
    expect(result.stepAverages).toEqual([
      { step: 'Build', quality: 4, stability: 4 },
      { step: 'Review', quality: 4, stability: 2 },
    ]);
    expect(result.productionReady).toEqual([{ option: 'Yes', count: 2 }, { option: 'With changes', count: 1 }, { option: 'No', count: 1 }]);
  });
  it('returns null and empty collections without submissions', () => {
    expect(overviewAggregate([v1], []).kpis).toEqual({ submissions: 0, users: 0, nps: null, avgQuality: null });
    expect(overviewAggregate([v1], []).sectionAverages).toEqual([]);
    expect(overviewAggregate([v1], []).stepAverages).toEqual([]);
    expect(overviewAggregate([v1], []).productionReady).toEqual([]);
  });
});

describe('FeedbackOverview', () => {
  it('renders KPI and drills into a section row', () => {
    const onDrill = vi.fn();
    render(<FeedbackOverview forms={[v1, v2]} submissions={submissions} onDrill={onDrill} />);
    expect(screen.getByText('Bài gửi')).toBeTruthy();
    expect(screen.getByText('25')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Tổng quan/ }));
    expect(onDrill).toHaveBeenCalledWith('Tổng quan');
  });
  it('renders the filtered empty state', () => {
    render(<FeedbackOverview forms={[v1]} submissions={[]} />);
    expect(screen.getByText('Chưa có bài gửi nào khớp bộ lọc.')).toBeTruthy();
    expect(screen.queryByText('Bài gửi')).toBeNull();
  });
});
