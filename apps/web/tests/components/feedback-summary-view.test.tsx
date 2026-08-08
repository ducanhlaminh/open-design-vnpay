// @vitest-environment jsdom
// @ts-nocheck
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FeedbackFormDef, FeedbackSubmission } from '@open-design/contracts';
import { aggregateFeedback, FeedbackSummaryView } from '../../src/components/feedback/FeedbackSummaryView';
import { filterFeedbackSubmissions } from '../../src/components/feedback/FeedbackSummaryRoute';

afterEach(() => cleanup());

const form = (questions: FeedbackFormDef['questions'], extra: Partial<FeedbackFormDef> = {}): FeedbackFormDef => ({ version: 1, title: 'Khảo sát', questions, createdAt: 1, ...extra });
const submission = (answers: FeedbackSubmission['answers'], extra: Partial<FeedbackSubmission> = {}): FeedbackSubmission => ({ id: crypto.randomUUID(), formVersion: 1, user: 'alice', channel: 'packaged', workflowId: 'wf', answers, createdAt: 10, ...extra });

it('aggregateFeedback đếm lựa chọn, scale trung bình, text theo user', () => {
  const f = form([{ id: 'r', label: 'Chọn', type: 'radio', options: ['A', 'B'], allowOther: true }, { id: 'c', label: 'Nhiều', type: 'checkbox', options: ['X', 'Y'] }, { id: 's', label: 'Điểm', type: 'scale', scaleMax: 10 }, { id: 't', label: 'Nói', type: 'text' }]);
  const out = aggregateFeedback([f], [submission({ r: 'A', c: ['X', 'Y'], s: 8, t: 'một' }, { user: 'u1', createdAt: 2 }), submission({ r: '__other__', c: ['X'], s: 6, t: 'hai' }, { user: 'u2', createdAt: 3, otherTexts: { r: 'Tự chọn' } })]);
  expect(out[0].sections[0].items.find((item) => item.question.id === 'r')?.optionCounts).toEqual([{ option: 'A', count: 1 }, { option: 'B', count: 0 }, { option: '__other__', count: 1 }]);
  expect(out[0].sections[0].items.find((item) => item.question.id === 's')?.scaleAverage).toBe(7);
  expect(out[0].sections[0].items.find((item) => item.question.id === 't')?.texts).toEqual(['u2: hai', 'u1: một']);
});

it('tách hai form version, không trộn count, mới nhất trước', () => {
  const f1 = form([{ id: 'q', label: 'Cũ', type: 'radio', options: ['A'] }]);
  const f2 = { ...f1, version: 2, title: 'Mới', questions: [{ id: 'q', label: 'Mới', type: 'radio' as const, options: ['B'] }] };
  const out = aggregateFeedback([f1, f2], [submission({ q: 'A' }), submission({ q: 'B' }, { formVersion: 2 })]);
  expect(out.map((item) => item.form.version)).toEqual([2, 1]);
  expect(out[0].sections[0].items[0].optionCounts).toEqual([{ option: 'B', count: 1 }]);
});

it('giữ submission mồ côi trong nhóm version không rõ', () => {
  const out = aggregateFeedback([], [submission({ lost: 'value' }, { formVersion: 99 })]);
  expect(out[0].form.title).toBe('Version không rõ');
  expect(out[0].submissionCount).toBe(1);
  expect(out[0].sections[0].items[0].texts).toEqual(['alice: value']);
});

it('sections + section lặp tạo instance theo option, đếm đúng', () => {
  const f = form([{ id: 'q', label: 'Đánh giá bước', type: 'radio', sectionId: 'repeat', options: ['Tốt', 'Tệ'] }], { sections: [{ id: 'repeat', title: 'Theo bước', repeatForQuestionId: 'used' }] });
  const out = aggregateFeedback([f], [submission({ 'q@A': 'Tốt', 'q@B': 'Tệ' }), submission({ 'q@A': 'Tốt' })]);
  expect(out[0].sections[0].title).toBe('Theo bước');
  expect(out[0].sections[0].items.map((item) => item.instanceLabel)).toEqual(['A', 'B']);
  expect(out[0].sections[0].items[0].optionCounts).toEqual([{ option: 'Tốt', count: 2 }, { option: 'Tệ', count: 0 }]);
});

it('scaleMin 0 tạo đủ histogram từ 0 và average đúng', () => {
  const f = form([{ id: 'nps', label: 'NPS', type: 'scale', scaleMin: 0, scaleMax: 5 }]);
  const item = aggregateFeedback([f], [submission({ nps: 0 }), submission({ nps: 2 })])[0].sections[0].items[0];
  expect(item.scaleAverage).toBe(1);
  expect(item.scaleCounts).toEqual([{ value: 0, count: 1 }, { value: 1, count: 0 }, { value: 2, count: 1 }, { value: 3, count: 0 }, { value: 4, count: 0 }, { value: 5, count: 0 }]);
});

it('optionsSource đếm giá trị quan sát, không cần options gốc', () => {
  const f = form([{ id: 'steps', label: 'Bước', type: 'checkbox', optionsSource: 'workflow-steps' }]);
  const item = aggregateFeedback([f], [submission({ steps: ['Alpha', 'Beta'] }), submission({ steps: ['Alpha'] })])[0].sections[0].items[0];
  expect(item.optionCounts).toEqual([{ option: 'Alpha', count: 2 }, { option: 'Beta', count: 1 }]);
});

const demoForms = [form([{ id: 'q', label: 'Lựa chọn', type: 'radio', options: ['A', 'B'], allowOther: true }, { id: 's', label: 'Điểm', type: 'scale', scaleMax: 5 }])];

it('render option count, Khác + chữ tay, gallery ảnh và stage-output', () => {
  const submissions = [{ ...submission({ q: '__other__', s: 4 }, { otherTexts: { q: 'Tự viết' }, attachments: [{ kind: 'image', path: 'a.png', name: 'anh.png' }, { kind: 'stage-output', path: 'a.md', name: 'bao-cao.md', stageId: 'review' }] }) }];
  render(<FeedbackSummaryView forms={demoForms} submissions={submissions} attachmentUrl={(path) => `/store/${path}`} />);
  expect(screen.getAllByText('Khác').length).toBeGreaterThan(0); expect(screen.getByText('Tự viết')).toBeTruthy(); expect(screen.getByText('bao-cao.md')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'anh.png' }).getAttribute('src')).toBe('/store/a.png');
  expect(screen.getByRole('link', { name: /bao-cao\.md/ }).getAttribute('href')).toBe('/store/a.md');
});

it('filterFeedbackSubmissions: ẩn dev mặc định, workflow lọc đúng', () => {
  const rows = [submission({ q: 'A' }, { channel: 'dev', user: 'dev' }), submission({ q: 'B' }, { workflowId: 'other', user: 'real' })];
  expect(filterFeedbackSubmissions(rows, { workflow: '', hideDev: true })).toHaveLength(1);
  expect(filterFeedbackSubmissions(rows, { workflow: '', hideDev: false })).toHaveLength(2);
  expect(filterFeedbackSubmissions(rows, { workflow: 'other', hideDev: false })).toHaveLength(1);
  expect(filterFeedbackSubmissions(rows, { workflow: 'wf', hideDev: true })).toHaveLength(0);
});

it('empty state khi không có bài gửi', () => {
  render(<FeedbackSummaryView forms={demoForms} submissions={[]} attachmentUrl={(path) => path} />);
  expect(screen.getByText(/Chưa có bài gửi phù hợp/)).toBeTruthy();
});
